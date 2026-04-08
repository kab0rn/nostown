# NOS Town Fork Strategy — Upstream Sync & Divergence

Architectural relationship between NOS Town and the upstream Gas Town project.

---

## Overview

NOS Town is a **runtime-specialized fork** of [Gas Town](https://github.com/gastownhall/gastown). While Gas Town focuses on the "City Planning" (the organizational logic of AI agents), NOS Town focuses on the "Power Plant" (optimizing that logic for Groq's high-speed inference) **and the "Memory Palace"** (giving agents persistent, structured, cross-session memory via MemPalace).

Our strategy is to remain **Schema Compatible** with Gas Town while being **Execution Divergent** and **Memory Divergent**.

---

## Relationship Matrix

| Aspect | Gas Town (Upstream) | NOS Town (Fork) | Sync Strategy |
|---|---|---|---|
| **Core Schema** | Beads, Hooks, Convoys | **Identical** | Full Sync (Automated) |
| **Agent Roles** | Mayor, Witness, Deacon | **Extended** | Manual Adapter |
| **Inference** | Claude Code (IDE) | **Groq API (Cloud)** | No Sync (Diverged) |
| **Quality Gate** | Single Model Review | **Consensus Council** | No Sync (Diverged) |
| **Persistence** | Session-based | **MemPalace + Historian Playbooks** | No Sync (Diverged) |
| **Memory Layer** | None | **MemPalace (Palace + KG + Diaries)** | No Sync (NOS Town only) |
| **Routing** | Static config | **KG-backed temporal triples** | No Sync (NOS Town only) |

---

## What We Sync (The "Hard" Core)

NOS Town maintains 1:1 compatibility with Gas Town's data structures. This ensures that any codebase managed by Gas Town can be immediately "powered up" by NOS Town.

- **Hook Format:** We follow the upstream `.hook` file specification exactly. MemPalace *augments* hooks (L0+L1 wake-up replaces hook reads at session start) but does not change the hook schema.
- **Bead Schema:** We maintain the JSON structure of the Beads ledger. MemPalace Drawers store verbatim Bead JSON as the raw source material.
- **Mailbox Protocol:** Role-to-role communication files remain compatible. Mailbox events are additionally logged to `hall_events` in the relevant Rig wing.

---

## Where We Diverge (The "Soft" Shell)

NOS Town deliberately breaks from Gas Town in three layers:

### 1. Model Heterogeneity

Upstream assumes a single frontier model (Claude 3.5/3.7). NOS Town uses a **Routing Table** to swap between 8B, 70B, and 120B models mid-flight, now backed by temporal KG triples rather than a static markdown table.

### 2. Witness Council

Upstream uses a single Witness. NOS Town implements a **Council Mode** (3+ parallel 70B models) because Groq's speed makes consensus cheaper and faster than a single serial Claude call. Council votes are now logged to the MemPalace Knowledge Graph as permanent triples.

### 3. The Historian

Upstream has no persistent "Institutional Memory." NOS Town's Historian mines successful patterns into Playbooks, now stored in MemPalace's `hall_advice` rooms (semantically searchable) rather than flat markdown files.

### 4. MemPalace Memory Layer (New Divergence)

Upstream has no cross-session memory system. NOS Town adds MemPalace as a first-class architectural primitive:

- **Palace hierarchy** (Wings → Rooms → Halls → Closets → Drawers) replaces flat `.hook` files for context loading
- **Knowledge Graph** (temporal SQLite triple store) replaces static routing tables and provides audit-trail-capable history
- **MCP server** (19 tools) exposes the full palace to every NOS Town agent
- **Per-role diaries** give each agent (Mayor, Witness, Safeguard, Historian) accumulated expertise that persists across sessions
- **Cross-Rig Tunnels** connect shared rooms across projects — a feature impossible in the session-based upstream

This is the deepest divergence from Gas Town and the primary value-add of NOS Town over the upstream.

---

## Upstream Sync Workflow

We use a "Cherry-Pick" strategy to avoid runtime pollution.

```bash
# 1. Fetch upstream updates
git remote add upstream https://github.com/gastownhall/gastown.git
git fetch upstream

# 2. Sync Schema changes (Hooks, Beads, Mailbox) — MemPalace-safe
git checkout main
git checkout -b sync/upstream-schema
git checkout upstream/main -- src/schema/ hooks/ docs/protocol.md
git commit -m "sync: update core schemas from gastown upstream"

# 3. Verify MemPalace integration still valid after schema sync
# Ensure Bead JSON schema additions don't break MemPalace Drawer storage
mempalace validate --wing wing_rig_myproject

# 4. Adapt Role Prompts (Manual)
# We review upstream role changes and translate them into
# the NOS Town "Performance Optimized + Palace Memory" prompt format.
```

---

## Contribution Policy

- **Core Architectural Fixes:** Bug fixes in the Bead or Hook logic should be submitted to **Gas Town Upstream** first.
- **Performance/Model Enhancements:** Groq-specific optimizations, new Council patterns, or Historian logic should be submitted to **NOS Town**.
- **MemPalace Enhancements:** Palace hierarchy, KG schema changes, AAAK dialect improvements, and MCP tool additions go to **MemPalace upstream** (milla-jovovich/mempalace) and are consumed by NOS Town via version pinning.
- **Compatibility:** Always verify that NOS Town remains capable of reading a standard Gas Town ledger after any schema changes.

---

## See Also

- [MEMPALACE.md](./MEMPALACE.md) — Full MemPalace architecture — NOS Town's memory divergence layer
- [HISTORIAN.md](./HISTORIAN.md) — How the Historian mines Beads into MemPalace wings
- [ROUTING.md](./ROUTING.md) — KG-backed routing evolution replacing static markdown tables
