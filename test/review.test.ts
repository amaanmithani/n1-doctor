// Regression tests for the adversarial review findings.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, run } from '../src/cli.js';
import { detect } from '../src/detect.js';
import { parseExport, parseTraceFile } from '../src/otlp.js';
import { newFindings, renderGitHub, toBaseline } from '../src/report.js';
import { q, trace, type SpanSpec } from './build.js';

const loop = (n: number, sql: (i: number) => string): SpanSpec[] =>
  Array.from({ length: n }, (_, i) => q(sql(i)));
const handler = (children: SpanSpec[]) => trace({ name: 'POST /tags', children });
const upserts = (selects: number, inserts: number) =>
  handler([
    ...loop(selects, (i) => `SELECT id FROM tag WHERE name = 't${i}'`),
    ...loop(inserts, (i) => `INSERT INTO tag (name) VALUES ('t${i}')`),
  ]);

describe('review fixes', () => {
  it('baseline keys survive a loop body whose statement mix changes with the data', () => {
    const base = toBaseline(detect(parseExport(upserts(8, 8))));
    const later = detect(parseExport(upserts(8, 6)));
    expect(later).toHaveLength(2);
    expect(newFindings(later, base)).toEqual([]);
  });

  it('counts a span once even if it is read twice', () => {
    const t = handler(loop(3, (i) => `SELECT * FROM a WHERE id = ${i}`));
    expect(detect([...parseExport(t), ...parseExport(t)])).toEqual([]);
  });

  it('estimates savings from wall time, so concurrent loops are not overstated', () => {
    const t = handler(loop(10, (i) => `SELECT * FROM a WHERE id = ${i}`));
    const spans = parseExport(t);
    // Make every statement start at the same instant and take 5 ms.
    for (const s of spans.filter((x) => x.name === 'pg.query')) {
      s.startNs = 0n;
      s.endNs = 5_000_000n;
    }
    const [f] = detect(spans);
    expect(f!.totalMs).toBeCloseTo(50, 5);
    expect(f!.estimatedSavedMs).toBeCloseTo(0, 5);
  });

  it('handles very large loops', () => {
    const t = handler(loop(200_000, (i) => `SELECT * FROM a WHERE id = ${i}`));
    expect(detect(parseExport(t))[0]!.maxCount).toBe(200_000);
  });

  it('does not ignore PL/SQL blocks or mistake casts for parameters', () => {
    expect(detect(parseExport(handler(loop(6, (i) => `BEGIN refresh_row(${i}); END;`))))).toHaveLength(1);
    const casts = ['int', 'text', 'uuid', 'jsonb', 'date'].map((t) => q(`SELECT val::${t} FROM a`));
    expect(detect(parseExport(handler(casts)))).toEqual([]);
    expect(detect(parseExport(handler(loop(6, () => 'START TRANSACTION'))))).toEqual([]);
  });

  it('rejects files that are not OTLP and tolerates a truncated last line', () => {
    expect(() => parseTraceFile(JSON.stringify({ data: [] }))).toThrow(/resourceSpans/);
    const line = JSON.stringify(handler(loop(5, (i) => `SELECT * FROM a WHERE id = ${i}`)));
    const warnings: string[] = [];
    const spans = parseTraceFile(`${line}\n${line.slice(0, 40)}`, (w) => warnings.push(w));
    expect(spans.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/line 2/);
    expect(() => parseTraceFile(`${line.slice(0, 40)}\n${line}`)).toThrow(/line 1/);
    expect(() => parseTraceFile(`${line}\n{"x":1}`)).toThrow(/line 2: not an OTLP/);
  });

  it('parses fractional and oversized numbers without throwing', () => {
    const doc = handler([q('SELECT 1 FROM a')]) as {
      resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    const s = doc.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    s.startTimeUnixNano = 1.5e18;
    s.endTimeUnixNano = '1500000000000000000.7';
    (s.attributes as unknown[]).push({ key: 'big', value: { intValue: '9007199254740993' } });
    const [a] = parseExport(doc as never);
    expect(a!.startNs).toBe(1500000000000000000n);
    expect(a!.attributes['big']).toBe('9007199254740993');
  });

  it('escapes annotation property values', () => {
    const t = trace({
      name: 'GET /x',
      attrs: { 'code.filepath': 'src/a,b:c.ts', 'code.lineno': 12 },
      children: loop(5, (i) => `SELECT * FROM a WHERE id = ${i}`),
    });
    expect(renderGitHub(detect(parseExport(t)), new Set())).toContain('file=src/a%2Cb%3Ac.ts,line=12,');
  });

  it('cli: exit 2 conditions surface as errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'n1r-'));
    const empty = join(dir, 'e.json');
    writeFileSync(empty, JSON.stringify({ resourceSpans: [] }));
    expect(() => run(parseArgs(['check', empty]), () => {})).toThrow(/no spans/);
    const ok = join(dir, 'ok.json');
    writeFileSync(ok, JSON.stringify(handler([q('SELECT 1 FROM a')])));
    expect(() => run(parseArgs(['check', ok, '--baseline', join(dir, 'missing.json')]), () => {})).toThrow(
      /ENOENT/,
    );
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"resourceSpans": [}');
    expect(() => run(parseArgs(['check', bad]), () => {})).toThrow(/bad\.json: line 1/);
  });
});
