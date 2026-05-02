# NOSTown

Bridge-first swarm consensus runtime for Gas City, with a tmux-backed Queen CLI
for operators and a JSON-safe adapter for `city.toml`.

NOSTown's current product direction is deliberately narrow:

- Gas City stays static.
- The only Gas City integration point is `city.toml`.
- `nt gascity ... --json` is automation-safe and writes JSON only to stdout.
- Full swarm traces stay in NOSTown's local comb.
- Gas City receives only compact `nos.consensus.*` metadata.

## Architecture Contract

The boundary is fixed:

```text
NOSTown custom runtime -> bridge adapter -> static Gas City
```

Gas City can invoke NOSTown only through `city.toml` and the external
`sling_query` command. The bridge may inherit shell environment, call `bd`, and
read bead metadata. It must not require Gas City sessions, packs, formulas, or
custom Gas City Go code.

The older Mayor/Polecat/Witness runtime still exists in the repository as
internal runway for future swarm/runtime work. It is not the current UX, API, or
Gas City bridge contract.

## Public Surface

### Queen Operator CLI

```bash
nt
nt queen attach
nt queen start
nt queen stop
nt queen restart
nt queen status
nt hive status
nt swarm <bead>
```

Bare `nt` aliases to `nt queen attach`. The Queen shell is a persistent tmux
session named `nt-queen` with a `queen>` prompt.

Inside the shell:

- `/status` - show hive status
- `/trail` - show recent comb records
- `/show <bead>` - inspect a bead through `bd`
- `/swarm <bead>` - run pure swarm consensus
- `/doctor` - validate bridge prerequisites
- `/gas` - print the Gas City `city.toml` snippet
- `/help` - show shell commands
- `/exit` - leave the shell

### Gas City Adapter

These commands are the bridge surface intended for `city.toml` and scripts:

```bash
nt gascity swarm --bead <id> --mode pure --json
nt gascity swarm --bead <id> --mode apply --json
nt gascity swarm --stdin --json
nt gascity watch --mode apply
nt gascity doctor
```

Bridge output is role-neutral: workers, judges, arbiter, strategy, agreement,
and consensus. Beehive terms are UI/product language only. `majority` means a
candidate exceeded 50% of total worker responses; weaker plurality is resolved
through Arbiter and marked `adjudicated`.

Supported bridge flags are strict. Unknown flags, missing values, invalid modes,
bad ranges, and malformed stdin are rejected with a JSON error on stdout and
diagnostics on stderr.

```bash
nt gascity swarm \
  --bead <id> \
  --mode pure|apply \
  --strategy majority|unanimous|first_quorum \
  --workers 1..9 \
  --quorum 0.01..1 \
  --timeout-ms 90000 \
  --json
```

`nt swarm <bead>` is a convenience alias for pure JSON bridge mode. It keeps the
same supported swarm flags but always forces `--mode pure`.

## Gas City Configuration

Configure a no-demand router agent. Do not set `max_active_sessions = 0`; Gas
City treats that as zero capacity for routed work.

```toml
[[agent]]
name = "nostown"
scope = "city"
min_active_sessions = 0
max_active_sessions = 1
work_query = "printf ''"
sling_query = "nt gascity swarm --bead {} --mode apply --json"
```

Then route a bead:

```bash
gc sling nostown <bead-id>
```

Expected flow:

1. Gas City resolves the bead and executes `sling_query`.
2. `nt gascity swarm` loads bead data through `bd`.
3. Provider workers run in parallel.
4. NOSTown resolves consensus.
5. Failed quorum/unanimous strategies can produce `status: "adjudicated"` when
   valid worker output exists; that is intentionally not labeled consensus.
6. `pure` mode emits a result and performs no bead writes.
7. `apply` mode writes only namespaced `nos.consensus.*` metadata.
8. Full run details are written to the local comb keyed by `run_id`.

Metadata written in `apply` mode:

- `nos.consensus.status`
- `nos.consensus.run_id`
- `nos.consensus.strategy`
- `nos.consensus.agreement`
- `nos.consensus.adjudicated`
- `nos.consensus.summary`

The bridge does not write `gc.routed_to`, start Gas City sessions, require
packs, require formulas, or call Gas City internals.

If applying metadata fails after the comb record is written, the bridge returns a
structured `status: "error"` result with the comb path preserved. That is
intentional: the comb is the durable local ledger, while Gas City metadata is a
compact status projection.

## Installation

```bash
git clone https://github.com/kab0rn/nostown
cd nostown
npm install
```

Install `nt` on `PATH`:

```bash
./scripts/install-nt.sh
```

NOSTown must be discoverable through `NOS_HOME` or `~/.nostown/home`:

```bash
export NOS_HOME=/path/to/nostown
```

Validate the bridge environment:

```bash
nt gascity doctor
```

## Requirements

