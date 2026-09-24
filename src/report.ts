import type { Finding } from './detect.js';

export interface Baseline {
  version: 1;
  keys: string[];
}

export function newFindings(findings: Finding[], baseline: Baseline | null): Finding[] {
  const known = new Set(baseline?.keys ?? []);
  return findings.filter((f) => f.keys.some((k) => !known.has(k)));
}

export function toBaseline(findings: Finding[]): Baseline {
  return { version: 1, keys: [...new Set(findings.flatMap((f) => f.keys))].sort() };
}

const ms = (n: number) => `${n.toFixed(1)} ms`;

export function renderText(findings: Finding[], fresh: Set<string>): string {
  if (!findings.length) return 'No N+1 query patterns found.\n';
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(
      `${fresh.has(f.key) ? 'NEW ' : ''}N+1 in ${f.service} › ${f.parent}: ${f.kind} repeated up to ${f.maxCount}× ` +
        `(${f.occurrences.length} trace${f.occurrences.length === 1 ? '' : 's'}, ${ms(f.totalMs)} total, ` +
        `~${ms(f.estimatedSavedMs)} avoidable)`,
      ...f.statements.map((fp, i) => `  ${i ? '          ' : 'query:    '}${fp}`),
      ...(f.location ? [`  where:    ${f.location}`] : []),
      ...(f.orm ? [`  via:      ${f.orm}`] : []),
      `  fix:      ${f.suggestion}`,
      `  key:      ${f.keys.join(' ')}`,
      '',
    );
  }
  return lines.join('\n');
}

/** GitHub Actions workflow commands, so findings show up as annotations:
 * ::error file=src/app.ts,line=42,title=N+1 query::message */
export function renderGitHub(findings: Finding[], fresh: Set<string>): string {
  return findings
    .map((f) => {
      const level = fresh.has(f.key) ? 'error' : 'warning';
      const loc = f.location?.match(/^(.+?):(\d+)/);
      const props = [...(loc ? [`file=${prop(loc[1]!)}`, `line=${loc[2]}`] : []), 'title=N+1 query'].join(
        ',',
      );
      const msg = `${f.kind} repeated up to ${f.maxCount}x in ${f.parent}: ${f.fingerprint}. Fix: ${f.suggestion}`;
      return `::${level} ${props}::${esc(msg)}`;
    })
    .join('\n');
}

// Workflow-command escaping: data needs %, CR, LF; property values also : and ,.
function prop(s: string): string {
  return esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function esc(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
