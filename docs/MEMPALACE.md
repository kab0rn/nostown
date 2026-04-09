# NOS Town MemPalace — Persistent Memory Layer

Deep, structured, cross-session memory for every NOS Town agent. MemPalace is the "long-term brain" that makes every Rig, Polecat, Witness, and Historian **remember everything** — verbatim, hierarchically organized, and retrievable with 94.8% R@10 precision.

---

## Why NOS Town Needs MemPalace

NOS Town's execution layer is already among the fastest AI agent systems on the planet thanks to Groq's LPU. But speed without memory is brute force. Every session restart today means the Mayor re-reads `.hook` files to bootstrap context — a lossy, flat, 30-day-expiry summary layer. MemPalace replaces and dramatically extends this:

| Current NOS Town | With MemPalace |
|---|---|
| `.hook` files — flat text, manually maintained | Palace Wings — hierarchical, auto-indexed |
| Beads expire after 30 days | Verbatim Drawers stored permanently |
| Historian mines patterns nightly with 70B passes | MemPalace mines Beads into Closets automatically |
| Witness outcomes not tracked across sessions | Knowledge Graph records every council vote |
| Rigs isolated from each other | Tunnels connect shared rooms across Rigs |
| ~170-token wake-up not structured | L0+L1 structured 4-layer memory stack |

---

## Palace Hierarchy (The Memory Palace Metaphor)

Inspired by the ancient "Method of Loci" mnemonic: each memory is placed in a spatial location so it can be retrieved by navigating a mental map. In NOS Town:

```
Wing (= Rig or Role)          wing_rig_tcgliveassist
  └── Room (= Topic/Task)       auth-migration
        ├── Hall (= Memory Type)      hall_facts
        │                             hall_events
        │                             hall_discoveries
        │                             hall_preferences
        │                             hall_advice       <- Playbooks live here
        ├── Closet (= Summary Pointer) closet_auth_jwt_v2
        └── Drawer (= Verbatim Original) bead_892a-bc34.json

Tunnel (= Cross-Rig shared room) wing_rig_openclaw <-> wing_rig_tcgliveassist (both have room: auth-migration)
```

### Hall Definitions

| Hall | What Lives Here | NOS Town Equivalent |
|---|---|---|
| `hall_facts` | Permanent truths — team, stack, config | `.hook` files (upgraded) |
| `hall_events` | Session-level happenings, milestones | Mailbox logs |
| `hall_discoveries` | Debug findings, root causes, "aha" moments | Polecat BLOCKED resolutions |
| `hall_preferences` | Model routing preferences per task cluster | Routing Table entries |
| `hall_advice` | Validated implementation strategies | **Playbooks** |

---

## 4-Layer Memory Stack

MemPalace loads memory in tiers to keep token cost near zero at session start:

| Layer | Content | Tokens | Trigger |
|---|---|---|---|
| **L0** | Rig identity — what project, what stack | ~50 | Always |
| **L1** | Critical facts — team, current sprint, model prefs | ~120 | Always |
| **L2** | Room recall — recent sessions, current task | On demand | Topic arises |
| **L3** | Deep search — semantic query across all closets | On demand | Explicit search |

**L0+L1 combined is ~170 tokens.** The Mayor wakes up knowing the full project context before decomposing a single Bead.

---

## Wing-Per-Role Mapping

Every NOS Town role and every Rig gets its own dedicated memory namespace:

| NOS Town Entity | MemPalace Wing | Primary Halls Used |
|---|---|---|
| Mayor | `wing_mayor` | `hall_facts`, `hall_decisions` |
| Historian | `wing_historian` | `hall_advice`, `hall_discoveries` |
| Witness Council | `wing_witness` | `hall_events`, `hall_advice` |
| Safeguard | `wing_safeguard` | `hall_facts`, `hall_events` |
| Rig: Project A | `wing_rig_{project_name}` | All halls |
| Rig: Project B | `wing_rig_{project_name}` | All halls |

When two Rigs share a room name (e.g., both have `auth-migration`), MemPalace **automatically creates a Tunnel** between the wings, enabling the Mayor to query: "Did we solve this auth problem in another Rig?"

---

## The Knowledge Graph (Temporal Triple Store)

Backed by local SQLite, the KG tracks entity-relationship triples with validity windows.

### Consistency & Conflict Resolution

The KG is eventually consistent. We use **Deterministic Conflict Resolution (DCR)** to ensure all agents reach the same state:

1. **Total Ordering**: Conflicts are resolved by:
   - `valid_from` timestamp (later wins)
   - Metadata field count (Most Informative Merge - MIM)
   - Lexicographic comparison of object values (Tiebreaker)
