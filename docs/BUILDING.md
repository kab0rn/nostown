# NOS Town — Building Guide

How to build NOS Town on top of the [Gas Town](https://github.com/gastownhall/gastown) codebase. This document bridges the gap between the architectural docs and an actual working implementation.

---

## Prerequisites

Before starting, you need:

- **Node.js 20+** — NOS Town agents run in Node.js/TypeScript
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
├── package.json        # Node.js project root
├── src/
│   ├── mayor/          # Mayor orchestrator (groq/compound)
│   ├── polecat/        # Polecat agent swarm (Llama 4 Scout / 8B)
│   ├── witness/        # Witness council (qwen3-32b / 70B)
│   ├── historian/      # Batch mining pipeline
│   ├── safeguard/      # Security sentry (pooled)
│   ├── routing/        # KG-backed model routing
│   ├── convoys/        # Message bus + mailboxes
│   ├── kg/             # Knowledge Graph (SQLite triple store)
│   └── ledger/         # Append-only JSONL bead ledger
├── rigs/               # One subdir per project rig
│   └── my-project/
│       ├── .hook       # Gas Town hook file (schema compat)
│       └── beads/
│           └── current.jsonl  # Per-rig bead ledger
├── kg/
│   └── knowledge_graph.sqlite  # KG triple store
└── docs/               # This documentation
```

---

## Gas Town Compatibility Layer

NOS Town maintains 1:1 compatibility with Gas Town's `.hook` file schema and `beads.jsonl` ledger format. This means any project already managed by Gas Town can be "powered up" by NOS Town without migrating data.

### What Gas Town provides (keep these)

| Gas Town Concept | File/Format | NOS Town behavior |
|---|---|---|
| Hook | `.hook` (JSON) | Read on session start; hook executor runs variable substitution and dispatches actions |
| Bead Ledger | `beads.jsonl` | Historian reads this nightly; KG stores derived routing decisions |
| Convoy | Convoy schema | NOS Town extends with Ed25519 signature verification (see CONVOYS.md) |
| Roles (Mayor/Witness) | Role definitions | Extended with KG-backed routing and Playbook protocols (see ROLES.md) |

### What NOS Town adds on top

| NOS Town Addition | Where it lives | Purpose |
|---|---|---|
| Knowledge Graph | `kg/knowledge_graph.sqlite` | KG-backed routing, temporal triples, audit history |
| Historian batch job | `src/historian/` | Nightly mining of beads into Playbooks |
| Safeguard sentry | `src/safeguard/` | Real-time security layer (pooled workers) |
| Mailboxes | `src/convoys/` | Async inter-agent message bus |

---

## Setup Walkthrough (End-to-End)

### Step 1: Install dependencies

```bash
npm install
```

### Step 2: Initialize a rig

A "rig" is a project-level workspace. Each rig has a Gas Town `.hook` file and a per-rig bead ledger.

```bash
# Create the rig directory
mkdir -p rigs/my-project/beads

# Initialize a Gas Town hook (copy structure from Gas Town docs)
echo '{"project": "my-project", "state": "active"}' > rigs/my-project/.hook
```

### Step 3: Run the Mayor

```bash
# Set env
export GROQ_API_KEY=gsk_...
export NOS_RIG=my-project

# Start the Mayor orchestrator
npx tsx src/mayor/index.ts --rig my-project
```

### Step 4: Verify with a test task

```bash
# Send a test task via the Convoy bus
npx tsx src/convoys/send.ts --rig my-project --task "List open issues in my rig"
```

---

## Agent Build Order

Build in this order — each layer depends on the one below it:

1. **Groq provider wrapper** (`src/groq/`) — `executeInference()` with escalation + rate limit logic
2. **Ledger** (`src/ledger/`) — append-only JSONL with per-rig mutex
3. **Knowledge Graph** (`src/kg/`) — SQLite triple store with class-aware conflict resolution
4. **Polecat** (`src/polecat/`) — simplest agent, validates the full stack
5. **Convoys / Mailboxes** (`src/convoys/`) — inter-agent messaging
6. **Witness Council** (`src/witness/`) — parallel multi-judge consensus
7. **Mayor** (`src/mayor/`) — top-level orchestrator, depends on all above
8. **Safeguard** (`src/safeguard/`) — pooled security sentry, wraps all agent output
9. **Historian** (`src/historian/`) — batch job, runs independently

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | Yes | Groq Cloud API key |
| `NOS_RIG` | Yes | Active rig name (e.g. `my-project`) |
| `NOS_ROLE_KEY_DIR` | Yes | Directory containing per-role Ed25519 signing keys |
| `NOS_LOG_LEVEL` | No | Log verbosity: `debug`, `info`, `warn` (default: `info`) |
| `HISTORIAN_CRON` | No | Cron schedule for nightly Historian run (default: `0 2 * * *`) |
| `SAFEGUARD_MODE` | No | `sentry` (real-time) or `audit` (log-only) |
| `OLLAMA_URL` | No | Ollama server URL — activates Tier B local fallback if set |

---

## Testing Strategy

### Unit tests

Test each agent in isolation by mocking the Groq SDK:

```typescript
// Mock the groq-sdk
jest.mock('groq-sdk');
```

No external server is required. All persistence is via the Ledger (JSONL) and Knowledge Graph (SQLite), both of which can be initialized in-process for tests using `tmp` directories.

### Integration tests

Spin up a real SQLite KG and per-rig ledger in a temp directory:

```bash
npx jest --testPathPattern=integration
```

### End-to-end tests

Send a real task through the full stack (requires a valid `GROQ_API_KEY`):

```bash
npx jest --testPathPattern=e2e
```

---

## Related Docs

- [ROLES.md](ROLES.md) — Agent prompt templates and agentic protocols
- [GROQ_INTEGRATION.md](GROQ_INTEGRATION.md) — SDK setup, model selection matrix, Batch API
- [ROUTING.md](ROUTING.md) — Escalation ladder and KG-backed routing
- [FORK_STRATEGY.md](FORK_STRATEGY.md) — Gas Town upstream sync strategy

---

## Gate-by-Gate Risk Tracking

| Gate | Risk to Surface | How to Look for It | Exit Criterion |
|---|---|---|---|
| Gate 1 | Ledger mutex contention under concurrent writes | Load test 5, 10, 15 concurrent writers per rig | p95 lock wait <= 25ms |
| Gate 1 | KG SQLite write latency | Benchmark concurrent triple inserts | p95 KG write <= 50ms |
| Gate 2 | Mayor orphan workflow risk | Kill Mayor mid-dispatch during integration run | Replacement Mayor resumes without duplicate bead creation |
| Gate 2 | Playbook freshness drift | Replay stale playbook scenarios with recent rejections | Stale playbooks are advisory-only, not route-locking |
| Gate 3 | Forged convoy sender | Inject valid-HMAC but wrong-key message | Receiver rejects with `AUTHN_FAILED` or `AUTHZ_DENIED` |
| Gate 3 | Queue starvation of critical beads | Run mixed fan-out workload under backpressure | Critical-path / high-fan-out predecessors drain first |
| Gate 4 | KG critical conflict corruption | Simulate conflicting routing / ownership writes from different roles | Role precedence resolves critical conflicts correctly |
| Gate 4 | Cross-rig tunnel leakage | Create same-room, incompatible-stack rigs | Tunnel results are blocked or advisory-only |
| Gate 5 | Hook-triggered command injection | Fuzz substitution inputs and command payloads | Sanitizer blocks unsafe expansion |
| Gate 6 | Safeguard bottleneck | Burst 20–50 diff scans with one worker and with pool | P95 scan latency and queue depth stay within thresholds |
| Gate 6 | Ledger mutex contention | Parallel writes across multiple rigs | Per-rig partitions keep lock waits below threshold |
| Gate 7 | Deadlock missed by time-only heuristics | Create high-fan-out blocked predecessor | Early escalation occurs before 15-minute timeout |
| Gate 8 | Architecture/spec drift | Full end-to-end trace review against invariants | All critical invariants proven by tests + telemetry |

## Implementation Gates

To ensure the gastown team can build a complete project plan, NOS Town's implementation is organized into sequential gates. Each gate must be completed and tested before moving to the next.

### Gate 1: Foundation

**Goal**: Get the core infrastructure running

**Deliverables**:
- [ ] SQLite Knowledge Graph initialized with schema from [KNOWLEDGE_GRAPH.md](./KNOWLEDGE_GRAPH.md)
- [ ] Per-rig Ledger with append-only JSONL and mutex
- [ ] Groq SDK integration with preview/primary model selection (see [GROQ_INTEGRATION.md](./GROQ_INTEGRATION.md))
- [ ] Gas Town CLI installed and bead ledger initialized

**Test**: Create a test bead, resolve it with Groq, verify Ledger and KG store the outcome

**Files**: `src/ledger/index.ts`, `src/kg/index.ts`, `src/groq/sdk.ts`, `package.json`

---

### Gate 2: Roles & Routing

**Goal**: Implement the Mayor, Historian, and routing rules

**Deliverables**:
- [ ] Mayor role with model promotion logic (see [ROLES.md](./ROLES.md))
- [ ] Historian role with nightly KG writes (see [HISTORIAN.md](./HISTORIAN.md))
- [ ] Event routing rules from [ROUTING.md](./ROUTING.md) implemented in `src/routing/dispatch.ts`
- [ ] Convoy bus for inter-role messaging (see [CONVOYS.md](./CONVOYS.md))

**Test**: Mayor assigns a bead → Polecat resolves → Historian logs → Mayor promotes model via KG

**Files**: `src/roles/mayor.ts`, `src/roles/historian.ts`, `src/routing/dispatch.ts`, `src/convoys/bus.ts`

---

### Gate 3: Convoys & Transport

**Goal**: Enable Gas Town compatibility via convoy transport

**Deliverables**:
- [ ] Convoy signature generation and validation using Ed25519 per-role keys (see [CONVOYS.md](./CONVOYS.md))
- [ ] Inter-agent communication bus at `src/convoys/bus.ts`
- [ ] Sequence number enforcement and replay attack prevention
- [ ] Failure quarantine logic

**Test**: Send a signed convoy → verify validation passes → Receiver processes message

**Files**: `src/convoys/bus.ts`, `src/convoys/sign.ts`

---

### Gate 4: Knowledge Graph Integration

**Goal**: Use the KG for routing locks, audit history, and class-aware conflict resolution

**Deliverables**:
- [ ] KG triple store with class-aware resolveConflict() (see [KNOWLEDGE_GRAPH.md](./KNOWLEDGE_GRAPH.md))
- [ ] Temporal triples with `valid_from` / `valid_to` windows
- [ ] Mayor KG routing lock query at dispatch time
- [ ] Circular dependency detection in Convoy bus

**Test**: Create a routing lock in KG → Mayor respects lock at next dispatch → lock demotion writes correctly

**Files**: `src/kg/index.ts`, `src/routing/dispatch.ts`

---

### Gate 5: Hooks & Gas Town Compatibility

**Goal**: Load and execute .hook files for event-driven behaviors

**Deliverables**:
- [ ] Hook loader from `hooks/*.hook` files (see [HOOK_SCHEMA.md](./HOOK_SCHEMA.md))
- [ ] Hook validation for required fields and action types
- [ ] Variable substitution engine for `{{event.beadId}}` syntax with allow-list
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

**Files**: `src/groq/provider.ts`, `src/hardening/sanitize.ts`

---

### Gate 7: Swarm Workflows

**Goal**: Multi-agent coordination patterns

**Deliverables**:
- [ ] Fork-join pattern implementation (see [SWARM.md](./SWARM.md))
- [ ] Broadcast convoy support
- [ ] Rendezvous bead waiting for multiple prerequisites
- [ ] Swarm failure handling and recovery

**Test**: Execute a 10-bead swarm with parallel and sequential stages → verify all complete → no deadlocks

**Files**: `src/swarm/coordinator.ts`

---

### Gate 8: Full Stack Test

**Goal**: End-to-end verification of all components

**Deliverables**:
- [ ] All unit tests passing (see Testing Strategy section)
- [ ] Integration test: Real KG + Groq + Gas Town CLI
- [ ] Load test: 100+ beads processed concurrently
- [ ] Gas Town compatibility test: nostown and gastown agents interoperate
- [ ] Documentation complete and reviewed

**Test**: Run the full stack scenario from [FORK_STRATEGY.md](./FORK_STRATEGY.md) end-to-end

**Files**: `tests/integration/`, `tests/e2e/`

---

## Implementation Order

Follow this sequence for fastest path to working system:

1. **Groq provider wrapper**
2. **Ledger + KG primitives**
3. **Convoy authn/authz primitives**
4. **Ledger partitioning**
5. **Polecat**
6. **Witness**
7. **Mayor**
8. **Safeguard pool**
9. **KG conflict-class logic**
10. **Swarm coordinator**
11. **Historian**
12. **Full-stack testing**

---

## Progress Tracking

Use the checkboxes in each gate to track implementation progress. All checkboxes must be complete before moving to the next gate. For each gate:

1. Complete all deliverables
2. Run the gate's test scenario
3. Review files for code quality
4. Check off all boxes
5. Proceed to next gate

## Known Risks Register

The living risk register is tracked in [RISKS.md](./RISKS.md). Every gate review MUST:

1. update risk status
2. attach metric evidence
3. attach failing or passing test references
4. document mitigation shipped or deferred

---

## See Also

- [ROUTING.md](./ROUTING.md) — How the Mayor chooses roles.
- [RESILIENCE.md](./RESILIENCE.md) — Handling failures and outages.
- [KNOWLEDGE_GRAPH.md](./KNOWLEDGE_GRAPH.md) — KG schema, MIM conflict resolution.

## Architecture Corrections Required Before v1.0

The documentation defines the target architecture, but the following corrections are mandatory during implementation:

1. Mayor dispatch must be checkpoint-gated (local `ckpt_<uuid>`, verified by convoy bus)
2. Convoy sender identity must use per-role Ed25519 keys, not shared HMAC alone
3. Safeguard must run as a pool (min 2 workers in development, 4 in staging/production)
4. Ledger writes must be partitioned per rig with per-rig mutex
5. Critical KG conflicts must use role precedence, not MIM
6. Swarm queueing must prioritize dependency criticality, not FIFO only

These are implementation-blocking invariants, not optional hardening.
