// Tests: Telemetry — metrics instruments, structured logger, trace context (OBSERVABILITY.md)

import { structuredLog, createLogger } from '../../src/telemetry/logger';
import { newTraceContext, extractTraceContext, withSpan } from '../../src/telemetry/tracer';
import {
  beadThroughput,
  groqApiErrors,
  convoyDeliveryFailure,
  convoyAuthzDenied,
  beadLatencyMs,
  safeguardScanLatencyMs,
  ledgerLockWaitMs,
} from '../../src/telemetry/metrics';

describe('Structured Logger', () => {
  let output: string;
  let origWrite: typeof process.stdout.write;

  beforeEach(() => {
    output = '';
    origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      output += String(chunk);
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = origWrite;
  });

  it('writes valid JSON to stdout', () => {
    structuredLog({
      level: 'INFO',
      role: 'polecat',
      agent_id: 'polecat_01',
      event: 'BEAD_STARTED',
      bead_id: 'bead-001',
      message: 'Starting task',
    });

    expect(output.trimEnd()).not.toBe('');
    const parsed = JSON.parse(output.trimEnd());
    expect(parsed.level).toBe('INFO');
    expect(parsed.role).toBe('polecat');
    expect(parsed.agent_id).toBe('polecat_01');
    expect(parsed.event).toBe('BEAD_STARTED');
    expect(parsed.bead_id).toBe('bead-001');
    expect(typeof parsed.timestamp).toBe('string');
    // timestamp is ISO 8601
    expect(() => new Date(parsed.timestamp)).not.toThrow();
  });

  it('bound logger pre-fills role and agent_id', () => {
    const log = createLogger('witness', 'witness_01');
    log('WARN', 'REVIEW_VERDICT', 'Rejected — quality below threshold', { pr_id: 'pr-123' });

    const parsed = JSON.parse(output.trimEnd());
    expect(parsed.role).toBe('witness');
    expect(parsed.agent_id).toBe('witness_01');
    expect(parsed.level).toBe('WARN');
    expect(parsed.pr_id).toBe('pr-123');
  });

  it('includes arbitrary extra fields', () => {
    structuredLog({
      level: 'ERROR',
      role: 'mayor',
      agent_id: 'mayor_01',
      event: 'CHECKPOINT_FAILED',
      message: 'Dispatch blocked',
      checkpoint_id: 'ckpt-xyz',
      task_type: 'implement',
    });

    const parsed = JSON.parse(output.trimEnd());
    expect(parsed.checkpoint_id).toBe('ckpt-xyz');
    expect(parsed.task_type).toBe('implement');
  });
});

describe('Trace Context', () => {
  it('newTraceContext generates a non-empty trace_id', () => {
    const ctx = newTraceContext();
    expect(typeof ctx.trace_id).toBe('string');
    expect(ctx.trace_id.length).toBeGreaterThan(0);
    expect(ctx.parent_span_id).toBeUndefined();
  });

  it('two calls produce distinct trace_ids', () => {
    const a = newTraceContext();
    const b = newTraceContext();
    expect(a.trace_id).not.toBe(b.trace_id);
  });

  it('extractTraceContext preserves trace_id from header', () => {
    const ctx = extractTraceContext({ trace_id: 'abc123', parent_span_id: 'span01' });
    expect(ctx.trace_id).toBe('abc123');
    expect(ctx.parent_span_id).toBe('span01');
  });

  it('extractTraceContext generates trace_id when header has none', () => {
    const ctx = extractTraceContext({});
    expect(typeof ctx.trace_id).toBe('string');
    expect(ctx.trace_id.length).toBeGreaterThan(0);
  });

  it('withSpan executes the wrapped function and returns result', async () => {
    const ctx = newTraceContext();
    const result = await withSpan('test-span', ctx, async () => 42);
    expect(result).toBe(42);
  });

  it('withSpan re-throws errors from the wrapped function', async () => {
    const ctx = newTraceContext();
    await expect(
      withSpan('failing-span', ctx, async () => { throw new Error('test error'); }),
    ).rejects.toThrow('test error');
  });
});

describe('Metrics instruments', () => {
  it('counters can be incremented without throwing', () => {
    expect(() => beadThroughput.add(1, { role: 'polecat' })).not.toThrow();
    expect(() => groqApiErrors.add(1, { model: 'llama-3.1-8b', type: '429' })).not.toThrow();
    expect(() => convoyDeliveryFailure.add(1, { sender: 'mayor_01' })).not.toThrow();
    expect(() => convoyAuthzDenied.add(1, { sender: 'polecat_01' })).not.toThrow();
  });

  it('histograms can record values without throwing', () => {
    expect(() => beadLatencyMs.record(1250, { model: 'llama-3.1-8b', role: 'polecat' })).not.toThrow();
    expect(() => safeguardScanLatencyMs.record(450)).not.toThrow();
    expect(() => ledgerLockWaitMs.record(12)).not.toThrow();
  });

  it('observable gauges are defined', () => {
    // Gauges are OTel observable instruments; just verify they exist
    const { mayorHeartbeatGapMs, polecatStallRate, safeguardQueueDepth } =
      require('../../src/telemetry/metrics');
    expect(mayorHeartbeatGapMs).toBeDefined();
    expect(polecatStallRate).toBeDefined();
    expect(safeguardQueueDepth).toBeDefined();
  });
});
