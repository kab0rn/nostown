# NOS Town — Gap Analysis

**Date:** 2026-04-14  
**Baseline:** 550 tests passing, TypeScript clean, all P1–P13 implementation plan items merged.  
**Scope:** Implementation vs. product vision as documented in `docs/`.

This document enumerates known gaps between the current codebase and the full product vision. Each gap lists severity, the spec reference, what exists today, and what needs to be built. Items are grouped by severity and ordered within each group by impact.

---

## HIGH Severity

These gaps cause silent data loss or broken spec contracts in the core execution path.

---

### H1 — Token Usage Discarded by GroqProvider

**Spec:** `HISTORIAN.md` §Core Persistence Layers (bead JSON example shows `"tokens": 2400`); `BeadMetrics.tokens` field defined in `src/types/index.ts`.

**Current state:**  
`GroqProvider.runWithRetry()` at `src/groq/provider.ts:259` extracts only `response.choices[0].message.content` and returns it as a plain string. `response.usage.total_tokens` is discarded. The `BeadMetrics.tokens` field exists in the type but is never populated anywhere in the codebase.

**Impact:**  
The Historian cannot compute per-model cost metrics, playbook quality cannot be weighted by token efficiency, and OTel token-budget alerts (OBSERVABILITY.md §2) have no data to work with.

**What to build:**  
Change `executeInference()` to return `{ content: string; tokens: number }` and thread token counts through `Polecat.execute()` into `bead.metrics.tokens`. Since `executeInference()` has many call sites, a minimal approach is to add a parallel `executeInferenceWithUsage()` method and call it only in Polecat, keeping the existing signature for other callers.

Alternatively, change the return type of `executeInference()` to `{ content: string; tokens?: number }` and update all call sites.

```typescript
// src/groq/provider.ts — in runWithRetry(), after extracting content:
const tokens = response.usage?.total_tokens ?? 0;
// Return { content, tokens } or store on a lastUsage instance field
```

```typescript
// src/roles/polecat.ts — in execute(), build the done bead:
const done: Bead = {
  ...inProgress,
  status: 'done',
  outcome: 'SUCCESS',
  metrics: {
    ...bead.metrics,
    duration_ms: durationMs,
    tokens: result.tokens,   // ← add this
  },
  updated_at: new Date().toISOString(),
};
```

**Acceptance criteria:**
- `bead.metrics.tokens` is non-zero after a successful Polecat execution (integration test)
- `beadThroughput` or a new `tokenConsumption` metric records tokens per bead
- Historian `generatePlaybooks()` can optionally weight by average token count per outcome

---

### H2 — KGSyncMonitor Not Implemented

**Spec:** `KNOWLEDGE_GRAPH.md` §Consistency Model — "Every 500ms, the KG sync monitor computes `hash = SHA-256(last_100_triple_ids + their_created_at values)`... Agents compare their cached hash against this to detect if the KG has changed since their last read."

**Current state:**  
`KnowledgeGraph.computeStateHash()` exists at `src/kg/index.ts:353` and is tested, but nothing in the codebase calls it periodically. No `KGSyncMonitor` class exists. No agent checks the hash before acting on cached KG state.

**Impact:**  
In the default single-SQLite deployment this is low risk (all writers share the same file). In any multi-agent or multi-process scenario, stale KG reads cause routing decisions to lag behind reality — a model could be demoted but an already-running Mayor still dispatches to it.

**What to build:**

```typescript
// src/kg/sync-monitor.ts

export class KGSyncMonitor {
  private kg: KnowledgeGraph;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private lastHash = '';
  private onStateChange: ((hash: string) => void) | null;

  constructor(kg: KnowledgeGraph, intervalMs = 500, onStateChange?: (hash: string) => void) {
    this.kg = kg;
    this.intervalMs = intervalMs;
    this.onStateChange = onStateChange ?? null;
  }

  start(): void {
    this.timer = setInterval(() => {
      const hash = this.kg.computeStateHash();
      if (hash !== this.lastHash) {
        this.lastHash = hash;
        this.onStateChange?.(hash);
      }
    }, this.intervalMs);
    this.timer.unref(); // don't keep the process alive
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  currentHash(): string { return this.lastHash; }
}
```

