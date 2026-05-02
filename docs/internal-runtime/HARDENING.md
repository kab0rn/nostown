# NOS Town Production Hardening Strategy

> Internal runway note: this strategy covers the broader legacy/future runtime.
> Current production hardening for Gas City lives in `../GASCITY_BRIDGE.md` and
> keeps Gas City static except `city.toml`.

Production-grade reliability, security, and performance specification for NOS Town. This document defines concrete implementation requirements across three hardening pillars: Resilience & Failover, Data Integrity, and Transport Security.

---

## Pillar 1: Resilience & Failover

See [RESILIENCE.md](./RESILIENCE.md) for the full failover decision tree. Summary of requirements:

### 1.1 Dynamic Endpoint Switching

Every inference call MUST go through `src/groq/provider.ts` — never call `groq.chat.completions.create()` directly from agent code. The provider handles:

- **Tier escalation on failure:** If a preview model (S+) returns 503, 429, or `model_not_found`, the provider automatically retries with the configured `stableFallback` model for that tier. No agent code changes required.
- **Exponential backoff:** On 429, wait `min(retryAfter, 30)` seconds before retry. After 3 retries on the fallback, emit a `PROVIDER_EXHAUSTED` event to the Mayor.
- **Local Ollama fallback (optional):** If `OLLAMA_URL` env var is set and all Groq endpoints return 5xx for > 60 seconds, the provider hot-swaps to Ollama for Tier B tasks (8B models only). Tier A/S tasks are queued, not downgraded.

```typescript
// src/groq/provider.ts — required interface
export interface InferenceParams {
  role: 'mayor' | 'polecat' | 'witness' | 'refinery' | 'safeguard' | 'historian';
  messages: ChatMessage[];
  temperature?: number; // default: 0.1
  maxTokens?: number; // default: role-specific (see table below)
  forceModel?: string; // override routing (Mayor use only)
  rigName?: string; // for KG routing lookup
  taskType?: string; // for Playbook short-circuit check
}

// Role-default token limits (hard caps to prevent runaway cost)
const ROLE_TOKEN_LIMITS: Record<string, number> = {
  mayor: 4096,
  polecat: 2000, // hard cap — see GROQ_INTEGRATION.md
  witness: 2048,
  refinery: 8192,
  safeguard: 1024,
  historian: 4096, // batch mode, cost controlled separately
};
```

### 1.2 State Checkpointing

Agent state is tracked via the Ledger (JSONL) and Knowledge Graph. Roles write bead status updates as they progress through execution.

- **Polecat:** Bead status transitions (`in_progress` → `done` / `failed`) are written to the Ledger.
- **Witness:** KG vote triples written per judge; council verdict written at the end.
- **Mayor:** Generates a session-local `plan_checkpoint_id` (`ckpt_<uuid>`) before dispatching. If session restarts, Mayor reads the Ledger for orphan beads.
- **Historian:** Nightly pipeline runs to completion; interrupted runs restart from the beginning on next invocation.

### 1.2.1 Mayor Dispatch Invariant

Mayor checkpointing is a hard invariant, not a best-effort behavior.

Required flow:

1. Mayor generates a session-local `plan_checkpoint_id = ckpt_<uuid>` before decomposing any task
2. Mayor includes `plan_checkpoint_id` on every `BEAD_DISPATCH`
3. `src/convoys/bus.ts` verifies the checkpoint field is present before writing the convoy

If checkpoint is missing, dispatch is aborted with `MAYOR_CHECKPOINT_MISSING`.

### 1.3 Heartbeat Monitoring

The `src/monitor/heartbeat.ts` module runs as a background process (not an agent) and is responsible for:

- **Polling interval:** Every 90 seconds, query all active Polecat `hall_events` rooms for `STATUS: IN_PROGRESS` entries older than 10 minutes.
- **Stall detection:** If a Polecat's `IN_PROGRESS` checkpoint has not been updated in 10+ minutes, emit a `POLECAT_STALLED` event to the Mayor's mailbox.
- **Mayor response:** Mayor receives `POLECAT_STALLED` and either nudges the Polecat (sends a retry signal) or re-queues the Bead for a new Polecat.
- **Escalation:** If the same Bead stalls 3 times, Mayor escalates to `BLOCKED` status and notifies the human operator via the escalation channel.

