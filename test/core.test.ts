import { describe, expect, it } from 'vitest';
import { detect } from '../src/detect.js';
import { fingerprint, looksLikePointQuery } from '../src/fingerprint.js';
import { parseExport, parseTraceFile, statementOf } from '../src/otlp.js';
import { newFindings, renderGitHub, renderText, toBaseline } from '../src/report.js';
import { suggest } from '../src/suggest.js';
import { prisma, q, trace } from './build.js';

describe('fingerprint', () => {
  it('abstracts literals and parameters', () => {
    const a = fingerprint(`SELECT * FROM "Post" WHERE "authorId" = 42 AND title = 'it''s'`);
    const b = fingerprint(`select *  from "Post" where "authorId" = 7 and title = 'x' -- trailing`);
    expect(a).toBe(b);
    expect(fingerprint('SELECT * FROM t WHERE id = $1')).toBe(fingerprint('SELECT * FROM t WHERE id = :id'));
    expect(fingerprint('SELECT * FROM t WHERE id = @p1 AND ok = true AND x IS NULL')).toBe(
      'select * from t where id = ? and ok = ? and x is ?',
    );
  });
  it('collapses IN lists and VALUES of any length, keeps identifiers with digits', () => {
    expect(fingerprint('SELECT * FROM t WHERE id IN (1, 2, 3)')).toBe(
      fingerprint('SELECT * FROM t WHERE id IN ($1)'),
    );
    expect(fingerprint('INSERT INTO t VALUES (1, 2), (3, 4), (5, 6)')).toBe(
      fingerprint('insert into t values (?, ?)'),
    );
    expect(fingerprint('SELECT col1 FROM t2 /* hint */ WHERE 1 = 1')).toBe('select col1 from t2 where ? = ?');
  });
  it('recognises point queries', () => {
    expect(looksLikePointQuery(fingerprint('SELECT * FROM t WHERE id = 5'))).toBe(true);
    expect(looksLikePointQuery(fingerprint('SELECT * FROM t WHERE id IN (5, 6)'))).toBe(false);
  });
});

describe('detect', () => {
  const handler = (children: ReturnType<typeof q>[]) =>
    trace({
      name: 'GET /posts',
      attrs: { 'code.filepath': 'src/routes.ts', 'code.lineno': 12, 'code.function': 'listPosts' },
      children,
    });

  it('flags a classic N+1 and points at the handler', () => {
    const t = handler([
      q('SELECT * FROM posts'),
      ...Array.from({ length: 8 }, (_, i) => q(`SELECT * FROM users WHERE id = ${i}`, 3)),
    ]);
    const [f, ...rest] = detect(parseExport(t));
    expect(rest).toHaveLength(0);
    expect(f!.maxCount).toBe(8);
    expect(f!.kind).toBe('select');
    expect(f!.parent).toBe('GET /posts');
    expect(f!.location).toBe('src/routes.ts:12 (listPosts)');
    expect(f!.estimatedSavedMs).toBeCloseTo(21, 5);
    expect(f!.examples).toHaveLength(3);
    expect(f!.suggestion).toContain('ANY($1)');
  });

  it('sees through ORM wrapper spans (Prisma)', () => {
    const t = trace({
      name: 'GET /feed',
      children: Array.from({ length: 6 }, (_, i) =>
        prisma(`SELECT "User".* FROM "User" WHERE "id" = $1 /* ${i} */`),
      ),
    });
    const [f] = detect(parseExport(t));
    expect(f?.orm).toBe('prisma');
    expect(f?.parent).toBe('GET /feed');
    expect(f?.suggestion).toContain('findMany');
  });

  it('does not flag look-alikes', () => {
    const distinct = handler(
      Array.from({ length: 10 }, (_, i) => q(`SELECT * FROM table_${String.fromCharCode(97 + i)}`)),
    );
    const underThreshold = handler(
      Array.from({ length: 4 }, (_, i) => q(`SELECT * FROM users WHERE id = ${i}`)),
    );
    const txn = handler([
      ...Array.from({ length: 10 }, () => q('BEGIN')),
      ...Array.from({ length: 10 }, () => q('COMMIT')),
    ]);
    const batched = handler([q('SELECT * FROM users WHERE id IN (1,2,3,4,5,6,7,8)')]);
    for (const t of [distinct, underThreshold, txn, batched]) expect(detect(parseExport(t))).toEqual([]);
  });

  it('separates parents and merges the same pattern across traces', () => {
    const a = handler(Array.from({ length: 5 }, (_, i) => q(`SELECT * FROM users WHERE id = ${i}`)));
    const b = handler(Array.from({ length: 7 }, (_, i) => q(`SELECT * FROM users WHERE id = ${i}`)));
    const other = trace({
      name: 'GET /users',
      children: Array.from({ length: 5 }, (_, i) => q(`SELECT * FROM users WHERE id = ${i}`)),
    });
    const fs = detect([...parseExport(a), ...parseExport(b), ...parseExport(other)]);
    expect(fs).toHaveLength(2);
    const posts = fs.find((f) => f.parent === 'GET /posts')!;
    expect(posts.occurrences).toHaveLength(2);
    expect(posts.maxCount).toBe(7);
  });

  it('classifies writes and suggests batching', () => {
    const ins = handler(Array.from({ length: 5 }, (_, i) => q(`INSERT INTO log (msg) VALUES ('m${i}')`)));
    expect(detect(parseExport(ins))[0]?.kind).toBe('insert');
    expect(suggest('insert', 'prisma', '')).toContain('createMany');
    expect(suggest('update', null, '')).toContain('UPDATE');
    expect(suggest('delete', 'prisma', '')).toContain('deleteMany');
    expect(suggest('update', 'prisma', '')).toContain('updateMany');
    expect(suggest('delete', null, '')).toContain('ANY');
    expect(suggest('other', null, '')).toContain('Batch');
    expect(suggest('insert', null, '')).toContain('multi-row');
  });
});

