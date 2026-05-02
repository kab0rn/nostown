#!/usr/bin/env bash
# Read-only smoke test for the NOSTown Gas City bridge.
#
# This script builds a temporary nt binary, validates local tool discovery, and
# exercises JSON-safe bridge paths without writing real bead metadata.

set -euo pipefail

MODE="${1:---read-only}"
if [[ "$MODE" != "--read-only" ]]; then
  echo "usage: $0 --read-only" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

assert_json_ok() {
  node -e '
    const fs = require("fs");
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!payload.ok) {
      console.error(JSON.stringify(payload, null, 2));
      process.exit(1);
    }
  '
}

assert_json_error() {
  node -e '
    const fs = require("fs");
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    if (payload.ok !== false || payload.status !== "error") {
      console.error(JSON.stringify(payload, null, 2));
      process.exit(1);
    }
  '
}

require_cmd go
require_cmd node
require_cmd npm
require_cmd bd

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/home" "$TMP_DIR/outside" "$TMP_DIR/comb"
(cd "$PROJECT_DIR" && npm run build >/dev/null)
(cd "$PROJECT_DIR/cmd/nt" && go build -o "$TMP_DIR/bin/nt" .)

export PATH="$TMP_DIR/bin:$PATH"
export NOS_HOME="$PROJECT_DIR"
export NOS_MOCK_PROVIDER=1
export NOS_COMB_DIR="$TMP_DIR/comb"

echo "[smoke] nt gascity doctor"
nt gascity doctor | assert_json_ok

echo "[smoke] bootstrap failure remains JSON-safe"
failure_json="$(
  unset NOS_HOME
  export HOME="$TMP_DIR/home"
  cd "$TMP_DIR/outside"
  nt gascity doctor || true
)"
printf '%s\n' "$failure_json" | assert_json_error

echo "[smoke] watch option validation is local"
watch_error="$(nt gascity watch --once --workers 0 || true)"
printf '%s\n' "$watch_error" | assert_json_error

echo "[smoke] pure stdin swarm"
printf '%s\n' '{"schema":"gascity.swarm.v1","bead_id":"smoke-1","bead":{"id":"smoke-1","title":"Read-only smoke"},"mode":"pure","workers":1}' \
  | nt gascity swarm --stdin --json \
  | assert_json_ok

if find "$TMP_DIR/comb" -maxdepth 1 -type f -name '*.json' | grep -q .; then
  echo "[smoke] comb records written under temporary NOS_COMB_DIR"
else
  echo "expected temporary comb record" >&2
  exit 1
fi

echo "[smoke] read-only bridge smoke passed"
