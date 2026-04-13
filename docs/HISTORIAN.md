# NOS Town Historian — Persistence & Memory

Institutional memory system for mining patterns, generating Playbooks, and evolving the NOS Town multi-agent swarm. Backed by the Ledger (JSONL) and Knowledge Graph (SQLite) — no external sidecar required.

---

## Overview

The Historian is the "institutional brain" of NOS Town. While other agents focus on immediate tasks (Beads), the Historian analyzes the long-term trace of the system. It runs primarily as an offline process via **Groq Batch**, transforming raw execution logs into reusable **Playbooks** and KG routing decisions that improve Mayor model selection on every future session.

---

## Core Persistence Layers

### 1. The Beads Ledger

The single source of truth for all system actions. Every agent writes to the ledger upon task completion.

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

### 2. The Knowledge Graph

Model routing decisions, Witness council votes, and architectural choices are stored as temporal triples in `kg/knowledge_graph.sqlite`. This is the live, queryable source of truth for routing decisions.

---

## The Historian Pipeline

```
Nightly Run
│
├─ 1. MINE PATTERNS — read Ledger, cluster by task_type + model + outcome
├─ 2. GENERATE PLAYBOOKS — Groq Batch 70B reasoning pass for high-score clusters
│       Write KG triple: subject=task_type, relation=has_playbook, object=playbook_id
├─ 3. UPDATE ROUTING KG — compute success rates, write model promotion/demotion triples
│       kg.addTriple("llama-3.1-8b", "locked_to", "typescript_generics", valid_from=today)
└─ 4. RECORD RIG STATE — write KG triple for this nightly run
        kg.addTriple(rigName, "historian_run", "completed", valid_from=today)
```

---

## Model Evolution & Benchmarking (KG-Backed)

Model routing decisions are KG triples with temporal validity, replacing any static routing table:

```typescript
// Promotion: llama-3.1-8b achieves >95% on typescript_generics over 500 Beads
kg.addTriple({
  subject: 'llama-3.1-8b',
  relation: 'locked_to',
  object: 'typescript_generics',
  valid_from: today,
  metadata: { success_rate: 0.97, sample_size: 523 },
});

// Demotion: model score drops <80% after provider update (Prompt Drift)
kg.addTriple({
  subject: 'llama-3.1-8b',
  relation: 'demoted_from',
  object: 'typescript_generics',
  valid_from: today,
  metadata: { reason: 'prompt_drift', new_score: 0.78 },
});

// Mayor can query the current routing state at any time:
kg.queryTriples('llama-3.1-8b', today);
// → shows all current locks, demotions, and the effective routing decision
```

---

## AAAK Bead Manifest Compression

For Mayor context loading, the Historian generates an AAAK-compressed Bead manifest written as a KG triple. This is used for the Mayor's planning pass context window:

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
- **KG History:** All model routing triples and Witness council votes are permanent with valid_from/valid_to windows.
- **Privacy Filter:** Before mining, the Historian runs a PII-stripping pass on code snippets to ensure sensitive data doesn't leak into Playbooks or KG entries.
- **Cross-Rig Isolation:** Each rig's Ledger is isolated by default. The KG namespace is shared but keyed by rig name.

---

## See Also

- [ROLES.md](./ROLES.md) — Historian role summary and Mayor Playbook lookup protocol
- [ROUTING.md](./ROUTING.md) — How KG-backed routing decisions drive model selection
- [KNOWLEDGE_GRAPH.md](./KNOWLEDGE_GRAPH.md) — KG schema, MIM conflict resolution, consistency model
