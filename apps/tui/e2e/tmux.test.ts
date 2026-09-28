import { describe, expect, it } from "bun:test"
import { exitOf } from "./tmux.ts"

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
