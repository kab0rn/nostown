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
Wing (= Rig or Role)               wing_rig_tcgliveassist
  └── Room (= Topic/Task)              auth-migration
        ├── Hall (= Memory Type)           hall_facts
        │                                 hall_events
        │                                 hall_discoveries
        │                                 hall_preferences
        │                                 hall_advice       ← Playbooks live here
        ├── Closet (= Summary Pointer)    closet_auth_jwt_v2
        └── Drawer (= Verbatim Original)  bead_892a-bc34.json

Tunnel (= Cross-Rig shared room)   wing_rig_openclaw ←→ wing_rig_tcgliveassist
                                     (both have room: auth-migration)
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
| **L1** | Critical facts — team, current sprint, model prefs | ~120 (AAAK) | Always |
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

When two Rigs share a room name (e.g., both have `auth-migration`), MemPalace **automatically creates a Tunnel** between the wings, enabling the Mayor to query: *"Did we solve this auth problem in another Rig?"*

---

## The Knowledge Graph (Temporal Triple Store)

Backed by local SQLite, the KG tracks entity-relationship triples with validity windows:

```python
# Witness council decision
kg.add_triple("witness_council_042", "approved", "auth-migration-PR#89",
    valid_from="2026-04-08", metadata={"score": "3/3", "model": "qwen3-32b"})

# Model routing lock
kg.add_triple("llama-3.1-8b", "locked_to", "typescript_generics",
    valid_from="2026-04-01")

# Model demotion (invalidates previous lock)
kg.add_triple("llama-3.1-8b", "locked_to", "typescript_generics",
    valid_to="2026-04-08", metadata={"reason": "prompt_drift"})

# Time-aware query
kg.query_entity("llama-3.1-8b", as_of="2026-04-05")
# → [llama-3.1-8b → locked_to → typescript_generics (active)]
```

**KG Use Cases in NOS Town:**
- Track Witness council votes across sessions — Mayor queries `kg.timeline("billing-refactor")` before planning
- Track model performance locks/demotions — Historian writes, Mayor reads
- Track team assignments — *"Who owns auth-migration as of this week?"*
- Historical debugging — *"What was the routing table for Security/Auth in March?"*

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
- `mempalace_diary_write` — each role logs its session in AAAK dialect
- `mempalace_diary_read` — role reads its own history before starting

### Status
- `mempalace_status` — returns AAAK spec + memory protocol (self-configuring)

---

## Retrieval Performance

Searching *without* palace structure (flat ChromaDB) vs. *with* palace filtering:

| Search Scope | R@10 | Gain vs Flat |
|---|---|---|
| All closets (flat) | 60.9% | baseline |
| Within wing only | 73.1% | +12% |
| Wing + hall | 84.8% | +24% |
| Wing + room | 94.8% | **+34%** |

The hierarchy is not organizational aesthetics — it is a **34% retrieval improvement** that directly impacts Mayor planning quality and Polecat context accuracy.

---

## Auto-Save Hooks Integration

MemPalace ships two shell hooks that integrate with the NOS Town session lifecycle:

### `mempal_save_hook.sh` — Periodic Save
Triggers every 15 Mayor messages. Performs a structured write:
- Topics discussed → room classification
- Decisions made → `hall_facts` + KG triple
- Code changes → `hall_discoveries` drawer
- Polecat outcomes → Bead drawer in appropriate room

### `mempal_precompact_hook.sh` — Emergency Save
Fires **before context compression**, preventing data loss when the NOS Town session hits context limits. This is especially critical for long Convoy chains where multiple dependent Beads accumulate.

> **Security Note:** The save hooks use shell execution. Ensure inputs are sanitized — see upstream MemPalace Issue #110 for the active patch on shell injection hardening.

---

## AAAK Compression for Bead Ledger Context Loading

AAK is a custom lossy abbreviation dialect that assigns short entity codes to frequently-repeated names. It is **not** used for retrieval (raw mode scores 96.6% R@5 vs AAAK's 84.2%) but is highly effective for **context loading** of the Beads Ledger into the Mayor's planning pass:

```
# Raw Bead (verbose JSON — expensive at 500+ beads/day):
{"role": "polecat", "task_type": "refactor_generic_type", "model": "llama-3.1-8b-instant",
 "test_pass": true, "witness_score": 92, "duration_ms": 1450}

# AAAK compressed (for Mayor context loading):
POL|rfct.gen_type|L8B|pass|W92|1450ms
```

AAK entity codes are readable by any LLM (Claude, Groq models, GPT, Gemini) without a decoder — it is compressed English, not binary encoding.

**Use AAAK for:** Mayor Bead manifest loading, agent diary entries, L1 critical facts
**Use Raw mode for:** All MemPalace retrieval/search operations

---

## Setup

```bash
# Install MemPalace as a dependency
pip install mempalace>=3.0.0

# Initialize a wing for a NOS Town Rig
mempalace init --wing wing_rig_myproject --auto-detect-rooms ./src

# Initialize role wings
mempalace init --wing wing_mayor
mempalace init --wing wing_historian
mempalace init --wing wing_witness
mempalace init --wing wing_safeguard

# Start the MCP server (used by all NOS Town agents)
mempalace serve --port 7474
```

Add to your NOS Town Mayor prompt:
```
STRICT MEMORY PROTOCOL (prepend to every session):
1. CALL mempalace_status → load AAAK spec and memory protocol
2. CALL mempalace wake-up --wing wing_rig_{project} → load L0+L1 (~170 tokens)
3. CALL mempalace_kg_query for current team assignments and open work
4. THEN decompose into Micro-Beads as normal
```

---

## Relationship to Historian

MemPalace does not replace the Historian — it **supercharges** it:

| Historian Function | Before MemPalace | After MemPalace |
|---|---|---|
| Pattern mining | Groq Batch embedding + 70B clustering | `mempalace mine --mode convos` auto-classifies |
| Playbook storage | `playbooks/` markdown files (flat) | `hall_advice` rooms (semantically searchable) |
| Model routing updates | Routing table markdown file | KG triple with `valid_from` timestamp |
| Cross-Rig pattern sharing | None (Rigs isolated) | Tunnels auto-connect shared rooms |
| Bead compression for context | Not implemented | AAAK manifest for Mayor planning pass |

See [HISTORIAN.md](./HISTORIAN.md) for the updated Historian pipeline that incorporates MemPalace mining.

---

## See Also

- [ROLES.md](./ROLES.md) — Updated Mayor, Historian, Witness, and Safeguard prompts with MemPalace calls
- [HISTORIAN.md](./HISTORIAN.md) — Updated pipeline: Bead export → MemPalace mine → Playbook generation
- [ROUTING.md](./ROUTING.md) — Palace-aware routing column: playbook match before model selection
- [FORK_STRATEGY.md](./FORK_STRATEGY.md) — Persistence divergence from Gas Town upstream
