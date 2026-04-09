// NOS Town — Trace Context Propagation
// Per OBSERVABILITY.md §2: every convoy carries trace_id + parent_span_id.
// Uses @opentelemetry/api tracer (no-op by default; wire SDK in production).

import { trace, SpanStatusCode } from '@opentelemetry/api';
import { v4 as uuidv4 } from 'uuid';

export interface TraceContext {
  trace_id: string;
  parent_span_id?: string;
}

const tracer = trace.getTracer('nos-town', '0.1.0');

/**
 * Generate a new root trace context (Mayor Plan span).
 */
export function newTraceContext(): TraceContext {
  return { trace_id: uuidv4().replace(/-/g, '') };
}

/**
 * Extract trace context from a convoy header.
 * Falls back to a new context if header has no trace_id.
 */
export function extractTraceContext(header: {
  trace_id?: string;
  parent_span_id?: string;
}): TraceContext {
  return {
    trace_id: header.trace_id ?? newTraceContext().trace_id,
    parent_span_id: header.parent_span_id,
  };
}

/**
 * Run an async operation inside a named OTel span.
 * Span attributes include trace_id for correlation with convoy log entries.
 */
export async function withSpan<T>(
  spanName: string,
  traceCtx: TraceContext,
  fn: () => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(spanName);
  span.setAttribute('nos.trace_id', traceCtx.trace_id);
  if (traceCtx.parent_span_id) {
    span.setAttribute('nos.parent_span_id', traceCtx.parent_span_id);
  }

  try {
    const result = await fn();
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    span.recordException(err as Parameters<typeof span.recordException>[0]);
    throw err;
  } finally {
    span.end();
  }
}
