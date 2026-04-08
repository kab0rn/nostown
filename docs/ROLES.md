# NOS Town Roles - Performance Optimized

High-fidelity role definitions for the NOS Town multi-agent system. Each role is tuned for Groq's low-latency, high-throughput environment, utilizing the "Preview-Primary" strategy for maximum capability.

---

## Overview

NOS Town roles are designed to exploit Groq's unique properties:
1. **Sub-second latency** enables multi-round consensus and "just-in-time" quality checks.
2. **Massive throughput** allows for large agent swarms (20-50+ instances) without serial bottlenecks.
3. **Preview-Primary Strategy** prioritizes cutting-edge performance while maintaining production stability.
4. **Palace Memory** gives every role persistent, cross-session memory via MemPalace wings and the Knowledge Graph.

---

## Role Hierarchy

```text
The Mayor (groq/compound)       ← Agentic orchestrator + memory steward
├── Rig: Crew Swarm
│   ├── Polecat (llama-4-scout)  ← High-speed code traversal
│   ├── Witness (qwen3-32b)      ← Multi-judge consensus + KG vote logger
│   └── Deacon (8B Router)       ← Ephemeral routing
├── Refinery (gpt-oss-120b)     ← Synthesis & reasoning
├── Historian (Batch API)       ← Institutional memory + MemPalace miner
└── Safeguard (gpt-oss-20b)     ← Real-time security sentry + vuln memory
```

---

## Mayor

**Primary Model:** `groq/compound` **Fallback Model:** `llama-3.3-70b-versatile`

**MemPalace Wing:** `wing_mayor`

**Quality Tuning:**
- **Palace-First Context:** Mayor calls `mempalace_status` then `mempalace wake-up` to load L0+L1 (~170 tokens) before reading `.hook` files. This gives full cross-session project context, not just the last manually-written hook.
- **Task Decomposition:** Mayor must break goals into "Micro-Beads" (< 50 lines of code) to maximize 8B Polecat success rate.
- **Playbook Lookup:** Before decomposing, Mayor calls `mempalace_search` against the relevant Rig wing + `hall_advice` to check for an existing Playbook match. If found, Polecat is given the Playbook as a Golden Path.
- **Chain-of-Verification (CoVe):** Mayor must draft the plan, self-critique for dependencies, then query `mempalace_kg_timeline({room})` for any past Witness rejections before assigning to Crew.

**Optimized Prompt:**
```markdown
You are the Mayor of NOS Town. Your goal is to orchestrate a swarm of agents to complete: {goal}.
STRICT PROTOCOL:
1. CALL mempalace_status → load AAAK spec and memory protocol.
2. CALL mempalace wake-up --wing wing_rig_{project} → load L0+L1 context (~170 tokens).
3. CALL mempalace_kg_query for current team assignments and any open blocked rooms.
4. CALL mempalace_search "{goal_keywords}" --wing wing_rig_{project} --hall hall_advice → check for Playbook match.
5. READ .hook files for any delta since last palace save.
6. DECOMPOSE the goal into discrete, non-overlapping Micro-Beads.
7. VERIFY that Bead B does not depend on Bead A unless explicitly sequenced in a Convoy.
8. ASSIGN each Bead to a Polecat. High-risk Beads (Auth/DB) MUST flag `witness_required: true`.
9. OUTPUT: Return a valid JSON Beads ledger.
```

---

## Polecat (Swarm Agent)

**Primary Model:** `meta-llama/llama-4-scout-17b-16e-instruct` **Fallback Model:** `llama-3.1-8b-instant`

**Quality Tuning:**
- **Atomic Operations:** Polecats only handle one Micro-Bead at a time.
- **Fast-Failure:** If a Polecat cannot resolve a dependency in < 5 seconds, it must abort and request a "Planning Council" via the Mayor.
- **Discovery Logging:** When a Polecat resolves a BLOCKED state (finds the missing context), it calls `mempalace_add_drawer` to save the resolution to `hall_discoveries` in the current Rig wing.

**Optimized Prompt:**
```markdown
You are a NOS Town Polecat. Execute this Micro-Bead: {bead_details}.
CONSTRAINTS:
- Use provided toolsets ONLY.
- Write minimal, testable code.
- If context is missing, output `STATUS: BLOCKED` and specify the missing `.hook`.
- If you resolve a BLOCKED state, call mempalace_add_drawer(wing=wing_rig_{project}, hall=hall_discoveries, room={task_room}, content={resolution_summary}).
- On Bead completion, write your outcome to the Beads Ledger as normal.
```

