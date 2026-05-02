#!/usr/bin/env bash
# NOS Town main entry point

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

if [[ ! -d node_modules ]]; then
    echo "[NOS Town] Installing dependencies..."
    npm install
fi

exec npx tsx src/index.ts "$@"
