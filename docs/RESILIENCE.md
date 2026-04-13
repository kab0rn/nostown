# NOS Town Agent Resilience & Failover

Full failover decision tree, Groq provider failure modes, local fallback configuration, and convoy queueing behavior. NOS Town is designed to remain operational through API outages, rate limits, and model deprecations.

---

## Groq Failover Decision Tree

Every inference request passes through `src/groq/provider.ts`. The decision tree on failure:

```
Request sent to Primary Model (e.g. llama-4-scout-17b)
  │
  ├── 200 OK → return response
  │
  ├── 429 Rate Limit
  │     ├── Read Retry-After header (default: 5s if missing)
  │     ├── Wait exponentially: attempt 1=5s, 2=15s, 3=30s
  │     ├── Retry on same model (up to 3 attempts)
  │     └── After 3 failures → hot-swap to Stable Fallback model
  │           └── After 3 fallback failures → emit PROVIDER_EXHAUSTED to Mayor
  │
  ├── 503 / 502 Service Unavailable
  │     ├── Immediate retry once (no wait)
  │     └── On second 5xx → hot-swap to Stable Fallback immediately
  │
  ├── model_not_found (preview model deprecated)
  │     ├── Hot-swap to Stable Fallback permanently for this session
  │     └── Emit MODEL_DEPRECATED event → Historian writes KG demotion triple
  │
  ├── context_length_exceeded
  │     ├── Trigger Deacon "Summarize & Prune" on the offending context
  │     └── Retry with pruned context (max 1 prune attempt per Bead)
  │
  └── malformed JSON response
        ├── Retry once with temperature: 0.0
        └── On second failure → escalate to next tier model
```

---

## Model Tier Failover Map

Each role has a defined fallback chain. Hot-swap is instantaneous — no agent restart required.

| Role | Primary (Preview) | Fallback 1 | Fallback 2 (Ollama) |
|---|---|---|---|
| Mayor | `groq/compound` | `llama-3.3-70b-versatile` | not supported |
| Polecat | `llama-4-scout-17b-16e-instruct` | `llama-3.1-8b-instant` | `ollama/llama3.2` |
| Witness | `qwen/qwen3-32b` | `llama-3.3-70b-versatile` | not supported |
| Refinery | `openai/gpt-oss-120b` | `llama-3.3-70b-versatile` | not supported |
| Safeguard | `openai/gpt-oss-safeguard-20b` | `openai/gpt-oss-20b` | not supported |
| Historian | Batch `llama-3.1-8b` | Sync `llama-3.1-8b-instant` | `ollama/llama3.2` |

**Ollama fallback** is only available for Tier B roles (Polecat, Historian) and only when `OLLAMA_URL` env var is set. It activates only after all Groq endpoints fail for > 60 continuous seconds. Tier A and S roles queue their requests rather than downgrading.

---

## Convoy Queueing During Outage

When the provider emits `PROVIDER_EXHAUSTED` or Groq returns 5xx for > 60 seconds:

1. **Mayor pauses dispatch:** No new Polecats are spawned. Pending Beads are held in the Mayor's in-memory outage queue.
2. **In-flight Polecats are not killed:** They continue using their current fallback model until completion or natural timeout.
3. **Queue persistence:** The outage queue is in-memory only. It does not survive a Mayor process restart. Surviving in-progress beads are recovered from the Ledger on next startup.
4. **Recovery signal:** The heartbeat monitor (`src/monitor/heartbeat.ts`) polls the Groq health endpoint every 30 seconds during outage. On recovery (200 response), it emits `PROVIDER_RECOVERED` to the Mayor mailbox.
5. **Resume dispatch:** Mayor drains the outage queue in FIFO order, re-dispatching Beads with fresh Polecats.

---

## State Recovery

### Mayor Session Recovery

On startup, Mayor reads the Ledger directly for any in-progress or pending beads:

