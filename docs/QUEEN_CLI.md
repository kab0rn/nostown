# Queen CLI

The Queen is NOSTown's human operator shell.

```bash
nt
nt queen attach
nt queen start
nt queen stop
nt queen restart
nt queen status
```

Bare `nt` aliases to `nt queen attach`. The tmux session name is `nt-queen`.
If the session is missing it is started automatically. If the pane exists but
the runtime has exited back to a shell, `nt queen attach` respawns the Queen
runtime before attaching.

## Shell Commands

- `/status` - hive status
- `/trail` - recent comb records
- `/show <bead>` - inspect a bead through `bd`
- `/swarm <bead>` - run pure swarm consensus
- `/doctor` - validate Gas City bridge prerequisites
- `/gas` - print the `city.toml` router-agent snippet
- `/exit` - leave the shell
- `/quit` - leave the shell

Beehive language is UI-only. The bridge schema remains role-neutral: worker,
judge, arbiter, consensus.

`/doctor` renders a human table. `/swarm` renders consensus, adjudicated,
no-consensus, timeout, and error states explicitly. Ctrl-C returns control to
the prompt for an active `/swarm`; already-started provider work may continue in
the background if the provider cannot cancel it. The Queen tmux session stays
alive.

Plain text is intentionally conservative. Inputs such as `swarm gc-123` and
`show gc-123` are routed to bridge actions; broader instructions are acknowledged
as operator intent rather than passed to the legacy role runtime.
