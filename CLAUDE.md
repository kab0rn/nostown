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

Memory: Agent memory is provided by the Ledger (`rigs/{rig}/beads/current.jsonl`) and the Knowledge Graph (`kg/knowledge_graph.sqlite`). No external server required — all persistence is local SQLite and JSONL.

Full architecture docs: `docs/`

## Development

```bash
npm test              # Run all tests
npm run typecheck     # TypeScript check
```

**Note:** `nt up` no longer exists — no server to start. All persistence is local SQLite + JSONL.

## Dolt / beads

NOS Town uses `bd` (beads) for issue tracking. Run `bd prime` for context.

## Session close

Before ending a session:
1. `npm test` — all tests must pass
2. `git push` — push to origin


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
