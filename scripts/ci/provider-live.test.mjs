import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const script = fileURLToPath(new URL("./provider-live.sh", import.meta.url))
test("missing Cerebras credential fails before invoking providers", () => {
  const environment = { ...process.env }
  delete environment.CEREBRAS_API_KEY
  const result = spawnSync("/bin/bash", [script], { env: environment, encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /CEREBRAS_API_KEY is required/)
  assert.equal(result.stdout, "")
})
test("missing subscription CLI fails before invoking the API or test runner", () => {
  const result = spawnSync("/bin/bash", [script], {
    env: { PATH: "/usr/bin:/bin", CEREBRAS_API_KEY: "test-placeholder" }, encoding: "utf8"
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Codex CLI is required/)
  assert.equal(result.stdout, "")
})

test("empty Cerebras credential fails before invoking providers", () => {
  const result = spawnSync("/bin/bash", [script], { env: { ...process.env, CEREBRAS_API_KEY: "" }, encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /CEREBRAS_API_KEY is required/)
})

// Fake CLIs isolate runner guard/order behavior; the integration suite uses real providers.
for (const [name, status, loginExit, failCall, expectedExit, calls] of [
  ["vendor auth failure", "Not logged in", 1, 0, 1, 0],
  ["API-key login", "Logged in using an API key", 0, 0, 1, 0],
  ["ChatGPT login", "Logged in using ChatGPT", 0, 0, 0, 2],
  ["first suite fails", "Logged in using ChatGPT", 0, 1, 7, 1],
  ["second suite fails", "Logged in using ChatGPT", 0, 2, 7, 2]
]) {
  test(name, () => {
    const root = mkdtempSync(join(tmpdir(), "provider-live-guard-"))
    try {
      const log = join(root, "calls")
      writeFileSync(log, "")
      writeFileSync(join(root, "codex"), `#!/bin/bash\necho '${status}' >&2\nexit ${loginExit}\n`, { mode: 0o755 })
      writeFileSync(join(root, "pnpm"), `#!/bin/bash\necho "$*" >> "$LIVE_GUARD_LOG"\ncount=$(wc -l < "$LIVE_GUARD_LOG")\n[[ "$SMITHERS_LIVE_MODEL_TESTS" == 1 && "$SMITHERS_REQUIRE_LIVE_CREDENTIALS" == 1 ]] || exit 9\n[[ "$count" -eq "$LIVE_GUARD_FAIL_CALL" ]] && exit 7\nexit 0\n`, { mode: 0o755 })
      const result = spawnSync("/bin/bash", [script], { env: { PATH: `${root}:/usr/bin:/bin`, CEREBRAS_API_KEY: "test-placeholder", LIVE_GUARD_LOG: log, LIVE_GUARD_FAIL_CALL: String(failCall) }, encoding: "utf8" })
      assert.equal(result.status, expectedExit)
      const launches = readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
      assert.equal(launches.length, calls)
      if (calls > 0) assert.match(launches[0], /--dir .*packages\/smithers\/agent\/model exec vitest run test\/CerebrasStructuredOutput.integration.test.ts --coverage.enabled=false/)
      if (calls > 1) assert.match(launches[1], /--dir .*packages\/smithers exec vitest run test\/CodexSeat.integration.test.ts --coverage.enabled=false/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
