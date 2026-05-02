# NOS Town Roles - Performance Optimized

> Internal runway note: this document describes the legacy/future role runtime.
> It is not the current public UX, `nt gascity` bridge schema, or Gas City
> integration contract. Current operator language is Queen/Hive/Swarm/Comb, and
> the bridge remains role-neutral.

High-fidelity role definitions for the NOS Town multi-agent system. Each role is tuned for Groq's low-latency, high-throughput environment, utilizing the "Preview-Primary" strategy for maximum capability.

---

## Overview

NOS Town roles are designed to exploit Groq's unique properties:
1. **Sub-second latency** enables multi-round consensus and "just-in-time" quality checks.
2. **Massive throughput** allows for large agent swarms (20-50+ instances) without serial bottlenecks.
3. **Preview-Primary Strategy** prioritizes cutting-edge performance while maintaining production stability.
4. **KG-Backed Memory** gives every role access to persistent routing decisions and audit history via the Knowledge Graph.

---

## Role Hierarchy

```text
The Mayor (groq/compound)       ← Agentic orchestrator + KG consumer
├── Rig: Crew Swarm
│   ├── Polecat (llama-4-scout)  ← High-speed code traversal
│   ├── Witness (qwen3-32b)      ← Multi-judge consensus + KG vote logger
│   └── Deacon (8B Router)       ← Ephemeral routing
├── Refinery (gpt-oss-120b)     ← Synthesis & reasoning
├── Historian (Batch API)       ← Institutional memory + KG writer
└── Safeguard (gpt-oss-20b)     ← Real-time security sentry + in-process pattern cache
```

---

## Mayor

**Primary Model:** `groq/compound` **Fallback Model:** `llama-3.3-70b-versatile`

**Quality Tuning:**
- **Ledger-First Recovery:** On startup, Mayor reads the Ledger for any in-progress or pending beads from a prior session. Orphan beads are adopted and logged via `MAYOR_ADOPTION` audit entry.
- **KG Routing Lookup:** Before decomposing, Mayor queries the KG for any `locked_to` or `demoted_from` triples to select the optimal model for each bead's task type.
- **Task Decomposition:** Mayor must break goals into "Micro-Beads" (< 50 lines of code) to maximize 8B Polecat success rate.
- **Local Checkpoint:** Mayor generates a session-local `ckpt_<uuid>` checkpoint before dispatch. No bead may be dispatched without a valid `plan_checkpoint_id`.
- **Chain-of-Verification (CoVe):** Mayor drafts the plan and self-critiques for dependencies before assigning to Crew.
- **Dispatch Guard:** Mayor may not emit `BEAD_DISPATCH` until the convoy bus confirms the stored `plan_checkpoint_id`.
- **Critical Path Annotation:** During decomposition, Mayor computes `fan_out_weight` and marks `critical_path` beads so convoy scheduling is dependency-aware.

**Orchestration Steps:**
```
1. Check Ledger for orphan beads (startup recovery)
2. Read KG routing locks for task_type
3. Decompose goal → Micro-Beads
4. Annotate beads with critical_path, fan_out_weight, plan_checkpoint_id
5. Dispatch signed convoys to Polecats
```

---

## Polecat (Swarm Agent)

**Primary Model:** `meta-llama/llama-4-scout-17b-16e-instruct` **Fallback Model:** `llama-3.1-8b-instant`

**Quality Tuning:**
- **Atomic Operations:** Polecats only handle one Micro-Bead at a time.
- **Fast-Failure:** If a Polecat cannot resolve a dependency in < 5 seconds, it must abort and request a "Planning Council" via the Mayor.
- **Ledger Write:** On completion, Polecat writes outcome to the Ledger.

**Optimized Prompt:**
```markdown
You are a NOS Town Polecat. Execute this Micro-Bead: {bead_details}.
CONSTRAINTS:
- Use provided toolsets ONLY.
- Write minimal, testable code.
- If context is missing, output `STATUS: BLOCKED` and specify the missing context.
- On Bead completion, write your outcome to the Beads Ledger as normal.
```

