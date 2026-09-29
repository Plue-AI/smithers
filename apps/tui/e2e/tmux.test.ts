import { describe, expect, it } from "bun:test"
import { tmpdir } from "node:os"
import { exitOf, nudge, Tui } from "./tmux.ts"

describe("exitOf", () => {
  it("reports a live pane as running", () => {
    expect(exitOf("0::")).toBeUndefined()
  })

  // tmux marks a pane dead at PTY EOF, which can precede reaping its process.
  it("waits for the status of a pane that closed its terminal before it was reaped", () => {
    expect(exitOf("1::")).toBeUndefined()
  })

  it("reports the exit status and a signal death", () => {
    expect(exitOf("1:0:")).toEqual({ code: 0 })
    expect(exitOf("1:3:")).toEqual({ code: 3 })
    expect(exitOf("1::1")).toEqual({ code: null, signal: 1 })
  })
})

describe("nudge", () => {
  it("does nothing for a pid tmux did not print or a server that is gone", () => {
    expect(() => nudge(Number.NaN)).not.toThrow()
    expect(() => nudge(0)).not.toThrow()
    const gone = Bun.spawnSync(["sh", "-c", "echo $$"]).stdout.toString().trim()
    expect(() => nudge(Number(gone))).not.toThrow()
  })
})

describe("a pane's liveness", () => {
  it("is alive while its process runs and not alive once it exits, reaped or not", async () => {
    const tui = await Tui.start({ cwd: tmpdir(), command: "sh -c 'read line; exit 3'" })
    try {
      expect(tui.alive).toBe(true)
      expect(tui.exited).toBeUndefined()
      await tui.press("go\r")
      expect(await tui.waitForExit()).toEqual({ code: 3 })
      expect(tui.alive).toBe(false)
    } finally {
      tui.dispose()
    }
  }, 20_000)
})