```
Heartbeat loop (every 90s):
  for each active rig:
    for each polecat checkpoint in hall_events where status = IN_PROGRESS:
      if now - checkpoint.timestamp > 10min:
        emit POLECAT_STALLED → Mayor mailbox
        if stall_count[bead_id] >= 3:
          emit BEAD_BLOCKED → escalation channel
```

---

## Pillar 2: Data Integrity & Consistency

### 2.1 Beads Ledger Integrity

The `beads.jsonl` ledger is the source of truth. Its integrity rules:

- **Append-only:** No agent may modify or delete an existing line. New entries are always appended.
- **Write lock:** `src/convoys/ledger.ts` MUST use a file-level mutex (via `proper-lockfile` or equivalent) before appending. Concurrent Polecat writes without locking will corrupt the JSONL file.
- **Schema validation:** Every Bead written to the ledger MUST be validated against the Bead schema (see [HOOK_SCHEMA.md](./HOOK_SCHEMA.md)) before append. Invalid Beads are rejected and logged to `hall_events` with `status: SCHEMA_ERROR`.
- **Checksum:** Each Bead entry MUST include a `checksum` field: `sha256(JSON.stringify(bead_without_checksum))`. The Historian validates checksums during nightly mining and flags corrupted entries.

### 2.1.1 Ledger Partitioning

Ledger writes are partitioned per rig to avoid global mutex contention:

- `rigs/{rig}/beads/current.jsonl`
- optional rollover: `rigs/{rig}/beads/archive/YYYY-MM-DD.jsonl`
- mutex scope is per-rig current ledger, never global across all rigs
- each segment stores `{segment_id, bead_count, segment_checksum}`
- Historian reconciliation reads segment manifests first, then only scans segments requiring validation

### 2.2 KG Consistency

The Knowledge Graph (SQLite) uses class-aware conflict resolution. Rules:

- **Ledger-primary:** All bead state is authoritative in the Ledger. The KG stores derived routing decisions and audit history, not bead status.
- **KG conflict resolution — class-aware precedence:** Critical triples and advisory triples use different conflict rules (see [KNOWLEDGE_GRAPH.md](./KNOWLEDGE_GRAPH.md)).

### 2.3 Convoy Sequencing

Beads within a Convoy that have dependencies MUST be sequenced using the `needs` field (Gas Town schema-compatible). NOS Town adds enforcement:

- The Mayor MUST check `needs` graph for cycles before dispatching a Convoy. Cyclic dependency = Convoy rejected with `DEPENDENCY_CYCLE` error.
- The Convoy bus (`src/convoys/bus.ts`) MUST NOT dispatch a Bead whose `needs` predecessors have not reached `outcome: SUCCESS` in the ledger.
- If a predecessor Bead fails, the Convoy bus emits `CONVOY_BLOCKED` to the Mayor mailbox with the full dependency chain.

---

## Pillar 3: Transport Security (Convoys)

See [CONVOYS.md](./CONVOYS.md) for the full Convoy schema and verification protocol. Summary of security requirements:

### 3.1 Payload Integrity

Every inter-agent Convoy message MUST be signed before dispatch and verified on receipt.

Sender authenticity uses per-role Ed25519 keys. Cluster-local HMAC is optional and supplements transport integrity only.

```typescript
// src/convoys/sign.ts
import { createHmac } from 'crypto';

export function signConvoy(payload: object, senderId: string, seq: number): string {
  const canonical = canonicalize({ payload, sender_id: senderId, seq });
  return signWithRoleKey(canonical, senderId);
}

export function verifyConvoy(msg: ConvoyMessage): boolean {
  const canonical = canonicalize({
    payload: msg.payload,
    sender_id: msg.header.sender_id,
    seq: msg.header.seq
  });
  return verifyRoleSignature(canonical, msg.signature, msg.header.sender_id);
}
```

