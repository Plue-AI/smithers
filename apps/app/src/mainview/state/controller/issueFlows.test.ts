import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { createIssueFlowsController } from "./issueFlows"
import { createIssuesSeam } from "../seams/IssuesSeam"
import type { SeamContext } from "../seams/SeamContext"
import { repositoryHttpFixture } from "../TestFixtures"
const REPO = "owner/repo"
async function setup() {
  const data = new Map<string, string>()
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k,v) }, removeItem: (k: string) => { data.delete(k) } }
  const store = await createAppStore({ kind: "localStorage", storage })
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