2. **State Hash Exchange**: Every 500ms, the MemPalace MCP server computes a rolling SHA-256 hash of the last 100 KG writes.
3. **Reconciliation**: If an agent detects a hash mismatch, it pauses writes, fetches missing triples via `mempalace_kg_timeline`, applies DCR, and resumes.

```typescript
// Example DCR logic
function resolveConflict(tripleA: Triple, tripleB: Triple): Triple {
  if (tripleA.valid_from > tripleB.valid_from) return tripleA;
  if (tripleA.valid_from < tripleB.valid_from) return tripleB;
  
  const metaA = Object.keys(tripleA.metadata || {}).length;
  const metaB = Object.keys(tripleB.metadata || {}).length;
  if (metaA > metaB) return tripleA;
  if (metaB > metaA) return tripleB;
  
  return tripleA.object > tripleB.object ? tripleA : tripleB;
}
```

---

## MCP Integration (19 Tools)

MemPalace exposes its full palace as an MCP server. NOS Town agents access it via these tool groups:

### Palace Read
- `mempalace_search` — semantic search across closets, filtered by wing+room
- `mempalace_list_wings` — enumerate all Rig wings
- `mempalace_list_rooms` — rooms within a wing
- `mempalace_get_taxonomy` — full palace map
- `mempalace_traverse` — walk the hierarchy
- `mempalace_find_tunnels` — cross-rig shared rooms

### Palace Write
- `mempalace_add_drawer` — store a verbatim Bead, Playbook, or session log
- `mempalace_delete_drawer` — remove stale content

### Knowledge Graph
- `mempalace_kg_add` — add a triple (entity, relationship, entity)
- `mempalace_kg_query` — query by entity, optionally `as_of` a date
- `mempalace_kg_timeline` — full history of a room or entity
- `mempalace_kg_invalidate` — mark a triple as no longer valid

### Agent Diaries
- `mempalace_diary_write` — each role logs its session
- `mempalace_diary_read` — role reads its own history before starting

---

## Retrieval Performance

Searching without palace structure (flat ChromaDB) vs. with palace filtering:

| Search Scope | R@10 | Gain vs Flat |
|---|---|---|
| All closets (flat) | 60.9% | baseline |
| Within wing only | 73.1% | +12% |
| Wing + hall | 84.8% | +24% |
| Wing + room | 94.8% | **+34%** |

---

## Auto-Save Hooks & Security

MemPalace hooks integrate with the NOS Town session lifecycle.

### ⚠️ Security Hardening

To prevent shell injection, all save hooks MUST use parameterized execution.

**DO NOT** use string interpolation:
```bash
# VULNERABLE
mempal_save --content "$USER_INPUT" 
```

**DO** use explicit argument passing and whitelisting:
```bash
# SECURE
mempal_save --content-file /tmp/bead_payload.json --wing "$SAFE_WING_NAME"
```

### `mempal_save_hook.sh` — Periodic Save
Triggers every 15 Mayor messages. Performs a structured write of decisions, code changes, and outcomes.

### `mempal_precompact_hook.sh` — Emergency Save
Fires **before context compression**, preventing data loss when the session hits context limits.

---

## Setup

```bash
# Install MemPalace
pip install mempalace>=3.0.0

# Initialize wings
mempalace init --wing wing_rig_myproject --auto-detect-rooms ./src
mempalace init --wing wing_mayor
mempalace init --wing wing_witness

# Start MCP server
mempalace serve --port 7474
```

---

## Deployment Modes

### Mode A — Single Sidecar (Gate 1–2 only)

- one MCP server
- one SQLite KG writer
- direct reads and writes
- suitable for local development and low-concurrency validation only

### Mode B — Queued Write Front Door (Gate 3+ recommended)

- direct read path remains available
- all write operations pass through a local bounded queue
- vector writes and KG writes are decoupled
- queue metrics are exported to observability

### Promotion Criteria

Move from Mode A to Mode B when any of the following is true:

- p95 KG write latency > 50ms during gate tests
- p95 `mempalace_add_drawer` > 150ms
- more than 10 concurrent writer agents are required

## Orphan Workflow Recovery

If active beads exist with no live Mayor heartbeat:

1. mark workflow `orphaned`
2. freeze new dispatch
3. start or elect a replacement Mayor
4. replacement Mayor reloads `active-convoy`, outage queue, and outstanding bead checkpoints
5. replacement Mayor reconciles dependencies before resuming dispatch

No orphaned workflow may resume dispatch until dependency reconciliation completes.

---

## See Also
- [ROLES.md](./ROLES.md) — Updated Mayor, Historian, Witness, and Safeguard prompts
- [HISTORIAN.md](./HISTORIAN.md) — Updated pipeline with incremental checkpointing
- [ROUTING.md](./ROUTING.md) — Capability-based model routing
- [OBSERVABILITY.md](./OBSERVABILITY.md) — Metrics, tracing, and alerting strategy
