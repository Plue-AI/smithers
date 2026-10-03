/*
 * The smithers repository's own flows are slash commands (#1964): every row
 * of the checked-in `.smithers/factory.json` projection becomes a leaf
 * (flows/entries/flow.ts repositoryFlowLeaves), beside the app's built-in
 * change and stack commands. The rows are the real file, not a copy.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { repositoryFlowsOf } from "./seams/RepositoryFlowsSeam"
import { memoryStorage, settle, unavailableAgent } from "./TestFixtures"

const createAppController = scopedControllers()
const projection = JSON.parse(readFileSync(new URL("../../../../../.smithers/factory.json", import.meta.url), "utf8")) as {
  readonly flows: Parameters<typeof repositoryFlowsOf>[0]
}

test("the smithers repository's declared flows and the built-in change and stack commands are all slash commands", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, {
    openExternal: async () => true,
    fetchImpl: async () => Response.json({ message: "Unexpected request" }, { status: 404 })
  })
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "smithersai/smithers", org: "smithersai", name: "smithers", ownerKind: "user", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" }).isPersisted.promise
  // The seam's own read (answered 404 here) lands first; the projection replaces it.
  await settle()
  await store.dispatch({ type: "repository-flows.loaded", actor: "system", repo: "smithersai/smithers", flows: repositoryFlowsOf(projection.flows) }).isPersisted.promise
  await settle()
  for (const name of ["review", "lint", "pr-triage", "issue-triage", "release-notes", "coding.request"]) {
    const entry = controller.commands.find(name)
    expect({ name, grammar: typeof entry?.metadata.grammar }).toEqual({ name, grammar: "function" })
  }
  expect(controller.commands.find("history.show")).toBeDefined()
  expect(controller.commands.find("change.request")).toBeUndefined()
})
