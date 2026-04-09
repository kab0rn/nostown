# NOS Town Production Hardening Strategy

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
  temperature?: number;       // default: 0.1
  maxTokens?: number;         // default: role-specific (see table below)
  forceModel?: string;        // override routing (Mayor use only)
  rigName?: string;           // for KG routing lookup
  taskType?: string;          // for Playbook short-circuit check
}

// Role-default token limits (hard caps to prevent runaway cost)
const ROLE_TOKEN_LIMITS: Record<string, number> = {
  mayor:     4096,
  polecat:   2000,   // hard cap — see GROQ_INTEGRATION.md
  witness:   2048,
  refinery:  8192,
  safeguard: 1024,
  historian: 4096,   // batch mode, cost controlled separately
};
```

### 1.2 State Checkpointing

Every agent role MUST checkpoint its state to MemPalace before any operation that could be interrupted:

- **Polecat:** Write `STATUS: IN_PROGRESS` with current Bead ID and step to `hall_events` before starting file modifications. On completion, update to `STATUS: DONE`.
- **Witness:** Write council vote progress (partial votes) to `hall_events` before submitting the final verdict.
- **Mayor:** Write Convoy plan JSON to `hall_facts` before dispatching Polecats. If session restarts, Mayor reads this to avoid re-decomposing already-dispatched work.
- **Historian:** Write nightly pipeline progress (which steps completed) to `wing_historian / hall_events` so interrupted runs can resume from the last completed step.

```typescript
// Required checkpoint shape written to hall_events:
interface AgentCheckpoint {
  agent_id: string;       // e.g. "polecat-7f3b"
  role: string;
  bead_id: string;
  step: string;           // e.g. "modifying_file", "writing_tests"
  status: 'in_progress' | 'done' | 'blocked' | 'failed';
  timestamp: string;      // ISO 8601
  context_ref?: string;   // MemPalace drawer ID if relevant context saved
}
```

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

### 2.2 MemPalace Consistency

The MemPalace KG (SQLite) and ChromaDB vector store are eventually consistent. Rules:

- **Write-through:** When a Polecat writes a Drawer, it writes to MemPalace first, then appends to `beads.jsonl`. Not the reverse. This ensures MemPalace is never behind the ledger.
- **Historian reconciliation:** During the nightly run, the Historian compares `beads.jsonl` entries against MemPalace Drawers by `bead_id`. Any ledger entry without a corresponding Drawer is re-inserted (backfill mode).
- **KG conflict resolution — Most Informative Merge (MIM):** If two concurrent agents write conflicting triples (same subject+relation, different objects with overlapping validity windows), the Historian applies MIM: the triple with more metadata fields wins. If equal, the later `valid_from` wins.
- **State hash exchange:** Every 500ms, the MemPalace MCP server computes a rolling SHA-256 hash of the last 100 KG writes and exposes it via `mempalace_status`. Agents can detect divergence by comparing their local last-known hash against the server hash.

### 2.3 Convoy Sequencing

Beads within a Convoy that have dependencies MUST be sequenced using the `needs` field (Gas Town schema-compatible). NOS Town adds enforcement:

- The Mayor MUST check `needs` graph for cycles before dispatching a Convoy. Cyclic dependency = Convoy rejected with `DEPENDENCY_CYCLE` error.
- The Convoy bus (`src/convoys/bus.ts`) MUST NOT dispatch a Bead whose `needs` predecessors have not reached `outcome: SUCCESS` in the ledger.
- If a predecessor Bead fails, the Convoy bus emits `CONVOY_BLOCKED` to the Mayor mailbox with the full dependency chain.

---

## Pillar 3: Transport Security (Convoys)

See [CONVOYS.md](./CONVOYS.md) for the full Convoy schema and verification protocol. Summary of security requirements:

### 3.1 Payload Integrity

Every inter-agent Convoy message MUST be signed before dispatch and verified on receipt:

```typescript
// src/convoys/sign.ts
import { createHmac } from 'crypto';

export function signConvoy(payload: object, senderId: string, seq: number): string {
  const canonical = JSON.stringify({ payload, sender_id: senderId, seq });
  return createHmac('sha256', process.env.NOS_CONVOY_SECRET!)
    .update(canonical)
    .digest('hex');
}

