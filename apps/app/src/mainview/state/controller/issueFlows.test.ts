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
  await store.dispatch({ type: "workspaces.loaded", actor: "system", repoId: REPO, workspaces: [] }).isPersisted.promise
  const serverIssue = { issue_digest: "a".repeat(64), make_todo_allowed: true, issue: { number: 7, title: "Webhooks fail on 502", body: "Webhooks fail on 502", state: "open", user: {login:"ben"} }, comments: [{user:{login:"alice"},body:"retry at most 5 times"}] }
  const fallback = repositoryHttpFixture()
  const http: SeamContext["http"] = async (input, init) => String(input).includes("/api/issues/7") ? Response.json(serverIssue) : fallback(input, init)
  const ctx: SeamContext = { store, http, baseUrl: "", dispatch: store.dispatch, actor: () => "user", nextOrdinal: store.nextOrdinal }
  return { store, ctx, storage, serverIssue }
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
  }, { draftFromIssue: async () => { throw Error("Issue flows never draft a TODO") } })
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

test("Make TODO drafts from the open GitHub issue card and never launches a workspace flow", async () => {
  const { store, ctx } = await setup()
  const calls: unknown[] = []
  const drafted: unknown[] = []
  const workspaceId = "11111111-1111-4111-8111-111111111111"
  await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [{ id: workspaceId, repoId: REPO, name: "Coding", targetBookmark: "main", status: "running", provisioningStage: null, suspendedAt: null, createdAt: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: REPO + "#workspace:" + workspaceId }).isPersisted.promise
  const flows = createIssueFlowsController(ctx, {
    requireBox: () => undefined,
    listWorkspaceWorkflows: async () => { throw Error("Make TODO reads no catalog") },
    runWorkflow: async (...args) => { calls.push(args); return { value: "launched" } }
  }, { draftFromIssue: async (source) => { drafted.push(source); return { value: "Drafted" } } })
  // No issue card open, or only the legacy tracker's: nothing to draft from.
  expect(await flows.runIssueImplementation(7)).toBe("Open the issue again to check permission to make a TODO.")
  const legacy = { number: 7, repo: REPO, title: "Tracker issue", state: "open" as const, author: "ada", issueBody: "Legacy", labels: [], comments: [] }
  await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "issue-legacy", kind: "issue", title: legacy.title, status: "active", createdAt: 1, ordinal: 1, payload: legacy } }).isPersisted.promise
  expect(await flows.runIssueImplementation(7)).toBe("Open the issue again to check permission to make a TODO.")
  const github = { ...legacy, title: "Webhooks fail on 502", author: "ben", issueBody: "Webhooks fail on 502", source: "github" as const,
    htmlUrl: "https://github.com/owner/repo/issues/7", makeTodoAllowed: true, issueDigest: "a".repeat(64), todoAuthorizationScope: JSON.stringify([store.collections.identitySessions.get("identity"), ""]),
    comments: [{ author: "alice", commentBody: "retry at most 5 times", createdAt: null }] }
  await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "issue-github-owner/repo-7", kind: "issue", title: github.title, status: "active", createdAt: 2, ordinal: 2, payload: github } }).isPersisted.promise
  expect(await flows.runIssueImplementation(7, REPO, true)).toEqual({ value: "Drafted" })
  expect(drafted).toEqual([{ author: "ben", number: 7, digest: "a".repeat(64), title: "Webhooks fail on 502", body: "Webhooks fail on 502", url: "https://github.com/owner/repo/issues/7",
    comments: [{ author: "alice", body: "retry at most 5 times" }] }])
  // Another repository's issue and a closed issue draft nothing.
  expect(await flows.runIssueImplementation(7, "other/repo")).toBe("Open the issue again to check permission to make a TODO.")
  await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "issue-github-owner/repo-8", kind: "issue", title: "Closed", status: "active", createdAt: 3, ordinal: 3, payload: { ...github, number: 8, state: "closed" as const } } }).isPersisted.promise
  expect(typeof await flows.runIssueImplementation(8)).toBe("string")
  expect(drafted).toHaveLength(1)
  expect(calls).toEqual([])
  await store.dispose?.()
})

test("review asks the host and never launches in a browser working copy", async () => {
  const { store, ctx } = await setup()
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  let calls = 0
  const unexpected = async () => { throw Error("Review must not execute in the browser") }
  const review = createIssueFlowsController({ ...ctx, http: async () => { calls++; return Response.json({ error: { class: "infra", code: "review_delivery_unavailable", message: "Review unavailable" } }, { status: 503 }) } },
    { requireBox: () => { throw Error("No working copy") }, listWorkspaceWorkflows: unexpected, runWorkflow: unexpected }, { draftFromIssue: unexpected })
  expect(await review.triagePullRequest(50, REPO, true)).toEqual({ value: "Requested" })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(calls).toBe(1)
  expect(store.session().reviewRequests?.[0]?.state).toBe("failed")
  expect([...store.collections.cards.values()]).toEqual([])
  await store.dispose?.()
})