Wire into `WorkerRuntime.start()` alongside the poll loop. The Mayor queries the KG before routing — if its cached hash differs from `KGSyncMonitor.currentHash()`, it must re-query before dispatching.

**Acceptance criteria:**
- `KGSyncMonitor` starts and emits a change event when a new triple is written
- `WorkerRuntime` stops the monitor in `drain()`/`stop()`
- Unit test: two KG instances see hash divergence within one tick after a write

---

### H3 — POTENTIAL_DEADLOCK Heartbeat Event Not Handled

**Spec:** `SWARM.md` — POTENTIAL_DEADLOCK event should trigger re-queue or escalation. `HeartbeatMonitor` emits this event type (defined in `src/types/index.ts:90`).

**Current state:**  
`heartbeatHandler()` in `src/index.ts:65` handles `MAYOR_MISSING`, `POLECAT_STALLED`, and `BEAD_BLOCKED`. `POTENTIAL_DEADLOCK` is silently dropped — no log, no escalation, no re-queue.

**Impact:**  
Deadlock conditions (HIGH_FAN_OUT, SOLE_PREDECESSOR, STARVATION) are detected but never acted on. The swarm can stall indefinitely with no operator signal.

**What to build:**  
Add a handler branch in `heartbeatHandler()`:

```typescript
// src/index.ts — in heartbeatHandler()
if (event.type === 'POTENTIAL_DEADLOCK') {
  structuredLog({
    level: 'WARN',
    role: 'mayor',
    agent_id: AGENT_ID,
    event: 'POTENTIAL_DEADLOCK',
    message: `Deadlock detected: bead=${event.bead_id} reason=${event.reason} stall=${event.stall_duration_ms}ms`,
    bead_id: event.bead_id,
  });
  // Escalate for SOLE_PREDECESSOR and STARVATION (highest risk)
  if (event.reason !== 'HIGH_FAN_OUT') {
    void runtimeRef?.handleDeadlock(event);
  }
}
```

Add `WorkerRuntime.handleDeadlock()` that emits a `SWARM_ABORT` convoy to the Mayor's inbox if stall exceeds the configured threshold (default 30 seconds), then re-queues the bead.

**Acceptance criteria:**
- POTENTIAL_DEADLOCK events produce a structured WARN log
- SOLE_PREDECESSOR and STARVATION events trigger `handleDeadlock()` 
- HIGH_FAN_OUT events are logged but not escalated
- Unit test: mock HeartbeatMonitor emitting each reason variant

---

## MEDIUM Severity

These gaps cause specification drift — the implementation diverges from documented behavior in ways that will confuse future contributors and operators.

---

### M1 — `playbook_match` Bead Field Not Written

**Spec:** `HISTORIAN.md` §Core Persistence Layers shows a bead with `"playbook_match": "typescript_generics_v2"` indicating which playbook was used for that execution.

**Current state:**  
`playbook_match` is not defined in the `Bead` interface (`src/types/index.ts`). `Mayor.orchestrate()` does look up and apply playbooks (added in P2), but does not stamp `playbook_match` on dispatched beads. There is no way to trace which playbook produced a given bead outcome.

**Impact:**  
The Historian cannot compute per-playbook success rates or detect playbook regressions. The feedback loop from execution → Historian → better playbooks is weakened.

**What to build:**

1. Add to `Bead` interface:
```typescript
playbook_match?: string;   // ID of playbook that guided this execution
```

2. In `Mayor.orchestrate()`, when a playbook is applied, stamp all dispatched beads:
```typescript
const beadsWithPlaybook = beads.map((b) => ({
  ...b,
  playbook_match: activePlaybook?.id,
}));
```

3. In `Historian.minePatterns()`, use `playbook_match` to group outcomes by playbook for regression detection.

**Acceptance criteria:**
- Beads dispatched via a matching playbook have `playbook_match` set
- Historian generates a `playbook_regression` KG triple when a playbook's success rate drops > 10%

---

### M2 — `preferred_for` KG Relation Never Written

**Spec:** `KNOWLEDGE_GRAPH.md` §Core Triple Vocabularies — `{model_id} preferred_for {rig_name}` indicates a model has demonstrated strong performance on a particular rig's workload profile.