export function verifyConvoy(msg: ConvoyMessage): boolean {
  const expected = signConvoy(msg.payload, msg.header.sender_id, msg.header.seq);
  return expected === msg.signature;
}
```

- `NOS_CONVOY_SECRET` is a required env var — startup MUST fail if absent.
- Signature mismatches are logged to Historian and the convoy is quarantined (not re-delivered).

### 3.2 Replay Attack Prevention

- Each sender maintains a monotonically increasing `seq` counter persisted in its MemPalace `hall_events` room under key `convoy_seq`.
- Receivers maintain a `last_seen_seq` per sender in memory (reset on restart) and in `hall_events` (durable).
- A convoy with `seq <= last_seen_seq[sender]` is rejected as a replay.
- Sequence counters are never reset. If a sender restarts, it reads its last `convoy_seq` from `hall_events` before sending.

### 3.3 Input Sanitization (Safeguard Integration)

All Convoy payloads containing code diffs or shell command strings MUST pass through the Safeguard sentry before the recipient processes them:

- Safeguard runs synchronously on the receiving end for Polecat→Witness convoys.
- Safeguard runs asynchronously (fire-and-monitor) for Mayor→Polecat convoys, with a 500ms window to raise a `LOCKDOWN` before execution begins.
- Any payload containing shell metacharacters (`; | & $( )`) outside of explicitly whitelisted code blocks triggers an automatic `LOCKDOWN`.

---

## Hardening Checklist (Implementation Gate)

Before NOS Town v1.0 ships, all of the following MUST have passing tests:

| # | Check | Test File | Status |
|---|---|---|---|
| 1 | Provider falls back on 429 without data loss | `tests/integration/provider-failover.test.ts` | TODO |
| 2 | Provider falls back on model_not_found | `tests/integration/provider-failover.test.ts` | TODO |
| 3 | Ledger append is atomic under concurrent writes | `tests/integration/ledger-concurrency.test.ts` | TODO |
| 4 | Checksum validation rejects corrupt Beads | `tests/unit/ledger-checksum.test.ts` | TODO |
| 5 | Convoy signature mismatch quarantines message | `tests/unit/convoy-sign.test.ts` | TODO |
| 6 | Replay attack rejected by seq validation | `tests/unit/convoy-replay.test.ts` | TODO |
| 7 | Stalled Polecat triggers POLECAT_STALLED event | `tests/integration/heartbeat-stall.test.ts` | TODO |
| 8 | Mayor checkpoints plan before dispatch | `tests/unit/mayor-checkpoint.test.ts` | TODO |
| 9 | MemPalace backfill catches missing Drawers | `tests/integration/historian-backfill.test.ts` | TODO |
| 10 | KG MIM resolves conflicts correctly | `tests/unit/kg-mim.test.ts` | TODO |

---

## See Also

- [RESILIENCE.md](./RESILIENCE.md) — Full Groq failover logic, Ollama fallback, convoy queueing
- [CONVOYS.md](./CONVOYS.md) — Convoy schema, signing, replay prevention, failure quarantine
- [KNOWLEDGE_GRAPH.md](./KNOWLEDGE_GRAPH.md) — KG sync protocol, MIM conflict resolution, consistency model
- [HOOK_SCHEMA.md](./HOOK_SCHEMA.md) — Gas Town Bead and Hook wire format reference
- [GROQ_INTEGRATION.md](./GROQ_INTEGRATION.md) — SDK setup, rate limit handling, error codes


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

### 4.2 Vulnerability Memory (Palace Wing)

The Safeguard maintains a dedicated MemPalace Wing (`wing_safeguard`) containing:
- **Known Vulnerabilities**: Patterns identified in previous sessions that led to failures.
- **Trusted Patches**: Examples of secure fixes for common issues.
- **Violation History**: A per-role score of security violations to detect "drifting" agents.

### 4.3 Safeguard Ruleset (JSONL)

```jsonl
{"id": "rule_no_secrets", "severity": "CRITICAL", "pattern": "/(gsk_|sk-|AIza)[a-zA-Z0-9_-]+/"}
{"id": "rule_no_eval", "severity": "HIGH", "pattern": "/eval\(|new Function\(/"}
{"id": "rule_no_shell", "severity": "HIGH", "pattern": "/child_process\.exec\(|spawn\('/"}
```

---

## See Also
- [RESILIENCE.md](./RESILIENCE.md) — For endpoint failover.
- [ROUTING.md](./ROUTING.md) — For model-specific safety overrides.
- [BUILDING.md](./BUILDING.md) — Setup guide for the Safeguard sidecar.
