import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"
import { Workspace } from "../src/workspace.ts"

const setup = () => {
  let input: Host.TurnInput | undefined
  let resolve!: (outcome: Host.Outcome) => void
  const host: Host.Host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-steer-")),
    judged: false,
    dispose: async () => {},
    run: (value) => {
      input = value
      return {
        done: new Promise((done) => {
          resolve = done
        }),
        cancel: () => resolve({ _tag: "cancelled" })
      }
    }
  }
  const workspace = new Workspace({ host, workerSeat: "worker:test", history: () => [], persist: () => {} })
  return { workspace, input: () => input, complete: (outcome: Host.Outcome) => resolve(outcome) }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const text = (message: { readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> }) =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("")

describe("steering a worker", () => {
  it("refuses before the worker runs and after it settles", async () => {
    const f = setup()
    f.workspace.request({ id: "fix", title: "Fix", prompt: "Fix it." })
    expect(f.workspace.steer("fix", "also the docs")).toBe(false)
    await tick()
    f.complete({ _tag: "done", answer: "Fixed." })
    await tick()
    expect(f.workspace.steer("fix", "also the docs")).toBe(false)
    expect(f.workspace.steer("missing", "hello")).toBe(false)
  })

  it("delivers a steer at the worker's next cell boundary and shows it in the worker's transcript", async () => {
    const f = setup()
    f.workspace.request({ id: "fix", title: "Fix", prompt: "Fix it." })
    await tick()
    expect(f.workspace.steer("fix", "also the docs")).toBe(true)
    const items = f.workspace.transcript("fix").items
    expect(items.at(-1)).toMatchObject({ kind: "user", text: "also the docs", queued: true })
    const source = f.input()?.steering
    expect(source).toBeDefined()
    const drain = Effect.runSync(source!.drain({ boundary: "cell-1", wouldIdle: false }))
    expect(drain.inserts.map(text)).toEqual(["also the docs"])
    const file = f.workspace.snapshot().tabs[0]!.file
    expect(Session.load(file).some((record) => record.type === "user" && record.text === "also the docs")).toBe(true)
    f.workspace.dispose()
  })
})
