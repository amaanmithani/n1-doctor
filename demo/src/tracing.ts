// OpenTelemetry setup for the demo: HTTP + Express + Prisma instrumentation,
// spans kept in memory and written out as OTLP/JSON (the same shape the
// collector's file exporter produces), which is what n1doctor reads.
import { register } from 'node:module';
import { trace } from '@opentelemetry/api';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';

// ESM modules (express, node:http) are only patchable through the loader hook;
// app code must be imported after this module.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url, {
  data: { include: ['express', 'http', 'node:http'] },
});

export const exporter = new InMemorySpanExporter();

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ 'service.name': 'blog-api' }),
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();
registerInstrumentations({
  tracerProvider: provider,
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation(), new PrismaInstrumentation()],
});

const root = fileURLToPath(new URL('../..', import.meta.url));

/** Record the calling source location on the active span (code.* semconv),
 * so findings point at the handler that loops. */
export function here(): void {
  const frame = new Error().stack?.split('\n')[2] ?? '';
  const m =
    /\((?:file:\/\/)?(.+?):(\d+):\d+\)$/.exec(frame) ?? /at (?:file:\/\/)?(.+?):(\d+):\d+$/.exec(frame);
  const span = trace.getActiveSpan();
  if (m?.[1] && span)
    span.setAttributes({ 'code.filepath': relative(root, m[1]), 'code.lineno': Number(m[2]) });
}

const hex = (t: [number, number]) => String(BigInt(t[0]) * 1_000_000_000n + BigInt(t[1]));

interface KeyValue {
  key: string;
  value: { stringValue?: string; boolValue?: boolean; intValue?: string; doubleValue?: number };
}

function kv(attrs: ReadableSpan['attributes']): KeyValue[] {
  return Object.entries(attrs).flatMap(([key, v]): KeyValue[] => {
    if (typeof v === 'string') return [{ key, value: { stringValue: v } }];
    if (typeof v === 'boolean') return [{ key, value: { boolValue: v } }];
    if (typeof v === 'number')
      return [{ key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } }];
    return [];
  });
}

/** Finished spans as one OTLP/JSON ExportTraceServiceRequest. */
export function toOtlp(spans: ReadableSpan[]) {
  return {
    resourceSpans: [
      {
        resource: { attributes: kv(spans[0]?.resource.attributes ?? {}) },
        scopeSpans: [
          {
            spans: spans.map((s) => ({
              traceId: s.spanContext().traceId,
              spanId: s.spanContext().spanId,
              parentSpanId: s.parentSpanContext?.spanId ?? '',
              name: s.name,
              startTimeUnixNano: hex(s.startTime),
              endTimeUnixNano: hex(s.endTime),
              attributes: kv(s.attributes),
            })),
          },
        ],
      },
    ],
  };
}
