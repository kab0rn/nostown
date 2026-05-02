#!/usr/bin/env bash
# npm-compatible nt wrapper. The full install path still builds cmd/nt, but
# this keeps `npx nt ...` usable in development. .env loading is deliberately
# limited to simple KEY=value lines; this script never sources shell code.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

if [[ -f "$PROJECT_DIR/.env" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[[:space:]]*$ ]] && continue
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
        key="${line%%=*}"
        value="${line#*=}"
        if [[ -z "${!key+x}" ]]; then
            export "$key=$value"
        fi
    done < "$PROJECT_DIR/.env"
fi

case "${1:-}" in
    gascity|swarm)
        exec npx tsx src/index.ts "$@"
        ;;
esac

if command -v go >/dev/null 2>&1; then
    cd "$PROJECT_DIR/cmd/nt"
    exec go run . "$@"
fi

if [[ $# -eq 0 || "${1:-}" == "queen" ]]; then
    exec npx tsx src/index.ts queen-shell
fi

exec npx tsx src/index.ts "$@"