describe('otlp', () => {
  it('parses JSON Lines, old field names and value types', () => {
    const doc = {
      resourceSpans: [
        {
          instrumentationLibrarySpans: [
            {
              spans: [
                {
                  traceId: 't',
                  spanId: 's',
                  name: 'x',
                  startTimeUnixNano: 1,
                  endTimeUnixNano: 2,
                  attributes: [
                    { key: 'db.statement', value: { stringValue: 'SELECT 1' } },
                    { key: 'n', value: { doubleValue: 1.5 } },
                    { key: 'b', value: { boolValue: true } },
                    { key: 'e', value: {} },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const spans = parseTraceFile(`${JSON.stringify(doc)}\n${JSON.stringify(doc)}\n`);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.service).toBe('unknown');
    expect(statementOf(spans[0]!)).toBe('SELECT 1');
    expect(spans[0]!.attributes).toMatchObject({ n: 1.5, b: true, e: '' });
    expect(parseTraceFile('  ')).toEqual([]);
  });
});

describe('report', () => {
  const t = trace({
    name: 'GET /posts',
    attrs: { 'code.filepath': 'src/a.ts', 'code.lineno': 3 },
    children: Array.from({ length: 5 }, (_, i) => q(`SELECT * FROM u WHERE id = ${i}`)),
  });
  const findings = detect(parseExport(t));
  it('baselines and diffs', () => {
    const base = toBaseline(findings);
    expect(newFindings(findings, base)).toEqual([]);
    expect(newFindings(findings, null)).toHaveLength(1);
  });
  it('renders text and GitHub annotations', () => {
    const fresh = new Set(findings.map((f) => f.key));
    expect(renderText(findings, fresh)).toContain('NEW N+1 in api › GET /posts');
    expect(renderText([], fresh)).toContain('No N+1');
    expect(renderGitHub(findings, fresh)).toMatch(
      /^::error file=src\/a.ts,line=3,title=N\+1 query::select repeated/,
    );
    expect(renderGitHub(findings, new Set())).toMatch(/^::warning /);
  });
});

describe('loop bodies', () => {
  it('reports statements repeated together as one finding', () => {
    const upserts = Array.from({ length: 6 }, (_, i) => [
      q(`SELECT id FROM tag WHERE name = 't${i}'`),
      q(`INSERT INTO tag (name) VALUES ('t${i}')`),
    ]).flat();
    const [f, ...rest] = detect(parseExport(trace({ name: 'POST /tags', children: upserts })));
    expect(rest).toEqual([]);
    expect(f!.statements).toEqual([
      'select id from tag where name = ?',
      'insert into tag (name) values (?+)',
    ]);
    expect(f!.kind).toBe('insert');
    expect(f!.suggestion).toContain('multi-row');
    expect(renderText([f!], new Set())).toContain('insert into tag');
  });
  it('keeps loops with different counts apart', () => {
    const kids = [
      ...Array.from({ length: 6 }, (_, i) => q(`SELECT * FROM a WHERE id = ${i}`)),
      ...Array.from({ length: 9 }, (_, i) => q(`SELECT * FROM b WHERE id = ${i}`)),
    ];
    expect(detect(parseExport(trace({ name: 'GET /x', children: kids })))).toHaveLength(2);
  });
});
