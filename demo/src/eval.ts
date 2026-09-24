// Ground-truth evaluation: hit every labelled route, capture its trace, run the
// detector, and score it. Then measure latency of each N+1 route against its fix.
import { exporter, toOtlp } from './tracing.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { detect } from '../../src/detect.js';
import { parseExport } from '../../src/otlp.js';

const { app } = await import('./app.js');
const { prisma } = await import('./db.js');
const { seed } = await import('./seed.js');
const clearTags = () => prisma.tag.deleteMany();

interface Route {
  method: 'GET' | 'POST';
  path: string;
  n1: boolean;
  note: string;
  fixOf?: string;
  /** For N+1 routes: the finding must be of this kind and mention this table. */
  expect?: { kind: string; table: string };
  /** Runs before each request, outside timing (e.g. so upserts insert). */
  reset?: () => Promise<unknown>;
}
const ROUTES: Route[] = [
  {
    method: 'GET',
    path: '/feed/n1',
    n1: true,
    note: 'author per post (findUnique in a loop)',
    expect: { kind: 'select', table: '"user"' },
  },
  {
    method: 'GET',
    path: '/users/n1',
    n1: true,
    note: 'post count per user',
    expect: { kind: 'select', table: '"post"' },
  },
  {
    method: 'GET',
    path: '/comments/n1',
    n1: true,
    note: 'author per comment via Promise.all + findFirst (concurrent N+1)',
    expect: { kind: 'select', table: '"user"' },
  },
  {
    method: 'POST',
    path: '/audit/n1',
    n1: true,
    note: 'insert per event',
    expect: { kind: 'insert', table: '"auditlog"' },
  },
  {
    method: 'POST',
    path: '/views/n1',
    n1: true,
    note: 'update per post',
    expect: { kind: 'update', table: '"post"' },
  },
  {
    method: 'POST',
    path: '/tags/n1',
    n1: true,
    note: 'upsert per new tag',
    expect: { kind: 'insert', table: '"tag"' },
    reset: clearTags,
  },
  { method: 'GET', path: '/feed/fixed', n1: false, note: 'include', fixOf: '/feed/n1' },
  { method: 'GET', path: '/users/fixed', n1: false, note: 'groupBy', fixOf: '/users/n1' },
  { method: 'GET', path: '/comments/fixed', n1: false, note: 'DataLoader', fixOf: '/comments/n1' },
  { method: 'POST', path: '/audit/fixed', n1: false, note: 'createMany', fixOf: '/audit/n1' },
  { method: 'POST', path: '/views/fixed', n1: false, note: 'updateMany', fixOf: '/views/n1' },
  {
    method: 'POST',
    path: '/tags/fixed',
    n1: false,
    note: 'createMany skipDuplicates',
    fixOf: '/tags/n1',
    reset: clearTags,
  },
  { method: 'GET', path: '/dashboard', n1: false, note: 'look-alike: 7 different queries' },
  {
    method: 'GET',
    path: '/export',
    n1: false,
    note: 'look-alike: keyset pagination, each page depends on the last',
  },
  { method: 'POST', path: '/publish', n1: false, note: 'look-alike: transaction of distinct statements' },
  { method: 'GET', path: '/by-ids', n1: false, note: 'look-alike: one IN query' },
  {
    method: 'GET',
    path: '/comments/batched',
    n1: false,
    note: 'look-alike: concurrent findUnique, which Prisma batches into one query',
  },
  {
    method: 'GET',
    path: '/pinned',
    n1: true,
    note: 'real N+1 of only 3 iterations: below the default threshold',
  },
];

await seed();
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const call = (r: Route) => fetch(base + r.path, { method: r.method }).then((x) => x.text());
const prepare = async (r: Route) => {
  await r.reset?.();
};

// Warm up connections and Prisma's query plans.
for (const r of ROUTES) {
  await prepare(r);
  await call(r);
}
await new Promise((ok) => setTimeout(ok, 200));
exporter.reset();