---

## Witness (The Judge)

**Primary Model:** `qwen/qwen3-32b` **Fallback Model:** `llama-3.3-70b-versatile`

**Quality Tuning:**
- **Blind Review:** Witness reviews code without seeing the Polecat's reasoning, only the diff and the requirement.
- **Consensus Ladder:** For critical PRs, 3 Witnesses run in parallel; 2/3 majority required to merge.
- **KG Vote Logging:** After every council decision, the lead Witness writes the vote as a KG triple. This enables the Mayor to query the full approval/rejection history of any room before re-planning.

**Witness KG Protocol:**
```typescript
// After every council vote:
kg.addTriple({
  subject: `witness_council_${councilId}`,
  relation: approved ? 'approved' : 'rejected',
  object: `${rigName}-${prId}`,
  valid_from: today,
  metadata: { score: `${votes}/3`, model: 'qwen3-32b', reason: rejectionReason },
});
```

---

## Refinery (Reasoning/Synthesis)

**Primary Model:** `openai/gpt-oss-120b` **Fallback Model:** `llama-3.3-70b-versatile`

**Triggered when:**
- Witness council rejects with score 0/N (unanimous failure)
- `task_type` is `architecture` or `security` and 2+ prior attempts failed
- Mayor explicitly marks a bead `refinery_required: true`

**Quality Tuning:**
- **High-Token Reasoning:** Used for architectural decisions and complex bug root-cause analysis where 17B models lack depth.
- **KG Write:** Architectural decisions made by the Refinery are written as permanent KG triples (`architectural_decision` relation), not just session notes.

---

## Safeguard (Security Sentry)

**Primary Model:** `openai/gpt-oss-safeguard-20b` **Fallback Model:** `llama-3.1-8b-instant`

**Quality Tuning:**
- **Zero-Latency Scan:** Runs on every diff generated by a Polecat before it reaches a Witness.
- **Hard Stop:** Any detected credential leakage or destructive CLI commands result in an immediate `LOCKDOWN` signal to the Mayor.
- **In-Process Pattern Cache:** Safeguard caches newly discovered vulnerability patterns in memory for the duration of the session. These are session-local — patterns learned in one session are not carried to the next.
- **Lockdown KG Entry:** Every LOCKDOWN event is written as a KG triple so the Mayor can query the history of lockdowns by type.
- **Pooled Execution:** Safeguard runs as a worker pool with a shared ruleset cache; no production design may assume a singleton Safeguard worker.

**Safeguard Scan Protocol:**
```
Before scanning each diff:
1. Load in-process pattern cache (from prior scans this session)
2. Run static rule check (hardcoded patterns)
3. If critical rule fires → LOCKDOWN immediately; skip LLM scan
4. Run LLM semantic scan with cached patterns as priors
5. If new high/critical pattern found → add to in-process cache
6. If LOCKDOWN triggered → write KG triple: lockdown_{id} triggered_by {vuln_type}
```

---

## Historian

See [HISTORIAN.md](./HISTORIAN.md) for the full pipeline. Summary:

**Primary Model:** `Batch API (llama-3.1-8b)`

**Quality Tuning:**
- **Ledger Mining:** Historian reads the Ledger to cluster Beads by task_type, model, and outcome — no external data source required.
- **Playbook Generation:** High-success clusters (>90% rate, ≥20 samples) trigger a Groq Batch 70B reasoning pass to synthesize a Golden Path Playbook. Written as a KG triple.
- **Routing KG Updates:** Model promotion/demotion decisions are written as KG triples with `valid_from` timestamps.
- **AAAK Manifest:** Generates a compressed Bead manifest for Mayor context loading.

---

## See Also

- [HISTORIAN.md](./HISTORIAN.md) — Updated Historian pipeline
- [ROUTING.md](./ROUTING.md) — KG-backed routing: model selection and lock/demotion protocol
- [KNOWLEDGE_GRAPH.md](./KNOWLEDGE_GRAPH.md) — KG schema, triple writes, MIM conflict resolution
