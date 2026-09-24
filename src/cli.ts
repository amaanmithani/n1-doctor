#!/usr/bin/env node
// n1doctor check <traces...> [--threshold N] [--baseline file] [--format text|json|github]
// n1doctor baseline <traces...> --out n1-baseline.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DEFAULTS, detect } from './detect.js';
import { parseTraceFile } from './otlp.js';
import { newFindings, renderGitHub, renderText, toBaseline, type Baseline } from './report.js';

export interface Args {
  cmd: 'check' | 'baseline';
  files: string[];
  threshold: number;
  baseline: string | null;
  out: string;
  format: 'text' | 'json' | 'github';
}

export function parseArgs(argv: string[]): Args {
  const [cmd, ...rest] = argv;
  if (cmd !== 'check' && cmd !== 'baseline')
    throw new Error('usage: n1doctor check|baseline <traces...> [options]');
  const a: Args = {
    cmd,
    files: [],
    threshold: DEFAULTS.threshold,
    baseline: null,
    out: 'n1-baseline.json',
    format: 'text',
  };
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i]!;
    const next = () => {
      const n = rest[++i];
      if (n === undefined) throw new Error(`${v} needs a value`);
      return n;
    };
    if (v === '--threshold') a.threshold = Number(next());
    else if (v === '--baseline') a.baseline = next();
    else if (v === '--out') a.out = next();
    else if (v === '--format') a.format = next() as Args['format'];
    else a.files.push(v);
  }
  if (!a.files.length) throw new Error('no trace files given');
  if (!Number.isInteger(a.threshold) || a.threshold < 2)
    throw new Error('--threshold must be an integer >= 2');
  if (!['text', 'json', 'github'].includes(a.format))
    throw new Error('--format must be text, json or github');
  return a;
}

/** Runs the command; returns the exit code (1 = new N+1s found). */
export function run(a: Args, out: (s: string) => void): number {
  const spans = a.files.flatMap((f) => parseTraceFile(readFileSync(f, 'utf8')));
  const findings = detect(spans, { threshold: a.threshold });
  if (a.cmd === 'baseline') {
    writeFileSync(a.out, JSON.stringify(toBaseline(findings), null, 2) + '\n');
    out(`wrote ${a.out} with ${findings.length} known N+1 pattern(s)\n`);
    return 0;
  }
  const base: Baseline | null =
    a.baseline && existsSync(a.baseline) ? JSON.parse(readFileSync(a.baseline, 'utf8')) : null;
  const fresh = new Set(newFindings(findings, base).map((f) => f.key));
  if (a.format === 'json')
    out(JSON.stringify({ spans: spans.length, findings, new: [...fresh] }, null, 2) + '\n');
  else if (a.format === 'github') out(renderGitHub(findings, fresh) + '\n');
  else out(renderText(findings, fresh));
  return fresh.size > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  try {
    process.exitCode = run(parseArgs(process.argv.slice(2)), (s) => process.stdout.write(s));
  } catch (e) {
    process.stderr.write(`n1doctor: ${(e as Error).message}\n`);
    process.exitCode = 2;
  }
}