// One trace per route.
const traceOf = new Map<string, string>();
for (const r of ROUTES) {
  await prepare(r);
  await new Promise((ok) => setTimeout(ok, 20));
  const before = new Set(exporter.getFinishedSpans().map((s) => s.spanContext().traceId));
  await call(r);
  await new Promise((ok) => setTimeout(ok, 50));
  const t = exporter
    .getFinishedSpans()
    .find((s) => !before.has(s.spanContext().traceId) && s.attributes['http.route'] !== undefined);
  if (!t) throw new Error(`no trace for ${r.path}`);
  traceOf.set(t.spanContext().traceId, r.path);
}
const otlp = toOtlp(exporter.getFinishedSpans());
mkdirSync('../demo/traces', { recursive: true });
writeFileSync('traces/demo.json', JSON.stringify(otlp));
const spans = parseExport(otlp);
const dbSpans = (path: string) =>
  spans.filter(
    (s) =>
      traceOf.get(s.traceId) === path && ('db.query.text' in s.attributes || 'db.statement' in s.attributes),
  ).length;

// Strict scoring: an N+1 route is caught only by a finding of the expected kind on the
// expected table; every other finding, on any route, is a false alarm.
function score(threshold: number) {
  const findings = detect(spans, { threshold });
  const byRoute = new Map<string, typeof findings>();
  for (const f of findings)
    for (const o of f.occurrences) {
      const path = traceOf.get(o.traceId)!;
      byRoute.set(path, [...(byRoute.get(path) ?? []), f]);
    }
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const rows = ROUTES.map((r) => {
    const fs = byRoute.get(r.path) ?? [];
    const right = fs.filter(
      (f) => r.expect && f.kind === r.expect.kind && f.statements.some((st) => st.includes(r.expect!.table)),
    );
    const caught = r.n1 && right.length > 0;
    if (caught) tp++;
    else if (r.n1) fn++;
    else if (!fs.length) tn++;
    fp += fs.length - right.length;
    return {
      path: r.path,
      n1: r.n1,
      flagged: fs.length > 0,
      caught,
      wrongFindings: fs.length - right.length,
    };
  });
  return {
    threshold,
    tp,
    fp,
    fn,
    tn,
    precision: tp / (tp + fp || 1),
    recall: tp / (tp + fn || 1),
    rows,
    findings,
  };
}

const main = score(5);
const sweep = [2, 3, 4, 5, 6, 8, 10, 12, 15].map((t) => {
  const { threshold, tp, fp, fn, precision, recall } = score(t);
  return { threshold, tp, fp, fn, precision, recall };
});

// Latency: N+1 route vs its fix, sequential requests, same process and tracing.
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))]!;
const latency = [];
for (const fix of ROUTES.filter((r) => r.fixOf)) {
  const bad = ROUTES.find((r) => r.path === fix.fixOf)!;
  const t: Record<string, number[]> = { bad: [], fix: [] };
  for (let i = 0; i < 60; i++)
    for (const [k, r] of [
      ['bad', bad],
      ['fix', fix],
    ] as const) {
      await prepare(r);
      const s = performance.now();
      await call(r);
      if (i >= 10) t[k]!.push(performance.now() - s);
    }
  latency.push({
    route: bad.path,
    fix: fix.note,
    queries: { n1: dbSpans(bad.path), fixed: dbSpans(fix.path) },
    p50Ms: { n1: quantile(t.bad!, 0.5), fixed: quantile(t.fix!, 0.5) },
    p95Ms: { n1: quantile(t.bad!, 0.95), fixed: quantile(t.fix!, 0.95) },
  });
}

const out = {
  generatedAt: new Date().toISOString(),
  env: { node: process.version, db: 'PostgreSQL (local, same host)', requestsPerSide: 50 },
  routes: ROUTES.map(({ reset, ...r }) => ({
    ...r,
    dbQueries: dbSpans(r.path),
    resetBetweenRequests: !!reset,
  })),
  main: {
    ...main,
    findings: main.findings.map((f) => ({ ...f, route: traceOf.get(f.occurrences[0]!.traceId) })),
  },
  sweep,
  latency,
};
writeFileSync('../results/eval.json', JSON.stringify(out, null, 2) + '\n');
console.log(
  `threshold 5: P=${main.precision.toFixed(2)} R=${main.recall.toFixed(2)} tp=${main.tp} fp=${main.fp} fn=${main.fn}`,
);
for (const r of main.rows)
  console.log(`${r.n1 ? 'N+1' : '   '} ${r.flagged ? 'FLAG' : '    '} ${r.caught ? 'ok' : '  '} ${r.path}`);
for (const l of latency) console.log(l.route, l.queries, l.p50Ms);
server.close();
await prisma.$disconnect();
