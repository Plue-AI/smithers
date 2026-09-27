import { AGENT_ROLES } from "@smthrs/rpc/AgentRoles"
import { afterEach, expect, test } from "bun:test"
import type { Card, RepositoryFlow } from "../AppState"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { memoryStorage, settled } from "../TestFixtures"
import { AGENTS_CARD_ID, agentProfileOf, createAgentsController, flowModelOf, repositoryAgentProfiles } from "./agents"
import type { ControllerContext } from "./context"

/*
 * An agent is a flow (#2203): the Agents card lists the built-in roles and
 * the loaded repository's flows that declare a model, each with its label,
 * purpose and model, and the card renders every row's Runs door
 * (AgentCards.tsx, runs.list flow=<id>). No organization, no reporting line.
 */

const REPO = "smithersai/smithers"
const flow = (id: string, model: string | null, description = `Runs ${id}.`): RepositoryFlow =>
  ({ id, description, summary: null, featured: false, model, modelInvocable: true })

const opened: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of opened.splice(0)) await close() })

const setup = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let disposed = false
  const finalizers: Array<() => void | Promise<void>> = []
  const ctx = {
    store, commandActor: "user", baseUrl: "", get disposed() { return disposed },
    onDispose: (finalizer: () => void | Promise<void>) => { finalizers.push(finalizer) }
  } as unknown as ControllerContext
  const agents = createAgentsController(ctx, { nextOrdinal: store.nextOrdinal })
  opened.push(async () => { disposed = true; for (const finalizer of finalizers) await finalizer(); await store.settled?.(); await store.dispose?.() })
  const card = (): Extract<Card, { kind: "agents" }> | undefined => {
    const row = store.collections.cards.get(AGENTS_CARD_ID)
    return row?.kind === "agents" ? row : undefined
  }
  const rows = () => {
    const payload = card()?.payload
    return payload !== undefined && "agents" in payload ? payload.agents : []
  }
  return { store, agents, card, rows }
}

const loadRepository = async (store: AppStore, flows: ReadonlyArray<RepositoryFlow>) => {
  await store.dispatch({ type: "repository.upserted", actor: "system",
    repository: { id: REPO, org: "smithersai", ownerKind: "org", name: "smithers", head: null, catalog: true } }).isPersisted.promise
  await store.dispatch({ type: "repository-flows.loaded", actor: "system", repo: REPO, flows: [...flows] }).isPersisted.promise
}

test("the card lists the built-in roles, then the repository's flows that declare a model, with label, purpose and model", async () => {
  const t = await setup()
  await loadRepository(t.store, [
    flow("review", "sol", "Reviews the working-copy change."),
    flow("checks/lint", null),
    flow("assistant", "openai:gpt-6-astra", "Answers questions and routes work.")
  ])
  await t.agents.listAgents()
  expect(t.rows().map((row) => row.id)).toEqual([...AGENT_ROLES.map((role) => role.id), "review", "assistant"])
  expect(t.rows().slice(AGENT_ROLES.length)).toEqual([
    { id: "review", label: "review", purpose: "Reviews the working-copy change.", model: { provider: "", id: "sol", label: "sol" },
      builtin: false, available: false, reason: "", account: "" },
    { id: "assistant", label: "assistant", purpose: "Answers questions and routes work.", model: { provider: "openai", id: "gpt-6-astra", label: "gpt-6-astra" },
      builtin: false, available: false, reason: "", account: "" }
  ])
  // A built-in row keeps its harness; a flow runs on Smithers itself and names none.
  expect(t.rows()[0]).toMatchObject({ id: "orchestrator", harness: "claude", builtin: true })
  expect(Object.keys(t.rows().at(-1)!)).not.toContain("harness")
})

test("without a loaded repository the card lists the built-in roles alone", async () => {
  const t = await setup()
  await t.agents.listAgents()
  expect(t.rows().map((row) => row.id)).toEqual(AGENT_ROLES.map((role) => role.id))
})

test("an open card follows the repository: flows that load after it was asked for appear in place, at the same ordinal", async () => {
  const t = await setup()
  await t.agents.listAgents()
  const before = t.card()!
  expect(t.rows()).toHaveLength(AGENT_ROLES.length)
  await loadRepository(t.store, [flow("triage", "luna")])
  await settled()
  expect(t.rows().map((row) => row.id)).toContain("triage")
  expect(t.card()!.ordinal).toBe(before.ordinal)
  expect(t.card()!.createdAt).toBe(before.createdAt)
  // Nothing else changed: the card is not rewritten again.
  const transitions = t.store.collections.transitions.size
  await t.store.dispatch({ type: "toast.shown", actor: "system", key: "x", title: "x" }).isPersisted.promise
  await settled()
  expect(t.store.collections.transitions.size).toBe(transitions + 1)
})

test("a flow id with a path segment keeps its id, which is the Runs door's flow filter", async () => {
  const t = await setup()
  await loadRepository(t.store, [flow("checks/wiki", "fable")])
  await t.agents.listAgents()
  expect(t.rows().at(-1)).toMatchObject({ id: "checks/wiki", label: "checks/wiki" })
  expect(repositoryAgentProfiles(t.store).map((row) => row.id)).toEqual(["checks/wiki"])
})

test("a flow's model is shown as written: a bare seat, or provider:modelId; a seat that reads as a flag is no model", () => {
  expect(flowModelOf("sol")).toEqual({ provider: "", id: "sol", label: "sol" })
  expect(flowModelOf(" anthropic:claude-fable-5-1 ")).toEqual({ provider: "anthropic", id: "claude-fable-5-1", label: "claude-fable-5-1" })
  expect(flowModelOf("openai:-m evil")).toBeUndefined()
  expect(flowModelOf("")).toBeUndefined()
  expect(agentProfileOf(flow("plain", null))).toBeUndefined()
  expect(agentProfileOf(flow("odd", "openai:"))).toBeUndefined()
})
