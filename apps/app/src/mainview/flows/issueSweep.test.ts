/*
 * `issue-sweep`, the app's typed entry for the repository's burndown flow
 * (entries/issue.ts): one flow with three doors. The slash and the button
 * resolve this entry, never the generic repository leaf; its input mirrors the
 * flow's schema, so a bare line with a selected repository runs with the
 * flow's defaults; the agent's call confirms first and binds the repository
 * (THE THREE-DOOR LAW); the run is the repository's own `issue-sweep` flow.
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { RuntimeCapabilitySchema, type AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { createAppStore, type AppStore } from "../state/AppStore"
import { loadBox } from "../state/TestFixtures"
import { flowArgs } from "./FlowArgs"
import { modelInvocable } from "./registry"
import { payloadFor } from "./SlashPayload"
import { repositoryFlowLeaves } from "./entries/flow"
import type { CommandActions } from "./entries/Declare"

const REPO = "will/smithers"
const PROJECTION = `/api/repos/${REPO}/contents/.smithers/factory.json`
const factory = {
  summary: "test",
  flows: [{ id: "issue-sweep", description: "Work every open GitHub issue that no other machine holds.", summary: "Work every open GitHub issue that no other machine holds.",
    featured: true, kind: "ts", path: "flows/issue-sweep/flow.ts", capabilities: [], model: null, modelInvocable: false, flows: [] }],
  on: [], github: { writers: [] }
}

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }
}
const unavailableAgent: AgentPort = {
  available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {}
}
const EVERYTHING: AppBootstrap = {
  apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: [...RuntimeCapabilitySchema.options], authFlow: "both",
  sandbox: { platform: "darwin", mode: "enforced" }
}
const settle = async (ticks = 8): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const boot = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const rpc: Array<{ procedure: string; payload: Record<string, unknown> }> = []
  const controller = createAppController(store, unavailableAgent, {
    bootstrap: EVERYTHING,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url, "http://local.test").pathname
      if (path === PROJECTION) return json(200, { type: "file", path: ".smithers/factory.json", encoding: "utf-8", content: JSON.stringify(factory) })
      if (path === "/api/workflow/rpc") {
        const call = JSON.parse(String(init?.body)) as { procedure: string; payload: Record<string, unknown> }
        rpc.push(call)
        return json(200, { ok: true, payload: call.procedure === "Plan" ? { planId: "plan-1", digest: "d", envelope: {} } : call.procedure === "Run" ? { runId: "run-1" } : { rows: [] } })
      }
      if (path === "/api/workflow/provision") return json(200, { status: "ready" })
      return json(404, { status: "error", message: `no stub for ${path}` })
    }
  })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null })
  store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null })
  store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
    { id: REPO, org: "will", name: "smithers", ownerKind: "user", head: { bookmark: "main", changeId: "q", commitId: "c" }, catalog: true }
  ] })
  store.dispatch({ type: "repo.selected", actor: "user", id: REPO })
  await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [] }).isPersisted.promise
  await loadBox(store, REPO)
  await settle(20)
  return { store, controller, rpc }
}

const forms = (store: AppStore) => [...store.collections.cards.values()].filter((card) => card.kind === "flow-form")
const messages = (store: AppStore) => [...store.collections.messages.values()].sort((left, right) => left.ordinal - right.ordinal)

describe("the issue-sweep grammar", () => {
  test("reads the width, the placement, the attempt and the repository in any order", () => {
    expect(payloadFor("issue-sweep", "8 vm attempt=3 will/smithers")).toEqual({ payload: { maxAgents: 8, placement: "vm", attempt: 3, repo: REPO } })
    expect(payloadFor("issue-sweep", "local 4")).toEqual({ payload: { maxAgents: 4, placement: "local" } })
    expect(payloadFor("issue-sweep", "")).toEqual({ payload: {} })
  })

  test("reads how many changes check their landing at once, and how many agents overflow to the cloud", () => {
    expect(payloadFor("issue-sweep", "8 landers=3")).toEqual({ payload: { maxAgents: 8, landers: 3 } })
    expect(payloadFor("issue-sweep", "2 vm cloudAgents=6")).toEqual({ payload: { maxAgents: 2, placement: "vm", cloudAgents: 6 } })
  })

  test("the button's JSON line is what the grammar parses back", () => {
    const line = flowArgs("issue-sweep", { maxAgents: 32, placement: "vm", attempt: 10, landers: 4, repo: REPO })
    expect(payloadFor("issue-sweep", line)).toEqual({ payload: { maxAgents: 32, placement: "vm", attempt: 10, landers: 4, repo: REPO } })
  })

  test("refuses a word it does not know, naming it", () => {
    expect(payloadFor("issue-sweep", "8 cloud")).toEqual({ error: "issue-sweep takes [agents] [local|vm] [attempt=<n>] [landers=<n>] [cloudAgents=<n>] [owner/repo], not cloud" })
  })

  test("the featured button's bare owner/repo token parses to {repo} here and in every repository leaf", () => {
    expect(payloadFor("issue-sweep", REPO)).toEqual({ payload: { repo: REPO } })
    const [leaf] = repositoryFlowLeaves({} as CommandActions, "other/repo", [{ id: "review", description: "Review", summary: null, featured: true, model: null, modelInvocable: true }])
    // The leaf's own name rides flow.run's grammar; the schema keeps only repo and input.
    expect(leaf?.metadata.grammar?.(REPO)).toEqual({ payload: { name: "review", repo: REPO } })
  })
})

describe("the issue-sweep entry", () => {
  test("the typed entry owns the name: the repository's projection row adds no second issue-sweep", async () => {
    const { controller } = await boot()
    const entries = controller.commands.entries().filter((entry) => entry.declaredName === "issue-sweep")
    expect(entries).toHaveLength(1)
    expect(entries[0]?.metadata.workflow).toBe("issue-sweep")
    expect(entries[0]?.metadata.confirm).toBeDefined()
    // Never user-only: the agent may ask.
    expect(modelInvocable(entries[0]!)).toBe(true)
    controller.dispose()
  })

  test("a bare line with a selected repository launches with {repo} only; the flow's defaults cover the rest", async () => {
    const { store, controller, rpc } = await boot()
    const outcome = await controller.commands.run("issue-sweep", "")
    await settle(60)
    expect(outcome.status).toBe("executed")
    expect(forms(store)).toEqual([])
    const card = [...store.collections.cards.values()].find((each) => each.kind === "run-trace")
    const input = card?.kind === "run-trace" ? card.payload.input as Record<string, unknown> | undefined : undefined
    expect((input?._workflowLaunch as { input?: unknown } | undefined)?.input).toEqual({ repo: REPO })
    expect(input).not.toHaveProperty("maxAgents")
    expect(rpc.some((call) => call.procedure === "Plan")).toBe(true)
    controller.dispose()
  })

  test("the agent's bare call confirms first, and the confirmation binds the repository resolved at ask time", async () => {
    const { store, controller, rpc } = await boot()
    const result = await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "issue-sweep" }) })
    expect(result).toContain("asked the user to confirm")
    const confirmation = messages(store).find((message) => message.action?.flow === "issue-sweep")
    expect(confirmation?.action?.args).toBe(flowArgs("issue-sweep", { repo: REPO }))
    expect(rpc).toEqual([])
    controller.dispose()
  })

  test("the agent's call confirms first and runs nothing; the confirmation carries the exact line", async () => {
    const { store, controller, rpc } = await boot()
    const args = flowArgs("issue-sweep", { maxAgents: 8, placement: "vm", repo: REPO })
    const result = await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "issue-sweep", args }) })
    expect(result).toContain("asked the user to confirm")
    const confirmation = messages(store).find((message) => message.action?.flow === "issue-sweep")
    expect(confirmation?.action?.args).toBe(args)
    expect(rpc).toEqual([])
    controller.dispose()
  })

  test("a human's full line launches the repository's issue-sweep flow with that input", async () => {
    const { store, controller, rpc } = await boot()
    const outcome = await controller.commands.run("issue-sweep", "8 vm attempt=2 landers=3 cloudAgents=4")
    await settle(60)
    expect(outcome.status).toBe("executed")
    const card = [...store.collections.cards.values()].find((each) => each.kind === "run-trace")
    expect(card?.kind === "run-trace" ? card.payload.workflow : undefined).toBe("issue-sweep")
    expect(card?.kind === "run-trace" ? card.payload.input : undefined).toMatchObject({ repo: REPO, maxAgents: 8, attempt: 2, placement: "vm", landers: 3, cloudAgents: 4 })
    expect(rpc.some((call) => call.procedure === "Plan" && JSON.stringify(call.payload).includes("issue-sweep"))).toBe(true)
    controller.dispose()
  })
})
