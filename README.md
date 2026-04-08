# NOS Town

**Groq-native multi-agent orchestration system — agentic swarms, consensus councils, palace memory, and persistent work tracking at nitrous speed.**

---

## Overview

NOS Town is a high-performance workspace manager that coordinates swarms of AI coding agents running on Groq's LPU™ architecture. By leveraging sub-second inference, extreme throughput, and a structured persistent memory layer (MemPalace), NOS Town enables complex workflows—like multi-judge consensus, nightly institutional memory mining, and cross-session palace navigation—that are economically and technically impossible on conventional frontier models.

NOS Town is a spiritual reimagining of [Gas Town](https://github.com/gastownhall/gastown), rebuilt to exploit **Agentic Systems** (like Groq Compound), **Preview Models** (like Llama 4 Scout), and **Persistent Memory** (MemPalace) as first-class architectural primitives.

---

## The NOS Town Advantage

| Challenge | NOS Town Solution | Core Technology |
|---|---|---|
| Static Context | Work persists in git-backed **Hooks** + **Palace Wings** | MemPalace L0+L1 wake-up |
| Manual Handoffs | Built-in **Mailboxes** and **Deacons** | 8B Async Swarms |
| 4-10 Agent Limit | Scales comfortably to **20-50+ agents** | Groq Throughput |
| Hallucinations | **Witness Councils** (Multi-judge) | Parallel 70B/120B |
| Serial Planning | **Agentic Orchestration** | Groq Compound |
| Silent Regression | **Historian** mining and Playbooks | Groq Batch + MemPalace Mine |
| Session Memory Loss | **MemPalace** palace hierarchy + verbatim Drawers | ChromaDB + 94.8% R@10 |
| Flat Playbook Index | **hall_advice** semantic search | Palace-filtered ChromaDB |
| Routing Drift | **KG-backed routing** with temporal triples | SQLite Knowledge Graph |
| Rig Isolation | **Cross-Rig Tunnels** for shared room knowledge | MemPalace Tunnels |
| Security Risk | **Safeguard-20B** sentry + vuln memory | 1000 TPS + palace diary |

---

## Architecture

```text
NOS Town Workspace ~/nos/
│
├── The Mayor (groq/compound)        ← Agentic orchestrator and planner
│   ├── Palace wake-up (L0+L1)        ← ~170 tokens — replaces .hook reads
│   ├── Playbook search (hall_advice)  ← Before any Bead decomposition
│   ├── KG query (team + open rooms)   ← Temporal knowledge graph
│   └── Model routing table            ← KG-backed, live triples
│
├── Rig: Project A  (wing_rig_projecta)
│   ├── Hooks                          ← Git-backed workspace state (schema compat)
│   ├── Palace Rooms                   ← auth-migration, billing, ci-pipeline...
│   ├── Crew (Llama 4 Scout)           ← High-speed codebase traversal swarm
│   ├── Polecats (Llama 3.1 8B)        ← Ephemeral execution + discovery logging
│   └── Mailboxes                      ← Inter-agent message bus → hall_events
│
├── The Historian (Batch)             ← Nightly institutional memory mining
│   ├── mempalace mine (Beads)         ← Auto-classifies into halls
│   ├── hall_advice/                   ← Semantically searchable Playbooks
│   └── KG triples                     ← Model routing locks + demotions
│
├── MemPalace MCP Server (:7474)      ← 19-tool palace interface for all agents
│   ├── Wings → Rooms → Halls          ← Hierarchical namespace per Rig + role
│   ├── Closets (summaries)            ← Semantic search targets
│   ├── Drawers (verbatim Beads)       ← Permanent, never summarized
│   ├── Knowledge Graph                ← Temporal SQLite triple store
│   └── Tunnels                        ← Cross-Rig shared room connections
│
└── Safeguard (gpt-oss-20b)           ← Real-time security sentry + vuln memory
```

---

## Model Strategy: Preview-Primary

NOS Town uses a "Preview-Primary" strategy, prioritizing Groq's latest high-performance preview models while maintaining stable production fallbacks.

| Role | Primary Model (Preview/System) | Stable Fallback (Production) |
|---|---|---|
| **Mayor** | `groq/compound` | `llama-3.3-70b-versatile` |
| **Polecat** | `meta-llama/llama-4-scout-17b` | `llama-3.1-8b-instant` |
| **Witness** | `qwen/qwen3-32b` | `llama-3.3-70b-versatile` |
| **Refinery** | `openai/gpt-oss-120b` | `llama-3.3-70b-versatile` |
| **Safeguard** | `openai/gpt-oss-safeguard-20b` | `llama-3.1-8b-instant` |

---

## Documentation

- [**MEMPALACE.md**](./docs/MEMPALACE.md) — **Start here for memory.** Palace hierarchy, KG schema, AAAK compression, MCP tool reference, and setup.
- [**ROLES.md**](./docs/ROLES.md) — Role-by-role quality tuning, palace-first prompts, and agentic protocols.
- [**ROUTING.md**](./docs/ROUTING.md) — The escalation ladder, Playbook short-circuit, KG-backed routing evolution, cross-rig tunnels.
- [**HISTORIAN.md**](./docs/HISTORIAN.md) — MemPalace mining pipeline, Playbook generation, AAAK Bead manifest compression.
- [**FORK_STRATEGY.md**](./docs/FORK_STRATEGY.md) — Relationship to upstream Gas Town: what we sync, what we diverge, MemPalace as a NOS Town-only layer.
- [**GROQ_INTEGRATION.md**](./docs/GROQ_INTEGRATION.md) — SDK setup, Batch API, and performance matrix.

---

## Production Hardening

- [**HARDENING.md**](./docs/HARDENING.md) — Production hardening roadmap: resilience, data integrity, and transport security pillars.
- [**RESILIENCE.md**](./docs/RESILIENCE.md) — Groq failover logic, local fallback (Ollama), convoy queueing, and state checkpointing.
- [**KNOWLEDGE_GRAPH.md**](./docs/KNOWLEDGE_GRAPH.md) — MemPalace sync protocol, eventual consistency, and conflict resolution.
- [**CONVOYS.md**](./docs/CONVOYS.md) — Convoy transport integrity: hash verification, replay attack prevention, and failure quarantine.


## License

MIT © [kab0rn](https://github.com/kab0rn)