- `NOS_ROLE_KEY_DIR` is required — startup MUST fail if no sender keys are available.
- `NOS_CONVOY_SECRET` is optional and used only for cluster-local MAC verification.
- Signature mismatches or sender/type authorization failures are logged to Historian and the convoy is quarantined (not re-delivered).

### 3.2 Replay Attack Prevention

- Each sender maintains a monotonically increasing `seq` counter persisted in the KG as a `historical` triple under key `convoy_seq`.
- Receivers maintain a `last_seen_seq` per sender in memory (reset on restart) and in the KG (durable).
- A convoy with `seq <= last_seen_seq[sender]` is rejected as a replay.
- Sequence counters are never reset. If a sender restarts, it reads its last `convoy_seq` from the KG before sending.

### 3.3 Input Sanitization (Safeguard Integration)

All Convoy payloads containing code diffs or shell command strings MUST pass through the Safeguard sentry before the recipient processes them:

- Safeguard runs synchronously on the receiving end for Polecat→Witness convoys.
- Safeguard runs asynchronously (fire-and-monitor) for Mayor→Polecat convoys, with a 500ms window to raise a `LOCKDOWN` before execution begins.
- Any payload containing shell metacharacters (`; | & $( )`) outside of explicitly whitelisted code blocks triggers an automatic `LOCKDOWN`.

---

## Pillar 4: The Safeguard Sentry (Real-time Security)

To prevent agents from introducing vulnerabilities or leaking sensitive data, the **Safeguard** role (`openai/gpt-oss-safeguard-20b`) acts as a mandatory middleware for all file writes and external API calls.

### 4.1 Mandatory Write-Scan

Every `FILE_WRITE` action must be intercepted by the Safeguard:

1. **Interception**: The Mayor dispatches the `FILE_WRITE` bead to the Safeguard first.
2. **Analysis**: The Safeguard scans the diff for:
   - Hardcoded secrets (API keys, tokens).
   - Insecure patterns (SQL injection, shell execution).
   - Logic smells (unauthorized access checks).
3. **Approval**:
   - `APPROVED`: The Safeguard forwards the convoy to the target role (or executor).
   - `REJECTED`: The Safeguard emits a `SECURITY_VIOLATION` event and blocks the write.

### 4.1.1 Safeguard Pooling

Safeguard is a pooled service, not a singleton.

Requirements:

- Minimum pool size: 2 in development, 4 in staging/production
- Shared in-process cache of vulnerability patterns discovered during the session
- Queue depth and scan latency exported as metrics
- Worker loss MUST degrade throughput, not halt the file-write path

### 4.2 Vulnerability Pattern Cache

The Safeguard maintains an in-process cache of vulnerability patterns discovered during the current session. This cache:
- Is shared across all workers in the pool via a module-level variable
- Persists for the lifetime of the process (session-local only)
- Is not carried across process restarts

### 4.3 Safeguard Ruleset (JSONL)

```jsonl
{"id": "rule_no_secrets", "severity": "CRITICAL", "pattern": "/(gsk_|sk-|AIza)[a-zA-Z0-9_-]+/"}
{"id": "rule_no_eval", "severity": "HIGH", "pattern": "/eval\(|new Function\(/"}
{"id": "rule_no_shell", "severity": "HIGH", "pattern": "/child_process\.exec\(|spawn\('/"}
```

---

## Hardening Checklist (Implementation Gate)

Before NOS Town v1.0 ships, all of the following MUST have passing tests:

