# NOS Town Knowledge Graph — SQLite Triple Store

The MemPalace Knowledge Graph (KG) is a temporal SQLite triple store embedded in the MemPalace MCP server. It is the authoritative source for model routing state, Witness council votes, architectural decisions, and team assignments across all NOS Town sessions.

---

## Why a Knowledge Graph

NOS Town's routing and orchestration decisions are not static — they evolve as models are promoted, demoted, or deprecated, and as the Witness council builds up a history of approval/rejection patterns. A flat markdown routing table cannot represent this. The KG stores:

- **Temporal triples** with `valid_from` / `valid_to` windows — so "what was the routing state on date X?" is always answerable
- **Council vote history** — so the Mayor can check "has this type of change been rejected before?"
- **Team and ownership state** — so the Mayor can query "who owns this room right now?"
- **Model performance locks** — so the Historian can write promotions/demotions that take immediate effect

---

## SQLite Schema

The KG lives at `palace-db/knowledge_graph.sqlite`. Schema:

```sql
CREATE TABLE triples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  relation    TEXT NOT NULL,
  object      TEXT NOT NULL,
  valid_from  TEXT NOT NULL,   -- ISO 8601 date, e.g. '2026-04-08'
  valid_to    TEXT,            -- NULL = currently active
  agent_id    TEXT NOT NULL,   -- who wrote this triple
  metadata    TEXT,            -- JSON blob for extra fields
  created_at  TEXT NOT NULL    -- ISO 8601 datetime (write time)
);

CREATE INDEX idx_subject     ON triples(subject);
CREATE INDEX idx_relation    ON triples(relation);
CREATE INDEX idx_valid_from  ON triples(valid_from);
CREATE INDEX idx_valid_to    ON triples(valid_to);
```

**Triple semantics:** `(subject, relation, object)` is a directional fact. The `valid_from`/`valid_to` window defines when that fact is true. A triple with `valid_to = NULL` is currently active.

---

## Core Triple Vocabularies

### Model Routing

| Subject | Relation | Object | Example |
|---|---|---|---|
| `{model_id}` | `locked_to` | `{task_type}` | `llama-3.1-8b` locked_to `typescript_generics` |
| `{model_id}` | `demoted_from` | `{task_type}` | `llama-3.1-8b` demoted_from `security_auth` |
| `{model_id}` | `preferred_for` | `{rig_name}` | `qwen3-32b` preferred_for `wing_rig_tcgliveassist` |

### Witness Council Votes

| Subject | Relation | Object | Metadata |
|---|---|---|---|
| `witness_council_{id}` | `approved` | `{room}-{pr_id}` | `{"score": "3/3", "model": "qwen3-32b"}` |
| `witness_council_{id}` | `rejected` | `{room}-{pr_id}` | `{"score": "1/3", "reason": "missing null check"}` |

### Architectural Decisions

| Subject | Relation | Object | Example |
|---|---|---|---|
| `rig_{name}` | `uses_pattern` | `{pattern_name}` | `rig_tcgliveassist` uses_pattern `jwt_refresh_v2` |
| `room_{name}` | `resolved_by` | `playbook_{id}` | `room_auth-migration` resolved_by `playbook_jwt_auth_v3` |

### Team Ownership

| Subject | Relation | Object | Example |
|---|---|---|---|
| `room_{name}` | `owned_by` | `{agent_or_human_id}` | `room_billing-refactor` owned_by `polecat-7f3b` |
| `room_{name}` | `blocked_by` | `{dependency}` | `room_checkout-flow` blocked_by `room_auth-migration` |

### Safeguard Events

| Subject | Relation | Object | Metadata |
|---|---|---|---|
| `lockdown_{id}` | `triggered_by` | `{vuln_type}` | `{"room": "auth-migration", "diff_hash": "abc123"}` |
| `vuln_pattern_{id}` | `detected_in` | `room_{name}` | `{"pattern": "hardcoded_secret", "severity": "critical"}` |

---

## MCP Tool Reference

### `mempalace_kg_add`

Add a new triple. If a conflicting active triple exists (same subject+relation, `valid_to = NULL`), the existing triple is NOT automatically invalidated — that is the caller's responsibility (use `mempalace_kg_invalidate` first if needed).

```typescript
// Input
{
  subject:    string;   // e.g. "llama-3.1-8b"
  relation:   string;   // e.g. "locked_to"
  object:     string;   // e.g. "typescript_generics"
  valid_from: string;   // ISO 8601 date (default: today)
  metadata?:  object;   // arbitrary JSON
}
// Output: { triple_id: number }
```

### `mempalace_kg_query`

Query all active triples for a subject, optionally as of a historical date.

```typescript
// Input
{
  subject:  string;
  as_of?:   string;   // ISO 8601 date (default: today)
  relation?: string;  // optional filter
}
// Output: Triple[]
// Triple = { id, subject, relation, object, valid_from, valid_to, metadata }
```

### `mempalace_kg_timeline`

Return the full history of all triples touching a subject or room, ordered by `valid_from` ascending.

```typescript
// Input: { subject: string }
// Output: Triple[]   -- all time, including expired
```

