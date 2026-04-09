# Swarm Coordination

NOS Town supports multi-agent swarm workflows where multiple roles collaborate on complex tasks requiring parallel execution and cross-role coordination.

## Swarm Primitives

Swarm coordination uses:
- **Beads with multiple prerequisite dependencies**: A bead can list multiple `needs` that must resolve before it dispatches
- **Broadcasting**: A role can emit a broadcast convoy that all listening roles receive
- **Rendezvous points**: Special beads that wait for multiple roles to signal completion

---

## Swarm Workflow Example

### Research + Analysis + Report Generation

```jsonl
{"id": "bead_research_1", "role": "Researcher", "needs": [], "action": "GATHER_DATA", "context": {"topic": "market_trends"}}
{"id": "bead_research_2", "role": "Researcher", "needs": [], "action": "GATHER_DATA", "context": {"topic": "competitor_analysis"}}
{"id": "bead_analysis", "role": "Analyst", "needs": ["bead_research_1", "bead_research_2"], "action": "SYNTHESIZE", "context": {}}
{"id": "bead_report", "role": "Writer", "needs": ["bead_analysis"], "action": "GENERATE_REPORT", "context": {"format": "PDF"}}
```

This creates a dependency graph:
```
Researcher (topic A) ↓
                     → Analyst → Writer
Researcher (topic B) ↑
```

---

## Broadcasting

A role can broadcast to all roles:

```typescript
// src/convoy/bus.ts
await convoyBus.broadcast({
  from: "Mayor",
  type: "PRIORITY_OVERRIDE",
  payload: {instruction: "Pause all non-critical beads"}
});
```

All roles receive the broadcast and can choose to respond or ignore based on their current state.

---

## Rendezvous Points

A **rendezvous bead** waits for multiple roles to signal completion before proceeding:

```jsonl
{"id": "bead_rendezvous", "role": "Coordinator", "needs": ["bead_task_a", "bead_task_b", "bead_task_c"], "action": "MERGE_RESULTS", "context": {}}
```

The Coordinator won't dispatch until all three prerequisite beads resolve.

---

## Swarm Coordination Patterns

### Pattern 1: Fork-Join
```
Mayor creates N parallel beads → all execute concurrently → rendezvous bead waits for all → final action
```

### Pattern 2: Pipeline
```
Role A → Role B → Role C (sequential chain)
```

### Pattern 3: Map-Reduce
```
Mayor maps work to N Researchers → Analyst reduces results → Writer outputs
```

---

## Swarm State Management

The **Knowledge Graph** tracks swarm state:
- Each bead's resolution status is stored as a triple: `(bead_id, has_status, PENDING|RESOLVED|FAILED)`
- Dependencies are tracked: `(bead_child, needs, bead_parent)`
- The Convoy bus queries the KG before dispatching to ensure all prerequisites are met

---

## Swarm Failure Handling

If a bead in a swarm fails:
1. The Historian logs the failure
2. All dependent beads are marked as `BLOCKED`
3. The Mayor is notified via `SWARM_FAILURE` event
4. The Mayor decides: retry, skip, or abort the entire swarm

---

## Swarm MCP Tools

Roles can use these MCP tools for swarm coordination:

### `swarm_status`
```typescript
{
  name: "swarm_status",
  description: "Get current status of all beads in a swarm workflow",
  inputSchema: {
    type: "object",
    properties: {
      swarmId: {type: "string", description: "ID of the swarm workflow"}
    },
    required: ["swarmId"]
  }
}
```

### `swarm_broadcast`
```typescript
{
  name: "swarm_broadcast",
  description: "Broadcast a message to all roles in the swarm",
  inputSchema: {
    type: "object",
    properties: {
      message: {type: "string", description: "Message to broadcast"},
      priority: {type: "string", enum: ["LOW", "NORMAL", "HIGH", "CRITICAL"]}
    },
    required: ["message"]
  }
}
```

---

## Swarm Testing Checklist

- [ ] Fork-join pattern with 3+ parallel beads resolves correctly
- [ ] Rendezvous bead waits for all prerequisites before dispatching
- [ ] Broadcast reaches all listening roles
- [ ] Failed bead blocks dependent beads and notifies Mayor
- [ ] KG correctly tracks swarm dependency graph
- [ ] Swarm with 10+ beads completes without deadlock
- [ ] Circular dependency detection prevents infinite loops

---

## See Also

- [ROUTING.md](./ROUTING.md) — Event dispatch and convoy routing rules
- [KNOWLEDGE_GRAPH.md](./KNOWLEDGE_GRAPH.md) — Dependency tracking and state queries
- [CONVOYS.md](./CONVOYS.md) — Message passing integrity and verification
