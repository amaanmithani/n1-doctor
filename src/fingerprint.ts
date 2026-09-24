// SQL fingerprints: two statements that differ only in literal values map to
// the same fingerprint. Deliberately a lexer, not a parser: it must never
// throw on dialects it hasn't seen.

/**
 * Normalise a SQL statement:
 * - string, numeric, boolean and NULL literals -> ?
 * - positional/named parameters ($1, :name, @p1, ?) -> ?
 * - IN (...) / VALUES lists of any length -> a single ?-list
 * - comments removed, whitespace collapsed, keywords lower-cased
 */
export function fingerprint(sql: string): string {
  let s = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, '?') // string literals
    .replace(/\$\d+|:[A-Za-z_]\w*|@\w+/g, '?') // bind parameters
    .replace(/\b0x[0-9a-f]+\b/gi, '?')
    .replace(/(?<![\w."])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, '?') // numbers not part of identifiers
    .replace(/\b(?:true|false|null)\b/gi, '?');
  // Collapse lists: IN (?, ?, ?) -> IN (?+), VALUES (?, ?), (?, ?) -> VALUES (?+)
  s = s.replace(/\(\s*\?(?:\s*,\s*\?)*\s*\)/g, '(?+)');
  s = s.replace(/\bvalues\s*\(\?\+\)(?:\s*,\s*\(\?\+\))*/gi, 'values (?+)');
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s;
}

/** True for statements that read or write one row by key: the typical N+1 unit. */
export function looksLikePointQuery(fp: string): boolean {
  return /\bwhere\b[^()]*=\s*\?/.test(fp) && !/\bin\s*\(\?\+\)/.test(fp);
}
