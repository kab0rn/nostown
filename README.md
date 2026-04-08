# NOS Town

**Groq-native multi-agent orchestration system — agentic swarms, consensus councils, and persistent work tracking at nitrous speed.**

---

## Overview

NOS Town is a high-performance workspace manager that coordinates swarms of AI coding agents running on Groq's LPU™ architecture. By leveraging sub-second inference and extreme throughput, NOS Town enables complex workflows—like multi-judge consensus and nightly institutional memory mining—that are economically and technically impossible on conventional frontier models.

NOS Town is a spiritual reimagining of [Gas Town](https://github.com/gastownhall/gastown), rebuilt to exploit **Agentic Systems** (like Groq Compound) and **Preview Models** (like Llama 4 Scout) as first-class architectural primitives.

---

## The NOS Town Advantage

| Challenge | NOS Town Solution | Core Technology |
|-----------|-------------------|-----------------|
| Static Context | Work persists in git-backed **Hooks** | Persistent Storage |
| Manual Handoffs| Built-in **Mailboxes** and **Deacons** | 8B Async Swarms |
| 4-10 Agent Limit| Scales comfortably to **20-50+ agents** | Groq Throughput |
| Hallucinations | **Witness Councils** (Multi-judge) | Parallel 70B/120B |
| Serial Planning | **Agentic Orchestration** | Groq Compound |
| Silent Regression| **Historian** mining and Playbooks | Groq Batch API |
| Security Risk | **Safeguard-20B** sentry on every diff | 1000 TPS Safety Model |

---

## Architecture

```text
NOS Town Workspace ~/nos/
│
├── The Mayor (groq/compound)        ← Agentic orchestrator and planner
│   ├── Model routing table          ← Dynamic tier selection + fallbacks
│   └── Planning councils            ← 120B reasoning passes
│
├── Rig: Project A
│   ├── Hooks                        ← Git-backed persistent workspace state
│   ├── Crew (Llama 4 Scout)         ← High-speed codebase traversal swarm
│   ├── Polecats (Llama 3.1 8B)      ← Ephemeral execution executors
│   └── Mailboxes                    ← Inter-agent message bus
│
└── The Historian (Batch)            ← Nightly institutional memory mining
    └── Playbooks/                   ← Reusable implementation "Golden Paths"
```

---

## Model Strategy: Preview-Primary

NOS Town uses a "Preview-Primary" strategy, prioritizing Groq's latest high-performance preview models while maintaining stable production fallbacks.

| Role | Primary Model (Preview/System) | Stable Fallback (Production) |
|------|--------------------------------|------------------------------|
| **Mayor** | `groq/compound` | `llama-3.3-70b-versatile` |
| **Polecat** | `meta-llama/llama-4-scout-17b` | `llama-3.1-8b-instant` |
| **Witness** | `qwen/qwen3-32b` | `llama-3.3-70b-versatile` |
| **Refinery**| `openai/gpt-oss-120b` | `llama-3.3-70b-versatile` |
| **Safeguard**| `openai/gpt-oss-safeguard-20b`| `llama-3.1-8b-instant` |

---

## Documentation

- [**ROLES.md**](docs/ROLES.md) — Role-by-role quality tuning and agentic prompts.
- [**ROUTING.md**](docs/ROUTING.md) — The escalation ladder, council protocols, and fallbacks.
- [**HISTORIAN.md**](docs/HISTORIAN.md) — Batch mining, Playbook generation, and institutional memory.
- [**FORK_STRATEGY.md**](docs/FORK_STRATEGY.md) — Relationship to upstream Gas Town.
- [**GROQ_INTEGRATION.md**](docs/GROQ_INTEGRATION.md) — SDK setup, Batch API, and performance matrix.

---

## License

MIT © [kab0rn](https://github.com/kab0rn)
