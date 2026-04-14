// NOS Town — OTel Metrics
// All KPIs from OBSERVABILITY.md §1 — counters, histograms, observable gauges.
// Uses @opentelemetry/api (no-op by default; wire SDK in production via sdk.ts).

import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('nos-town', '0.1.0');

// ── Counters ──────────────────────────────────────────────────────────────────

/** Total beads resolved per minute */
export const beadThroughput = meter.createCounter('bead_throughput', {
  description: 'Total beads resolved',
});

/** Groq API 429/5xx errors */
export const groqApiErrors = meter.createCounter('groq_api_error_rate', {
  description: 'Groq API 429/5xx error count',
});

/** Messages failing signature/seq check (P0 alert threshold: > 0) */
export const convoyDeliveryFailure = meter.createCounter('convoy_delivery_failure', {
  description: 'Convoy messages failing signature or sequence check',
});

/** Signed messages rejected by AUTHZ matrix (P0 alert threshold: > 0) */
export const convoyAuthzDenied = meter.createCounter('convoy_authz_denied_total', {
  description: 'Convoy messages rejected by sender/type authorization',
});

/** Critical-path beads bypassed by lower-priority work (P2 alert: sustained > 0) */
export const criticalBeadStarvation = meter.createCounter('critical_bead_starvation_count', {
  description: 'Critical-path beads repeatedly bypassed under load',
});

// ── Histograms ────────────────────────────────────────────────────────────────

/** Time from bead assignment to resolution (P95 alert: > 60s) */
export const beadLatencyMs = meter.createHistogram('bead_latency_ms', {
  description: 'Time from bead assignment to resolution in ms',
  unit: 'ms',
});

/** KG query latency (P95 alert: > 500ms) */
export const kgRetrievalLatencyMs = meter.createHistogram('kg_retrieval_latency', {
  description: 'KG query round-trip time in ms',
  unit: 'ms',
});

/** KG write latency (P95 alert: > 50ms) */
export const kgWriteLatencyMs = meter.createHistogram('kg_write_latency_ms', {
  description: 'KG triple write time in ms',
  unit: 'ms',
});

/** Safeguard diff scan time (P95 alert: > 1000ms) */
export const safeguardScanLatencyMs = meter.createHistogram('safeguard_scan_latency_ms', {
  description: 'Time to scan a diff and return a Safeguard verdict in ms',
  unit: 'ms',
});

/** Per-rig ledger lock wait time (P95 alert: > 25ms) */
export const ledgerLockWaitMs = meter.createHistogram('ledger_lock_wait_ms', {
  description: 'Time spent waiting on a per-rig ledger lock in ms',
  unit: 'ms',
});

// ── Observable Gauges ─────────────────────────────────────────────────────────

/** Time since last Mayor heartbeat in ms (alert: > 180000) */
export const mayorHeartbeatGapMs = meter.createObservableGauge('mayor_heartbeat_gap_ms', {
  description: 'Milliseconds since the last Mayor heartbeat',
  unit: 'ms',
});

/** Fraction of registered Polecats in stalled state (alert: > 10%) */
export const polecatStallRate = meter.createObservableGauge('polecat_stall_rate', {
  description: 'Fraction of Polecats currently stalled (0.0–1.0)',
});

/** Witness council approval rate (alert: < 70%) */
export const witnessApprovalRate = meter.createObservableGauge('witness_approval_rate', {
  description: 'Fraction of reviewed PRs approved by Witness council (0.0–1.0)',
});

// ── Witness approval rate accumulator ────────────────────────────────────────
// Updated by Witness.review() on each verdict; read by the gauge callback.

let _witnessTotal = 0;
let _witnessApproved = 0;

/**
 * Record a Witness verdict for the approval-rate gauge.
 * Call this from Witness.review() after a verdict is reached.
 */
export function recordWitnessVerdict(approved: boolean): void {
  _witnessTotal++;
  if (approved) _witnessApproved++;
}

witnessApprovalRate.addCallback((result) => {
  // Default to 1.0 (healthy) when no verdicts have been issued yet
  result.observe(_witnessTotal > 0 ? _witnessApproved / _witnessTotal : 1.0);
});

/** Workflows with active beads but no Mayor heartbeat (alert: > 0) */
export const orphanWorkflowCount = meter.createObservableGauge('orphan_workflow_count', {
  description: 'Count of workflows with no active Mayor heartbeat',
});

/** Pending Safeguard diff scans in queue (alert: > 20) */
export const safeguardQueueDepth = meter.createObservableGauge('safeguard_queue_depth', {
  description: 'Number of diff scans waiting for a Safeguard worker',
});
