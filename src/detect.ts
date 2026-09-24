import { createHash } from 'node:crypto';
import { fingerprint } from './fingerprint.js';
import { durationMs, statementOf, type Span } from './otlp.js';
import { suggest, type Kind } from './suggest.js';

export interface Options {
  /** Minimum repetitions of one fingerprint under one logical parent. */
  threshold: number;
}

export const DEFAULTS: Options = { threshold: 5 };

export interface Occurrence {
  traceId: string;
  parentSpanId: string;
  count: number;
  totalMs: number;
}

export interface Finding {
  /** Identifies this finding within one report (derived from `keys`). */
  key: string;
  /** One per statement, stable across runs: service + logical parent name + fingerprint.
   * Baselines store these, so a loop body that issues a different mix of statements
   * on different data still matches. */
  keys: string[];
  service: string;
  parent: string;
  /** The first statement of the loop body. */
  fingerprint: string;
  /** Every statement the loop body repeats, in order (upsert = select + insert, ...). */
  statements: string[];
  kind: Kind;
  orm: string | null;
  location: string | null;
  occurrences: Occurrence[];
  maxCount: number;
  totalMs: number;
  /** Wall time the repeated statements took (overlapping concurrent queries counted
   * once) minus the slowest one: what one batched query of that cost would save. */
  estimatedSavedMs: number;
  examples: string[];
  suggestion: string;
}

// Spans that belong to the database layer rather than to application code:
// ORM wrappers and driver spans. The N+1 "parent" is the first ancestor that
// isn't one of these (e.g. the HTTP handler that looped).
const ORM_SPAN = /^(prisma:|pg[.:]|mysql|sequelize|typeorm|knex|mikro-orm|drizzle|sqlalchemy|django\.db)/i;

function isDbLayer(s: Span): boolean {
  return ORM_SPAN.test(s.name) || 'db.system' in s.attributes || 'db.system.name' in s.attributes;
}

function ormOf(chain: Span[]): string | null {
  for (const s of chain) {
    const m = ORM_SPAN.exec(s.name);
    if (m?.[1]) return m[1].replace(/[.:]$/, '').toLowerCase();
  }
  return null;
}

function locationOf(chain: Span[]): string | null {
  for (const s of chain) {
    const file = s.attributes['code.filepath'] ?? s.attributes['code.file.path'];
    if (typeof file === 'string') {
      const line = s.attributes['code.lineno'] ?? s.attributes['code.line.number'];
      const fn = s.attributes['code.function'] ?? s.attributes['code.function.name'];
      return `${file}${line !== undefined ? `:${line}` : ''}${fn ? ` (${fn})` : ''}`;
    }
  }
  return null;
}

// Transaction control and connection chatter. `begin` only on its own: a PL/SQL
// `begin proc(?); end;` block called in a loop is a real N+1.
const IGNORED =
  /^(?:(?:begin|start transaction)(?: transaction| work| isolation level [a-z ]+| read (?:only|write))*;?$|commit|rollback|savepoint|release savepoint|set |show |select \?;?$|deallocate|discard )/;

export function keyOf(service: string, parent: string, fp: string): string {
  return createHash('sha256').update(`${service}\0${parent}\0${fp}`).digest('hex').slice(0, 16);
}