**Current state:**  
The `preferred_for` relation is documented in the vocabulary table but no code ever writes it. `Historian.autoValidatePromotedModels()` writes `demoted_from` triples and `Historian.generatePlaybooks()` writes `has_playbook` triples. The promotion path writes only `locked_to` triples scoped to task types — there is no rig-level preference triple.

**Impact:**  
The rig-level preference signal is completely absent from the KG. The routing system cannot differentiate models that generalize well across a particular rig's task mix.

**What to build:**  
In `Historian.runNightly()`, after computing per-task-type success rates, compute an aggregate score per (model, rig) pair. Write a `preferred_for` triple when a model achieves >85% across ≥5 distinct task types on that rig:

```typescript
// src/roles/historian.ts — in runNightly(), after updateRoutingKg()
await this.updateRigPreferences(rigName, beads);

private async updateRigPreferences(rigName: string, beads: Bead[]): Promise<void> {
  // Group beads by model, count task types and outcomes
  // Write preferred_for triple for models with broad strong performance
}
```

**Acceptance criteria:**
- `preferred_for` triple is written to KG after a successful nightly run with qualifying beads
- `RoutingDispatcher` reads `preferred_for` triples as a tiebreaker when multiple models qualify
- Unit test: model with 90% across 6 task types gets `preferred_for` triple; model with 90% on only 2 types does not

---

### M3 — Historian Step 4 Label Mismatch

**Spec:** `HISTORIAN.md` §The Historian Pipeline shows step 4 as:
```
└─ 4. RECORD RIG STATE — write KG triple for this nightly run
        kg.addTriple(rigName, "historian_run", "completed", valid_from=today)
```

**Current state:**  
`Historian.recordRigWing()` (`src/roles/historian.ts:418`) writes:
```typescript
{
  subject: 'historian_wings',
  relation: 'registered',
  object: myWing,  // "wing_rig_{rigName}"
}
```

The subject, relation, and object are all different from the spec. The intent (recording a nightly run completion) is the same, but the KG triple is not queryable by anyone expecting the documented schema.

**Impact:**  
Any agent querying `kg.queryTriples(rigName, 'historian_run', 'completed')` to check whether the Historian has run recently gets no results. The `KNOWLEDGE_GRAPH.md` vocabulary table will be misleading once operators start building on the documented schema.

**Resolution:**  
Two options:
1. **Change the implementation** to match the spec: `subject=rigName, relation='historian_run', object='completed'`
2. **Update the spec** to match the implementation: describe `historian_wings.registered.wing_rig_{rigName}` as the canonical triple

**Recommendation:** Option 1 — the spec's schema is more queryable (rigName as subject enables `kg.queryEntity(rigName)` to return all nightly run records). The implementation should change.

```typescript
// src/roles/historian.ts — recordRigWing()
this.kg.addTriple({
  subject: rigName,
  relation: 'historian_run',
  object: 'completed',
  valid_from: today,
  agent_id: this.agentId,
  metadata: { class: 'historical', wing: myWing },
  created_at: new Date().toISOString(),
});
```

**Acceptance criteria:**
- `kg.queryTriples(rigName, 'historian_run', 'completed')` returns one result per nightly run
- Existing historian nightly tests updated to check new subject/relation/object
- HISTORIAN.md step 4 comment removed from this gap list

---

### M4 — `refinery_required` Bead Flag Not Implemented

**Spec:** `ROLES.md` §Refinery — "Mayor explicitly marks a bead `refinery_required: true`" to route it through the Refinery for multi-step improvement before Witness review.

**Current state:**  
`refinery_required` is not in the `Bead` interface. `WorkerRuntime` never routes PATCH_READY convoys to the Refinery. The Refinery role exists (`role: 'refinery'` is valid in `BeadWriteSchema`) but has no routing path.

**Impact:**  
The Refinery agent role is a dead branch. No bead is ever improved by the Refinery before Witness review, even for high-complexity tasks where multi-step improvement would significantly increase approval rates.

**What to build:**

1. Add to `Bead` interface:
```typescript
refinery_required?: boolean;  // route through Refinery before Witness
```

