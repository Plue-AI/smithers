import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { createIssueFlowsController } from "./issueFlows"
import { createIssuesSeam } from "../seams/IssuesSeam"
import type { SeamContext } from "../seams/SeamContext"
import { loadBox, repositoryHttpFixture, TEST_BOX } from "../TestFixtures"
const REPO = "owner/repo"
async function setup() {
  const data = new Map<string, string>()
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k,v) }, removeItem: (k: string) => { data.delete(k) } }
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "workspaces.loaded", actor: "system", repoId: REPO, workspaces: [] }).isPersisted.promise
  const ctx: SeamContext = { store, http: repositoryHttpFixture(), baseUrl: "", dispatch: store.dispatch, actor: () => "user", nextOrdinal: store.nextOrdinal }
  return { store, ctx, storage }
}
test("remote comments and state survive reopening and reload", async () => {
  const {store,ctx,storage} = await setup()
  const issues = createIssuesSeam(ctx)
  await issues.listIssues("open",REPO)
  await issues.viewIssue(3,REPO)
  expect(await issues.commentOnIssue(3,"Reproduced with an empty name",REPO)).toBeUndefined()
  expect(await issues.setIssueState(3,"closed",REPO)).toBeUndefined()
  await issues.viewIssue(2,REPO)
  await issues.viewIssue(3,REPO)
  const issue = [...store.collections.cards.values()].find(c => c.kind === "issue" && c.payload.number === 3)
  expect(issue?.kind === "issue" && issue.payload.state).toBe("closed")
  expect(issue?.kind === "issue" && issue.payload.comments.at(-1)?.commentBody).toBe("Reproduced with an empty name")
  await store.dispose?.()
  const restored = await createAppStore({kind:"localStorage",storage})
  const restoredIssues = createIssuesSeam({...ctx,store:restored,dispatch:restored.dispatch})
  await restoredIssues.listIssues("open",REPO)
  let list = [...restored.collections.cards.values()].find(card => card.kind === "issue-list")
  expect(list?.kind === "issue-list" && list.payload.issues.map(i=>i.number)).toEqual([2])
  await restored.dispose?.()
})
test("a Cloud issue launches its workspace flow without waiting for a background catalog read", async () => {
  const {store,ctx} = await setup()
  const issue = { number: 9, repo: "owner/repo", title: "The real issue", state: "open" as const, author: "ada", issueBody: "Details", labels: ["bug"], comments: [] }
  await store.dispatch({type:"card.upsert",actor:"user",card:{ id:"issue-live",kind:"issue",title:issue.title,status:"active",createdAt:1,ordinal:1,payload:issue }}).isPersisted.promise
  const calls: unknown[] = []
  const flows = createIssueFlowsController(ctx, {
    requireBox: () => undefined,
    listWorkspaceWorkflows: async () => { throw Error("Catalog read must not block the launch") },
    runWorkflow: async (...args) => { calls.push(args); return {value:"launched"} }
  })
  expect(await flows.runIssueFlow("repro",9,issue.repo)).toContain("/box.open")
  expect(calls).toHaveLength(0)
  const workspaceId = "11111111-1111-4111-8111-111111111111"
  await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [{ id: workspaceId, repoId: issue.repo, name: "Coding", targetBookmark: "main", status: "running", provisioningStage: null, suspendedAt: null, createdAt: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: issue.repo + "#workspace:" + workspaceId }).isPersisted.promise
  expect(await flows.runIssueFlow("repro",9,issue.repo)).toEqual({value:"launched"})
  expect(calls).toHaveLength(1)
  const [name, repo, input, source] = calls[0] as [string, string, {args:string}, string | undefined]
  expect([name,repo,source]).toEqual(["issue/repro",issue.repo,undefined])
  expect(JSON.parse(input.args)).toEqual({issue})
  await store.dispose?.()
})

test("the Fix an issue app implements an issue picked on the home, read without a card", async () => {
  const { store, ctx } = await setup()
  const calls: unknown[] = []
  const workspaceId = "11111111-1111-4111-8111-111111111111"
  await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [{ id: workspaceId, repoId: REPO, name: "Coding", targetBookmark: "main", status: "running", provisioningStage: null, suspendedAt: null, createdAt: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: REPO + "#workspace:" + workspaceId }).isPersisted.promise
  const flows = createIssueFlowsController(ctx, {
    requireBox: () => undefined,
    listWorkspaceWorkflows: async () => { throw Error("Catalog read must not block the launch") },
    runWorkflow: async (...args) => { calls.push(args); return { value: "launched" } }
  })
  // No issue card is open: the issue is read from the tracker and the run card is what follows.
  expect([...store.collections.cards.values()].some(card => card.kind === "issue")).toBe(false)
  expect(await flows.runIssueImplementation(3)).toEqual({ value: "launched" })
  expect([...store.collections.cards.values()].some(card => card.kind === "issue")).toBe(false)
  const [name, repo, input] = calls[0] as [string, string, { prompt: string }]
  expect([name, repo]).toEqual(["coding/request", REPO])
  const sent = JSON.parse(input.prompt.slice(input.prompt.indexOf("\n{") + 1)) as { number: number; title: string }
  expect([sent.number, sent.title]).toEqual([3, "Issue 3"])
  // An issue the tracker does not have is that refusal, never a launch.
  expect(await flows.runIssueImplementation(99)).toContain("Issue #99")
  expect(calls).toHaveLength(1)
  await store.dispose?.()
})

test("review refuses every browser door without reads, selection or launch", async () => {
  const { store, ctx } = await setup()
  let effects = 0
  const unexpected = async () => { effects++; throw Error("Review must not execute in the browser") }
  for (const actor of ["user", "smithers"] as const) {
    const review = createIssueFlowsController({ ...ctx, actor: () => actor, http: unexpected }, { requireBox: () => { effects++; throw Error("No working copy") }, listWorkspaceWorkflows: unexpected, runWorkflow: unexpected })
    for (const selected of [false, true]) {
      if (selected) await loadBox(store, REPO, TEST_BOX)
      for (const humanDoor of [false, true]) {
        for (const number of [50, 51]) {
          expect(await review.triagePullRequest(number, REPO, humanDoor)).toBe("Review is unavailable on this host.")
        }
      }
    }
  }
  expect(effects).toBe(0)
  expect([...store.collections.cards.values()]).toEqual([])
  await store.dispose?.()
})
