# NOS Town Fork Strategy — Upstream Sync & Divergence

Architectural relationship between NOS Town and the upstream Gas Town project.

---

## Overview

NOS Town is a **runtime-specialized fork** of [Gas Town](https://github.com/gastownhall/gastown). While Gas Town focuses on the "City Planning" (the organizational logic of AI agents), NOS Town focuses on the "Power Plant" (optimizing that logic for Groq's high-speed inference) and the **Knowledge Graph** (giving agents persistent, structured, cross-session memory via a local SQLite triple store — no external sidecar required).

Our strategy is to remain **Schema Compatible** with Gas Town while being **Execution Divergent** and **Persistence Divergent**.

---

## Relationship Matrix

| Aspect | Gas Town (Upstream) | NOS Town (Fork) | Sync Strategy |
|---|---|---|---|
| **Core Schema** | Beads, Hooks, Convoys | **Identical** | Full Sync (Automated) |
| **Agent Roles** | Mayor, Witness, Deacon | **Extended** | Manual Adapter |
| **Inference** | Claude Code (IDE) | **Groq API (Cloud)** | No Sync (Diverged) |
| **Quality Gate** | Single Model Review | **Consensus Council** | No Sync (Diverged) |
| **Persistence** | Session-based | **Ledger JSONL + SQLite KG** | No Sync (Diverged) |
| **Memory Layer** | None | **KG temporal triples + Historian Playbooks** | No Sync (NOS Town only) |
| **Routing** | Static config | **KG-backed temporal triples** | No Sync (NOS Town only) |

---

## What We Sync (The "Hard" Core)

NOS Town maintains 1:1 compatibility with Gas Town's data structures. This ensures that any codebase managed by Gas Town can be immediately "powered up" by NOS Town.

- **Hook Format:** We follow the upstream `.hook` file specification exactly without modification.
- **Bead Schema:** We maintain the JSON structure of the Beads ledger (`rigs/<rig>/beads/current.jsonl`) verbatim.
- **Mailbox Protocol:** Role-to-role communication files remain compatible.

---

## Where We Diverge (The "Soft" Shell)

NOS Town deliberately breaks from Gas Town in three layers:

### 1. Model Heterogeneity

Upstream assumes a single frontier model (Claude 3.5/3.7). NOS Town uses a **Routing Table** to swap between 8B, 70B, and 120B models mid-flight, backed by temporal KG triples rather than a static markdown table.

### 2. Witness Council

Upstream uses a single Witness. NOS Town implements a **Council Mode** (3+ parallel 70B models) because Groq's speed makes consensus cheaper and faster than a single serial Claude call. Council votes are logged to the Knowledge Graph as permanent triples.

### 3. The Historian + Knowledge Graph

Upstream has no persistent "Institutional Memory." NOS Town's Historian mines successful patterns into Playbooks stored as KG triples (queryable, temporally-versioned) rather than flat markdown files. The KG at `kg/knowledge_graph.sqlite` is the authoritative source for routing state, council votes, and architectural decisions across all sessions.

There is no external memory server or MCP sidecar — all persistence is in-process via `src/kg/` (SQLite) and the Ledger (JSONL).

---

## Upstream Sync Workflow

We use a "Cherry-Pick" strategy to avoid runtime pollution.

```bash
# 1. Fetch upstream updates
git remote add upstream https://github.com/gastownhall/gastown.git
git fetch upstream

# 2. Sync Schema changes (Hooks, Beads, Mailbox)
git checkout main
git checkout -b sync/upstream-schema
git checkout upstream/main -- src/schema/ hooks/ docs/protocol.md
git commit -m "sync: update core schemas from gastown upstream"

# 3. Verify KG schema is still valid after sync
# Ensure Bead JSON schema additions don't break KG triple writes
npm test  # KG integration tests cover this

# 4. Adapt Role Prompts (Manual)
# We review upstream role changes and translate them into
# the NOS Town "Performance Optimized + KG-backed" prompt format.
```

---

## Contribution Policy

- **Core Architectural Fixes:** Bug fixes in the Bead or Hook logic should be submitted to **Gas Town Upstream** first.
- **Performance/Model Enhancements:** Groq-specific optimizations, new Council patterns, or Historian logic should be submitted to **NOS Town**.
- **KG Schema Changes:** Triple vocabulary additions or consistency rule changes live in `docs/KNOWLEDGE_GRAPH.md` and `src/kg/`.
- **Compatibility:** Always verify that NOS Town remains capable of reading a standard Gas Town ledger after any schema changes.

---

## See Also

- [KNOWLEDGE_GRAPH.md](./KNOWLEDGE_GRAPH.md) — KG schema, tool reference, consistency model
- [HISTORIAN.md](./HISTORIAN.md) — How the Historian mines Beads into KG triples
- [ROUTING.md](./ROUTING.md) — KG-backed routing evolution replacing static markdown tables
