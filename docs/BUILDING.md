# NOS Town — Building Guide

How to build NOS Town on top of the [Gas Town](https://github.com/gastownhall/gastown) codebase. This document bridges the gap between the architectural docs and an actual working implementation.

---

## Prerequisites

Before starting, you need:

- **Node.js 20+** — NOS Town agents run in Node.js/TypeScript
- **Python 3.11+** — Required for the `mempalace` MCP sidecar server
- **A Groq API key** — `export GROQ_API_KEY=gsk_...`
- **Gas Town repo cloned** — NOS Town extends Gas Town's data structures

```bash
git clone https://github.com/gastownhall/gastown
git clone https://github.com/kab0rn/nostown
```

---

## Repository Structure

NOS Town is a documentation + orchestration layer, not a full fork. The directory layout you'll build toward:

```
nos/
├── package.json              # Node.js project root
├── src/
│   ├── mayor/                 # Mayor orchestrator (groq/compound)
│   ├── polecat/               # Polecat agent swarm (Llama 4 Scout / 8B)
│   ├── witness/               # Witness council (qwen3-32b / 70B)
│   ├── historian/             # Batch mining pipeline
│   ├── safeguard/             # Security sentry
│   ├── routing/               # KG-backed model routing
│   ├── convoys/               # Message bus + mailboxes
│   └── mempalace/             # MCP client (calls sidecar)
├── mempalace-server/          # Python MCP sidecar (separate process)
├── rigs/                      # One subdir per project rig
│   └── my-project/
│       ├── .hook              # Gas Town hook file (schema compat)
│       └── beads.jsonl        # Gas Town bead ledger
└── docs/                      # This documentation
```

---

## Language Boundary: Node.js Agents ↔ Python MemPalace

This is the most important architectural boundary to understand.

**NOS Town agents** are written in **Node.js/TypeScript** and call Groq via `groq-sdk`.

**MemPalace** is a **Python** package that runs as a separate MCP server process on port `:7474`.

They communicate over the **MCP (Model Context Protocol)**. The Node.js agents call the MemPalace MCP server using an MCP client library — they do **not** import Python directly.

```
[Node.js Mayor/Polecat/Witness]
          |
          | MCP protocol (JSON-RPC over stdio or HTTP)
          |
[Python mempalace MCP server :7474]
          |
          |—— ChromaDB (vector store)
          |—— SQLite  (knowledge graph)
          └—— filesystem (hook files, bead ledger)
```

### Starting the MemPalace sidecar

```bash
# In a separate terminal or via process manager
cd mempalace-server/
pip install mempalace>=3.0.0
mempalace serve --port 7474
```

### Calling MemPalace from Node.js

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const palace = new Client({ name: 'nos-town-agent', version: '1.0.0' }, {});
// connect to mempalace sidecar
await palace.connect(transport); // e.g. SSEClientTransport('http://localhost:7474')

// Example: wake up a wing (L0+L1 palace read)
const wakeup = await palace.callTool('palace_wakeup', {
  wing: 'wing_rig_myproject',
  roles: ['mayor', 'polecat']
});
```

See MEMPALACE.md for all 19 tool signatures.

---

## Gas Town Compatibility Layer

NOS Town maintains 1:1 compatibility with Gas Town's `.hook` file schema and `beads.jsonl` ledger format. This means any project already managed by Gas Town can be "powered up" by NOS Town without migrating data.

### What Gas Town provides (keep these)

| Gas Town Concept | File/Format | NOS Town behavior |
|---|---|---|
| Hook | `.hook` (JSON) | Read on session start; MemPalace L0+L1 augments but doesn't replace |
| Bead Ledger | `beads.jsonl` | Historian reads this nightly; Drawers store verbatim copies |
| Convoy | Convoy schema | NOS Town extends with hash verification (see CONVOYS.md) |
| Roles (Mayor/Witness) | Role definitions | Extended with palace-first prompts (see ROLES.md) |

### What NOS Town adds on top

| NOS Town Addition | Where it lives | Purpose |
|---|---|---|
| MemPalace MCP server | `mempalace-server/` | Persistent cross-session memory |
| Knowledge Graph | SQLite in `palace-db/` | KG-backed routing, temporal triples |
| Historian batch job | `src/historian/` | Nightly mining of beads into Playbooks |
| Safeguard sentry | `src/safeguard/` | Real-time security layer |
| Mailboxes | `src/convoys/` | Async inter-agent message bus |

---

## Setup Walkthrough (End-to-End)

### Step 1: Install dependencies

```bash
# Node.js dependencies
npm install

# Python MemPalace sidecar
python -m venv mempalace-server/venv
source mempalace-server/venv/bin/activate
pip install mempalace>=3.0.0 chromadb
```

### Step 2: Initialize a rig

A "rig" is a project-level workspace. Each rig has a Gas Town `.hook` file and a MemPalace wing.

```bash
# Create the rig directory
mkdir -p rigs/my-project

# Initialize a Gas Town hook (copy structure from Gas Town docs)
echo '{"project": "my-project", "state": "active"}' > rigs/my-project/.hook

# Initialize the MemPalace wing for this rig
mempalace init --wing wing_rig_myproject
```

### Step 3: Start the MemPalace sidecar

```bash
mempalace serve --port 7474 --db-path ./palace-db
```

### Step 4: Run the Mayor

```bash
# Set env
export GROQ_API_KEY=gsk_...
export MEMPALACE_URL=http://localhost:7474

# Start the Mayor orchestrator
npx tsx src/mayor/index.ts --rig my-project
```

### Step 5: Verify with a test task

```bash
# Send a test task via the Convoy bus
npx tsx src/convoys/send.ts --rig my-project --task "List open rooms in my palace"
```

---

## Agent Build Order

Build in this order — each layer depends on the one below it:

1. **MemPalace MCP client** (`src/mempalace/`) — foundation for all memory reads/writes
2. **Groq provider wrapper** (`src/groq/`) — `executeInference()` with escalation + rate limit logic
3. **Polecat** (`src/polecat/`) — simplest agent, validates the full stack
4. **Convoys / Mailboxes** (`src/convoys/`) — inter-agent messaging
5. **Witness Council** (`src/witness/`) — parallel multi-judge consensus
6. **Mayor** (`src/mayor/`) — top-level orchestrator, depends on all above
7. **Historian** (`src/historian/`) — batch job, runs independently
8. **Safeguard** (`src/safeguard/`) — security sentry, wraps all agent output

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | Yes | Groq Cloud API key |
| `MEMPALACE_URL` | Yes | MemPalace MCP server URL (default: `http://localhost:7474`) |
| `NOS_RIG` | Yes | Active rig name (e.g. `my-project`) |
| `NOS_LOG_LEVEL` | No | Log verbosity: `debug`, `info`, `warn` (default: `info`) |
| `HISTORIAN_CRON` | No | Cron schedule for nightly Historian run (default: `0 2 * * *`) |
| `SAFEGUARD_MODE` | No | `sentry` (real-time) or `audit` (log-only) |

---

## Testing Strategy

### Unit tests
Test each agent in isolation by mocking the Groq SDK and MemPalace MCP client:

```typescript
// Mock the groq-sdk
jest.mock('groq-sdk');
// Mock the palace client
jest.mock('../mempalace/client');
```

### Integration tests
Spin up a real MemPalace sidecar against a test SQLite + ChromaDB instance:

```bash
MEMPALACE_URL=http://localhost:7475 mempalace serve --port 7475 --db-path ./test-palace-db
npx jest --testPathPattern=integration
```

### End-to-end tests
Send a real task through the full stack (requires a valid `GROQ_API_KEY`):

```bash
npx jest --testPathPattern=e2e
```

---

## Related Docs

- [MEMPALACE.md](MEMPALACE.md) — All 19 MCP tool signatures, palace hierarchy, AAAK compression
- [ROLES.md](ROLES.md) — Agent prompt templates and agentic protocols
- [GROQ_INTEGRATION.md](GROQ_INTEGRATION.md) — SDK setup, model selection matrix, Batch API
- [ROUTING.md](ROUTING.md) — Escalation ladder and KG-backed routing
- [FORK_STRATEGY.md](FORK_STRATEGY.md) — Gas Town upstream sync strategy


---

## Implementation Gates

To ensure the gastown team can build a complete project plan, NOS Town's implementation is organized into sequential gates. Each gate must be completed and tested before moving to the next.

### Gate 1: Foundation
**Goal**: Get the core infrastructure running

**Deliverables**:
- [ ] MemPalace MCP server running (`palace serve`)
- [ ] SQLite Knowledge Graph initialized with schema from [KNOWLEDGE_GRAPH.md](./KNOWLEDGE_GRAPH.md)
- [ ] Groq SDK integration with preview/primary model selection (see [GROQ_INTEGRATION.md](./GROQ_INTEGRATION.md))
- [ ] Gas Town CLI installed and bead ledger initialized

**Test**: Create a test bead, resolve it with Groq, verify MemPalace stores the event

**Files**: `src/mempalace/client.ts`, `src/groq/sdk.ts`, `palace/db/knowledge_graph.sqlite`, `package.json`

---

### Gate 2: Roles & Routing
**Goal**: Implement the Mayor, Historian, and routing rules

**Deliverables**:
- [ ] Mayor role with model promotion logic (see [ROLES.md](./ROLES.md))
- [ ] Historian role with event logging to MemPalace (see [HISTORIAN.md](./HISTORIAN.md))
- [ ] Event routing rules from [ROUTING.md](./ROUTING.md) implemented in `src/routing/dispatch.ts`
- [ ] Convoy bus for inter-role messaging (see [CONVOYS.md](./CONVOYS.md))

**Test**: Mayor assigns a bead → Researcher resolves → Historian logs → Mayor promotes model

**Files**: `src/roles/mayor.ts`, `src/roles/historian.ts`, `src/routing/dispatch.ts`, `src/convoy/bus.ts`

---

### Gate 3: Convoys & Mailboxes
**Goal**: Enable Gas Town compatibility via mailbox files and convoy transport

**Deliverables**:
- [ ] Convoy signature generation and validation (see [CONVOYS.md](./CONVOYS.md))
- [ ] Mailbox file format writer at `{BEADS_DIR}/mailboxes/{role}/inbox/*.json` (see [MAILBOXES.md](./MAILBOXES.md))
- [ ] `gt mail check` compatibility for polling agents
- [ ] Sequence number enforcement and replay attack prevention

**Test**: Send a convoy → verify mailbox file written → Gas Town agent reads via `gt mail check`

**Files**: `src/convoy/transport.ts`, `src/convoy/mailbox.ts`, `hooks/` directory

---

### Gate 4: Knowledge Graph Integration
**Goal**: Use the KG for dependency tracking and state queries

**Deliverables**:
- [ ] Bead dependency graph stored as triples (see [KNOWLEDGE_GRAPH.md](./KNOWLEDGE_GRAPH.md))
- [ ] MCP tools for KG queries: `kg_query`, `kg_insert`, `kg_traverse`
- [ ] Swarm coordination using KG for prerequisite tracking (see [SWARM.md](./SWARM.md))
- [ ] Circular dependency detection

**Test**: Create a swarm with fork-join pattern → verify KG tracks dependencies → all beads resolve in correct order

**Files**: `src/kg/client.ts`, `src/kg/tools.ts`, `palace/db/knowledge_graph.sqlite`

---

### Gate 5: Hooks & Gas Town Compatibility
**Goal**: Load and execute .hook files for event-driven behaviors

**Deliverables**:
- [ ] Hook loader from `hooks/*.hook` files (see [HOOK_SCHEMA.md](./HOOK_SCHEMA.md))
- [ ] Hook validation for required fields and action types
- [ ] Variable substitution engine for `{{event.beadId}}` syntax
- [ ] Hook execution with priority ordering
- [ ] Action handlers for: MCP_TOOL, CONVOY, KG_QUERY, CUSTOM

**Test**: Load a hook file → trigger event → verify hook executes and action dispatches

**Files**: `src/hooks/loader.ts`, `src/hooks/validator.ts`, `src/hooks/executor.ts`, `hooks/` directory

---

### Gate 6: Resilience & Hardening
**Goal**: Production-ready error handling and failover

**Deliverables**:
- [ ] Circuit breaker for Groq API (see [RESILIENCE.md](./RESILIENCE.md))
- [ ] Exponential backoff retry logic
- [ ] Fallback model cascade (preview → primary → fallback)
- [ ] Input sanitization and validation (see [HARDENING.md](./HARDENING.md))
- [ ] Audit logging for all sensitive operations

**Test**: Simulate Groq API failure → verify circuit breaker opens → fallback model used → service continues

**Files**: `src/resilience/circuit-breaker.ts`, `src/groq/fallback.ts`, `src/hardening/sanitize.ts`

---

### Gate 7: Swarm Workflows
**Goal**: Multi-agent coordination patterns

**Deliverables**:
- [ ] Fork-join pattern implementation (see [SWARM.md](./SWARM.md))
- [ ] Broadcast convoy support
- [ ] Rendezvous bead waiting for multiple prerequisites
- [ ] Swarm failure handling and recovery
- [ ] MCP tools: `swarm_status`, `swarm_broadcast`

**Test**: Execute a 10-bead swarm with parallel and sequential stages → verify all complete → no deadlocks

**Files**: `src/swarm/coordinator.ts`, `src/swarm/tools.ts`

---

### Gate 8: Full Stack Test
**Goal**: End-to-end verification of all components

**Deliverables**:
- [ ] All unit tests passing (see Testing Strategy section)
- [ ] Integration test: Real MemPalace + Groq + Gas Town CLI
- [ ] Load test: 100+ beads processed concurrently
- [ ] Gas Town compatibility test: nostown and gastown agents interoperate
- [ ] Documentation complete and reviewed

**Test**: Run the full stack scenario from [FORK_STRATEGY.md](./FORK_STRATEGY.md) end-to-end

**Files**: `tests/integration/`, `tests/e2e/`

---

## Implementation Order

Follow this sequence for fastest path to working system:

1. **Gate 1** (Foundation) — 2-3 days
2. **Gate 2** (Roles & Routing) — 3-4 days
3. **Gate 3** (Convoys & Mailboxes) — 2-3 days
4. **Gate 4** (Knowledge Graph) — 3-4 days
5. **Gate 5** (Hooks) — 2-3 days
6. **Gate 6** (Resilience) — 2-3 days
7. **Gate 7** (Swarm) — 3-4 days
8. **Gate 8** (Full Stack Test) — 2-3 days

**Total**: ~20-28 days for full implementation

---

## Progress Tracking

Use the checkboxes in each gate to track implementation progress. All checkboxes must be complete before moving to the next gate.

For each gate:
1. Complete all deliverables
2. Run the gate's test scenario
3. Review files for code quality
4. Check off all boxes
5. Proceed to next gate
