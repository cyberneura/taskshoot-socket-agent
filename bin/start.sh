#!/usr/bin/env bash
#
# Entry point for supervisor / launchd. Both start programs with an almost
# empty environment, so PATH (taskshoot, node, claude) is set up here rather
# than assumed. Extend PATH via TSSA_EXTRA_PATH or a local .env file.

set -euo pipefail
cd "$(dirname "$0")/.."

# Optional site-local environment (not committed): PATH additions,
# TSSA_* overrides, etc.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

export PATH="${TSSA_EXTRA_PATH:+${TSSA_EXTRA_PATH}:}${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

command -v taskshoot >/dev/null || { echo "taskshoot is not on PATH" >&2; exit 1; }
command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 1; }

if [ ! -d node_modules ]; then
  pnpm install --frozen-lockfile
fi
pnpm run build

exec node dist/main.js
