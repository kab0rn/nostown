# Gas City Bridge

NOSTown integrates with Gas City as an external `sling_query` command. Gas City
is static: no Go changes, no PackV2 requirement, no formulas, and no sessions
required for the bridge target.

## Architecture Contract

```text
NOSTown custom runtime -> bridge adapter -> static Gas City
```

The adapter runs outside Gas City. It may use inherited environment, the current
working directory, `bd`, and bead metadata. It must not set `gc.routed_to`, claim
sessions, assume pack/formula internals, or require custom Gas City code.

## city.toml

```toml
[[agent]]
name = "nostown"
scope = "city"
min_active_sessions = 0
max_active_sessions = 1
work_query = "printf ''"
sling_query = "nt gascity swarm --bead {} --mode apply --json"
```

`max_active_sessions = 1` avoids Gas City's zero-capacity warning. `work_query`
returns no demand because the target is a router, not a long-running Gas City
session.

## Flow

1. Operator runs `gc sling nostown <bead-id>`.
2. Gas City executes `nt gascity swarm --bead <bead-id> --mode apply --json` in
   the bead's resolved work directory with the relevant `bd` environment.
3. NOSTown loads the bead through `bd`.
4. Provider workers run in parallel.
5. NOSTown resolves consensus. `majority` requires a candidate to exceed 50% of
   total worker responses; invalid and timed-out workers count against that
   denominator.
6. If the requested strategy fails but valid worker output exists, NOSTown
   produces an `adjudicated` result instead of mislabeling it as consensus.
7. In `apply` mode, NOSTown writes compact `nos.consensus.*` metadata.
8. Full run details are stored in the local comb.

The comb is the long-form run ledger: request, worker candidates, parse errors,
provider/model/latency details, timeout flags, Arbiter trace, fallback details,
and final result. Gas City receives only compact `nos.consensus.*` metadata.
Comb writes are atomic local file writes with restrictive permissions, obvious
secret-like values redacted, and oversized raw strings truncated.

## Metadata Written

- `nos.consensus.status`
- `nos.consensus.run_id`
- `nos.consensus.strategy`
- `nos.consensus.agreement`
- `nos.consensus.adjudicated`
- `nos.consensus.summary`

The bridge never writes `gc.*` routing metadata and never starts Gas City
sessions.

## JSON Discipline

Every `nt gascity ... --json` command writes JSON only to stdout. Diagnostics go
to stderr. This keeps the command safe for `sling_query` and shell automation.
For one-shot bridge commands, the Go `nt` launcher synthesizes a structured JSON
error if the Node bridge crashes before writing JSON.

`nt gascity doctor` also writes JSON to stdout. Its payload is intentionally
small and stable for operators: `{ ok, checks }`, where each check includes
`ok` and `detail`.

The bridge parser is strict for `swarm`, `watch`, and `doctor`. Unknown flags,
missing values, duplicate flags, invalid modes, malformed stdin, and invalid
ranges return a JSON error on stdout.

For a local read-only smoke test:

```bash
npm run smoke:gascity
```

The smoke test builds `nt` into a temporary directory, uses a temporary comb, and
exercises `doctor`, launcher JSON failure handling, and pure `--stdin` swarm
mode without applying metadata to a real bead.

Supported `swarm` flags:

- `--bead <id>`
- `--stdin`
- `--mode pure|apply`
- `--strategy majority|unanimous|first_quorum`
- `--workers <n>` where default is `3` and default max is `9`
- `--quorum <ratio>` in `(0, 1]`
- `--timeout-ms <ms>` with default `90000`
- `--instructions <text>`
- `--json`

`--stdin` accepts a JSON bridge request. CLI flags override matching request
fields so automation can force read-only or timeout behavior at the call site.

## Adjudication

When the requested strategy fails but valid worker candidates exist, NOSTown runs
an Arbiter step. Arbiter results are returned with `status: "adjudicated"` and
`consensus.adjudicated: true`; they are never reported as normal consensus.

If the Arbiter provider fails, deterministic fallback is allowed, but it is still
marked `adjudicated`. Arbiter prompts, provider responses, and fallback details
live in the comb only.
