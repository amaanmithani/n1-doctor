// Reading spans from OTLP/JSON (the collector's file exporter and most
// backends' exports use this shape: resourceSpans -> scopeSpans -> spans).

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  startNs: bigint;
  endNs: bigint;
  attributes: Record<string, string | number | boolean>;
  service: string;
}

interface AnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}

interface KeyValue {
  key: string;
  value: AnyValue;
}

interface RawSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string | number;
  endTimeUnixNano: string | number;
  attributes?: KeyValue[];
}

interface ExportRequest {
  resourceSpans?: {
    resource?: { attributes?: KeyValue[] };
    scopeSpans?: { spans?: RawSpan[] }[];
    instrumentationLibrarySpans?: { spans?: RawSpan[] }[]; // pre-1.0 name
  }[];
}

function value(v: AnyValue): string | number | boolean {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return '';
}

function attrs(kvs: KeyValue[] | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const kv of kvs ?? []) out[kv.key] = value(kv.value);
  return out;
}

/** Parse one OTLP/JSON export request. */
export function parseExport(doc: ExportRequest): Span[] {
  const spans: Span[] = [];
  for (const rs of doc.resourceSpans ?? []) {
    const service = String(attrs(rs.resource?.attributes)['service.name'] ?? 'unknown');
    for (const ss of [...(rs.scopeSpans ?? []), ...(rs.instrumentationLibrarySpans ?? [])]) {
      for (const s of ss.spans ?? []) {
        spans.push({
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId ?? '',
          name: s.name,
          startNs: BigInt(s.startTimeUnixNano),
          endNs: BigInt(s.endTimeUnixNano),
          attributes: attrs(s.attributes),
          service,
        });
      }
    }
  }
  return spans;
}

/**
 * Parse a trace file: a single OTLP/JSON document, or JSON Lines of them
 * (the collector's file exporter writes one export request per line).
 */
export function parseTraceFile(text: string): Span[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    return parseExport(JSON.parse(trimmed) as ExportRequest);
  } catch {
    return trimmed
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((l) => parseExport(JSON.parse(l) as ExportRequest));
  }
}

/** The SQL text of a database span, if any (current and older semconv names). */
export function statementOf(s: Span): string | undefined {
  const v = s.attributes['db.query.text'] ?? s.attributes['db.statement'];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export function durationMs(s: Span): number {
  return Number(s.endNs - s.startNs) / 1e6;
}
