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
  │     ├── Log deprecation event to hall_events
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

1. **Mayor pauses dispatch:** No new Polecats are spawned. Pending Beads remain in the Convoy queue in `hall_events` with `status: QUEUED`.
2. **In-flight Polecats are not killed:** They continue using their current fallback model until completion or natural timeout.
3. **Queue persistence:** The Convoy queue is written to MemPalace `wing_mayor / hall_events / room: outage-queue` so it survives a Mayor session restart.
4. **Recovery signal:** The heartbeat monitor (`src/monitor/heartbeat.ts`) polls the Groq health endpoint every 30 seconds during outage. On recovery (200 response), it emits `PROVIDER_RECOVERED` to the Mayor mailbox.
5. **Resume dispatch:** Mayor drains the outage queue in FIFO order, re-dispatching Beads with fresh Polecats.

```typescript
// Outage queue entry shape (stored in hall_events):
interface QueuedBead {
  bead_id: string;
  convoy_id: string;
  queued_at: string;    // ISO 8601
  priority: 'high' | 'normal' | 'low';
  retry_count: number;
  last_error: string;
}
```

---

## State Checkpointing

All role state is checkpointed to MemPalace so sessions can recover after crashes or restarts.

### Mayor Session Recovery

On startup, Mayor MUST:

1. Call `mempalace_diary_read --wing wing_mayor` to load prior session summary.
2. Query `hall_facts / room: active-convoy` for any in-progress Convoy plan.
3. Query `hall_events / room: outage-queue` for any queued Beads from a prior outage.
4. Resume dispatching from the recovered state — do NOT re-decompose goals that are already in the ledger.

### Polecat Crash Recovery

If a Polecat crashes mid-task (process killed, context blown, timeout):

1. Heartbeat detects the missing `IN_PROGRESS` update after 10 minutes.
2. Mayor receives `POLECAT_STALLED` and checks the Bead's `retry_count` in the queue.
3. If `retry_count < 3`: re-dispatch the same Bead to a new Polecat with the prior Polecat's `hall_discoveries` as additional context.
4. If `retry_count >= 3`: Bead is marked `BLOCKED` and human escalation is triggered.

### Witness Council Recovery

If a Witness council vote is interrupted mid-consensus:

1. Lead Witness reads `wing_witness / hall_events / room: {pr_id}-vote` for partial votes.
2. Re-runs only the missing votes (not the full 3-judge panel).
3. If the partial vote is older than 24 hours, the entire council re-runs (stale context).

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
  | { type: 'MODEL_DEPRECATED';   model: string; fallback: string };
```

The heartbeat monitor does NOT make inference calls. It only reads MemPalace state and monitors the Groq health endpoint (`GET https://api.groq.com/openai/v1/models`).

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
