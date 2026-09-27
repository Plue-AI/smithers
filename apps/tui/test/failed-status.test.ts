/** Every way a background worker ends badly settles its tab, timeline and tab.read as failed. */
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as Host from "../src/host.ts"
import * as Runtime from "../src/runtime.ts"
import * as Session from "../src/session.ts"
import { Workspace } from "../src/workspace.ts"

const request = { id: "research", title: "Research", prompt: "Investigate the plugin surface." }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const setup = (run: Host.Host["run"], restored?: ConstructorParameters<typeof Workspace>[0]["restored"]) => {
  const records: Session.Record[] = []
  const host: Host.Host = {
    cwd: mkdtempSync(join(tmpdir(), "tui-failed-")),
    judged: false,
    compaction: async () => undefined,
    dispose: async () => {},
    run
  }
  const workspace = new Workspace({
    host,
    workerSeat: "worker:test",
    history: () => [],
    persist: (record) => records.push(record),
    ...(restored === undefined ? {} : { restored })
  })
  return { workspace, records, host }
}

/** What the coordinator sees through the real `tab.read` flow binding. */
const tabRead = async (workspace: Workspace, id: string) => {
  const bindings = await Effect.runPromise(
    Runtime.source({
      publish: () => {},
      delegate: workspace.request,
      read: workspace.read,
      list: () => workspace.snapshot().tabs
    }).bindings()
  )
  const read = bindings.find((binding) => binding.descriptor.name === "tab.read")!
  return Effect.runPromise(read.run({ input: { id } } as unknown as Parameters<typeof read.run>[0]))
}

const expectFailed = async (workspace: Workspace, message: string) => {
  const tab = workspace.snapshot().tabs[0]!
  expect(tab.status).toBe("failed")
  expect(tab.message).toContain(message)
  expect(tab.endedAt).toBeNumber()
  expect(workspace.busy).toBe(false)
  // The activity strip reads "Researching" while this stays "running".
  expect(workspace.transcript(tab.id).activity?.status).toBe("failed")
  expect(workspace.panel(tab.id).summary).toContain(tab.failure?.headline ?? "Worker stopped unexpectedly")
  expect(workspace.panel(tab.id).summary).not.toContain(message)
  expect(await tabRead(workspace, tab.id)).toMatchObject({
    outcome: "success",
    value: { id: tab.id, status: "failed", message: expect.stringContaining(message) }
  })
}

describe("failed worker status", () => {
  it("tab.read reports a parked worker's wait, then running once it resumes", async () => {
    let input: Host.TurnInput | undefined
    const f = setup((value) => {
      input = value
      return { done: new Promise(() => {}), cancel: () => {} }
    })
    f.workspace.request(request)
    await tick()
    const wakeAt = Date.UTC(2026, 8, 24, 14, 20)
    input!.onEvent(
      new AgentEvent.ModelParked({
        eventType: "flows.harness.model-parked.v1",
        seat: "openai:gpt-6-sol",
        wakeAt,
        source: "retry-after",
        code: "rate_limited"
      })
    )
    expect(await tabRead(f.workspace, request.id)).toMatchObject({
      outcome: "success",
      value: {
        id: request.id,
        status: "parked",
        wakeAt: "2026-09-24T14:20:00.000Z",
        summary: "waits for ChatGPT reset · 14:20"
      }
    })
    expect(JSON.parse(f.workspace.context())[0]).toMatchObject({ status: "parked", wakeAt: "2026-09-24T14:20:00.000Z" })
    input!.onEvent(
      new AgentEvent.ModelUnparked({
        eventType: "flows.harness.model-unparked.v1",
        seat: "openai:gpt-6-sol",
        at: wakeAt
      })
    )
    const resumed = await tabRead(f.workspace, request.id) as unknown as { value: { status: string; wakeAt?: string } }
    expect(resumed.value.status).toBe("running")
    expect(resumed.value.wakeAt).toBeUndefined()
  })

  it("settles a failed run outcome", async () => {
    const f = setup(() => ({
      done: Promise.resolve({ _tag: "failed", message: "Provider refused", detail: "" }),
      cancel: () => {}
    }))
    f.workspace.request(request)
    await tick()
    await expectFailed(f.workspace, "Provider refused")
  })

  it("settles a worker whose completion throws", async () => {
    const f = setup(() => ({
      done: Promise.reject(new TypeError("cannot read property 'map' of undefined")),
      cancel: () => {}
    }))
    f.workspace.request(request)
    await tick()
    await expectFailed(f.workspace, "cannot read property 'map' of undefined")
  })

  it("settles a worker that throws while launching", async () => {
    const f = setup(() => {
      throw new Error("Seat unavailable")
    })
    f.workspace.request(request)
    await tick()
    await expectFailed(f.workspace, "Seat unavailable")
  })

  it("reads a running worker through tab.read", async () => {
    const f = setup(() => ({ done: new Promise(() => {}), cancel: () => {} }))
    f.workspace.request(request)
    await tick()
    expect(await tabRead(f.workspace, request.id)).toMatchObject({ outcome: "success", value: { status: "running" } })
  })

  it("relaunches a worker whose host process died mid-run", async () => {
    const f = setup(() => ({ done: new Promise(() => {}), cancel: () => {} }))
    f.workspace.request(request)
    await tick()
    // The TUI process exits here: no outcome is written for the running worker.
    let launches = 0
    const restored = setup(() => {
      launches++
      return { done: new Promise(() => {}), cancel: () => {} }
    }, Session.restore(f.records).workspace)
    await tick()
    expect(launches).toBe(1)
    expect(restored.workspace.snapshot().tabs[0]).toMatchObject({ id: request.id, status: "running" })
  })

  it("keeps the real error of a worker that failed before its parent recorded it", async () => {
    const f = setup(() => ({ done: new Promise(() => {}), cancel: () => {} }))
    f.workspace.request(request)
    await tick()
    const tab = f.workspace.snapshot().tabs[0]!
    Session.reopen(tab.file).append({
      type: "outcome",
      at: 99,
      prompt: request.prompt,
      outcome: { _tag: "failed", message: "Frame limit reached" }
    })
    const restored = setup(() => {
      throw new Error("must not relaunch")
    }, Session.restore(f.records).workspace)
    await expectFailed(restored.workspace, "Frame limit reached")
    expect(restored.workspace.snapshot().tabs[0]?.endedAt).toBe(99)
  })
})
