import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

for (const runtime of ["node", "bun"]) {
  test(`shared provider transport streams, rebuilds and closes on ${runtime}`, { timeout: 90_000 }, async () => {
    const worker = fileURLToPath(new URL("./provider-runtime-worker.ts", import.meta.url))
    const { stdout } = await promisify(execFile)(runtime === "node" ? process.execPath : "bun", [worker], {
      timeout: 85_000,
      killSignal: "SIGKILL"
    })
    assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1)!), {
      streamed: true,
      rebuilt: true,
      redirects: 0,
      scopeClosed: true
    })
  })
}
