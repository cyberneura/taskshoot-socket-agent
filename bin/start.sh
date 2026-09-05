#!/usr/bin/env bash
#
# Entry point for supervisor / launchd. Both start programs with an almost
# empty environment, so PATH (taskshoot, node, and the agent binary for the
# configured TSSA_AGENT_BACKEND: claude or hermes) is set up here rather
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

command -v "${TSSA_TASKSHOOT_BIN:-taskshoot}" >/dev/null || {
  echo "${TSSA_TASKSHOOT_BIN:-taskshoot} is not on PATH" >&2
  exit 1
}
command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 1; }

# Always, not just when node_modules is missing. A host that only `git pull`s
# would otherwise keep a stale tree, and the `tsc` below fails outright on a
# newly added dependency (TS2307) — `set -e` then stops the daemon from
# starting at all.
#
# This does cost a second start-up build: `pnpm install` runs the package's own
# `prepare` script, which is also `tsc`. Left as is because the explicit build
# below is the one that is guaranteed to run (see the note on pnpm 11 there).
if command -v pnpm >/dev/null; then
  pnpm install --frozen-lockfile
elif [ ! -d node_modules ]; then
  echo "pnpm is not on PATH and node_modules is missing" >&2
  exit 1
else
  # Do not turn "pnpm is missing" into a new reason to fail: a host that was
  # already running with a populated node_modules keeps working. If the tree is
  # actually stale the build below says so.
  echo "pnpm is not on PATH; skipping install (dependencies may be stale)" >&2
fi
# tsc is invoked directly instead of `pnpm run build`: pnpm 11 runs a
# dependency status check before `run` scripts and aborts on hosts where the
# lockfile's build scripts were not interactively approved.
./node_modules/.bin/tsc

exec node dist/main.js