/** Wall time covered by a set of intervals, in ms. */
function wallMs(spans: Span[]): number {
  const iv = spans
    .map((s) => [s.startNs, s.endNs] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let total = 0n;
  let curStart: bigint | null = null;
  let curEnd = 0n;
  for (const [s, e] of iv) {
    if (curStart === null || s > curEnd) {
      if (curStart !== null) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) curEnd = e;
  }
  if (curStart !== null) total += curEnd - curStart;
  return Number(total) / 1e6;
}

function kindOf(fp: string): Kind {
  if (fp.startsWith('select') || fp.startsWith('with')) return 'select';
  if (fp.startsWith('insert')) return 'insert';
  if (fp.startsWith('update')) return 'update';
  if (fp.startsWith('delete')) return 'delete';
  return 'other';
}

/** Find N+1 patterns across all traces in `spans`. */
export function detect(spans: Span[], opts: Options = DEFAULTS): Finding[] {
  // The same span read twice (overlapping exports, a file passed twice) counts once.
  const byId = new Map<string, Span>();
  for (const s of spans) byId.set(`${s.traceId}/${s.spanId}`, s);
  const unique = [...byId.values()];

  interface Group {
    trace: string;
    parent: Span | undefined;
    fp: string;
    stmts: Span[];
    chain: Span[];
  }
  const groups = new Map<string, Group>();
  for (const s of unique) {
    const sql = statementOf(s);
    if (!sql) continue;
    const fp = fingerprint(sql);
    if (IGNORED.test(fp)) continue;
    // Walk up to the first application-level ancestor.
    const chain: Span[] = [s];
    let p = byId.get(`${s.traceId}/${s.parentSpanId}`);
    let guard = 0;
    while (p && isDbLayer(p) && guard++ < 64) {
      chain.push(p);
      p = byId.get(`${p.traceId}/${p.parentSpanId}`);
    }
    const key = `${s.traceId}|${p?.spanId ?? 'root'}|${fp}`;
    const g = groups.get(key) ?? {
      trace: s.traceId,
      parent: p,
      fp,
      stmts: [],
      chain: [...chain, ...(p ? [p] : [])],
    };
    g.stmts.push(s);
    groups.set(key, g);
  }

  // Statements that repeat the same number of times under the same parent are
  // one loop body (an upsert is a select plus an insert): report them together.
  const bodies = new Map<string, Group[]>();
  for (const g of groups.values()) {
    if (g.stmts.length < opts.threshold) continue;
    const k = `${g.trace}|${g.parent?.spanId ?? 'root'}|${g.stmts.length}`;
    bodies.set(k, [...(bodies.get(k) ?? []), g]);
  }

  const findings = new Map<string, Finding>();
  for (const body of bodies.values()) {
    const first = (g: Group) =>
      g.stmts.reduce((m, s) => (s.startNs < m ? s.startNs : m), g.stmts[0]!.startNs);
    body.sort((a, b) => (first(a) < first(b) ? -1 : first(a) > first(b) ? 1 : 0));
    const g0 = body[0]!;
    const fps = body.map((g) => g.fp);
    const service = g0.stmts[0]?.service ?? 'unknown';
    const parent = g0.parent?.name ?? '(root)';
    const keys = fps.map((fp) => keyOf(service, parent, fp));
    const key = createHash('sha256')
      .update([...keys].sort().join('\0'))
      .digest('hex')
      .slice(0, 16);
    let total = 0;
    let saved = 0;
    for (const g of body) {
      total += g.stmts.reduce((a, s) => a + durationMs(s), 0);
      saved += Math.max(0, wallMs(g.stmts) - g.stmts.reduce((m, s) => Math.max(m, durationMs(s)), 0));
    }
    const chain = body.flatMap((g) => g.chain);
    const orm = ormOf(chain);
    // A write in the loop body is what needs batching; otherwise it's a read.
    const kind = fps.map(kindOf).find((k) => k !== 'select') ?? kindOf(g0.fp);
    const count = g0.stmts.length;
    const f =
      findings.get(key) ??
      ({
        key,
        keys,
        service,
        parent,
        fingerprint: g0.fp,
        statements: fps,
        kind,
        orm,
        location: locationOf(chain),
        occurrences: [],
        maxCount: 0,
        totalMs: 0,
        estimatedSavedMs: 0,
        examples: [],
        suggestion: suggest(kind, orm, fps.find((fp) => kindOf(fp) === kind) ?? g0.fp),
      } satisfies Finding);
    f.occurrences.push({ traceId: g0.trace, parentSpanId: g0.parent?.spanId ?? '', count, totalMs: total });
    f.maxCount = Math.max(f.maxCount, count);
    f.totalMs += total;
    f.estimatedSavedMs += saved;
    for (const g of body)
      for (const s of g.stmts) {
        const sql = statementOf(s)!;
        if (f.examples.length < 3 && !f.examples.includes(sql)) f.examples.push(sql);
      }
    findings.set(key, f);
  }
  return [...findings.values()].sort((a, b) => b.estimatedSavedMs - a.estimatedSavedMs);
}