2. In `WorkerRuntime`, add a handler for `PATCH_READY` convoys:
```typescript
// If bead.refinery_required, route to Refinery instead of Witness
if (bead.refinery_required) {
  // dispatch to Refinery, wait for REFINERY_READY, then route to Witness
}
```

3. In `Mayor.decompose()`, set `refinery_required: true` for beads with `fan_out_weight >= 5` or task types in a configurable `REFINERY_TASK_TYPES` list.

**Acceptance criteria:**
- Beads with `refinery_required: true` go through Refinery before Witness in the WorkerRuntime pipeline
- Refinery role is instantiable (needs a minimal `Refinery` class if not already present)
- Integration test: bead with `refinery_required=true` shows Refinery outcome in ledger before Witness verdict

---

## LOW Severity

These gaps are spec completeness issues — the system works correctly without them, but the implementation falls short of the documented production readiness target.

---

### L1 — OTel Histogram Bucket Configuration Missing

**Spec:** `OBSERVABILITY.md` §2 — KPIs include p95 latency targets (e.g., bead execution p95 < 5s). Meaningful p95 reporting requires custom histogram bucket boundaries.

**Current state:**  
`beadLatencyMs` and `ledgerLockWaitMs` histograms in `src/telemetry/metrics.ts` use SDK default buckets (typically 0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000ms). These are too coarse for the 0–500ms range relevant to ledger lock waits and too fine for the 0–30s range relevant to bead execution.

**What to build:**  
Configure explicit bucket boundaries per histogram:

```typescript
// src/telemetry/metrics.ts
export const beadLatencyMs = meter.createHistogram('nos.bead.latency_ms', {
  description: 'End-to-end bead execution latency in milliseconds',
  unit: 'ms',
  advice: {
    explicitBucketBoundaries: [100, 500, 1000, 2000, 5000, 10000, 30000],
  },
});

export const ledgerLockWaitMs = meter.createHistogram('nos.ledger.lock_wait_ms', {
  description: 'Time waiting to acquire per-rig ledger lock',
  unit: 'ms',
  advice: {
    explicitBucketBoundaries: [5, 10, 20, 50, 100, 200, 500, 1000],
  },
});
```

---

### L2 — Ledger Rollover / Archive Not Implemented

**Spec:** `HARDENING.md` §2.1.1 — "When `current.jsonl` exceeds `NOS_LEDGER_MAX_BYTES` (default 100MB), it is archived to `beads/archive/YYYY-MM-DD.jsonl` and a new `current.jsonl` is started. A `manifest.json` in `beads/` lists all segment files."

**Current state:**  
`Ledger.appendBead()` writes to `current.jsonl` indefinitely. No size check, no archive, no manifest. In a production rig processing hundreds of beads per day, `current.jsonl` will grow without bound.

**What to build:**  
Add a size check in `appendBead()` after acquiring the lock:

```typescript
const stats = fs.statSync(filePath);
if (stats.size > maxBytes) {
  await this.archiveCurrentFile(rigName, filePath);
}
```

`archiveCurrentFile()` moves `current.jsonl` to `beads/archive/YYYY-MM-DD-{timestamp}.jsonl` and updates `beads/manifest.json`. `readBeads()` must also read archive segments when scanning all beads.

---

### L3 — KG Queued-Write Mode Not Implemented

**Spec:** `KNOWLEDGE_GRAPH.md` §Single-Instance Limits — "if p95 KG write latency exceeds 50ms for 5 minutes, enable queued-write mode."

**Current state:**  
`KnowledgeGraph.addTriple()` always writes synchronously and directly. There is no write queue, no latency monitor, and no queued-write fallback.

**What to build:**  
A `KGWriteQueue` that buffers writes and flushes them in a background interval when enabled. The queue is enabled/disabled based on observed p95 write latency (measured via a rolling window). This is a significant architectural change and is deferred until the SQLite deployment approaches its write concurrency limit.

---

### L4 — KG Vocabulary Gaps (`uses_pattern`, `resolved_by`, `room_*` relations)

**Spec:** `KNOWLEDGE_GRAPH.md` §Core Triple Vocabularies — several relation types are documented but never written:

| Relation | Written by | Status |
|---|---|---|
| `preferred_for` | Historian | Missing (M2 above) |
| `uses_pattern` | Safeguard / Historian | Never written |
| `resolved_by` | Historian | Never written |
| `room_*.owned_by` | Mayor | Written in tests only |
| `room_*.blocked_by` | Mayor | Never written |

