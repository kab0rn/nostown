# NOS Town Historian — Persistence & Memory

Institutional memory system for mining patterns and optimizing the NOS Town multi-agent swarm.

---

## Overview

The Historian is the "institutional brain" of NOS Town. While other agents focus on immediate tasks (Beads), the Historian analyzes the long-term trace of the system. It runs primarily as an offline process via **Groq Batch**, transforming raw execution logs into reusable **Playbooks** and optimized routing configurations.

---

## Core Memory Structures

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

### 2. Playbooks (Golden Paths)
Distilled implementation strategies that guide future agents. 

docs: Enhance HISTORIAN.md with persistence pipeline and model evolution logic- **Trigger:** Semantic description of the task (e.g., "Implement JWT Auth").
- **Strategy:** Step-by-step logic validated by previous successes.
docs: Enhance HISTORIAN.md with persistence pipeline and model evolution logicdocs: Enhance HISTORIAN.md with persistence pipeline and model evolution logic
---
docs: Enhance HISTORIAN.md with persistence pipeline and model evolution logic## The Historian Pipeline
docs: Enhance HISTORIAN.md with persistence pipeline and model evolution logic    participant P as Playbook Index
    participant R as Routing Table

    Note over H: Nightly Batch Run
    L->>H: Export last 24h Beads
    H->>H: Cluster by Task + Similarity
    H->>H: Identify High-Score Patterns
    H->>P: Generate/Update Playbooks
    H->>H: Benchmark Model Success Rates
    H->>R: Propose Routing Table Updates
```

---

## Implementation Detail: Pattern Mining

The Historian uses a **Semantic Clustering** approach to group tasks:

1. **Embedding:** Every Bead description is embedded using a small model.
2. **Clustering:** Beads with similar embeddings are grouped (e.g., all "database migrations").
3. **Pattern Extraction:** For each group, the Historian asks a 70B model:
   *"Review these 50 successful Beads. What is the common implementation pattern? What errors occurred in the 5 failed ones?"*
4. **Playbook Update:** The output is formatted as a Markdown Playbook and committed to `playbooks/`.

---

## Model Evolution & Benchmarking

The Historian is responsible for **Automatic Model Promotion**:

- **Promotion Path:** If `llama-3.1-8b` maintains a >95% success rate for a specific cluster over 500 Beads, the Historian updates the routing table to lock that task to 8B.
- **Demotion Path:** If a model's score drops <80% after a provider update (Prompt Drift), the Historian flags it for escalation to 70B and notifies the Mayor.

---

## Retention & Privacy

- **Short-term Memory:** Raw Beads are kept for 30 days for active debugging.
- **Long-term Memory:** Distilled Playbooks and Performance Metrics are permanent.
- **Privacy Filter:** Before mining, the Historian runs a PII-stripping pass on code snippets to ensure sensitive data doesn't leak into the Playbook index.
