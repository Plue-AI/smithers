import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const execute = promisify(execFile)
const fixture = fileURLToPath(new URL("./fixtures/external-peer-scenario.ts", import.meta.url))
for (
  const [mode, behavior] of [
    ["observe", "keeps one external worker through peer registration and observation"],
    ["stall", "keeps the worker after a live owner stalls beyond heartbeat write tolerance"],
    ["cancel", "cancels the external worker from another host"],
    ["recover", "recovers a genuinely dead owner and settles the parent"]
  ]
) {
  it(`public native flow ${behavior}`, async () => {
    const { stdout } = await execute(process.execPath, ["--experimental-strip-types", fixture, mode!], {
      timeout: 180_000,
      maxBuffer: 1024 * 1024
    })
    process.stdout.write(stdout)
    const receipt = stdout.trim().split("\n").findLast((line) => line.startsWith("{\"mode\":"))
    expect(receipt).toBeDefined()
    expect(JSON.parse(receipt!)).toEqual({ mode, passed: true })
  }, 185_000)
}