The `uses_pattern` and `resolved_by` relations are written by the Safeguard (when a known vulnerability pattern is detected) and by the Historian (when a room's blocking issue is resolved). These require the `room_*` concept to be more fully implemented in the Mayor and WorkerRuntime first.

**What to build:**  
Once Mayor tracks active rooms (currently not implemented), wire the Safeguard and Historian to write these triples. This is blocked by the room concept, which is a larger feature.

---

### L5 — KG Bootstrap Script Not Runnable

**Spec:** `KNOWLEDGE_GRAPH.md` §Bootstrap — "Run once on first startup to seed KG from static routing table: `npx tsx src/historian/bootstrap-kg.ts --routing-table docs/ROUTING.md`"

**Current state:**  
`src/historian/bootstrap-kg.ts` exists but reads the routing table from a fixed path (`docs/ROUTING.md`) and has no `--routing-table` flag. The script structure is correct but the CLI arg parsing is incomplete.

**What to build:**  
Add `process.argv` parsing for `--routing-table` and `--kg-path` flags, and add a `--dry-run` mode that prints what triples would be written without committing them.

---

## Already Resolved

The following items from prior gap analyses have been implemented and are tracked here for completeness:

| Item | Resolved in |
|---|---|
| Worker loop (WorkerRuntime) — P1 | feat/production-hardening |
| Mayor reads KG playbooks before decompose — P2 | feat/production-hardening |
| Persist convoy sequence counters — P3 | feat/production-hardening |
| AAAK manifest written to KG — P4 | feat/production-hardening |
| PII stripping on playbook samples — P5 | feat/production-hardening |
| NOS_ROLE_KEY_DIR fail-fast at startup — P6 | feat/production-hardening |
| Historian cron wiring — P7 | feat/production-hardening |
| CoVe self-critique pass — P8 | feat/production-hardening |
| Safeguard 500ms async window — P9 | feat/production-hardening |
| Historian Batch API — P10 | feat/production-hardening |
| RoutingDispatcher KG reverse lookup — P11 | feat/production-hardening |
| Safeguard rules loaded from JSONL — P12 | feat/production-hardening |
| Dead code cleanup — P13 | feat/production-hardening |
| Convoy quarantine folder | feat/production-hardening |
| Priority-aware inbox draining | feat/production-hardening |
| Safeguard KG pattern persistence (opt-in) | feat/production-hardening |
| findCachedBead() — bead result caching | feat/production-hardening |
| autoValidatePromotedModels() — model auto-demotion | feat/production-hardening |
| maxInflightBeads enforcement gate | feat/production-hardening |
| drain() — graceful shutdown | feat/production-hardening |
| Distributed tracing (trace_id wiring) | feat/production-hardening |
| NOS_LOG_LEVEL filtering in structuredLog | feat/production-hardening |

---

## Implementation Priority

```
Stream A — Data completeness (no external blockers):
  H1 (token usage) — change GroqProvider return type + Polecat wiring
  M3 (historian_run triple label) — change recordRigWing() subject/relation/object

Stream B — Observability:
  H2 (KGSyncMonitor) — new class + WorkerRuntime wiring
  H3 (POTENTIAL_DEADLOCK handler) — add branch to heartbeatHandler()
  L1 (OTel bucket config) — one-liner per histogram

Stream C — Spec completeness:
  M1 (playbook_match field) — type + Mayor dispatch + Historian mining
  M2 (preferred_for triple) — Historian nightly + RoutingDispatcher tiebreaker
  M4 (refinery_required flag) — type + WorkerRuntime routing

Stream D — Deferred (significant scope):
  L2 (ledger rollover) — size check + archive + manifest
  L3 (KG queued-write) — blocked on observing production load
  L4 (room relations) — blocked on room concept implementation
  L5 (bootstrap CLI args) — small fix, no urgency
```

**Recommended order:** H1 and M3 are one-day items with high confidence. H2 and H3 are two-day items that close operational blind spots. L1 is a one-liner. M1, M2, M4 together complete the data model and should land as a single PR. L2–L5 can be deferred until the system is under real production load.
