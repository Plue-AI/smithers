import { expect, test } from "bun:test"
import { scopedControllers } from "../../state/ControllerTestScope"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, silentAgent } from "../../state/TestFixtures"

const createAppController = scopedControllers()

test("install refuses legacy issue creation at the slash, button and agent doors before any write", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "owner/repo", org: "owner", ownerKind: "user", name: "repo", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "owner/repo" }).isPersisted.promise
  const writes: string[] = []
  const controller = createAppController(store, silentAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["install", "identity", "cloud"], authFlow: "credentials", sandbox: null },
    fetchImpl: async (input, init) => {
      if (init?.method === "POST") writes.push(String(input))
      return Response.json({}, { status: 404 })
    }
  })
  try {
    expect(await controller.commands.run("issues.create", "Legacy issue owner/repo")).toMatchObject({ status: "failed", error: "Use /issue.new on this install." })
    for (const actor of ["user", "agent"] as const) {
      expect(await controller.commands.submit({ name: "issues.create", payload: { title: "Legacy issue", repo: "owner/repo" }, actor })).toMatchObject({ status: "failed", error: "Use /issue.new on this install." })
    }
    expect(writes).toEqual([])
    expect([...store.collections.messages.values()].some(row => row.action?.flow === "issues.create")).toBe(false)
    expect([...store.collections.cards.values()].some(row => row.kind === "issue")).toBe(false)
  } finally { controller.dispose() }
})
