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
  /** Stable across runs: service + logical parent name + fingerprint. */
  key: string;
  service: string;
  parent: string;
  fingerprint: string;
  kind: Kind;
  orm: string | null;
  location: string | null;
  occurrences: Occurrence[];
  maxCount: number;
  totalMs: number;
  /** If each repeated batch had run as one query of the slowest member's cost. */
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

const IGNORED = /^(begin|commit|rollback|savepoint|release savepoint|set |show |select \?$|deallocate)/;

function kindOf(fp: string): Kind {
  if (fp.startsWith('select') || fp.startsWith('with')) return 'select';
  if (fp.startsWith('insert')) return 'insert';
  if (fp.startsWith('update')) return 'update';
  if (fp.startsWith('delete')) return 'delete';
  return 'other';
}

/** Find N+1 patterns across all traces in `spans`. */
export function detect(spans: Span[], opts: Options = DEFAULTS): Finding[] {
  const byId = new Map<string, Span>();
  for (const s of spans) byId.set(`${s.traceId}/${s.spanId}`, s);

  interface Group {
    trace: string;
    parent: Span | undefined;
    fp: string;
    stmts: Span[];
    chain: Span[];
  }
  const groups = new Map<string, Group>();
  for (const s of spans) {
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

  const findings = new Map<string, Finding>();
  for (const g of groups.values()) {
    if (g.stmts.length < opts.threshold) continue;
    const service = g.stmts[0]?.service ?? 'unknown';
    const parent = g.parent?.name ?? '(root)';
    const key = createHash('sha256').update(`${service}\0${parent}\0${g.fp}`).digest('hex').slice(0, 16);
    const durations = g.stmts.map(durationMs);
    const total = durations.reduce((a, b) => a + b, 0);
    const saved = total - Math.max(...durations);
    const orm = ormOf(g.chain);
    const kind = kindOf(g.fp);
    const f =
      findings.get(key) ??
      ({
        key,
        service,
        parent,
        fingerprint: g.fp,
        kind,
        orm,
        location: locationOf(g.chain),
        occurrences: [],
        maxCount: 0,
        totalMs: 0,
        estimatedSavedMs: 0,
        examples: [],
        suggestion: suggest(kind, orm, g.fp),
      } satisfies Finding);
    f.occurrences.push({
      traceId: g.trace,
      parentSpanId: g.parent?.spanId ?? '',
      count: g.stmts.length,
      totalMs: total,
    });
    f.maxCount = Math.max(f.maxCount, g.stmts.length);
    f.totalMs += total;
    f.estimatedSavedMs += saved;
    for (const s of g.stmts) {
      const sql = statementOf(s)!;
      if (f.examples.length < 3 && !f.examples.includes(sql)) f.examples.push(sql);
    }
    findings.set(key, f);
  }
  return [...findings.values()].sort((a, b) => b.estimatedSavedMs - a.estimatedSavedMs);
}
