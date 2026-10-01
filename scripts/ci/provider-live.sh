#!/usr/bin/env bash
set -euo pipefail

# Credentials and the selected execution home's vendor login are supplied by the caller.
: "${CEREBRAS_API_KEY:?CEREBRAS_API_KEY is required}"
if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI is required" >&2
  exit 1
fi
codex_status="$(codex login status 2>&1)" || {
  echo "Codex CLI must be logged in using ChatGPT" >&2
  exit 1
}
if [[ "$codex_status" != *"Logged in using ChatGPT"* ]]; then
  echo "Codex CLI must be logged in using ChatGPT" >&2
  exit 1
fi
unset codex_status
export SMITHERS_LIVE_MODEL_TESTS=1
export SMITHERS_REQUIRE_LIVE_CREDENTIALS=1
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pnpm --dir "$repo_root/packages/smithers/agent/model" exec vitest run test/CerebrasStructuredOutput.integration.test.ts --coverage.enabled=false
pnpm --dir "$repo_root/packages/smithers" exec vitest run test/CodexSeat.integration.test.ts --coverage.enabled=false
