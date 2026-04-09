# Swarm Coordination

NOS Town supports multi-agent swarm workflows where multiple roles collaborate on complex tasks requiring parallel execution and cross-role coordination.

---

## Swarm Primitives

Swarm coordination uses:
- **Beads with multiple prerequisite dependencies**: A bead can list multiple `needs` that must resolve before it dispatches.
- **Broadcasting**: A role can emit a broadcast convoy that all listening roles receive.
- **Rendezvous points**: Special beads that wait for multiple roles to signal completion.

---

## Cycle Detection & Throttling

To prevent deadlocks and system saturation, the Mayor role implements the following safety measures:

### 1. Planning-Time Cycle Detection
Before dispatching a Convoy, the Mayor MUST perform a topological sort on the Micro-Bead dependency graph. If a cycle is detected, the planning pass is rejected with `DEPENDENCY_CYCLE`.

### 2. Runtime Cycle Breaker
If a bead has been in `STATUS: WAITING` for more than 15 minutes, the heartbeat monitor emits a `POTENTIAL_DEADLOCK` event to the Mayor.
- The Mayor queries the Knowledge Graph for the full dependency chain.
- If a circular path is found, the Mayor aborts the chain and escalates to human review.

### 3. Adaptive Throttling (Backpressure)
To prevent overwhelming the system, the Mayor enforces in-flight limits:
- **Max In-Flight Polecat Beads**: 50
- **Max In-Flight Witness Beads**: 20
- Before decomposing a new goal, the Mayor calls `mempalace_kg_query("active_beads_count")`. If limits are exceeded, the Mayor enters a `WAITING_FOR_CAPACITY` state.

---

## Swarm Workflow Example

### Research + Analysis + Report Generation

```jsonl
{"id": "bead_research_1", "role": "Researcher", "needs": [], "action": "GATHER_DATA"}
{"id": "bead_research_2", "role": "Researcher", "needs": [], "action": "GATHER_DATA"}
{"id": "bead_analysis", "role": "Analyst", "needs": ["bead_research_1", "bead_research_2"], "action": "SYNTHESIZE"}
{"id": "bead_report", "role": "Writer", "needs": ["bead_analysis"], "action": "GENERATE_REPORT"}
```

This creates a dependency graph:
```
Researcher (topic A) \
                      -> Analyst -> Writer
Researcher (topic B) /
```

---

## Swarm MCP Tools

Roles can use these MCP tools for swarm coordination:

### `swarm_status`
Returns the status of all beads in a swarm workflow, including dependency resolution progress.

### `swarm_broadcast`
Broadcasts a message to all roles. Used for priority overrides or global state changes (e.g., `LOCKDOWN`).

---

## Swarm Testing Checklist

- [ ] Topological sort detects cycles in planning stage.
- [ ] Heartbeat monitor catches beads waiting > 15min.
- [ ] Mayor stops generation when in-flight limits reached.
- [ ] Rendezvous beads wait for all prerequisites correctly.
- [ ] Failed beads correctly block dependent chains.

---

## See Also
- [ROUTING.md](./ROUTING.md) — Event dispatch and backpressure
- [HARDENING.md](./HARDENING.md) — Security and dependency enforcement
- [OBSERVABILITY.md](./OBSERVABILITY.md) — Monitoring swarm health and stall rates
