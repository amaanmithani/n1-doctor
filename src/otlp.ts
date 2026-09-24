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
  if (v.intValue !== undefined) {
    const n = Number(v.intValue);
    return Number.isSafeInteger(n) ? n : String(v.intValue);
  }
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return '';
}

function attrs(kvs: KeyValue[] | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const kv of kvs ?? []) out[kv.key] = value(kv.value);
  return out;
}

function nanos(v: string | number | undefined): bigint {
  if (typeof v === 'number') return BigInt(Math.round(v));
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
    return BigInt(Math.round(Number(v)));
  return 0n;
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
          startNs: nanos(s.startTimeUnixNano),
          endNs: nanos(s.endTimeUnixNano),
          attributes: attrs(s.attributes),
          service,
        });
      }
    }
  }
  return spans;
}

function isExport(doc: unknown): doc is ExportRequest {
  return typeof doc === 'object' && doc !== null && Array.isArray((doc as ExportRequest).resourceSpans);
}

/**
 * Parse a trace file: a single OTLP/JSON document, or JSON Lines of them
 * (the collector's file exporter writes one export request per line). A cut-off
 * last line, common when the collector is still writing, is skipped with a warning.
 */
export function parseTraceFile(text: string, warn: (msg: string) => void = () => {}): Span[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let whole: unknown;
  try {
    whole = JSON.parse(trimmed);
  } catch {
    whole = undefined;
  }
  if (whole !== undefined) {
    if (!isExport(whole)) throw new Error('not an OTLP/JSON trace export (no resourceSpans)');
    return parseExport(whole);
  }
  const lines = trimmed.split('\n');
  const spans: Span[] = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let doc: unknown;
    try {
      doc = JSON.parse(line);
    } catch (e) {
      if (i === lines.length - 1 && i > 0) {
        warn(`skipped truncated last line ${i + 1}`);
        return;
      }
      throw new Error(`line ${i + 1}: ${(e as Error).message}`, { cause: e });
    }
    if (!isExport(doc)) throw new Error(`line ${i + 1}: not an OTLP/JSON trace export (no resourceSpans)`);
    spans.push(...parseExport(doc));
  });
  return spans;
}

/** The SQL text of a database span, if any (current and older semconv names). */
export function statementOf(s: Span): string | undefined {
  const v = s.attributes['db.query.text'] ?? s.attributes['db.statement'];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export function durationMs(s: Span): number {
  return Number(s.endNs - s.startNs) / 1e6;
}