test("Make TODO refuses a missing card and current server denials before drafting", async () => {
  const {store,ctx,serverIssue} = await setup()
  let role = "maintainer"
  const scopedCtx = {...ctx, issueAuthorizationScope: () => role}
  let drafts = 0
  const controller = createIssueFlowsController(scopedCtx, {requireBox: () => undefined, listWorkspaceWorkflows: async () => "", runWorkflow: async () => ""}, {draftFromIssue: async () => { drafts++; return {value:"Drafted"} }})
  expect(await controller.issueTodoRefusal(7,REPO)).toBeDefined()
  expect(typeof await controller.runIssueImplementation(7,REPO)).toBe("string")
  const payload = {number:7,repo:REPO,title:"Issue",state:"open" as const,author:"ben",issueBody:"Body",labels:[],comments:[],source:"github" as const}
  const put = async (extra: object) => store.dispatch({type:"card.upsert",actor:"system",card:{id:"issue-security",kind:"issue",title:"Issue",status:"active",createdAt:1,ordinal:1,payload:{...payload,...extra}}}).isPersisted.promise
  const digest = "a".repeat(64)
  for (const extra of [{issueDigest:digest}, {makeTodoAllowed:true}, {makeTodoAllowed:true,issueDigest:digest}]) {
    await put(extra)
    serverIssue.make_todo_allowed = false
    expect(await controller.issueTodoRefusal(7,REPO)).toBeDefined()
    expect(typeof await controller.runIssueImplementation(7,REPO)).toBe("string")
  }
  // Current server permission replaces the retained observation.
  await put({makeTodoAllowed:true,issueDigest:digest,todoAuthorizationScope:JSON.stringify([store.collections.identitySessions.get("identity"), role])})
  serverIssue.make_todo_allowed = true
  expect(await controller.issueTodoRefusal(7,REPO)).toBeUndefined()
  role = "member"
  serverIssue.make_todo_allowed = false
  expect(await controller.issueTodoRefusal(7,REPO)).toBeDefined()
  expect(typeof await controller.runIssueImplementation(7,REPO)).toBe("string")
  expect(drafts).toBe(0)
  await store.dispose?.()
})

for (const change of ["scope", "revision", "server"] as const) test(`Make TODO refuses ${change} changes during persistence`, async () => {
  const {store,ctx,serverIssue} = await setup()
  await store.dispatch({type:"card.upsert",actor:"system",card:{id:"race-issue",kind:"issue",title:"Issue",status:"active",createdAt:1,ordinal:1,payload:{number:7,repo:REPO,title:"Issue",state:"open",author:"ben",issueBody:"Body",labels:[],comments:[],source:"github"}}}).isPersisted.promise
  let scope = "session:0"
  let drafts = 0
  let pending = false
  let release!: () => void
  let gate: Promise<void>
  const guarded: SeamContext = {...ctx, issueAuthorizationScope: () => scope, dispatch: event => {
    const result = ctx.dispatch(event)
    if (event.type !== "card.upsert") return result
    pending = true
    const isPersisted = {...result.isPersisted, promise: result.isPersisted.promise.then(async value => { await gate; return value })}
    return new Proxy(result, {get: (transaction, key, receiver) => key === "isPersisted" ? isPersisted : Reflect.get(transaction, key, receiver)})
  }}
  const controller = createIssueFlowsController(guarded, {requireBox: () => undefined, listWorkspaceWorkflows: async () => "", runWorkflow: async () => ""}, {draftFromIssue: async () => { drafts++; return {value:"Drafted"} }})
  for (const door of ["confirmation", "draft"] as const) {
    scope = "session:0"
    serverIssue.make_todo_allowed = true
    pending = false
    gate = new Promise<void>(resolve => { release = resolve })
    const result = door === "confirmation" ? controller.issueTodoRefusal(7,REPO) : controller.runIssueImplementation(7,REPO)
    while (!pending) await new Promise(resolve => setTimeout(resolve, 0))
    if (change === "server") serverIssue.make_todo_allowed = false
    else scope = change === "scope" ? "other:0" : "session:1"
    release()
    expect(await result).toBeDefined()
  }
  expect(drafts).toBe(0)
  await store.dispose?.()
})
