# NOS Town

**Groq-native multi-agent orchestration system — agentic swarms, consensus councils, palace memory, and persistent work tracking at nitrous speed.**

---

## Overview

NOS Town coordinates swarms of AI coding agents running on Groq's LPU™ architecture. Sub-second inference, parallel Witness councils, and a persistent memory layer (MemPalace) enable workflows that are economically and technically impractical on conventional frontier models: multi-judge consensus, nightly institutional memory mining, and cross-session palace navigation.

**Two processes run the system:**
- **Node.js agent runtime** — Mayor, Polecat, Witness, Safeguard, Historian (TypeScript)
- **MemPalace server** — hierarchical memory + knowledge graph sidecar (Python/FastAPI, port 7474)

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 20+ | LTS recommended |
| npm | 10+ | Included with Node.js 20 |
| Python | 3.11+ | For MemPalace sidecar |
| [uv](https://docs.astral.sh/uv/) | latest | Recommended Python runner; falls back to `python3` |
| Groq API key | — | `gsk_...` from [console.groq.com](https://console.groq.com) |

**Optional:**
- **Ollama** — local inference fallback when all Groq endpoints fail. Must be running before NOS Town starts; no auto-pull. Set `OLLAMA_URL` to enable.

---

## Installation

```bash
# 1. Clone the repo
git clone https://github.com/kab0rn/nostown
cd nostown

# 2. Install Node.js dependencies
npm install

# 3. Install uv (if not already installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 4. Install Python dependencies for the MemPalace sidecar
cd mempalace-server && uv sync && cd ..
```

> **Without uv:** `cd mempalace-server && pip install fastapi uvicorn && cd ..`

---

## Configuration

### Required environment variable

```bash
export GROQ_API_KEY=gsk_...
```

NOS Town will refuse to start without it.

### Full environment variable reference

| Variable | Default | Description |
|---|---|---|
| `GROQ_API_KEY` | — | **Required.** Groq Cloud API key. |
| `MEMPALACE_URL` | `http://localhost:7474` | URL of the MemPalace sidecar. |
| `MEMPALACE_PORT` | `7474` | Port the MemPalace sidecar listens on. |
| `MEMPALACE_DB` | `palace-db/palace.sqlite` | SQLite database path for the palace + KG. |
| `NOS_AGENT_ID` | `mayor_01` | Mayor agent identity (used in convoy headers and keys). |
| `NOS_RIG` | `default` | Active rig name (maps to `rigs/<name>/`). |
| `NOS_RIGS_ROOT` | `rigs/` | Root directory containing all rig subdirectories. |
| `NOS_ROLE_KEY_DIR` | `keys/` | Directory holding Ed25519 `.key` / `.pub` files per agent. |
| `NOS_CONVOY_SECRET` | — | Optional HMAC transport secret for convoy `transport_mac` field. |
| `NOS_HOOKS_DIR` | `hooks/` | Directory scanned for `.hook` JSON event files. |
| `NOS_AUDIT_DIR` | `nos/audit/` | Append-only audit log directory for sensitive operations. |
| `NOS_QUARANTINE_DIR` | `nos/quarantine/` | Quarantine directory for convoy signature failures. |
| `NOS_PALACE_DB` | `palace-db/knowledge_graph.sqlite` | Knowledge graph SQLite path (separate from palace). |
| `OLLAMA_URL` | — | Optional. Base URL for local Ollama (e.g. `http://localhost:11434`). Enables Tier B fallback after 60 s of Groq failures. |

### Minimal `.env` for development

```bash
GROQ_API_KEY=gsk_your_key_here
NOS_AGENT_ID=mayor_01
NOS_RIG=my-project
```

---

## Setup: Signing Keys

Every agent that dispatches Convoy messages requires an Ed25519 key pair. Keys live in `keys/` by default (or `NOS_ROLE_KEY_DIR`).

Generate keys for the standard roles:

```bash
npx tsx -e "
import { generateKeyPair } from './src/convoys/sign.js';
await generateKeyPair('mayor_01');
await generateKeyPair('polecat_01');
await generateKeyPair('witness_01');
await generateKeyPair('safeguard_01');
await generateKeyPair('historian_01');
console.log('Keys written to keys/');
"
```

This writes `keys/<id>.key` (private) and `keys/<id>.pub` (public). **Keep `.key` files out of git** — add `keys/*.key` to `.gitignore`.

> `NOS_AGENT_ID` must match an existing key pair name. If you change the agent ID to `mayor_02`, run `generateKeyPair('mayor_02')` before starting.

---

## Running

NOS Town requires two processes. Start them in separate terminals (or a process manager).

### Terminal 1 — MemPalace sidecar

```bash
./scripts/start-palace.sh
```

Expected output:
```
[NOS Town] Starting MemPalace server on port 7474...
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:7474
```

Verify the sidecar is healthy:
```bash
curl -s http://localhost:7474/palace/status
```

### Terminal 2 — NOS Town agents

```bash
export GROQ_API_KEY=gsk_...
export NOS_AGENT_ID=mayor_01
export NOS_RIG=my-project

# Orchestrate a task
./scripts/nos.sh task "Refactor the authentication middleware to use JWT"

# Show system status
./scripts/nos.sh status
```

`nos.sh` auto-installs Node.js dependencies if `node_modules/` is missing.

### Running the Historian (nightly)

The Historian is not scheduled automatically. Trigger it manually or via cron:

```bash
NOS_RIG=my-project npx tsx -e "
import { Historian } from './src/roles/historian.js';
const h = new Historian({ agentId: 'historian_01' });
await h.runNightly('my-project');
h.close();
"
```

The Historian writes AAAK bead manifests, pattern clusters, and playbooks to MemPalace. Interrupted runs resume from the last completed step automatically.

---

## Directory Structure

```
nostown/
├── src/                        # TypeScript source
│   ├── roles/
│   │   ├── mayor.ts            # Orchestrator: decomposes tasks, dispatches via convoy
│   │   ├── polecat.ts          # Executor: resolves individual micro-beads
│   │   ├── witness.ts          # Validator: multi-judge consensus council
│   │   ├── safeguard.ts        # Sentry: real-time security scanning
│   │   ├── historian.ts        # Miner: nightly institutional memory pipeline
│   │   └── refinery.ts         # Synthesizer: 120B post-processing pass
│   ├── convoys/
│   │   ├── bus.ts              # Convoy transport with per-rig JSONL mailboxes
│   │   └── sign.ts             # Ed25519 signing + verification
│   ├── ledger/index.ts         # Append-only bead ledger: checksums + mutex locking
│   ├── mempalace/client.ts     # HTTP client for the MemPalace sidecar
│   ├── groq/
│   │   ├── provider.ts         # Groq SDK wrapper: retry, circuit breaker, Ollama fallback
│   │   └── batch.ts            # Groq Batch API client (Historian synthesis)
│   ├── kg/
│   │   ├── index.ts            # SQLite knowledge graph with MIM conflict resolution
│   │   └── sync-monitor.ts     # 500ms hash polling for KG convergence
│   ├── swarm/
│   │   ├── coordinator.ts      # Fork-join and rendezvous swarm patterns
│   │   └── tools.ts            # detectCycles(), isRendezvousNode(), backpressure limits
│   ├── monitor/heartbeat.ts    # Stall detection, MAYOR_MISSING, deadlock alerts
│   ├── hardening/audit.ts      # Append-only audit log for lockdowns, votes, etc.
│   ├── hooks/loader.ts         # .hook file loader and executor
│   ├── routing/dispatcher.ts   # KG-backed model routing with temporal triple lookups
│   ├── telemetry/
│   │   ├── metrics.ts          # OpenTelemetry counters, histograms, gauges
│   │   └── tracer.ts           # OTel distributed tracing (no-op until SDK wired)
│   └── index.ts                # CLI entry point: nos task / nos status
│
├── mempalace-server/           # Python FastAPI sidecar
│   ├── server.py               # REST API: wings, rooms, halls, drawers, KG, checkpoints
│   └── pyproject.toml          # Dependencies: fastapi, uvicorn
│
├── scripts/
│   ├── nos.sh                  # CLI wrapper (runs src/index.ts via tsx)
│   └── start-palace.sh         # Starts the MemPalace sidecar
│
├── keys/                       # Ed25519 key pairs (auto-created by generateKeyPair)
├── rigs/                       # Per-project rig directories (auto-created by Ledger)
│   └── <rig-name>/beads/current.jsonl
├── palace-db/                  # MemPalace SQLite databases (auto-created on first start)
├── hooks/                      # .hook event files (optional)
├── docs/                       # Specification documents
└── tests/
    ├── unit/                   # Isolated tests (Groq + MemPalace mocked)
    └── integration/            # Integration tests (real SQLite, mocked Groq)
```

---

## Model Strategy

NOS Town uses a preview-primary strategy: latest Groq preview models for speed and capability, with stable fallbacks for production reliability.

> Preview models (`llama-4-scout`, `qwen3-32b`) are **not recommended for production** without confirmed Groq GA status. The stable fallbacks are production-grade.

| Role | Primary (Preview) | Stable Fallback |
|---|---|---|
| Mayor | `groq/compound` | `llama-3.3-70b-versatile` |
| Polecat | `meta-llama/llama-4-scout-17b-16e-instruct` | `llama-3.1-8b-instant` |
| Witness | `qwen/qwen3-32b` | `llama-3.3-70b-versatile` |
| Refinery | `openai/gpt-oss-120b` | `llama-3.3-70b-versatile` |
| Safeguard | `openai/gpt-oss-safeguard-20b` | `openai/gpt-oss-20b` |
| Historian (batch) | Groq Batch API + `llama-3.3-70b-versatile` | — |

The Mayor's routing table is KG-backed: model promotions and demotions are written as temporal triples and persist across sessions.

---

## Development

```bash
# Type-check without building
npm run typecheck

# Compile TypeScript to dist/
npm run build

# Run all tests (405 tests, ~10 s)
npm test

# Unit tests only — no live services required
npm run test:unit

# Integration tests only
npm run test:integration
```

Unit tests mock both Groq SDK and MemPalace HTTP calls. Integration tests use real SQLite in a temp directory.

---

## Key Assumptions

1. **MemPalace must be running before agents start.** Palace failures are non-fatal (agents continue), but startup recovery, playbook lookups, and cross-session memory silently degrade without it.

2. **Key pairs must exist for every `NOS_AGENT_ID` used.** A missing key causes `Mayor key not found for <id>` on first convoy dispatch. Generate them before the first run.

3. **`NOS_RIGS_ROOT` must be writable.** The Ledger creates `rigs/<rig>/beads/current.jsonl` automatically. Default is `rigs/` relative to the project root.

4. **`GROQ_API_KEY` must be valid and have quota.** The Groq provider has a circuit breaker: 5 consecutive failures open it for 60 s. Without `OLLAMA_URL`, the system enters degraded mode during that window.

5. **Ollama (if used) must be running before NOS Town starts.** The provider checks `GET $OLLAMA_URL/api/tags` at startup. If unreachable, it logs a warning and disables the fallback for the session.

6. **Ed25519 private key files (`*.key`) must not be committed to git.** Add `keys/*.key` to `.gitignore`. Public keys (`*.pub`) are safe to commit.

7. **The Historian runs on demand, not automatically.** Wire it to a cron job or trigger it manually. Interrupted runs resume from the last completed step using MemPalace progress markers.

8. **`NOS_AGENT_ID` is part of the key identity.** It appears in convoy `sender_id` headers and maps to `keys/<NOS_AGENT_ID>.key`. Changing it without generating the matching key pair will break convoy dispatch.

---

## Architecture Overview

```
NOS Town
│
├── Mayor (groq/compound)
│   ├── Palace wakeup (L0+L1 context)     ← Cross-session memory, ~170 tokens
│   ├── AAAK bead manifest                ← Compressed prior-work context
│   ├── Playbook search (hall_advice)     ← Semantic search before decomposition
│   ├── Dependency cycle detection        ← DFS reject at planning time
│   └── Convoy dispatch + heartbeat       ← Signed Ed25519, per-rig JSONL mailboxes
│
├── Rig: <project>  (wing_rig_<project>)
│   ├── Beads ledger (current.jsonl)      ← Append-only, checksummed, mutex-locked
│   ├── Polecats (Llama 3.1 8B)           ← Execution swarm, sub-second inference
│   ├── Witness council (qwen3/70B)       ← Parallel multi-judge consensus
│   └── Safeguard (gpt-oss-20b)           ← Real-time security sentry
│
├── Historian (Groq Batch API)
│   ├── Classify beads → halls            ← task_type, model, outcome clustering
│   ├── AAAK manifest compression         ← Token-efficient Mayor context
│   ├── Playbook synthesis (70B batch)    ← Golden path reasoning → hall_advice
│   ├── Routing KG updates                ← Model promotions/demotions as triples
│   └── Cross-rig tunnel detection        ← Shared room discovery across rigs
│
└── MemPalace (port 7474)
    ├── Wings → Rooms → Halls             ← Hierarchical namespace per rig + role
    ├── Drawers (verbatim)                ← Permanent, never summarized
    ├── Knowledge Graph (SQLite)           ← Temporal triples, MIM conflict resolution
    └── Checkpoints                       ← Mayor plan state for crash recovery
```

---

## Troubleshooting

**`Mayor key not found for mayor_01`**
Run the key generation snippet above. Check that `NOS_ROLE_KEY_DIR` points to the directory containing the `.key` files.

**`Palace wakeup failed (non-fatal): connection refused`**
The MemPalace sidecar is not running. Start it with `./scripts/start-palace.sh`. Agents continue but without cross-session memory.

**`GROQ_API_KEY environment variable is required`**
Export your Groq API key before running.

**`Mayor WAITING_FOR_CAPACITY: N beads in-flight`**
The in-flight bead limit is reached. Wait for existing beads to resolve, or adjust `maxPolecatBeads` in `DEFAULT_IN_FLIGHT_LIMITS` in `src/swarm/tools.ts`.

**`DEPENDENCY_CYCLE detected in bead plan: A → B → A`**
The Mayor's decomposition produced a circular `needs` dependency. Re-describe the task to remove the circular prerequisite.

**`Replay attack detected: sender sent seq N but last was M`**
A convoy arrived out of order. This is an intentional guard. The sender should retry with the correct sequence number.

**Historian nightly run hangs or times out**
Playbook synthesis uses the Groq Batch API and retries on failure. Verify `GROQ_API_KEY` is valid and has access to 70B models. In tests, mock `GroqProvider.executeInference` to avoid retry backoff.

---

## Documentation

| Doc | Topic |
|---|---|
| [ROLES.md](docs/ROLES.md) | Role-by-role protocols, palace-first prompts, quality tuning |
| [MEMPALACE.md](docs/MEMPALACE.md) | Palace hierarchy, KG schema, AAAK compression, MCP tool reference |
| [HISTORIAN.md](docs/HISTORIAN.md) | Nightly mining pipeline, playbook generation, AAAK manifest |
| [ROUTING.md](docs/ROUTING.md) | Escalation ladder, playbook short-circuit, cross-rig tunnels |
| [GROQ_INTEGRATION.md](docs/GROQ_INTEGRATION.md) | SDK setup, Batch API, model selection matrix |
| [HARDENING.md](docs/HARDENING.md) | Production hardening: ledger integrity, signing, v1.0 test checklist |
| [RESILIENCE.md](docs/RESILIENCE.md) | Failover logic, Ollama fallback, outage queue, crash recovery |
| [CONVOYS.md](docs/CONVOYS.md) | Convoy transport: signing, replay prevention, failure quarantine |
| [SWARM.md](docs/SWARM.md) | Fork-join patterns, rendezvous dispatch, dependency cycles |
| [KNOWLEDGE_GRAPH.md](docs/KNOWLEDGE_GRAPH.md) | KG sync protocol, MIM conflict resolution, consistency model |
| [OBSERVABILITY.md](docs/OBSERVABILITY.md) | OTel metrics, distributed tracing, alerting tiers |
| [BUILDING.md](docs/BUILDING.md) | Build gates, implementation order, risk register |

---

## License

MIT © [kab0rn](https://github.com/kab0rn)
