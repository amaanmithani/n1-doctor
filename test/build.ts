// Builds OTLP/JSON export requests for tests.
let n = 0;
const id = () => (++n).toString(16).padStart(16, '0');

export interface SpanSpec {
  name: string;
  sql?: string;
  ms?: number;
  attrs?: Record<string, string | number>;
  children?: SpanSpec[];
}

export function trace(root: SpanSpec, service = 'api') {
  const traceId = id().padStart(32, '0');
  const spans: {
    traceId: string;
    spanId: string;
    parentSpanId: string;
    name: string;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    attributes: { key: string; value: { intValue: string } | { stringValue: string } }[];
  }[] = [];
  let t = 1_000_000_000n;
  const walk = (s: SpanSpec, parent: string) => {
    const spanId = id();
    const start = t;
    const dur = BigInt(Math.round((s.ms ?? 1) * 1e6));
    t += dur;
    const attributes = Object.entries({
      ...(s.attrs ?? {}),
      ...(s.sql ? { 'db.query.text': s.sql, 'db.system': 'postgresql' } : {}),
    }).map(([key, v]) => ({
      key,
      value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v },
    }));
    spans.push({
      traceId,
      spanId,
      parentSpanId: parent,
      name: s.name,
      startTimeUnixNano: String(start),
      endTimeUnixNano: String(start + dur),
      attributes,
    });
    for (const c of s.children ?? []) walk(c, spanId);
  };
  walk(root, '');
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeSpans: [{ spans }],
      },
    ],
  };
}

export const q = (sql: string, ms = 2): SpanSpec => ({ name: 'pg.query', sql, ms });

/** A Prisma-style query: client op -> engine query -> db query span. */
export const prisma = (sql: string, ms = 2): SpanSpec => ({
  name: 'prisma:client:operation',
  children: [{ name: 'prisma:engine:query', children: [{ name: 'prisma:engine:db_query', sql, ms }] }],
});
