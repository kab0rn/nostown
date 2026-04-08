# NOS Town Historian — Persistence & Memory

Institutional memory system for mining patterns, storing Playbooks, and evolving the NOS Town multi-agent swarm. Powered by MemPalace.

---

## Overview

The Historian is the "institutional brain" of NOS Town. While other agents focus on immediate tasks (Beads), the Historian analyzes the long-term trace of the system. It runs primarily as an offline process via **Groq Batch**, transforming raw execution logs into reusable **Playbooks** stored in MemPalace's `hall_advice` rooms — making them semantically searchable by the Mayor on every future session.

**MemPalace Wing:** `wing_historian`

---

## Core Memory Structures

### 1. The Beads Ledger

The single source of truth for all system actions. Every agent writes to the ledger upon task completion. Structure is unchanged for Gas Town compatibility.

```json
{
  "bead_id": "892a-bc34",
  "role": "polecat",
  "task_type": "refactor_generic_type",
  "model": "llama-3.1-8b-instant",
  "metrics": {
    "test_pass": true,
    "witness_score": 92,
    "duration_ms": 1450,
    "tokens": 2400
  },
  "playbook_match": "typescript_generics_v2",
  "outcome": "SUCCESS"
}
```

### 2. Playbooks (Golden Paths) — Now in hall_advice

Distilled implementation strategies that guide future agents.

- **Trigger:** Semantic description of the task (e.g., "Implement JWT Auth").
- **Strategy:** Step-by-step logic validated by previous successes.
- **Storage:** Stored as Drawers in `wing_rig_{project} / hall_advice / room: {task_type}` — semantically searchable via `mempalace_search`.
- **Retrieval:** Mayor calls `mempalace_search "{goal}" --wing wing_rig_{project} --hall hall_advice` before every decomposition pass.

### 3. The Knowledge Graph (New)

Model routing decisions, Witness council votes, and architectural choices are stored as temporal triples in the MemPalace Knowledge Graph. This replaces static markdown routing table updates with time-aware, queryable state.

---

## The Historian Pipeline (Updated)

```
Nightly Batch Run
│
├─ 1. EXPORT last 24h Beads from Ledger
├─ 2. AAAK COMPRESS Bead manifest for Mayor context loading
├─ 3. MEMPALACE MINE (replaces 70B clustering pass)
│       mempalace mine ~/nos/beads/ --mode convos --wing wing_rig_{project}
│       └─ Auto-classifies each Bead into:
│           hall_facts        (permanent config/team truths)
│           hall_events       (session milestones)
│           hall_discoveries  (BLOCKED resolutions, root causes)
│           hall_preferences  (model routing preferences)
│           hall_advice       (Playbooks — validated strategies)
├─ 4. PLAYBOOK GENERATION (for high-score clusters)
│       Groq Batch 70B reasoning pass → Playbook markdown
│       mempalace_add_drawer(wing, hall=hall_advice, room={task_type}, content=playbook_md)
├─ 5. MODEL BENCHMARKING
│       Evaluate success rates per model per task cluster
│       Promotions/demotions written to KG (not routing table markdown):
│       kg.add_triple("llama-3.1-8b", "locked_to", "typescript_generics", valid_from=today)
├─ 6. TUNNEL DISCOVERY
│       mempalace_find_tunnels() → detect same room name across multiple Rig wings
│       Register cross-Rig tunnels for Mayor cross-project queries
└─ 7. HISTORIAN DIARY
        mempalace_diary_write(wing=wing_historian, content=nightly_summary_aaak)
```

---

## Implementation Detail: MemPalace Mining

The MemPalace miner replaces the previous manual semantic clustering + 70B embedding pass for basic classification. The miner uses its own lightweight classification model to sort Beads into halls automatically:

```bash
# Run after nightly Beads export:
mempalace mine ~/nos/beads/export_$(date +%Y%m%d).jsonl \
  --mode convos \
  --wing wing_rig_myproject \
  --auto-rooms
```

For high-confidence Playbook candidates (clusters of 10+ successful Beads with >90% success rate), the Historian still runs a **Groq Batch 70B pass** to synthesize the Golden Path reasoning. This is the only remaining 70B usage in the nightly pipeline — everything else is handled by the miner.

**Dual Indexing:** Beads are indexed in both MemPalace (ChromaDB, permanent, semantic) and the Groq Batch embedding store (fast, ephemeral, for immediate Polecat use during the next session). These complement each other.

---

## Model Evolution & Benchmarking (KG-Backed)

Model routing decisions are now KG triples with temporal validity, replacing the static markdown routing table:

```python
# Promotion: llama-3.1-8b achieves >95% on typescript_generics over 500 Beads
kg.add_triple(
    "llama-3.1-8b", "locked_to", "typescript_generics",
    valid_from="2026-04-08",
    metadata={"success_rate": 0.97, "sample_size": 523}
)

# Demotion: model score drops <80% after provider update (Prompt Drift)
kg.add_triple(
    "llama-3.1-8b", "locked_to", "typescript_generics",
    valid_to="2026-04-15",
    metadata={"reason": "prompt_drift", "new_score": 0.78}
)

# Mayor can query the current routing state at any time:
kg.query_entity("llama-3.1-8b", as_of=today)
# → shows all current locks, demotions, and the effective routing decision
```

This replaces the `## Routing Table Updates` section in ROUTING.md with a live, time-aware data store.

---

## AAAK Bead Manifest Compression

For Mayor context loading, the Historian generates an AAAK-compressed Bead manifest. This is **not** used for retrieval (raw ChromaDB mode is used for that) — it is used for the Mayor's planning pass context window:

```
# AAAK entity codes defined once per rig:
POL=polecat | WIT=witness | L8B=llama-3.1-8b-instant | L4S=llama-4-scout-17b
RIG=wing_rig_myproject | rfct.gen=refactor_generic_type

# Compressed Bead manifest (vs verbose JSON):
892a|POL|rfct.gen|L8B|pass|W92|1450ms|ts_generics_v2
7f3b|POL|auth.jwt|L4S|pass|W88|2100ms|jwt_auth_v3
4d9c|WIT|council|QW32|rej|score:1/3|null-check-missing
```

At 500+ Beads/day, AAAK manifest loading saves significant tokens vs. loading raw JSON.

---

## Retention & Privacy

- **Short-term Memory:** Raw Beads kept for 30 days in the Ledger for active debugging.
- **Long-term Memory:** MemPalace Drawers (Closets + verbatim) are permanent. Playbooks in `hall_advice` never expire.
- **KG History:** All model routing triples and Witness council votes are permanent with valid_from/valid_to windows.
- **Privacy Filter:** Before mining, the Historian runs a PII-stripping pass on code snippets to ensure sensitive data doesn't leak into Playbooks or Drawers.
- **Cross-Rig Isolation:** Each Rig wing is isolated by default. Tunnels are opt-in via Historian discovery — no cross-rig data leaks without explicit tunnel registration.

---

## See Also

- [MEMPALACE.md](./MEMPALACE.md) — Full MemPalace architecture, palace hierarchy, KG schema, MCP tool reference
- [ROLES.md](./ROLES.md) — Historian role summary and Mayor Playbook lookup protocol
- [ROUTING.md](./ROUTING.md) — How KG-backed routing decisions replace the static routing table
