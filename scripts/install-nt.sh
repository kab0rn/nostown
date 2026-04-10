#!/usr/bin/env bash
# Install the nt binary and configure NOS_HOME discovery.
#
# Usage:
#   ./scripts/install-nt.sh             # installs to ~/.local/bin/nt
#   ./scripts/install-nt.sh /usr/local/bin
#
# After install, `nt up` starts MemPalace and `nt <task>` orchestrates tasks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
INSTALL_DIR="${1:-$HOME/.local/bin}"
BUILD_DIR="$PROJECT_DIR/cmd/nt"

echo "[NOS Town] Building nt binary..."
(cd "$BUILD_DIR" && go build -o "$BUILD_DIR/nt" .)

echo "[NOS Town] Installing to $INSTALL_DIR/nt..."
mkdir -p "$INSTALL_DIR"
cp "$BUILD_DIR/nt" "$INSTALL_DIR/nt"
chmod +x "$INSTALL_DIR/nt"

echo "[NOS Town] Writing project config (~/.nostown/home)..."
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

echo "  nt up       Start MemPalace server"
echo "  nt          Interactive session"
echo "  nt <task>   Orchestrate a task"
