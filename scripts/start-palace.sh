#!/usr/bin/env bash
# Start the MemPalace server

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PALACE_DIR="$PROJECT_DIR/mempalace-server"

MEMPALACE_PORT="${MEMPALACE_PORT:-7474}"
MEMPALACE_DB="${MEMPALACE_DB:-$PROJECT_DIR/palace-db/palace.sqlite}"

echo "[NOS Town] Starting MemPalace server on port $MEMPALACE_PORT..."
echo "[NOS Town] DB: $MEMPALACE_DB"

# Ensure palace-db directory exists
mkdir -p "$(dirname "$MEMPALACE_DB")"

export MEMPALACE_PORT
export MEMPALACE_DB

if command -v uv &>/dev/null; then
    cd "$PALACE_DIR"
    exec uv run python server.py
elif command -v python3 &>/dev/null; then
    # Try to run directly if fastapi/uvicorn are already installed
    cd "$PALACE_DIR"
    exec python3 server.py
else
    echo "ERROR: uv or python3 not found. Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
fi
