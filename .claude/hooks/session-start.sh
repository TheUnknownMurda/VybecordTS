#!/usr/bin/env bash
# Cloud sessions start from a fresh clone with no node_modules, so typecheck and
# build would fail. Only there: a desktop checkout already has its own install,
# with the Windows native binaries that --ignore-scripts would skip.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"
# postinstall fetches Windows-only native binaries; they cannot load on Linux anyway.
[ -d node_modules ] || npm ci --ignore-scripts --no-audit --no-fund >/dev/null