| # | Check | Test File | Status |
|---|---|---|---|
| 1 | Provider falls back on 429 without data loss | `tests/integration/provider-failover.test.ts` | ✅ DONE |
| 2 | Provider falls back on model_not_found | `tests/integration/provider-failover.test.ts` | ✅ DONE |
| 3 | Ledger append is atomic under concurrent writes | `tests/integration/ledger-concurrency.test.ts` | ✅ DONE |
| 4 | Checksum validation rejects corrupt Beads | `tests/unit/ledger-checksum.test.ts` | ✅ DONE |
| 5 | Convoy signature mismatch quarantines message | `tests/unit/convoy-sign.test.ts` | ✅ DONE |
| 6 | Replay attack rejected by seq validation | `tests/unit/convoy-replay.test.ts` | ✅ DONE |
| 7 | Stalled Polecat triggers POLECAT_STALLED event | `tests/integration/heartbeat-stall.test.ts` | ✅ DONE |
| 8 | Mayor checkpoints plan before dispatch | `tests/unit/mayor-checkpoint.test.ts` | ✅ DONE |
| 9 | KG MIM resolves conflicts correctly | `tests/unit/kg-mim.test.ts` | ✅ DONE |
| 11 | Mayor dispatch blocked without checkpoint | `tests/unit/mayor-dispatch-guard.test.ts` | ✅ DONE |
| 12 | Forged sender with valid HMAC but wrong key is rejected | `tests/unit/convoy-authn.test.ts` | ✅ DONE |
| 13 | Safeguard pool continues after worker loss | `tests/integration/safeguard-pool-failover.test.ts` | ✅ DONE |
| 14 | Per-rig ledger partitions avoid cross-rig lock contention | `tests/integration/ledger-partitioning.test.ts` | ✅ DONE |
| 15 | Critical KG conflicts use role precedence, not MIM | `tests/unit/kg-critical-conflict.test.ts` | ✅ DONE |
| 16 | KG class-aware DCR resolves conflicts correctly | `tests/integration/playbook-freshness.test.ts` | ✅ DONE |
| 17 | Priority-aware draining: critical-path beads drain before low-priority | `tests/integration/swarm-priority.test.ts` | ✅ DONE |
| 21 | Cross-rig tunnel safety guard blocks incompatible stacks | `tests/integration/tunnel-safety.test.ts` | ✅ DONE |
| 22 | Hook injection: allow-list + sanitizer blocks end-to-end | `tests/security/hook-injection.test.ts` | ✅ DONE |
| 21 | Historian AAAK manifest written as KG triple | `tests/unit/historian-aaak.test.ts` | ✅ DONE |

---

## Pillar 5: Hook Variable Substitution Allow-List

Hooks support template variables via `{{variable}}` syntax. To prevent injection attacks through event data:

1. **Allow-list:** Only these five paths are substitutable:
   `event.beadId`, `event.outcome`, `event.timestamp`, `event.role`, `event.modelId`
   All other paths return the original `{{placeholder}}` unchanged.

2. **Sanitization:** Every substituted value passes through `sanitizeHookValue()` before reaching the action executor. Blocked patterns (shell metacharacters, command substitution, template literals, null bytes, path traversal) result in an empty string — never the raw payload.

3. **Disabled guard:** `enabled: false` hooks never execute, even on matching triggers.

**Implementation:** `src/hooks/executor.ts`, `src/hardening/sanitize.ts`
**Test:** `tests/unit/hook-injection-fuzz.test.ts`, `tests/security/hook-injection.test.ts`

---

## Pillar 6: KG Class-Aware Conflict Resolution

`KnowledgeGraph.resolveConflict()` MUST be class-aware — it cannot apply MIM unconditionally.

- `critical` triples → role precedence (historian > mayor > witness > safeguard > polecat)
- `advisory` triples → Most Informative Merge (MIM)
- `historical` triples → append-only (no merge)

**Implementation:** `src/kg/index.ts` — `resolveConflict()` dispatches by `metadata.class`
**Test:** `tests/integration/playbook-freshness.test.ts` §KG class-aware DCR

---

## See Also

- [RESILIENCE.md](./RESILIENCE.md) — Full Groq failover logic, Ollama fallback, convoy queueing
- [CONVOYS.md](./CONVOYS.md) — Convoy schema, signing, replay prevention, failure quarantine
- [KNOWLEDGE_GRAPH.md](./KNOWLEDGE_GRAPH.md) — KG sync protocol, MIM conflict resolution, consistency model
- [HOOK_SCHEMA.md](./HOOK_SCHEMA.md) — Gas Town Bead and Hook wire format reference
- [GROQ_INTEGRATION.md](./GROQ_INTEGRATION.md) — SDK setup, rate limit handling, error codes
- [ROUTING.md](./ROUTING.md) — For model-specific safety overrides.
- [BUILDING.md](./BUILDING.md) — Setup guide for the Safeguard sidecar.
