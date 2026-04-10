# NOS Town

Run `nt prime` for full session context after compaction, clear, or new session.

## Startup

Check `nt status` to see if MemPalace is running. If not, `nt up` starts it.

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
| MemPalace | `mempalace-server/` | Memory sidecar (Python/FastAPI, port 7474) |
| Convoys | `src/convoys/` | Signed message bus |
| KG | `src/kg/` | Knowledge graph for model routing |

Full architecture docs: `docs/`

## Development

```bash
npm test              # Run all 572 tests
npm run typecheck     # TypeScript check
nt up                 # Start MemPalace
```

## Dolt / beads

NOS Town uses `bd` (beads) for issue tracking. Run `bd prime` for context.

## Session close

Before ending a session:
1. `npm test` — all tests must pass
2. `git push` — push to origin
