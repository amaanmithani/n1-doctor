// Renders the results section of README.md from results/eval.json, so every
// number in the README comes from a committed run.
import { readFileSync, writeFileSync } from 'node:fs';

const r = JSON.parse(readFileSync('results/eval.json', 'utf8'));
const pct = (x) => `${Math.round(x * 100)}%`;
const m = r.main;
const lines = [];
lines.push(
  `Ground truth: ${r.routes.length} routes of a Prisma 7 + Express 5 + PostgreSQL app (\`demo/\`), ` +
    `${r.routes.filter((x) => x.n1).length} with a real N+1 and ${r.routes.filter((x) => !x.n1).length} without. ` +
    `One request per route, traced with the stock OpenTelemetry HTTP/Express/Prisma instrumentations.`,
  '',
  `At the default threshold (${m.threshold}): **precision ${pct(m.precision)}, recall ${pct(m.recall)}** ` +
    `(${m.tp} caught, ${m.fp} false alarm, ${m.fn} missed).`,
  '',
  '| Route | Has N+1 | DB queries | Flagged | What it is |',
  '|---|---|---|---|---|',
);
for (const route of r.routes) {
  const row = m.rows.find((x) => x.path === route.path);
  const verdict =
    row.flagged === route.n1
      ? row.flagged
        ? 'yes'
        : 'no'
      : row.flagged
        ? '**yes (false alarm)**'
        : '**no (missed)**';
  lines.push(
    `| \`${route.method} ${route.path}\` | ${route.n1 ? 'yes' : 'no'} | ${route.dbQueries} | ${verdict} | ${route.note} |`,
  );
}
lines.push(
  '',
  'Threshold sweep (same traces):',
  '',
  '| Threshold | Precision | Recall | Caught | False alarms | Missed |',
  '|---|---|---|---|---|---|',
);
for (const s of r.sweep)
  lines.push(`| ${s.threshold} | ${pct(s.precision)} | ${pct(s.recall)} | ${s.tp} | ${s.fp} | ${s.fn} |`);
lines.push(
  '',
  `Latency of each N+1 route against its fix: ${r.env.requestsPerSide} sequential requests per side after warm-up, ` +
    `Node ${r.env.node}, ${r.env.db}. Round trips here cost well under a millisecond; over a network they cost more, so these are lower bounds.`,
  '',
  '| Route | Fix | Queries (N+1 → fixed) | p50 ms | p95 ms |',
  '|---|---|---|---|---|',
);
const f1 = (x) => x.toFixed(1);
for (const l of r.latency)
  lines.push(
    `| \`${l.route}\` | ${l.fix} | ${l.queries.n1} → ${l.queries.fixed} | ${f1(l.p50Ms.n1)} → ${f1(l.p50Ms.fixed)} | ${f1(l.p95Ms.n1)} → ${f1(l.p95Ms.fixed)} |`,
  );

const readme = readFileSync('README.md', 'utf8');
const start = '<!-- results:start -->';
const end = '<!-- results:end -->';
const i = readme.indexOf(start);
const j = readme.indexOf(end);
if (i < 0 || j < 0) throw new Error('README.md has no results markers');
writeFileSync(
  'README.md',
  readme.slice(0, i + start.length) + '\n' + lines.join('\n') + '\n' + readme.slice(j),
);
