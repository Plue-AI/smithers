import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { MonitorCard } from "@smthrs/rpc/MonitorCard"
import { RunContainer } from "../../cards/RunContainer"
import { createRunMonitorSeam } from "./RunMonitorSeam"
import type { TopicSnapshot } from "../../runtime/LiveChannel"

const run: MonitorCard = {
  id: "native-run", flow: "todo", version: "digest-1", title: "Retry checks", todo: 5, state: "interrupted",
  attempts: [{ n: 1, run_id: "native-run", state: "interrupted",
    graph: [{ id: "check", label: "Ran checks", state: "failed", deps: [] }],
    steps: [{ key: "check#1", id: "check", k: 1, label: "Ran checks", state: "failed", took_s: 2,
      input: { command: "pnpm test" }, output: "2 failed", usage: { tokens: 1200, cost_usd: 0.12 } }],
    phases: [{ id: "native-run:check#1", step: "check#1", title: "Ran checks · 2 failed", took_s: 2, tone: "fail",
      cells: [{ id: "native-run:check#1:3", kind: "run", label: "Ran checks", output: "2 failed" }] }] }],
  waits: [{ id: "wait-1", kind: "question", label: "Change the timeout?", since: "2026-10-06T10:00:00Z",
    settled: { by: { login: "ben", name: "Ben", kind: "person", avatar_url: "https://example.test/ben.png", color_index: 0 }, at: "2026-10-06T10:02:00Z" } }],
  tokens: 1200, time_s: 2, cost_usd: 0.12, engine: [{ label: "Checkpoint", detail: "agent/trace/checkpoint" }]
}
const harness = () => {
  let snapshot: TopicSnapshot | undefined
  let receive: (() => void) | undefined
  const requests: Array<{ path: string; method: string }> = []
  const seam = createRunMonitorSeam({ live: {
    subscribe: (topic, notify) => { expect(topic).toBe("run:native-run"); receive = notify; return () => { receive = undefined } },
    getSnapshot: () => snapshot
  }, http: async (path, init) => {
    requests.push({ path, method: init?.method ?? "GET" })
    return Response.json(path === "/api/runs" ? [run] : { ...run,
      journal: [{ seq: 3, at: "2026-10-06T10:00:00Z", type: "step_failed", step: "check#1", text: "2 failed" }], replay: { at: 3, last: 3 } })
  } })
  const send = (value: unknown, error?: string) => { snapshot = { topic: "run:native-run", data: value, error }; receive?.() }
  return { seam, requests, send }
}

test("authenticated run data reaches the mounted View with costs, phases, waits and interrupted Retry; journal/replay are GET only", async () => {
  const h = harness()
  const stop = h.seam.snapshots.subscribe("native-run", () => {})
  h.send(run)
  const model = h.seam.snapshots.get("native-run").model!
  expect(model.attempts[0]!.steps[0]!.usage).toEqual({ tokens: 1200, cost_usd: 0.12 })
  expect(model.waits[0]!.since).toBe("2026-10-06T10:00:00Z")
  expect(model.waits[0]!.settled?.at).toBe("2026-10-06T10:02:00Z")
  const html = renderToStaticMarkup(<RunContainer model={model} dispatch={() => {}} view={{ maximized: true }} onView={() => {}} />)
  expect(html).toContain("Interrupted")
  expect(html).toContain("Ran checks · 2 failed")
  expect(html).toContain("Retry")
  expect(html).not.toContain("Rewind")
  expect(await h.seam.trace("native-run")).toBeUndefined()
  expect(await h.seam.trace("native-run", 3)).toBeUndefined()
  expect(h.seam.snapshots.get("native-run").model?.journal?.[0]?.text).toBe("2 failed")
  expect(await h.seam.list()).toEqual([{ id: "native-run", title: "Retry checks" }])
  expect(h.requests).toEqual([
    { path: "/api/runs/native-run/trace", method: "GET" },
    { path: "/api/runs/native-run/trace?at=3", method: "GET" },
    { path: "/api/runs", method: "GET" }
  ])
  stop(); h.seam.dispose()
})

test("unavailable topics, malformed costs and another run fail closed without a trace read", async () => {
  const h = harness()
  const stop = h.seam.snapshots.subscribe("native-run", () => {})
  for (const value of [{ ...run, id: "other-repository-run" }, { ...run, cost_usd: -1 }]) {
    h.send(value)
    expect(h.seam.snapshots.get("native-run")).toEqual({ error: "Run unavailable" })
    expect(await h.seam.trace("native-run")).toBe("Run unavailable")
  }
  h.send(run)
  h.send(undefined, "forbidden")
  expect(h.seam.snapshots.get("native-run").model).toBeUndefined()
  expect(await h.seam.trace("native-run")).toBe("Run unavailable")
  expect(h.requests).toEqual([])
  stop(); h.seam.dispose()
})

test("a refused topic fences a pending journal response and later reads supersede earlier scrub positions", async () => {
  const pending: Array<(response: Response) => void> = []
  let snapshot: TopicSnapshot = { topic: "run:native-run", data: run }
  let receive!: () => void
  const seam = createRunMonitorSeam({ live: { getSnapshot: () => snapshot,
    subscribe: (_topic, notify) => { receive = notify; return () => {} } },
    http: () => new Promise(resolve => pending.push(resolve)) })
  const stop = seam.snapshots.subscribe("native-run", () => {})
  const first = seam.trace("native-run", 1)
  const second = seam.trace("native-run", 2)
  pending[1]!(Response.json({ ...run, journal: [], replay: { at: 2, last: 3 } }))
  await second
  pending[0]!(Response.json({ ...run, journal: [], replay: { at: 1, last: 3 } }))
  await first
  expect(seam.snapshots.get("native-run").model?.replay?.at).toBe(2)
  const last = seam.trace("native-run", 3)
  snapshot = { topic: "run:native-run", error: "forbidden" }; receive()
  pending[2]!(Response.json({ ...run, journal: [], replay: { at: 3, last: 3 } }))
  await last
  expect(seam.snapshots.get("native-run")).toEqual({ error: "Run unavailable" })
  stop(); seam.dispose()
})

test("an account switch hides cached run data and fences pending reads", async () => {
  let owner = "alice"
  let resolve!: (response: Response) => void
  const seam = createRunMonitorSeam({ owner: () => owner,
    live: { subscribe: () => () => {}, getSnapshot: () => ({ topic: "run:native-run", data: run }) },
    http: () => new Promise(done => { resolve = done }) })
  const stop = seam.snapshots.subscribe("native-run", () => {})
  expect(seam.snapshots.get("native-run").model?.id).toBe("native-run")
  const pending = seam.trace("native-run")
  owner = "bob"
  expect(seam.snapshots.get("native-run")).toEqual({ error: "Run unavailable" })
  resolve(Response.json({ ...run, journal: [] })); await pending
  expect(seam.snapshots.get("native-run").model).toBeUndefined()
  expect(await seam.trace("native-run")).toBe("Run unavailable")
  stop(); seam.dispose()
})