1. Read `rigs/<rig>/beads/current.jsonl` for beads with `status: in_progress` or `status: pending`.
2. If any found: log adoption event, emit `MAYOR_ADOPTION` audit entry.
3. Resume dispatching from the recovered state — do NOT re-decompose goals that are already in the ledger.

The local checkpoint (`ckpt_<uuid>`) is session-scoped. A replacement Mayor generates a new checkpoint and adopts orphan beads from the Ledger.

### Mayor Crash Detection

The heartbeat monitor emits `MAYOR_MISSING` when all of the following are true:

- no Mayor heartbeat for 2x the configured heartbeat interval
- unfinished beads remain in the Ledger

### Mayor Replacement Flow

1. Freeze new dispatch
2. Start replacement Mayor
3. Read Ledger for orphan beads
4. Adopt orphan beads
5. Reconcile dependency graph against ledger
6. Resume dispatch only after reconciliation succeeds

A replacement Mayor MUST NOT re-decompose a goal that already has in-progress beads in the Ledger.

### Polecat Crash Recovery

If a Polecat crashes mid-task (process killed, context blown, timeout):

1. Heartbeat detects the missing `IN_PROGRESS` update after 10 minutes.
2. Mayor receives `POLECAT_STALLED` and checks the Bead's `retry_count` in the queue.
3. If `retry_count < 3`: re-dispatch the same Bead to a new Polecat.
4. If `retry_count >= 3`: Bead is marked `BLOCKED` and human escalation is triggered.

### Witness Council Recovery

If a Witness council vote is interrupted mid-consensus, the council re-runs from the beginning on the next attempt. Partial vote state is not persisted between sessions.

---

## Heartbeat Monitor Specification

The `src/monitor/heartbeat.ts` process runs as a separate Node.js worker thread alongside the Mayor:

```typescript
// src/monitor/heartbeat.ts
export interface HeartbeatConfig {
  pollIntervalMs: number;        // default: 90_000 (90 seconds)
  stallThresholdMs: number;      // default: 600_000 (10 minutes)
  providerPollIntervalMs: number; // default: 30_000 during outage
  maxRetries: number;            // default: 3 before BLOCKED escalation
}

// Events emitted to Mayor mailbox:
type HeartbeatEvent =
  | { type: 'POLECAT_STALLED';    bead_id: string; agent_id: string; stall_duration_ms: number }
  | { type: 'BEAD_BLOCKED';       bead_id: string; retry_count: number }
  | { type: 'PROVIDER_EXHAUSTED'; model: string; error: string }
  | { type: 'PROVIDER_RECOVERED'; recovered_at: string }
  | { type: 'MODEL_DEPRECATED';   model: string; fallback: string }
  | { type: 'MAYOR_MISSING';      last_seen_at: string; active_convoy_id: string };
```

The heartbeat monitor does NOT make inference calls. It only reads Ledger state and monitors the Groq health endpoint (`GET https://api.groq.com/openai/v1/models`).

---

## Local Ollama Fallback Setup

Ollama fallback is optional but recommended for teams with self-hosted GPU resources:

```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull llama3.2   # Polecat fallback
ollama pull llama3.2   # Historian fallback

# Set env var to activate fallback
export OLLAMA_URL=http://localhost:11434
```

When active, the provider routes Tier B requests to Ollama only when all Groq endpoints fail for > 60 seconds. The Ollama model must be running before NOS Town starts — there is no auto-pull. A startup health check (`GET $OLLAMA_URL/api/tags`) warns if Ollama is configured but unreachable.

---

## See Also

- [HARDENING.md](./HARDENING.md) — Full hardening checklist, checkpointing requirements, integrity rules
- [GROQ_INTEGRATION.md](./GROQ_INTEGRATION.md) — SDK config, error handling, rate limit management
- [CONVOYS.md](./CONVOYS.md) — Convoy queueing schema and transport integrity
- [KNOWLEDGE_GRAPH.md](./KNOWLEDGE_GRAPH.md) — KG triple writes for model demotions
