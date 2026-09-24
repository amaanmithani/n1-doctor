import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, run } from '../src/cli.js';
import { q, trace } from './build.js';

describe('cli', () => {
  const dir = mkdtempSync(join(tmpdir(), 'n1-'));
  const file = join(dir, 't.json');
  writeFileSync(
    file,
    JSON.stringify(
      trace({
        name: 'GET /x',
        children: Array.from({ length: 6 }, (_, i) => q(`SELECT * FROM a WHERE id = ${i}`)),
      }),
    ),
  );

  it('fails on new N+1s, passes once baselined', () => {
    let out = '';
    expect(run(parseArgs(['check', file]), (s) => (out += s))).toBe(1);
    expect(out).toContain('NEW N+1');
    const baseline = join(dir, 'b.json');
    expect(run(parseArgs(['baseline', file, '--out', baseline]), () => {})).toBe(0);
    expect(JSON.parse(readFileSync(baseline, 'utf8')).keys).toHaveLength(1);
    expect(
      run(parseArgs(['check', file, '--baseline', baseline, '--format', 'json']), (s) => (out = s)),
    ).toBe(0);
    expect(JSON.parse(out).new).toEqual([]);
    expect(run(parseArgs(['check', file, '--format', 'github', '--threshold', '7']), (s) => (out = s))).toBe(
      0,
    );
  });

  it('validates arguments', () => {
    expect(() => parseArgs(['nope'])).toThrow(/usage/);
    expect(() => parseArgs(['check'])).toThrow(/no trace files/);
    expect(() => parseArgs(['check', file, '--threshold', '1'])).toThrow(/threshold/);
    expect(() => parseArgs(['check', file, '--format', 'xml'])).toThrow(/format/);
    expect(() => parseArgs(['check', file, '--baseline'])).toThrow(/needs a value/);
  });
});
