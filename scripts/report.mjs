// Renders the results section of README.md from results/eval.json, so every
// number in the README comes from a committed run.
import { execFileSync } from 'node:child_process';
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
    `(${m.tp} caught, ${m.fp} false alarm, ${m.fn} missed). An N+1 counts as caught only if a finding on that ` +
    `route names the expected statement kind and table; any other finding is a false alarm.`,
  '',
  '| Route | Has N+1 | DB queries | Flagged | What it is |',
  '|---|---|---|---|---|',
);
for (const route of r.routes) {
  const row = m.rows.find((x) => x.path === route.path);
  const verdict = route.n1
    ? row.caught
      ? 'yes'
      : row.flagged
        ? '**wrong statement**'
        : '**no (missed)**'
    : row.flagged
      ? '**yes (false alarm)**'
      : 'no';
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

function splice(text, name, body) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i < 0 || j < 0) throw new Error(`README.md has no ${name} markers`);
  return text.slice(0, i + start.length) + '\n' + body + '\n' + text.slice(j);
}

// The sample output is a real CLI run on the committed demo trace.
let sample = '';
try {
  execFileSync('node', ['dist/cli.js', 'check', 'examples/demo-trace.json'], { encoding: 'utf8' });
} catch (e) {
  sample = e.stdout;
}
let readme = readFileSync('README.md', 'utf8');
readme = splice(
  readme,
  'sample',
  '```\n$ n1doctor check examples/demo-trace.json\n' + sample.split('\n\n')[0] + '\n```',
);
readme = splice(readme, 'results', lines.join('\n'));
writeFileSync('README.md', readme);
