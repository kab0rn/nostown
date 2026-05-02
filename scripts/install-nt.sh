#!/usr/bin/env bash
# Install the nt binary and configure NOS_HOME discovery.
#
# Usage:
#   ./scripts/install-nt.sh             # installs to ~/.local/bin/nt
#   ./scripts/install-nt.sh /usr/local/bin
#
# After install, `nt` opens the Queen shell and `nt gascity ...` exposes the
# Gas City-safe bridge adapter.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
INSTALL_DIR="${1:-$HOME/.local/bin}"
BUILD_DIR="$PROJECT_DIR/cmd/nt"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "[NOSTown] Building nt binary..."
(cd "$BUILD_DIR" && go build -o "$TMP_DIR/nt" .)

echo "[NOSTown] Installing to $INSTALL_DIR/nt..."
mkdir -p "$INSTALL_DIR"
cp -f "$TMP_DIR/nt" "$INSTALL_DIR/nt"
chmod +x "$INSTALL_DIR/nt"

echo "[NOSTown] Writing project config (~/.nostown/home)..."
mkdir -p "$HOME/.nostown"
echo "$PROJECT_DIR" > "$HOME/.nostown/home"

echo ""
echo "Done. nt is installed."
echo ""

# Warn if install dir is not on PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    echo "  WARNING: $INSTALL_DIR is not in your PATH."
    echo "  Add to ~/.bashrc or ~/.zshrc:"
    echo "    export PATH=\"\$PATH:$INSTALL_DIR\""
    echo ""
fi

echo "  nt queen attach    Start or attach the Queen shell"
echo "  nt hive status     Show bridge runtime health"
echo "  nt gascity doctor  Validate Gas City bridge prerequisites"