---

## Witness (The Judge)

**Primary Model:** `qwen/qwen3-32b` **Fallback Model:** `llama-3.3-70b-versatile`

**MemPalace Wing:** `wing_witness`

**Quality Tuning:**
- **Blind Review:** Witness reviews code without seeing the Polecat's reasoning, only the diff and the requirement.
- **Consensus Ladder:** For critical PRs, 3 Witnesses run in parallel; 2/3 majority required to merge.
- **KG Vote Logging:** After every council decision, the lead Witness calls `mempalace_kg_add` to record the vote as a triple. This enables the Mayor to query the full approval/rejection history of any room before re-planning.
- **Pattern Memory:** Witness reads its own diary (`mempalace_diary_read --wing wing_witness`) before reviewing a room it has seen before — giving it memory of previous rejection reasons.

**Witness KG Protocol:**
```python
# After every council vote:
kg.add_triple(
    subject=f"witness_council_{council_id}",
    relation="approved" if passed else "rejected",
    object=f"{room_name}-{pr_id}",
    valid_from=today,
    metadata={"score": f"{votes}/3", "model": "qwen3-32b", "reason": rejection_reason}
)
```

---

## Refinery (Reasoning/Synthesis)

**Primary Model:** `openai/gpt-oss-120b` **Fallback Model:** `llama-3.3-70b-versatile`

**Quality Tuning:**
- **High-Token Reasoning:** Used for architectural decisions and complex bug root-cause analysis where 17B models lack depth.
- **Discovery Storage:** Architectural decisions made by the Refinery are written to `hall_facts` in the Rig wing as permanent KG triples, not just session notes.

---

## Safeguard (Security Sentry)

**Primary Model:** `openai/gpt-oss-safeguard-20b` **Fallback Model:** `llama-3.1-8b-instant`

**MemPalace Wing:** `wing_safeguard`

**Quality Tuning:**
- **Zero-Latency Scan:** Runs on every diff generated by a Polecat before it reaches a Witness.
- **Hard Stop:** Any detected credential leakage or destructive CLI commands result in an immediate `LOCKDOWN` signal to the Mayor.
- **Vulnerability Memory:** Safeguard writes every detected vulnerability pattern to `wing_safeguard / hall_facts / room: vuln-patterns` as a permanent Drawer. Before scanning a new diff, Safeguard reads its diary to apply learned patterns — making it smarter over time without retraining.
- **Lockdown KG Entry:** Every LOCKDOWN event is written as a KG triple so the Mayor can query the history of lockdowns by room/type.

**Safeguard Vuln Memory Protocol:**
```markdown
Before scanning each diff:
1. CALL mempalace_diary_read --wing wing_safeguard → load known vuln patterns
2. Run scan against diff using known patterns as priors
3. If new pattern found: CALL mempalace_add_drawer(wing=wing_safeguard, hall=hall_facts, room=vuln-patterns, content={pattern_description})
4. If LOCKDOWN triggered: CALL mempalace_kg_add("lockdown_{id}", "triggered_by", "{vuln_type}", valid_from=today)
```

---

## Historian

See [HISTORIAN.md](./HISTORIAN.md) for the full updated pipeline. Summary of role changes:

**Primary Model:** `Batch API (llama-3.1-8b)` **MemPalace Wing:** `wing_historian`

**Quality Tuning:**
- **MemPalace Miner:** Historian now runs `mempalace mine --mode convos` on the nightly Beads export, replacing the manual 70B clustering pass for pattern classification. The miner auto-classifies Beads into halls: facts, events, discoveries, preferences, advice.
- **Playbook → hall_advice:** Generated Playbooks are stored as Drawers in `hall_advice` rooms (semantically searchable) instead of flat markdown files.
- **Routing Table → KG:** Model promotion/demotion decisions are written as KG triples with `valid_from` timestamps, replacing the static routing table markdown update.
- **Cross-Rig Tunnel Discovery:** Historian checks for Tunnel-eligible rooms (same room name across multiple Rig wings) and registers them, enabling cross-project knowledge sharing.

---

## See Also

- [MEMPALACE.md](./MEMPALACE.md) — Full MemPalace architecture, palace hierarchy, KG schema, MCP tool reference
- [HISTORIAN.md](./HISTORIAN.md) — Updated Historian pipeline with MemPalace mining
- [ROUTING.md](./ROUTING.md) — Palace-aware routing: Playbook match check before model selection
