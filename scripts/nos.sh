#!/usr/bin/env bash
# NOS Town main entry point

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

if [[ -f "$PROJECT_DIR/.env" ]]; then
    set -a && source "$PROJECT_DIR/.env" && set +a
fi

if [[ ! -d node_modules ]]; then
    echo "[NOS Town] Installing dependencies..."
    npm install
fi

exec npx tsx src/index.ts "$@"
