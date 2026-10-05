import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { createIssueFlowsController } from "./issueFlows"
import type { SeamContext } from "../seams/SeamContext"

test("Make TODO drafts only from a GitHub issue card and never launches, even with a running workspace", async () => {
  const values = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } } })
  const ctx: SeamContext = { store, http: async () => { throw Error("Must not use the tutorial service") }, baseUrl: "", dispatch: store.dispatch, actor: () => "user", nextOrdinal: store.nextOrdinal }
  const repo = "owner/repo", workspaceId = "11111111-1111-4111-8111-111111111111"
  const issue = { repo, number: 9, title: "Real bug", state: "open" as const, author: "ada", issueBody: "Reproduction evidence", labels: [], comments: [] }
  await store.dispatch({ type: "workspaces.loaded", actor: "system", repoId: repo, workspaces: [] }).isPersisted.promise
  const calls: unknown[] = []
  const drafted: number[] = []
  let lists = 0
  const flows = createIssueFlowsController(ctx, {
    requireBox: () => undefined,
    listWorkspaceWorkflows: async () => {
      lists++
      throw Error("Catalog read must not block the launch")
    },
    runWorkflow: async (...args) => { calls.push(args); return { value: "started" } }
  }, { draftFromIssue: async source => { drafted.push(source.number); return { value: "Drafted" } } })
  // Before any GitHub issue card is open there is nothing to draft from.
  expect(await flows.runIssueImplementation(9, repo)).toBe("Open GitHub issue #9 before making a TODO.")
  // A same-number GitHub card must not satisfy the Cloud command; it is Make TODO's source.
  await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "github-issue", kind: "issue", title: "GitHub issue", status: "active", createdAt: 1, ordinal: 1, payload: { ...issue, source: "github" } } }).isPersisted.promise
  expect(await flows.runIssueFlow("repro", 9, repo)).toContain("Open Smithers Cloud issue #9")
  expect(await flows.runIssueImplementation(9, repo)).toEqual({ value: "Drafted" })
  expect(lists).toBe(0)
  await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "cloud-issue", kind: "issue", title: issue.title, status: "active", createdAt: 1, ordinal: 2, payload: issue } }).isPersisted.promise
  await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [{ id: workspaceId, repoId: repo, name: "Coding", targetBookmark: "main", status: "running", provisioningStage: null, suspendedAt: null, createdAt: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: repo + "#workspace:" + workspaceId }).isPersisted.promise
  expect(await flows.runIssueImplementation(9, repo)).toEqual({ value: "Drafted" })
  expect(drafted).toEqual([9, 9])
  expect(calls).toEqual([])
  expect(lists).toBe(0)
  await store.dispose?.()
})
