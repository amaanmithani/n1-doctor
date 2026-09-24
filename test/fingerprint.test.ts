import { describe, expect, it } from 'vitest';
import { fingerprint as fp } from '../src/fingerprint.js';

const same = (a: string, b: string) => expect(fp(a)).toBe(fp(b));
const differ = (a: string, b: string) => expect(fp(a)).not.toBe(fp(b));

describe('fingerprint lexer', () => {
  it('does not treat comment markers inside strings as comments', () => {
    same(`SELECT * FROM a WHERE slug = 'u1--x' AND id = 1`, `SELECT * FROM a WHERE slug = 'u2' AND id = 2`);
    differ(
      `SELECT * FROM a WHERE note = '--' AND id = 1`,
      `SELECT * FROM a WHERE note = '--' OR drop_everything = 1`,
    );
    same(
      `SELECT 1 FROM a WHERE x = '/* not a comment */' AND y = 2`,
      `SELECT 1 FROM a WHERE x = 'z' AND y = 3`,
    );
  });
  it('handles every string form', () => {
    same(`SELECT * FROM t WHERE v = $$v1$$`, `SELECT * FROM t WHERE v = $tag$it's$tag$`);
    same(`SELECT * FROM t WHERE n = 'O\\'Brien1'`, `SELECT * FROM t WHERE n = 'x'`);
    same(`SELECT * FROM t WHERE n = E'a\\'b'`, `SELECT * FROM t WHERE n = 'c'`);
    same(`SELECT * FROM t WHERE n = N'ü'`, `SELECT * FROM t WHERE n = 'u'`);
    same(`SELECT * FROM t WHERE n = 'it''s'`, `SELECT * FROM t WHERE n = 'x'`);
  });
  it('keeps casts and quoted identifiers', () => {
    differ(`SELECT val::int FROM t`, `SELECT val::text FROM t`);
    same(`SELECT a::text FROM t`, `SELECT a :: text FROM t`);
    same(`SELECT "Col?1" FROM "T" WHERE id = 1`, `select "col?1" from "t" where id = 9`);
    expect(fp(`SELECT @@version, @p1`)).toBe('select @@version, ?');
  });
  it('normalises numbers', () => {
    same(`SELECT * FROM t WHERE x = .5`, `SELECT * FROM t WHERE x = 7`);
    same(`SELECT * FROM t WHERE x = -1.5e3`, `SELECT * FROM t WHERE x = 2`);
    same(`SELECT * FROM t WHERE x > 0x1f`, `SELECT * FROM t WHERE x > 3`);
    expect(fp(`SELECT a - 1 FROM t2`)).toBe('select a - ? from t2');
    expect(fp(`SELECT col1 FROM t2`)).toBe('select col1 from t2');
  });
  it('collapses lists of any length', () => {
    same(`SELECT * FROM t WHERE id = ANY(ARRAY[1, 2, 3])`, `SELECT * FROM t WHERE id = ANY(ARRAY[4])`);
    same(`INSERT INTO t (a, b) VALUES (1, now()), (2, now())`, `INSERT INTO t (a, b) VALUES (3, now())`);
    same(`INSERT INTO t VALUES (1, 2), (3, 4)`, `INSERT INTO t VALUES ($1, $2)`);
    same(
      `SELECT * FROM t WHERE id IN (SELECT id FROM u WHERE k = 1)`,
      `SELECT * FROM t WHERE id IN (SELECT id FROM u WHERE k = 2)`,
    );
  });
  it('never throws on unterminated input', () => {
    for (const s of [
      `SELECT 'abc`,
      'SELECT "abc',
      'SELECT /* x',
      'SELECT $$x',
      "SELECT E'\\",
      'SELECT $a',
      '@',
      ':',
    ])
      expect(typeof fp(s)).toBe('string');
  });
});