### `mempalace_kg_invalidate`

Set `valid_to` on an active triple, marking it as no longer true. Used for model demotions, ownership transfers, and resolved blocks.

```typescript
// Input
{
  triple_id:  number;
  valid_to:   string;   // ISO 8601 date
  reason?:    string;   // logged to metadata
}
// Output: { success: boolean }
```

---

## Consistency Model

### Node Hierarchy (Single-Instance)

In NOS Town's default single-machine deployment, there is only one MemPalace MCP server instance. All agents write to it directly. The "Primary Historian" concept applies to multi-machine deployments:

- **Primary Historian node:** The machine running the nightly Historian batch job has authoritative write access to KG routing triples and model demotions.
- **Relay agents (Polecats, Witnesses):** Write council votes and discovery triples directly without going through the Historian.

### Eventual Consistency Rules

1. **Timestamping:** Every triple write includes a `created_at` timestamp with millisecond precision. In case of network partition between two MemPalace instances (multi-machine setup), `created_at` is used to order writes on merge.

2. **Most Informative Merge (MIM):** When two conflicting triples exist for the same `(subject, relation)` with overlapping `valid_from`/`valid_to` windows:
   - Count the fields in each triple's `metadata` JSON object
   - The triple with more metadata fields wins ("more informative")
   - If equal metadata richness: the triple with the later `valid_from` wins
   - Loser triple gets `valid_to = winner.valid_from - 1 day`

3. **Sync Heartbeat:** Every 500ms, the MemPalace server computes:
   ```
   hash = SHA-256(last_100_triple_ids + their_created_at values)
   ```
   This hash is exposed via `mempalace_status`. Agents compare their cached hash against this to detect if the KG has changed since their last read. If the hash differs, they must re-query before acting.

### Conflict Resolution Examples

```python
# Scenario: Two Witnesses simultaneously vote on the same PR
# Witness A writes:
kg.add_triple("witness_council_A", "approved", "auth-migration-PR#89",
              valid_from="2026-04-09",
              metadata={"score": "2/3", "model": "qwen3-32b"})

# Witness B writes (milliseconds later, different machine):
kg.add_triple("witness_council_B", "approved", "auth-migration-PR#89",
              valid_from="2026-04-09",
              metadata={"score": "3/3", "model": "qwen3-32b", "duration_ms": 1200})

# These are NOT conflicting — different subjects (council_A vs council_B).
# Both are valid. The Mayor queries by object to see all votes:
kg.query_entity("auth-migration-PR#89")  # returns both council votes
```

```python
# Scenario: Historian writes routing lock, then model degrades
# Initial lock:
kg.add_triple("llama-3.1-8b", "locked_to", "typescript_generics",
              valid_from="2026-04-01",
              metadata={"success_rate": 0.97, "sample_size": 523})

# After model degrades, Historian invalidates and writes demotion:
kg.invalidate(triple_id=..., valid_to="2026-04-09", reason="prompt_drift")
kg.add_triple("llama-3.1-8b", "demoted_from", "typescript_generics",
              valid_from="2026-04-09",
              metadata={"reason": "prompt_drift", "new_score": 0.78})

# Mayor queries current state:
kg.query_entity("llama-3.1-8b", as_of="2026-04-10")
# Returns: demoted_from typescript_generics (active), locked_to expired
```

---

## Retention & Privacy

- **Triples never deleted:** Once written, triples are permanent (append-only). Invalidation sets `valid_to` but does not delete the row. This provides a complete audit trail.
- **PII filter:** The Historian's nightly pipeline runs a PII-stripping pass before writing any code-content or description fields to the KG. Only task types, model IDs, and room names are stored — never raw code or credential patterns.
- **Cross-rig isolation:** Triples for different Rig wings are namespaced by rig prefix in `subject`/`object`. A query for `rig_tcgliveassist` does not return results for `rig_openclaw` unless a Tunnel explicitly links them.
- **SQLite file location:** `palace-db/knowledge_graph.sqlite`. Back this up before any MemPalace version upgrades.

---

## Bootstrap: Initial State

Before the Historian has enough Bead data to write KG routing triples (first week of operation), NOS Town bootstraps from the static routing table in ROUTING.md. The bootstrap script writes those defaults as KG triples with `valid_from = "2026-01-01"` and `agent_id = "bootstrap"`:

```bash
# Run once on first startup to seed KG from static routing table:
npx tsx src/historian/bootstrap-kg.ts --routing-table docs/ROUTING.md
```

Once 100+ Beads have been processed by the Historian, the bootstrap triples are superseded by empirical routing locks and the static table is no longer consulted.

---

## See Also

- [MEMPALACE.md](./MEMPALACE.md) — Full palace hierarchy, MCP tool list, ChromaDB integration
- [HISTORIAN.md](./HISTORIAN.md) — How and when the Historian writes routing triples
- [ROUTING.md](./ROUTING.md) — Static routing table (bootstrap only once KG is populated)
- [HARDENING.md](./HARDENING.md) — MIM conflict resolution requirements and consistency checklist
