# NOS Town Fork Strategy — Upstream Sync & Divergence

Architectural relationship between NOS Town and the upstream Gas Town project.

---

## Overview

NOS Town is a **runtime-specialized fork** of [Gas Town](https://github.com/gastownhall/gastown). While Gas Town focuses on the "City Planning" (the organizational logic of AI agents), NOS Town focuses on the "Power Plant" (optimizing that logic for Groq's high-speed inference).

Our strategy is to remain **Schema Compatible** with Gas Town while being **Execution Divergent**.

---

## Relationship Matrix

| Aspect | Gas Town (Upstream) | NOS Town (Fork) | Sync Strategy |
|--------|----------------------|-----------------|---------------|
| **Core Schema** | Beads, Hooks, Convoys | **Identical** | Full Sync (Automated) |
| **Agent Roles** | Mayor, Witness, Deacon | **Extended** | Manual Adapter |
| **Inference** | Claude Code (IDE) | **Groq API (Cloud)** | No Sync (Diverged) |
| **Quality Gate**| Single Model Review | **Consensus Council** | No Sync (Diverged) |
| **Persistence** | Session-based | **Historian Playbooks** | No Sync (Diverged) |

---

## What We Sync (The "Hard" Core)

NOS Town maintains 1:1 compatibility with Gas Town's data structures. This ensures that any codebase managed by Gas Town can be immediately "powered up" by NOS Town.

- **Hook Format:** We follow the upstream `.hook` file specification exactly.
- **Bead Schema:** We maintain the JSON structure of the Beads ledger.
- **Mailbox Protocol:** Role-to-role communication files remain compatible.

---

## Where We Diverge (The "Soft" Shell)

NOS Town deliberately breaks from Gas Town in the **Agent Implementation** layer to exploit Groq's performance.

### 1. Model Heterogeneity
Upstream assumes a single frontier model (Claude 3.5/3.7). NOS Town uses a **Routing Table** to swap between 8B, 70B, and 120B models mid-flight.

### 2. Witness Council
Upstream uses a single Witness. NOS Town implements a **Council Mode** (3+ parallel 70B models) because Groq's speed makes consensus cheaper and faster than a single serial Claude call.

### 3. The Historian
Upstream has no persistent "Institutional Memory." NOS Town's Historian is a unique addition that mines successful patterns into Playbooks.

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

# 3. Adapt Role Prompts (Manual)
# We review upstream role changes and translate them into the 
# NOS Town "Performance Optimized" prompt format.
```

---

## Contribution Policy

- **Core Architectural Fixes:** Bug fixes in the Bead or Hook logic should be submitted to **Gas Town Upstream** first.
- **Performance/Model Enhancements:** Groq-specific optimizations, new Council patterns, or Historian logic should be submitted to **NOS Town**.
- **Compatibility:** Always verify that NOS Town remains capable of reading a standard Gas Town ledger.
