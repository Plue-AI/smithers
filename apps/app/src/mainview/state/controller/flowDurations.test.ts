/*
 * Reading a flow's measured history: what lands, and what stays silent.
 *
 * Every refusal this projection can answer with is the same refusal to a
 * reader — no rows — because the numbers are an enhancement nobody asked for.
 * A toast about them would be an error message about a prediction.
 */
import { describe, expect, test } from "bun:test"
import type { FlowDurationRow, GatewayResult, GatewayWorkspaceBinding } from "./gateway"
import { createAppStore, type AppStore } from "../AppStore"
import { flowDurationRowId } from "../AppState"
import { memoryStorage } from "../TestFixtures"
import { createFlowDurationsReader } from "./flowDurations"
import type { ControllerContext } from "./context"

const row = (actionTag: string, p50Ms: number): FlowDurationRow =>
  ({ flowId: "review", actionTag, samples: 4, p50Ms, p90Ms: p50Ms * 2 })

const scope = async (
  answer: (repo: string, flowId: string, binding?: GatewayWorkspaceBinding) => Promise<GatewayResult<ReadonlyArray<FlowDurationRow>>>
) => {
  const store: AppStore = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const asked: Array<string> = []
  let epoch = 0
  const read = createFlowDurationsReader({
    store,
    disposed: false,
    get accountEpoch() { return epoch },
    services: { features: {} },
    gateway: {
      flowDurations: (repo: string, flowId: string, binding?: GatewayWorkspaceBinding) => {
        asked.push(`${repo} ${flowId}`)
        return answer(repo, flowId, binding)
      }
    }
  } as unknown as ControllerContext)
  return { store, asked, read, retire: () => { epoch++ } }
}

const rowsOf = (store: AppStore, flowId: string): ReadonlyArray<string> =>
  [...store.collections.flowDurations.values()].filter((held) => held.flowId === flowId).map((held) => held.actionTag).sort()

describe("reading a flow's measured durations", () => {
  test("the rows the gateway served reach the collection, keyed by tag", async () => {
    const { store, asked, read } = await scope(async () => ({ status: "ok", value: [row("acme/Build", 1_000)] }))
    await read("o/r", "review", { workspaceId: "ws-1" })
    expect(asked).toEqual(["o/r review"])
    expect(store.collections.flowDurations.get(flowDurationRowId("o/r", "review", "acme/Build", "ws-1"))?.p50Ms).toBe(1_000)
  })

  test("a box that refuses the selector leaves no rows, and says nothing", async () => {
    const { store, read } = await scope(async () => ({ status: "error", message: "Unknown selector" }))
    await read("o/r", "review", { workspaceId: "ws-1" })
    expect([...store.collections.flowDurations.values()]).toEqual([])
    expect([...store.collections.toasts.values()]).toEqual([])
  })

  test("an answer overtaken by a later read of the same flow is dropped", async () => {
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    let first = true
    const { store, read } = await scope(async () => {
      if (!first) return { status: "ok", value: [row("acme/Fresh", 2_000)] }
      first = false
      await held
      return { status: "ok", value: [row("acme/Stale", 1_000)] }
    })
    const slow = read("o/r", "review", { workspaceId: "ws-1" })
    await read("o/r", "review", { workspaceId: "ws-1" })
    release!()
    await slow
    expect(rowsOf(store, "review")).toEqual(["acme/Fresh"])
  })

  test("two flows read at once keep their own rows", async () => {
    const { store, read } = await scope(async (_repo, flowId) => ({
      status: "ok",
      value: [{ ...row(`acme/${flowId}`, 1_000), flowId }]
    }))
    await Promise.all([read("o/r", "review", { workspaceId: "ws-1" }), read("o/r", "ship", { workspaceId: "ws-1" })])
    expect(rowsOf(store, "review")).toEqual(["acme/review"])
    expect(rowsOf(store, "ship")).toEqual(["acme/ship"])
  })
})


test("the same flow read on separate workspaces retains both replies regardless of order", async () => {
  const slow = Promise.withResolvers<void>()
  const { store, read } = await scope(async (_repo, _flow, binding) => {
    if (binding?.workspaceId === "ws-1") await slow.promise
    return { status: "ok", value: [row("acme/Build", binding?.workspaceId === "ws-1" ? 1000 : 9000)] }
  })
  const first = read("o/r", "review", { workspaceId: "ws-1" })
  await read("o/r", "review", { workspaceId: "ws-2" })
  slow.resolve()
  await first
  expect([...store.collections.flowDurations.values()]).toHaveLength(2)
  expect([...store.collections.flowDurations.values()].map(value => value.p50Ms).sort((a, b) => a - b)).toEqual([1000, 9000])
})

test("a reply from a retired account cannot restore its measurements", async () => {
  const held = Promise.withResolvers<void>()
  const { store, read, retire } = await scope(async () => { await held.promise; return { status: "ok", value: [row("acme/Build", 1000)] } })
  const pending = read("o/r", "review", { workspaceId: "ws-1" })
  retire()
  held.resolve()
  await pending
  expect([...store.collections.flowDurations.values()]).toHaveLength(0)
})

test("a read pins a copy of its binding until the response arrives", async () => {
  const held = Promise.withResolvers<void>()
  const binding = { workspaceId: "ws-1" }
  const { store, read } = await scope(async (_repo, _flow, requested) => {
    await held.promise
    expect(requested?.workspaceId).toBe("ws-1")
    return { status: "ok", value: [row("acme/Build", 1000)] }
  })
  const pending = read("o/r", "review", binding)
  binding.workspaceId = "ws-2"
  held.resolve()
  await pending
  expect(store.collections.flowDurations.get(flowDurationRowId("o/r", "review", "acme/Build", "ws-1"))?.p50Ms).toBe(1000)
  expect(store.collections.flowDurations.get(flowDurationRowId("o/r", "review", "acme/Build", "ws-2"))).toBeUndefined()
})
