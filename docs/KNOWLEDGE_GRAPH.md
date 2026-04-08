# Knowledge Graph Synchronization

To maintain a consistent worldview across distributed MemPalace instances, NOS Town implements a synchronization protocol.

## Node Hierarchy
- **Primary Historian**: The authoritative node for a specific wing or jurisdiction.
- **Relay Nodes**: Subordinate MemPalace instances that cache and propagate updates.

## Consistency Model
NOS Town follows an **Eventual Consistency** model with conflict resolution:
1. **Timestamping**: Every entry is tagged with a high-resolution timestamp and agent ID.docs: add KNOWLEDGE_GRAPH.md — sync and consistency protocols
2. **Merge Strategy**: In case of overlapping updates to the same knowledge node, the Historian applies a "Most Informative Merge" (MIM) rule, preferring the more detailed context.
3. **Sync Heartbeat**: Nodes exchange state hashes every 500ms to detect discrepancies.
