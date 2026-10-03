import { afterEach, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { ConfiguredModel } from "@smthrs/rpc/ConfiguredModel"
import { createAppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import { assignedBinding,assignedModel } from "./modelSeats"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

const MINE: ConfiguredModel = { id: "mine", protocol: "openai-chat", baseUrl: "https://api.cerebras.ai", modelId: "qwen-3-coder-480b", credential: "CEREBRAS_API_KEY" }
const JEV: ConfiguredModel = { id: "jev", protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" }

const bootstrap = (host: AppBootstrap["host"]): AppBootstrap =>
  ({ apiVersion: 1, host, version: "test", buildSha: "test", capabilities: ["agent"], authFlow: "redirect", sandbox: null })

const fixture = async (host?: AppBootstrap["host"]) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  cleanups.push(async () => { await store.dispose?.() })
  for (const model of [MINE, JEV]) await store.dispatch({ type: "model.saved", actor: "user", model }).isPersisted.promise
  return { store, ctx: { store, services: host === undefined ? {} : { bootstrap: bootstrap(host) } } }
}

test("an unassigned seat carries nothing", async () => {
  const { ctx } = await fixture("cloud")
  for (const seat of ["chat", "explainer", "recommend"] as const) {
    expect(assignedModel(ctx, seat)).toBeUndefined()
    expect(assignedBinding(ctx, seat)).toBeUndefined()
  }
})

test("an assigned seat carries the record without its name, and nothing a key could ride in", async () => {
  const { store, ctx } = await fixture()
  await store.dispatch({ type: "seat.assigned", actor: "user", seat: "chat", recordId: "mine" }).isPersisted.promise
  await store.dispatch({ type: "seat.assigned", actor: "user", seat: "recommend", recordId: "jev" }).isPersisted.promise
  expect(assignedModel(ctx, "chat")).toEqual(MINE)
  expect(assignedBinding(ctx, "chat")).toEqual({ protocol: "openai-chat", baseUrl: "https://api.cerebras.ai", modelId: "qwen-3-coder-480b", credential: "CEREBRAS_API_KEY" })
  expect(assignedBinding(ctx, "recommend")).toEqual({ protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" })
})

test("a removed record and a reassignment to the default both leave the seat carrying nothing", async () => {
  const { store, ctx } = await fixture()
  await store.dispatch({ type: "seat.assigned", actor: "user", seat: "chat", recordId: "mine" }).isPersisted.promise
  await store.dispatch({ type: "seat.assigned", actor: "user", seat: "recommend", recordId: "jev" }).isPersisted.promise
  await store.dispatch({ type: "model.removed", actor: "user", id: "mine" }).isPersisted.promise
  await store.dispatch({ type: "seat.assigned", actor: "user", seat: "recommend", recordId: null }).isPersisted.promise
  expect(assignedBinding(ctx, "chat")).toBeUndefined()
  expect(assignedBinding(ctx, "recommend")).toBeUndefined()
})

test("a record of the wrong kind never rides a seat", async () => {
  const { store, ctx } = await fixture()
  await store.dispatch({ type: "seat.assigned", actor: "user", seat: "chat", recordId: "jev" }).isPersisted.promise
  await store.dispatch({ type: "seat.assigned", actor: "user", seat: "recommend", recordId: "mine" }).isPersisted.promise
  expect(assignedBinding(ctx, "chat")).toBeUndefined()
  expect(assignedBinding(ctx, "recommend")).toBeUndefined()
})

test("a seat this host does not serve carries nothing there; a host that has not said what it is decides for itself", async () => {
  for (const [host, served] of [["local", false], ["cloud", true], [undefined, true]] as const) {
    const { store, ctx } = await fixture(host)
    await store.dispatch({ type: "seat.assigned", actor: "user", seat: "recommend", recordId: "jev" }).isPersisted.promise
    await store.dispatch({ type: "seat.assigned", actor: "user", seat: "chat", recordId: "mine" }).isPersisted.promise
    expect(assignedBinding(ctx, "recommend") !== undefined).toBe(served)
    // Chat is served locally; recommendations are served by the Cloud host.
    expect(assignedBinding(ctx, "chat") !== undefined).toBe(host !== "cloud")
  }
})
