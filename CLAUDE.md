# NOS Town

Run `nt prime` for full session context after compaction, clear, or new session.

## Startup

Run `nt status` to confirm the rig and agent ID are loaded.

## Interaction model

Just type what you want — no command syntax required:

```bash
nt add rate limiting to the polecat dispatch loop
nt fix the convoy signature check
nt refactor the KG query cache
nt status
```

The `nt` binary routes plain text directly to the Mayor for orchestration.
For an interactive session (like this one), run `nt` with no arguments.

## Architecture

| Component | Location | Role |
|---|---|---|
| Mayor | `src/roles/mayor.ts` | Orchestrator — decomposes tasks into beads |
| Polecats | `src/roles/polecat.ts` | Workers — execute beads |
| Witnesses | `src/roles/witness.ts` | Reviewers — score completions |
| Convoys | `src/convoys/` | Signed message bus |
| KG | `src/kg/` | Knowledge graph for model routing |
| Ledger | `src/ledger/` | JSONL bead log (persistence layer) |

Memory: Agent memory is provided by the Ledger (`rigs/{rig}/beads/current.jsonl`) and the Knowledge Graph (`palace-db/knowledge_graph.sqlite`). No external memory server is required.

Full architecture docs: `docs/`

## Development

```bash
npm test              # Run all tests
npm run typecheck     # TypeScript check
```

## Dolt / beads

NOS Town uses `bd` (beads) for issue tracking. Run `bd prime` for context.

## Session close

Before ending a session:
1. `npm test` — all tests must pass
2. `git push` — push to origin
