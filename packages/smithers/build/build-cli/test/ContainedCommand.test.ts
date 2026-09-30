/**
 * The containment fixture's process inspection: a failed `ps` must fail
 * loudly, never read as a stopped process or a completed teardown.
 */
import { spawn } from "node:child_process"
import * as Fs from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { fixture, inspect, type PsRunner, runPs, until } from "./helpers/ContainedCommand.ts"

const unusedPid = 2_147_483

const failure = (fields: Record<string, unknown>): Error => Object.assign(new Error("ps failed"), fields)

const failures: ReadonlyArray<readonly [string, Error]> = [
  ["a timeout", failure({ code: "ETIMEDOUT", status: null, signal: "SIGKILL", stdout: "" })],
  ["a spawn error", failure({ code: "ENOENT", errno: -2, stdout: "" })],
  ["an unexpected exit status", failure({ status: 2, signal: null, stdout: "" })],
  ["a signalled exit 1", failure({ status: 1, signal: "SIGTERM", stdout: "" })],
  ["exit 1 with output", failure({ status: 1, signal: null, stdout: "R node\n" })]
]

describe("inspect", () => {
  it("reads a live process as running and an unused pid as absent through the real ps", () => {
    expect(inspect(process.pid)).toMatchObject({ state: "running" })
    expect(inspect(unusedPid)).toEqual({ state: "absent" })
  })

  it("distinguishes a zombie from a running process", () => {
    expect(inspect(unusedPid, () => "Z+   <defunct>\n")).toEqual({ state: "zombie", command: "Z+   <defunct>" })
    expect(inspect(unusedPid, () => "S    node -e x\n")).toEqual({ state: "running", command: "S    node -e x" })
  })

  it.each(failures)("rejects %s instead of reporting an absence", (_name, error) => {
    const run: PsRunner = () => {
      throw error
    }
    expect(() => inspect(unusedPid, run)).toThrow(/process inspection of 2147483 failed/)
  })

  it("rejects an empty successful answer", () => {
    expect(() => inspect(process.pid, () => "\n")).toThrow(/without describing/)
  })

  it("rejects a no-match answer for a process that still accepts signals", () => {
    const run: PsRunner = () => {
      throw failure({ status: 1, signal: null, stdout: "" })
    }
    expect(() => inspect(process.pid, run)).toThrow(/still accepts signals/)
    expect(inspect(unusedPid, run)).toEqual({ state: "absent" })
  })
})

describe.skipIf(process.platform === "win32")("contained-command fixture", () => {
  it("keeps a live owned process and its records when inspection fails", async () => {
    let broken: Error | undefined
    const child = await fixture({
      natural: false,
      inheritedOutput: false,
      ps: (args) => {
        if (broken !== undefined) throw broken
        return runPs(args)
      }
    })
    const leaderProcess = spawn(child.argv[0], child.argv.slice(1), { detached: true, stdio: "ignore" })
    try {
      await child.ready()
      await until(async () => (await child.leader())?.token === child.token)
      const leader = (await child.leader())!
      const beat = (await child.beat())!
      expect(child.stopped(leader)).toBe(false)
      expect(child.stopped(beat)).toBe(false)
      for (const [, error] of failures) {
        broken = error
        expect(() => child.stopped(leader)).toThrow(/process inspection/)
        expect(() => child.stopped(beat)).toThrow(/process inspection/)
        await expect(child.dispose()).rejects.toThrow(/process inspection/)
        // The owned processes survive, keep beating, and keep their records.
        expect(() => process.kill(leader.pid, 0)).not.toThrow()
        const before = (await child.beat())!.tick!
        await until(async () => ((await child.beat())?.tick ?? -1) > before)
        await expect(Fs.stat(child.directory)).resolves.toBeDefined()
      }
      broken = undefined
      await child.dispose()
      expect(child.stopped(leader)).toBe(true)
      expect(child.stopped(beat)).toBe(true)
      await expect(Fs.stat(child.directory)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      broken = undefined
      try {
        process.kill(-leaderProcess.pid!, "SIGKILL")
      } catch { /* The owned group already exited. */ }
      await child.dispose().catch(() => undefined)
    }
  })
})
