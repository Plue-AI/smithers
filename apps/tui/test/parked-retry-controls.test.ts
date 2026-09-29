import { ModelParked } from "@smthrs/harness/AgentEvent"
import { afterEach, expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as Host from "../src/host.ts"
import * as Runtime from "../src/runtime.ts"
import * as Session from "../src/session.ts"
import { Workspace } from "../src/workspace.ts"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
})

async function fixture() {
  const turns: Array<{
    input: Host.TurnInput
    finish: (outcome: Host.Outcome) => void
    reject: (error: Error) => void
    cancels: number
  }> = []
  const records: Session.Record[] = []
  const cwd = mkdtempSync(join(tmpdir(), "tui-parked-retry-"))
  const host: Host.Host = {
    cwd,
    judged: false,
    compaction: async () => undefined,
    dispose: async () => {},
    run: (input) => {
      let finish!: (outcome: Host.Outcome) => void
      let reject!: (error: Error) => void
      const done = new Promise<Host.Outcome>((resolve, fail) => {
        finish = resolve
        reject = fail
      })
      const turn = { input, finish: (outcome: Host.Outcome) => finish(outcome), reject, cancels: 0 }
      turns.push(turn)
      return {
        done,
        cancel: () => {
          turn.cancels++
        }
      }
    }
  }
  const workspace = new Workspace({
    host,
    workerSeat: "worker:test",
    history: () => [],
    persist: (record) => records.push(record)
  })
  cleanup.push(() => {
    workspace.dispose()
    rmSync(Session.directory(cwd), { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })
  const bindings = await Effect.runPromise(
    Runtime.source({
      publish: () => {},
      delegate: workspace.request,
      retry: workspace.retry,
      read: workspace.read,
      list: () => workspace.snapshot().tabs
    }).bindings()
  )
  const call = (name: "agent.delegate" | "tab.retry", input: object) => {
    const binding = bindings.find((candidate) => candidate.descriptor.name === name)!
    return Effect.runPromise(binding.run({ input } as Parameters<typeof binding.run>[0]))
  }
  const status = () => workspace.snapshot().tabs[0]?.status
  const park = (index: number) =>
    turns[index]!.input.onEvent(
      new ModelParked({
        eventType: "flows.harness.model-parked.v1",
        seat: "worker:test",
        wakeAt: Date.now() + 60_000,
        source: "retry-after",
        code: "rate_limited"
      })
    )
  const delegate = async () => {
    expect(await call("agent.delegate", { id: "review", title: "Review", prompt: "Review the change" }))
      .toMatchObject({ outcome: "success", value: { status: "requested" } })
    await flush()
    expect(turns).toHaveLength(1)
    park(0)
    expect(status()).toBe("parked")
    expect(await call("tab.retry", { id: "review" }))
      .toMatchObject({ outcome: "success", value: { status: "requested" } })
    await flush()
    expect(turns).toHaveLength(2)
    expect(turns[0]!.cancels).toBe(1)
    expect(status()).toBe("running")
  }
  return { turns, records, workspace, call, status, park, delegate }
}

it("keeps replacement Steer and Stop after the old parked turn settles first", async () => {
  const f = await fixture()
  await f.delegate()
  const replacementFile = f.workspace.snapshot().tabs[0]!.file
  expect(f.workspace.steer("review", "before")).toBe(true)
  f.turns[0]!.finish({ _tag: "cancelled" })
  await flush()
  expect(f.status()).toBe("running")
  expect(f.workspace.steer("review", "after")).toBe(true)
  expect(Session.load(replacementFile).flatMap((r) => r.type === "user" && r.steered ? [r.text] : []))
    .toEqual(["before", "after"])
  f.workspace.cancel("review")
  expect(f.turns[1]!.cancels).toBe(1)
  f.turns[1]!.finish({ _tag: "cancelled" })
  await flush()
  expect(f.status()).toBe("cancelled")
  expect(Session.restore(f.records).workspace.tabs[0]?.status).toBe("cancelled")
})

it("keeps replacement outcome when it settles before the old parked turn", async () => {
  const f = await fixture()
  await f.delegate()
  const replacementFile = f.workspace.snapshot().tabs[0]!.file
  f.turns[1]!.finish({ _tag: "done", answer: "Reviewed" })
  await flush()
  f.turns[0]!.finish({ _tag: "cancelled" })
  await flush()
  expect(f.workspace.read("review")).toMatchObject({ status: "done", answer: "Reviewed" })
  expect(Session.restore(f.records).workspace.tabs[0]).toMatchObject({ status: "done", answer: "Reviewed" })
  expect(Session.load(replacementFile).filter((r) => r.type === "outcome")).toHaveLength(1)
  expect(f.workspace.steer("review", "late")).toBe(false)
})

it("ignores a rejected old turn while replacement Stop and Steer stay available", async () => {
  const f = await fixture()
  await f.delegate()
  const replacementFile = f.workspace.snapshot().tabs[0]!.file
  f.turns[0]!.reject(new Error("old host rejected"))
  await flush()
  expect(f.status()).toBe("running")
  expect(f.workspace.steer("review", "continue")).toBe(true)
  f.workspace.cancel("review")
  expect(f.turns[1]!.cancels).toBe(1)
  expect(Session.load(replacementFile).filter((r) => r.type === "outcome")).toHaveLength(0)
  f.turns[1]!.finish({ _tag: "cancelled" })
  await flush()
  expect(f.status()).toBe("cancelled")
})

it("cleans controls after an ordinary replacement completion", async () => {
  const f = await fixture()
  await f.delegate()
  f.turns[0]!.finish({ _tag: "cancelled" })
  await flush()
  f.turns[1]!.finish({ _tag: "done", answer: "Done" })
  await flush()
  expect(f.status()).toBe("done")
  expect(f.workspace.steer("review", "late")).toBe(false)
  f.workspace.cancel("review")
  expect(f.turns[1]!.cancels).toBe(0)
})

it("cleans controls and saves failure when the replacement host rejects", async () => {
  const f = await fixture()
  await f.delegate()
  const replacementFile = f.workspace.snapshot().tabs[0]!.file
  f.turns[0]!.finish({ _tag: "cancelled" })
  await flush()
  f.turns[1]!.reject(new Error("replacement host rejected"))
  await flush()
  expect(f.status()).toBe("failed")
  expect(f.workspace.steer("review", "late")).toBe(false)
  f.workspace.cancel("review")
  expect(f.turns[1]!.cancels).toBe(0)
  expect(Session.load(replacementFile).filter((r) => r.type === "outcome")).toMatchObject([
    { outcome: { _tag: "failed" } }
  ])
  expect(Session.restore(f.records).workspace.tabs[0]?.status).toBe("failed")
})

it("does not transfer the old retry cancellation to an un-stopped parked replacement", async () => {
  const f = await fixture()
  await f.delegate()
  f.park(1)
  f.turns[1]!.finish({ _tag: "cancelled" })
  await flush()
  expect(f.status()).toBe("parked")
  expect(f.turns[1]!.cancels).toBe(0)
  f.turns[0]!.finish({ _tag: "cancelled" })
  await flush()
  expect(f.status()).toBe("parked")
})

it("preserves an explicit Stop on the parked replacement after the old turn settles", async () => {
  const f = await fixture()
  await f.delegate()
  f.park(1)
  f.workspace.cancel("review")
  expect(f.turns[1]!.cancels).toBe(1)
  f.turns[0]!.finish({ _tag: "cancelled" })
  await flush()
  f.turns[1]!.finish({ _tag: "cancelled" })
  await flush()
  expect(f.status()).toBe("cancelled")
  expect(Session.restore(f.records).workspace.tabs[0]?.status).toBe("cancelled")
})