| Requirement | Notes |
|---|---|
| Node.js 20+ | Runtime for the TypeScript CLI. |
| npm 10+ | Used by the local wrappers. |
| Go | Used by the `cmd/nt` lifecycle manager in development. |
| tmux 3.0+ | Required for `nt queen attach`. |
| bd | Required for Gas City bead reads/writes. |
| `nt` on `PATH` | Required for `city.toml` execution. |

Provider keys:

```bash
export GROQ_API_KEY=gsk_...
export DEEPSEEK_API_KEY=...
```

For local tests or dry runs:

```bash
export NOS_MOCK_PROVIDER=1
```

Provider selection can be overridden with `NOS_BRIDGE_PROVIDERS`, for example:

```bash
export NOS_BRIDGE_PROVIDERS=groq:groq/compound,deepseek:deepseek-v4-pro
```

The development `scripts/nt.sh` wrapper and Go launcher load `.env` with simple
`KEY=value` parsing only. They do not shell-source `.env` files.

## Local Storage

The comb stores full run traces outside Gas City's bead metadata.

| Variable | Default | Purpose |
|---|---|---|
| `NOS_HOME` | discovered from cwd or `~/.nostown/home` | NOSTown project root. |
| `NOS_COMB_DIR` | `$NOS_HOME/comb` | Full bridge run history. |
| `GROQ_API_KEY` | unset | Enables Groq provider. |
| `DEEPSEEK_API_KEY` | unset | Enables DeepSeek provider. |
| `NOS_MOCK_PROVIDER` | unset | Enables deterministic mock provider. |
| `NOS_BRIDGE_PROVIDERS` | auto | Comma-separated provider pool. |

## Production Operations

- Install `nt` with `./scripts/install-nt.sh`, then verify `nt` is on `PATH`.
- Run `nt gascity doctor` from the same shell environment Gas City will inherit.
- Add only the `city.toml` router-agent config shown above; Gas City stays
  static except `city.toml`.
- Keep `NOS_COMB_DIR` on a local writable disk. Comb records are the long-form
  ledger; Gas City metadata is only compact status.
- Bridge failures write JSON to stdout and diagnostics to stderr. If the Node
  bridge crashes before emitting JSON, the Go `nt` launcher emits a structured
  JSON error for one-shot bridge commands.
- Provider details, timings, invalid outputs, Arbiter traces, and deterministic
  fallback details live in the comb only. Obvious secret-like values are redacted
  before comb write.

## Development

```bash
npm run typecheck
npm run build
npm run test:unit
npm test
(cd cmd/nt && go test ./...)
npm run test:ci
npm run smoke:gascity
```

## Repository Map

```text
nostown/
├── cmd/nt/                 # Go lifecycle manager for the nt binary
├── src/cli/                # Queen shell and hive status UI
├── src/gascity/            # Role-neutral Gas City bridge adapter
├── src/providers/          # Groq, DeepSeek, and mock provider adapters
├── src/swarm/              # Consensus primitives
├── src/roles/              # Legacy/internal role runtime
├── docs/GASCITY_BRIDGE.md  # Bridge contract and city.toml flow
├── docs/QUEEN_CLI.md       # Operator shell behavior
├── docs/internal-runtime/  # Legacy/future Mayor/Polecat/Witness runway docs
└── tests/                  # Unit and integration tests
```

## Documentation

| Doc | Topic |
|---|---|
| [GASCITY_BRIDGE.md](docs/GASCITY_BRIDGE.md) | Static Gas City integration and JSON bridge contract |
| [QUEEN_CLI.md](docs/QUEEN_CLI.md) | Queen shell and tmux lifecycle |
| [docs/README.md](docs/README.md) | Public docs index |
| [internal-runtime/SWARM.md](docs/internal-runtime/SWARM.md) | Legacy/internal swarm patterns |
| [internal-runtime/GROQ_INTEGRATION.md](docs/internal-runtime/GROQ_INTEGRATION.md) | Legacy/internal Groq runtime details |
| [internal-runtime/RESILIENCE.md](docs/internal-runtime/RESILIENCE.md) | Legacy/internal failover notes |
| [internal-runtime/ROLES.md](docs/internal-runtime/ROLES.md) | Legacy/internal role runtime |

## Troubleshooting

**`nt gascity doctor` says `nt` is missing**
Install the wrapper with `./scripts/install-nt.sh` or put an equivalent `nt`
binary on `PATH`.

**`nt gascity doctor` says `bd` is missing**
Install Gas City's bead CLI and confirm it is available in the shell that runs
`gc sling`.

**`nt queen attach` fails with missing tmux**
Install tmux. The Queen shell intentionally uses a persistent terminal session.

**Bridge commands print diagnostics**
For `nt gascity ... --json`, diagnostics are written to stderr. Stdout remains a
single JSON payload or JSON line stream.

## License

MIT © [kab0rn](https://github.com/kab0rn)
