import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const execute = promisify(execFile)
const fixture = fileURLToPath(new URL("./fixtures/external-peer-scenario.ts", import.meta.url))
for (
  const [mode, behavior] of [
    ["observe", "keeps one external worker through peer registration and observation"],
    ["stall", "reconfirms a live owner after a 25-second stall without restarting external work"],
    ["cancel", "cancels the external worker from another host"],
    ["stolen", "stops external work when a cross-host peer steals the paused owner’s lease"],
    ["recover", "recovers a genuinely dead owner and settles the parent"],
    ["recover-released", "recovers a gracefully released worker after the owner exits"],
    ["recover-running", "releases a still-running root on graceful shutdown for peer recovery"],
    ["detached-stall", "reconfirms a detached worker of a completed root after a 25-second stall"]
  ]
) {
  const timeout = mode === "recover-released" || mode === "recover-running" ? 300_000 : 180_000
  it(`public native flow ${behavior}`, async () => {
    const { stdout, stderr } = await execute(process.execPath, ["--experimental-strip-types", fixture, mode!], {
      timeout,
      maxBuffer: 1024 * 1024
    })
    process.stdout.write(stdout)
    process.stdout.write(stderr)
    const receipt = stdout.trim().split("\n").findLast((line) => line.startsWith("{\"mode\":"))
    expect(receipt).toBeDefined()
    expect(JSON.parse(receipt!)).toEqual({ mode, passed: true })
  }, timeout + 5_000)
}
