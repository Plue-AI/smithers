import { expect, test } from "bun:test"
import { initialSetup, setupCandidate } from "@smthrs/rpc/RepositorySetup"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, recordingAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()
const id = "setup:maintainer:example%2Frepo:issues"

async function fixture() {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maintainer", admin: false, scopesPlain: null }).isPersisted.promise
  const payload = { ...initialSetup("example/repo", "issues", "maintainer"), inspectedAt: 1234 }
  await store.dispatch({ type: "card.upsert", actor: "user", card: {
    id, kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: store.nextOrdinal(), payload
  } }).isPersisted.promise
  const mutations: string[] = [], conversations: StartAgentTurnRequest[] = []
  const controller = createAppController(store, recordingAgent(conversations), {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (input, init) => {
      if (init?.method && init.method !== "GET") mutations.push(String(input))
      return String(input).includes("/repository-setup/state?")
        ? Response.json({ owner: "maintainer", repo: "example/repo", job: "issues", registration: { state: "known" }, setup: { state: "none" } })
        : Response.json({}, { status: 404 })
    }
  })
  await waitFor(() => { const card = store.collections.cards.get(id); return card?.kind === "repository-setup" && card.payload.recovery?.state === "completed" })
  const read = (args: string) => controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({ action: "execute", name: "setup.guide", args }) })
  return { store, payload, read, mutations, conversations, close: async () => { await controller.dispose(); await store.dispose?.() } }
}

test("the actual provider's JSON card argument reads the same owned setup as the existing bare ID", async () => {
  const t = await fixture()
  try {
    const before = t.store.collections.cards.get(id)
    const legacy = JSON.parse(await t.read(id))
    const structured = JSON.parse(await t.read(JSON.stringify({ cardId: id })))
    expect(structured).toEqual(legacy)
    expect(structured).toMatchObject({ cardId: id, repo: "example/repo", revision: 1, inspectedAt: 1234, draft: t.payload.draft })
    expect(setupCandidate(structured)).toBe(setupCandidate(t.payload))
    expect(t.store.collections.cards.get(id)).toEqual(before)
    expect(t.mutations).toEqual([])
    expect(t.conversations).toEqual([])
  } finally { await t.close() }
})

test("structured guide arguments cannot substitute a foreign owner or execute another setup action", async () => {
  const t = await fixture()
  try {
    await t.store.dispatch({ type: "card.upsert", actor: "user", card: {
      id: "foreign", kind: "repository-setup", title: "Other setup", status: "active", createdAt: 1, ordinal: t.store.nextOrdinal(),
      payload: { ...initialSetup("private/repo", "issues", "other"), inspectedAt: 1234 }
    } }).isPersisted.promise
    expect(await t.read(JSON.stringify({ cardId: "foreign" }))).toContain("different account")
    for (const args of [JSON.stringify({ cardId: id, operation: "apply" }), JSON.stringify({ cardId: id, owner: "other" }), JSON.stringify([id]), '{"cardId":', JSON.stringify({ cardId: 1 })]) {
      const result = await t.read(args)
      expect(result).not.toContain('"inspectedAt":1234')
    }
    expect(t.mutations).toEqual([])
    expect(t.conversations).toEqual([])
  } finally { await t.close() }
})
