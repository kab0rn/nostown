# NOS Town

**Groq-native multi-agent orchestration system — open-model swarms, consensus councils, and persistent work tracking at nitrous speed**

---

## Overview

NOS Town is a Groq-powered multi-agent workspace manager that coordinates swarms of AI coding agents running on Groq-hosted open models (Llama 3.x, Mistral, OpenAI gpt-oss family) working in parallel across your projects. Instead of losing context when agents restart, NOS Town persists all work state in git-backed Hooks and a Beads ledger — enabling reliable, resumable, high-throughput multi-agent workflows that run faster and cheaper than any proprietary-model equivalent.

NOS Town is a spiritual reimagining of [Gas Town](https://github.com/gastownhall/gastown), rebuilt ground-up to exploit Groq's unique inference properties: sub-second latency, 500+ tokens/sec per agent, multi-model routing from a single OpenAI-compatible API, and Batch processing discounts that make swarm-and-consensus strategies economically viable for the first time.

Where Gas Town is designed around Claude Code's IDE rails and a single frontier model per agent, NOS Town treats *inference speed, cost, and model diversity* as first-class architectural primitives. Every role is designed to exploit Groq's properties: self-consistent Polecat swarms for correctness, model councils for judgment, heterogeneous model routing per risk level, and continuous async self-evaluation via Groq Batch overnight — all without blowing up your inference budget.

### What Problem Does This Solve?

| Challenge | NOS Town Solution |
|---|---|
| Agents lose context on restart | Work persists in git-backed Hooks |
| Manual agent coordination | Built-in mailboxes, identities, and handoffs |
| 4–10 agents become chaotic | Scale comfortably to 20–50 agents |
| Work state lost in agent memory | Work state stored in Beads ledger |
| Single-model failure modes | Multi-model routing and council judgment |
| Slow frontier inference kills parallelism | Groq inference at 500+ tok/s per agent |
| No institutional memory across runs | Historian mines past Beads into Playbooks |
| Silent quality regressions over time | Continuous offline evals via Groq Batch |
| Hard to reconstruct failed edit context | Seance discovers and queries prior sessions |
| Expensive to run quality checks at scale | Safeguard-20B sentry on every diff for pennies |

---

## Architecture

```
NOS Town Workspace  ~/nos/
│
├── The Mayor (llama-3.3-70b-versatile)     ← Your primary interface and planner
│   ├── Model routing table                 ← Routes roles × risk × complexity → model
│   └── Planning councils (optional)        ← 70B vs 120B plan evaluation
│
├── Rig: Project A
│   ├── Crew (llama-3.3-70b-versatile)     ← Long-lived design and architecture agent
│   ├── Hooks                               ← Git worktree persistent storage
│   ├── Polecats (llama-3.1-8b-instant)    ← Ephemeral executor swarm
│   │   ├── Standard mode    (1× 8B)
│   │   ├── Self-consistent  (N× 8B → Arbiter 70B picks best)
│   │   └── Power mode       (1× 70B with failure history)
│   ├── Witness (70B + optional 120B council) ← Spec and quality judge
│   └── Refinery (70B / 8B fast-path)      ← Merge queue processor
│
├── Rig: Project B
│   └── (same structure, independent lifecycle)
│
├── Deacon (llama-3.1-8b-instant)           ← Cross-rig health monitor
├── Dogs (llama-3.1-8b-instant)             ← Maintenance and housekeeping workers
├── Safeguard Sentry (gpt-oss-safeguard-20b) ← Policy and security classifier
└── Historian (llama-3.3-70b via Batch)     ← Async Playbook builder
```

---

## What Makes NOS Town Different

### Groq as Infrastructure, Not Just a Backend

NOS Town is not Gas Town with a different model string. Groq's inference profile — low latency, high throughput, multi-model under one OpenAI-compatible API, and a 50% Batch discount — fundamentally changes which multi-agent designs are economically viable.

Gas Town is constrained by Claude Code's per-call latency and cost at scale. NOS Town is designed for a world where inference is fast and cheap enough that you can:

- Fire 3–5 parallel Polecat variants per Bead and pick the best one
- Run a two-judge model council on every high-risk merge without meaningfully slowing your pipeline
- Continuously re-evaluate your Town's behavior via Batch overnight at half price
- Mine thousands of historical Beads for patterns and write them back as Playbooks — all asynchronously

### Multi-Model Routing as a First-Class Concept

NOS Town ships with a **model routing table** built into the Mayor. Every role has a default model, an escalation model, a fast-path option, and optional council configuration. You change any of these at runtime without rewriting prompts or restructuring your Town.

```json
{
  "routing": {
    "mayor":    { "default": "llama-3.3-70b-versatile",  "escalate":  "openai/gpt-oss-120b" },
    "crew":     { "default": "llama-3.3-70b-versatile",  "escalate":  "openai/gpt-oss-120b" },
    "polecat":  { "default": "llama-3.1-8b-instant",     "boosted":   "llama-3.3-70b-versatile" },
    "witness":  { "default": "llama-3.3-70b-versatile",  "council":   ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"] },
    "refinery": { "default": "llama-3.3-70b-versatile",  "fast_path": "llama-3.1-8b-instant" },
    "deacon":   { "default": "llama-3.1-8b-instant",     "escalate":  "llama-3.3-70b-versatile" },
    "dogs":     { "default": "llama-3.1-8b-instant" },
    "safeguard":{ "default": "openai/gpt-oss-safeguard-20b" },
    "historian":{ "default": "llama-3.3-70b-versatile" }
  }
}
```

---

## Core Concepts

For full role-by-role details, see [docs/ROLES.md](docs/ROLES.md). Key concepts:

### The Mayor 🎭

Your primary AI coordinator running on Tier-A Groq model (`llama-3.3-70b-versatile` by default, escalatable to `openai/gpt-oss-120b`). The Mayor owns the routing table, decomposes specs into Beads, creates Convoys, and dispatches work to the right agents with the right models.

### Town 🏘️

Your workspace directory (e.g., `~/nos/`). Contains all Rigs, Hooks, Playbooks, and Town-level routing configuration.

### Rigs 🏭️

Project containers. Each Rig wraps a git repository and manages its Crew, Polecats, Witness, and Refinery independently.

### Crew Members 👤

Long-lived design agents per Rig. Crew maintains the Rig's `NOS.md` spec file and queries Playbooks before tackling design problems.

### Polecats 🦨

Ephemeral executor agents. Three modes:
- **Standard**: Single 8B instance for low-risk Beads
- **Self-consistent**: N parallel 8B instances, Arbiter picks best
- **Power**: Single 70B instance with full failure history

### Hooks 🪝

Git worktree-based persistent storage. Work survives crashes and restarts.

### Convoys 🚚

Work tracking bundles. Group related Beads with shared progress visibility. `mountain` Convoys get autonomous stall detection.

### Beads 📿

Atomic work units. Bead IDs: `nos-abc12`, `hq-x7k2m`. Fields: `spec`, `scope`, `risk`, `consistency`, `status`, `model_used`, `convoy_id`.

### Witness, Deacon, Dogs 🐕

- **Witness** (per-Rig): Monitors Polecats, judges quality, runs councils for high-risk Beads
- **Deacon** (cross-Rig): Background patrol, anomaly detection, Dog dispatch
- **Dogs**: Maintenance workers (logs, compaction, watchdogs)

### Refinery 🏭

Per-Rig merge queue with Bors-style bisecting. Supports offline merge simulation via Groq Batch.

### Historian 📚

Groq Batch job that mines completed Beads across all Rigs and writes reusable patterns into Playbooks. Mayor and Crew read these before planning.

### Safeguard Sentry 🛡️

Runs `gpt-oss-safeguard-20b` on diffs to flag policy/security issues. Fast and cheap enough to gate every change.

---

## Fork Strategy: Gas Town ↔ NOS Town

NOS Town is **not a fork** of Gas Town in the git sense. Instead, we use a **"practical fork" pattern** to stay architecturally aligned:

### Repository Structure

- **`kab0rn/gastown`** (forked from `gastownhall/gastown`) — Tracks Gas Town upstream. Contains all core orchestration logic, Beads integration, Hook lifecycle, Convoy management, and Mayor/Witness/Deacon/Refinery roles.
- **`kab0rn/nostown`** (this repo) — Groq-specific runtime, multi-model routing engine, council logic, Historian, Safeguard integration, and NOS-specific tooling.

### How It Works

1. **Gas Town (`kab0rn/gastown`) pulls from upstream** — When Steve Yegge ships new features (better Hook lifecycle, improved Convoy stall detection, Wasteland federation updates), we pull them into our fork.
2. **NOS Town depends on Gas Town core** — NOS Town imports Gas Town's `gt` CLI and Beads integration as a dependency (via Go modules or git submodule).
3. **NOS-specific extensions live here** — Multi-model routing, Groq API client, council orchestration, Historian Batch jobs, and Safeguard tooling live in `kab0rn/nostown`.
4. **Shared concepts, divergent runtimes** — Both use the same Beads ledger, Hook worktrees, Convoy tracking, and Mayor/Polecat/Witness roles. Gas Town uses Claude Code; NOS Town uses Groq models.

### Why Not a True Fork?

- **Preserves Gas Town's evolution** — Steve is actively iterating. A true fork would diverge and become hard to sync.
- **Keeps Groq-specific logic isolated** — Gas Town doesn't need to know about Groq Batch, multi-model routing, or council patterns. Those are NOS concerns.
- **Easier to contribute upstream** — If NOS Town discovers a better Hook lifecycle or Convoy pattern, we can PR it back to Gas Town without dragging Groq dependencies along.

---

## Installation

### Prerequisites

- **Go 1.25+** — [go.dev/dl](https://go.dev/dl/)
- **Git 2.25+** — for worktree support
- **Dolt 1.82.4+** — [github.com/dolthub/dolt](https://github.com/dolthub/dolt)
- **beads (bd) 0.55.4+** — [github.com/steveyegge/beads](https://github.com/steveyegge/beads)
- **sqlite3** — for Convoy database queries
- **tmux 3.0+** — recommended for full multi-agent UX
- **Groq API key** — [console.groq.com](https://console.groq.com/)

### Setup

```bash
# Install NOS Town
$ go install github.com/kab0rn/nostown/cmd/nos@latest

# Or clone and build
$ git clone https://github.com/kab0rn/nostown.git && cd nostown
$ go build -o nos ./cmd/nos
$ sudo mv nos /usr/local/bin/

# Set Groq API key
$ export GROQ_API_KEY="your-api-key"

# Create workspace
$ nos install ~/nos --git
$ cd ~/nos

# Add your first project
$ nos rig add myproject https://github.com/you/repo.git

# Create your crew workspace
$ nos crew add yourname --rig myproject
$ cd myproject/crew/yourname

# Start the Mayor
$ nos mayor attach
```

---

## Quick Start

### Tell the Mayor What You Want

```bash
# Start Mayor session
$ nos mayor attach

# In Mayor, describe your goal
Mayor> I want to add OAuth2 login to the user service and write integration tests.

# Mayor will:
# 1. Break this into Beads (implement OAuth, write tests, update docs)
# 2. Create a Convoy
# 3. Route Beads to appropriate Polecats (8B for simple, 70B for complex)
# 4. Monitor progress via Witness
# 5. Merge via Refinery when done

# Track progress
$ nos convoy list
$ nos feed  # Live TUI dashboard
```

### Manual Workflow

```bash
# Create Beads manually
$ bd create "Implement OAuth2" --rig myproject
# Returns: nos-abc12

$ bd create "Write OAuth integration tests" --rig myproject
# Returns: nos-def34

# Create Convoy
$ nos convoy create "Auth System" nos-abc12 nos-def34 --notify

# Beads are auto-assigned to Polecats based on routing table
# Or manually assign:
$ nos sling nos-abc12 myproject

# Check status
$ nos convoy show
$ nos agents
```

---

## Key Commands

```bash
# Workspace
nos install <path>          # Initialize NOS Town workspace
nos rig add <name> <url>    # Add project
nos crew add <name> --rig <rig>

# Agents
nos mayor attach            # Start Mayor session
nos agents                  # List active agents
nos feed                    # Live activity dashboard
nos feed --problems         # Problems view (stuck agents)

# Work
nos convoy create <title> [beads...]  # Create convoy
nos convoy list             # List convoys
nos sling <bead> <rig>      # Assign bead to worker

# Routing
nos config route show       # Show routing table
nos config route set polecat.boosted llama-3.3-70b-versatile
nos config route set witness.council "[llama-3.3-70b-versatile,openai/gpt-oss-120b]"

# Monitoring
nos escalate -s HIGH "description"  # Escalate blocker
nos escalate list                    # List escalations
nos historian status                 # Check Playbook builder
```

---

## Model Tiers

| Tier | Models | Use Cases | Cost |
|------|--------|-----------|------|
| **A** | llama-3.3-70b-versatile, openai/gpt-oss-120b | Mayor, Crew, Witness, Refinery | ~$0.80/M tokens |
| **B** | llama-3.1-8b-instant | Polecats (standard), Deacon, Dogs | ~$0.10/M tokens |
| **Safeguard** | gpt-oss-safeguard-20b | Security/policy classification | ~$0.20/M tokens |
| **Batch** | Any model via Groq Batch | Historian, offline evals | 50% discount |

---

## Documentation

Detailed docs:

- [docs/ROLES.md](docs/ROLES.md) — Full role-by-role design
- [docs/ROUTING.md](docs/ROUTING.md) — Model routing table and council patterns
- [docs/HISTORIAN.md](docs/HISTORIAN.md) — Playbook mining and institutional memory
- [docs/FORK_STRATEGY.md](docs/FORK_STRATEGY.md) — How NOS Town syncs with Gas Town upstream
- [docs/GROQ_INTEGRATION.md](docs/GROQ_INTEGRATION.md) — Groq API, Batch, and model selection

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Acknowledgments

NOS Town is inspired by and architecturally aligned with [Gas Town](https://github.com/gastownhall/gastown) by Steve Yegge. The core orchestration concepts (Hooks, Beads, Convoys, Mayor/Witness/Deacon roles) come from Gas Town. NOS Town's contribution is the Groq-native runtime, multi-model routing, and swarm/council patterns.
