// SQL fingerprints: two statements that differ only in literal values map to
// the same fingerprint. A single-pass lexer, not a parser: it must never throw
// on a dialect it hasn't seen, and it must see strings, quoted identifiers and
// comments in the order they occur (a `--` inside a string is not a comment).

const IDENT = /[A-Za-z_\u0080-￿]/;
const IDENT_REST = /[A-Za-z0-9_$\u0080-￿]/;
const DIGIT = /[0-9]/;

/** Tokens of a statement with literals and bind parameters replaced by `?`. */
function lex(sql: string): string[] {
  const out: string[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    const d = sql[i + 1];
    // whitespace
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // comments
    if (c === '-' && d === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    // string literals: '...', E'...' / e'...' (backslash escapes), N'...', X'...', B'...'
    if (c === "'" || (/[EeNnXxBbUu]/.test(c) && d === "'" && !IDENT_REST.test(sql[i - 1] ?? ' '))) {
      i += c === "'" ? 1 : 2;
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) {
          // MySQL treats backslash as an escape in every string; Postgres only in E''.
          // Skipping an escaped character is harmless either way.
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out.push('?');
      continue;
    }
    // dollar-quoted strings: $$...$$ or $tag$...$tag$
    if (c === '$' && (d === '$' || (d !== undefined && IDENT.test(d)))) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? n : end + tag.length;
        out.push('?');
        continue;
      }
    }
    // positional parameters $1
    if (c === '$' && d !== undefined && DIGIT.test(d)) {
      i++;
      while (i < n && DIGIT.test(sql[i]!)) i++;
      out.push('?');
      continue;
    }
    // quoted identifiers: "x", `x`, [x] (kept verbatim, lower-cased)
    if (c === '"' || c === '`') {
      const end = sql.indexOf(c, i + 1);
      const stop = end < 0 ? n : end + 1;
      out.push(sql.slice(i, stop).toLowerCase());
      i = stop;
      continue;
    }
    // casts: keep `::type` intact
    if (c === ':' && d === ':') {
      out.push('::');
      i += 2;
      continue;
    }
    // named parameters :name, @name (not @@system_var)
    if ((c === ':' || c === '@') && d !== undefined && IDENT.test(d) && sql[i - 1] !== c) {
      i++;
      while (i < n && IDENT_REST.test(sql[i]!)) i++;
      out.push('?');
      continue;
    }
    if (c === '@' && d === '@') {
      let j = i + 2;
      while (j < n && IDENT_REST.test(sql[j]!)) j++;
      out.push(sql.slice(i, j).toLowerCase());
      i = j;
      continue;
    }
    if (c === '?') {
      out.push('?');
      i++;
      continue;
    }
    // numbers: 1, 1.5, .5, 1e-3, 0x1f
    if (
      DIGIT.test(c) ||
      (c === '.' && d !== undefined && DIGIT.test(d) && !IDENT_REST.test(sql[i - 1] ?? ' '))
    ) {
      const m = /^(0x[0-9a-f]+|\d*\.?\d+(?:e[+-]?\d+)?)/i.exec(sql.slice(i))!;
      i += m[0].length;
      out.push('?');
      continue;
    }
    // identifiers and keywords
    if (IDENT.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_REST.test(sql[j]!)) j++;
      const word = sql.slice(i, j).toLowerCase();
      out.push(word === 'true' || word === 'false' || word === 'null' ? '?' : word);
      i = j;
      continue;
    }
    // unary minus directly before a number literal folds into it
    if (c === '-' && d !== undefined && (DIGIT.test(d) || d === '.')) {
      const prev = out[out.length - 1];
      if (
        prev === undefined ||
        /^(?:[=<>!,(+\-*/%]|<=|>=|<>|!=|and|or|not|in|values|select|when|then|else|between|like|is|return)$/.test(
          prev,
        )
      ) {
        i++;
        continue;
      }
    }
    // multi-character operators
    const op = /^(<=|>=|<>|!=|\|\||->>|->|#>>|#>|@>|<@|&&)/.exec(sql.slice(i));
    if (op) {
      out.push(op[0]);
      i += op[0].length;
      continue;
    }
    out.push(c);
    i++;
  }
  return out;
}

const NO_SPACE_BEFORE = new Set([',', ')', ']', '.', '::']);
const NO_SPACE_AFTER = new Set(['(', '[', '.', '::']);

function join(tokens: string[]): string {
  let s = '';
  let prev: string | undefined;
  for (const t of tokens) {
    if (prev !== undefined && !NO_SPACE_BEFORE.has(t) && !NO_SPACE_AFTER.has(prev)) s += ' ';
    s += t;
    prev = t;
  }
  return s;
}

/**
 * Normalise a SQL statement:
 * - string (incl. E'', dollar-quoted), numeric, boolean and NULL literals -> ?
 * - positional/named parameters ($1, :name, @p1, ?) -> ? (casts like ::int are kept)
 * - IN (...), ARRAY[...] and multi-row VALUES lists of any length -> one entry
 * - comments removed, whitespace normalised, unquoted words lower-cased
 */
export function fingerprint(sql: string): string {
  let s = join(lex(sql));
  // Lists of placeholders: IN (?, ?, ?) -> (?+), ARRAY[?, ?] -> [?+]
  s = s.replace(/\(\?(?:, \?)*\)/g, '(?+)');
  s = s.replace(/\[\?(?:, \?)*\]/g, '[?+]');
  // Repeated identical VALUES rows, including rows with expressions: (?, now()), (?, now())
  s = s.replace(/(\((?:[^()]|\([^()]*\))*\))(?:, \1)+/g, '$1');
  return s;
}

/** True for statements that read or write one row by key: the typical N+1 unit. */
export function looksLikePointQuery(fp: string): boolean {
  return /\bwhere\b[^()]*= \?/.test(fp) && !/\bin \(\?\+\)/.test(fp);
}
