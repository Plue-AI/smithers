/*
 * THE FORM LAW for a box-bound act (#2327). When several boxes of a
 * repository could be meant, a human's act renders the box.select form for
 * exactly those boxes instead of refusing with "Select a box of <repo>
 * first.". Nothing reaches a box before the pick; Submit selects the chosen
 * box and runs the act that asked once, on that box. No box is created and
 * none is chosen for the person.
 */
import { describe, expect, test } from "bun:test"
import type { AppStore } from "./AppStore"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { json, loadBox, memoryStorage, silentAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()

const REPO = "will/flows"
const BOX_A = "0b0c0d0e-0000-4000-8000-00000000000a"
const BOX_B = "0b0c0d0e-0000-4000-8000-00000000000b"
const FORM = "form-box.select"

const signedIn = async (): Promise<AppStore> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: REPO, org: "will", ownerKind: "user", name: "flows", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: REPO }).isPersisted.promise
  await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [] }).isPersisted.promise
  return store
}

/** Every box call is recorded and held open: the pick must precede them all. */
const boxCalls = () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  return {
    calls,
    services: {
      toastDebounceMs: 0,
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "https://app.test").pathname
        if (path.startsWith("/api/workflow/")) {
          calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> })
          return new Promise<Response>(() => {})
        }
        return json(404, { status: "error" })
      }
    }
  }
}

const pickForm = (store: AppStore) => {
  const card = store.collections.cards.get(FORM)
  return card?.kind === "flow-form" ? card : undefined
}

const inboxRequests = (store: AppStore) => store.session().approvalsInboxRequests ?? []

test("submitting the Inbox prerequisite opens one box and never silently reads Inbox or Runs", async () => {
  const store = await signedIn()
  await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null }).isPersisted.promise
  await store.dispatch({ type: "workspaces.loaded", actor: "system", repoId: REPO, workspaces: [] }).isPersisted.promise
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  const controller = createAppController(store, silentAgent, { toastDebounceMs: 0,
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "https://app.test").pathname
      const method = init?.method ?? "GET"
      calls.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      if (method === "POST" && path === `/api/repos/${REPO}/workspaces`) return json(201, {
        id: BOX_A, repository_id: 7, repo_full_name: REPO, name: "review", slug: "review", target_bookmark: "feature",
        status: "running", provisioning_stage: null, suspended_at: null, created_at: "2026-09-01T00:00:00Z"
      })
      if (path.endsWith("/bookmarks")) return json(200, { items: [], next_cursor: "" })
      if (path.endsWith("/workspace/sessions")) return json(200, [])
      return json(404, { status: "error" })
    }
  })
  await controller.commands.run("flow.create", `Review the repo ${REPO}`)
  await controller.commands.run("approvals.list", REPO)
  const formId = "form-box.open-approvals.list"
  expect(calls.filter(call => call.method === "POST" || call.path.startsWith("/api/workflow/") || call.path.includes("/approvals"))).toEqual([])
  expect((await controller.commands.run("form.set", `${formId} bookmark feature`)).status).toBe("executed")
  expect((await controller.commands.run("form.submit", formId)).status).toBe("executed")
  expect(calls.filter(call => call.method === "POST" && call.path === `/api/repos/${REPO}/workspaces`)).toEqual([
    { method: "POST", path: `/api/repos/${REPO}/workspaces`, body: { source_bookmark: "feature" } }
  ])
  expect(store.session().activeRepoKey).toBe(`${REPO}#workspace:${BOX_A}`)
  expect(inboxRequests(store)).toEqual([])
  expect([...store.collections.cards.values()].filter(card => card.kind === "run-list")).toEqual([])
  expect([...store.collections.cards.values()].filter(card => card.kind === "run-trace")).toEqual([])
  expect(store.collections.cards.get("form-box.open")?.status).toBe("active")
  expect(calls.filter(call => call.path.startsWith("/api/workflow/") || call.path.includes("/approvals"))).toEqual([])
  expect((await controller.commands.run("form.submit", formId)).status).toBe("failed")
  expect(calls.filter(call => call.method === "POST" && call.path === `/api/repos/${REPO}/workspaces`)).toHaveLength(1)
  await controller.dispose()
})

test("fresh-box Review a PR retains its act across reload and admits it only once on the created box", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null }).isPersisted.promise
  await store.dispatch({ type: "workspaces.loaded", actor: "system", repoId: REPO, workspaces: [] }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: REPO, org: "will", ownerKind: "user", name: "flows", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: REPO }).isPersisted.promise
  const calls: string[] = []
  const services = { toastDebounceMs: 0, workflowPollMs: 1, fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "https://app.test").pathname
    const method = init?.method ?? "GET"
    calls.push(`${method} ${path}`)
    if (method === "POST" && path === `/api/repos/${REPO}/workspaces`) return json(201, {
      id: BOX_A, repository_id: 7, repo_full_name: REPO, name: "review", slug: "review", target_bookmark: "main",
      status: "running", provisioning_stage: null, suspended_at: null, created_at: "2026-09-01T00:00:00Z"
    })
    if (path.endsWith("/bookmarks")) return json(200, { items: [], next_cursor: "" })
    if (path.endsWith("/workspace/sessions")) return json(200, [])
    if (path === `/api/repos/${REPO}`) return json(200, { full_name: REPO, github_source: { owner: "upstream", repo: "project" } })
    if (path === "/api/user/github-repos/upstream/project/pulls/17") return json(200,
      { number: 17, title: "Upstream PR", body: "Review", state: "open", user: { login: "writer" } })
    if (path === "/api/user/github-repos/upstream/project/pulls/17/diff") return new Response("diff --git a/a b/a\n+new code\n", { status: 200 })
    if (path.startsWith("/api/workflow/") && path.endsWith("/provision")) return json(200, { status: "ready", repo: REPO, gatewayId: "gateway" })
    return json(503, { code: "unavailable", message: "test gateway stopped after admission" })
  } }
  const controller = createAppController(store, silentAgent, services)
  expect((await controller.commands.run("prs.triage", `17 ${REPO}`)).status).toBe("executed")
  const form = [...store.collections.cards.values()].find(card => card.kind === "flow-form" && card.payload.afterBox?.kind === "prs.triage")
  expect(form?.kind).toBe("flow-form")
  if (form?.kind !== "flow-form") throw Error("Review prerequisite form missing")
  expect(form.payload.afterBox).toMatchObject({ repo: REPO, kind: "prs.triage", number: 17, owner: "will" })
  expect(calls.filter(call => call.includes("pulls/17") || call.startsWith("POST "))).toEqual([])
  expect((await controller.commands.run("form.submit", form.id)).status).toBe("executed")
  expect(store.collections.cards.get(form.id)).toMatchObject({ status: "acted", payload: { afterBox: { workspaceId: BOX_A } } })
  expect(calls.filter(call => call.includes("pulls/17"))).toEqual([])
  await controller.dispose()
  await store.dispose?.()

  const restored = await createAppStore({ kind: "localStorage", storage })
  const resumed = createAppController(restored, silentAgent, services)
  expect(restored.collections.cards.get(form.id)).toMatchObject({ payload: { afterBox: { workspaceId: BOX_A } } })
  expect((await resumed.commands.runForAgent("form.submit", form.id)).status).toBe("failed")
  await restored.dispatch({ type: "repo.selected", actor: "user", id: REPO }).isPersisted.promise
  expect((await resumed.commands.run("form.submit", form.id)).status).toBe("failed")
  await restored.dispatch({ type: "repo.selected", actor: "user", id: `${REPO}#workspace:${BOX_A}` }).isPersisted.promise
  await loadBox(restored, REPO, BOX_A, "starting")
  expect((await resumed.commands.run("form.submit", form.id)).status).toBe("failed")
  expect(calls.filter(call => call.includes("pulls/17"))).toEqual([])
  expect(restored.collections.cards.get(form.id)).not.toMatchObject({ payload: { afterBox: { consumed: true } } })
  await loadBox(restored, REPO, BOX_A, "running")
  const concurrent = await Promise.all([resumed.commands.run("form.submit", form.id), resumed.commands.run("form.submit", form.id)])
  expect(concurrent.map(outcome => outcome.status).sort()).toEqual(["executed", "failed"])
  await waitFor(() => calls.some(call => call.includes("pulls/17/diff")))
  await waitFor(() => [...restored.collections.cards.values()].some(card => card.kind === "run-trace" && card.payload.workflow === "pr-triage"))
  expect(calls.filter(call => call.includes("pulls/17"))).toEqual([
    "GET /api/user/github-repos/upstream/project/pulls/17",
    "GET /api/user/github-repos/upstream/project/pulls/17/diff"
  ])
  expect(restored.collections.cards.get(form.id)).toMatchObject({ payload: { afterBox: { consumed: true } } })
  expect((await resumed.commands.run("form.submit", form.id)).status).toBe("failed")
  expect(calls.filter(call => call.includes("pulls/17"))).toHaveLength(2)
  expect([...restored.collections.cards.values()].filter(card => card.kind === "run-trace" && card.payload.workflow === "pr-triage")).toHaveLength(1)
  expect(calls.filter(call => call === `POST /api/repos/${REPO}/workspaces`)).toHaveLength(1)
  await resumed.dispose()
  await restored.dispose?.()
})

test("a refused retained PR review stays visible and consumed instead of offering a duplicate launch", async () => {
  const store = await signedIn()
  await loadBox(store, REPO, BOX_A)
  await store.dispatch({ type: "repo.selected", actor: "user", id: `${REPO}#workspace:${BOX_A}` }).isPersisted.promise
  const formId = "form-box.open-pr-review"
  await store.dispatch({ type: "card.upsert", actor: "user", card: {
    id: formId, kind: "flow-form", title: "Open a box to review pull request #17", status: "acted", createdAt: 1, ordinal: 1,
    payload: { flow: "box.open", via: "user", fields: [], draft: { repo: REPO }, given: { repo: REPO },
      afterBox: { kind: "prs.triage", repo: REPO, number: 17, owner: "will", workspaceId: BOX_A } }
  } }).isPersisted.promise
  const calls: string[] = []
  const controller = createAppController(store, silentAgent, { fetchImpl: async (input: RequestInfo | URL) => {
    calls.push(new URL(String(input), "https://app.test").pathname)
    return json(503, { code: "unavailable", message: "PR source unavailable" })
  } })
  expect((await controller.commands.run("form.submit", formId)).status).toBe("failed")
  expect(store.collections.cards.get(formId)).toMatchObject({ status: "acted", payload: {
    afterBox: { consumed: true }, errorKind: "run" } })
  expect((await controller.commands.run("form.submit", formId)).status).toBe("failed")
  expect(calls.filter(path => path === `/api/repos/${REPO}`)).toHaveLength(1)
  await controller.dispose()
  await store.dispose?.()
})

test("a recorded run list without a box binding keeps its bound refusal", async () => {
  const store = await signedIn()
  await store.dispatch({ type: "card.upsert", actor: "system", card: {
    id: "recorded-runs", kind: "run-list", title: "Recorded runs", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: REPO, gatewayBindingVersion: 1, runs: [], statuses: [] }
  } }).isPersisted.promise
  const relay = boxCalls()
  const controller = createAppController(store, silentAgent, relay.services)
  const result = await controller.commands.run("runs.list", `sourceCard=recorded-runs ${REPO}`)
  expect(result.status).toBe("failed")
  if (result.status === "failed") expect(result.error).toContain("This list's box is gone")
  expect(store.collections.cards.get("form-box.open-runs.list")).toBeUndefined()
  expect(relay.calls).toEqual([])
  await controller.dispose()
})

for (const [flow, args] of [
  ["flow.create", `Create a lint flow ${REPO}`],
  ["triggers.register", `${REPO} --flow checks/fast`]
] as const) test(`${flow} keeps the agent on the refusal path`, async () => {
  const store = await signedIn()
  await loadBox(store, REPO, BOX_A)
  await loadBox(store, REPO, BOX_B)
  const relay = boxCalls()
  const controller = createAppController(store, silentAgent, relay.services)
  const outcome = await controller.commands.runForAgent(flow, args)
  expect(outcome.status).toBe("failed")
  if (outcome.status === "failed") expect(outcome.error).toContain(`Select a box of ${REPO}`)
  expect(pickForm(store)).toBeUndefined()
  expect(relay.calls).toEqual([])
  await controller.dispose()
})

for (const flow of ["triggers.run", "triggers.resume"] as const) test(`${flow} agent confirmation never opens a human box chooser`, async () => {
  const store = await signedIn()
  await loadBox(store, REPO, BOX_A)
  await loadBox(store, REPO, BOX_B)
  const relay = boxCalls()
  const controller = createAppController(store, silentAgent, relay.services)
  expect((await controller.commands.runForAgent(flow, `daily ${REPO}`)).status).toBe("executed")
  expect(pickForm(store)).toBeUndefined()
  expect(relay.calls).toEqual([])
  await controller.dispose()
})

test("flow authoring with no box opens the prerequisite form before creating a run", async () => {
  const store = await signedIn()
  const relay = boxCalls()
  const controller = createAppController(store, silentAgent, relay.services)
  expect((await controller.commands.run("flow.create", `Review the repo ${REPO}`)).status).toBe("executed")
  expect(store.collections.cards.get("form-box.open")).toMatchObject({ kind: "flow-form", payload: { draft: { repo: REPO } } })
  expect([...store.collections.cards.values()].filter(card => card.kind === "run-trace")).toEqual([])
  expect(relay.calls).toEqual([])
  await controller.dispose()
})

for (const act of [
  { flow: "approvals.list", label: "Inbox" },
  { flow: "runs.list", label: "Runs" }
] as const) test(`${act.label} with no box offers a typed open form and no implicit read`, async () => {
  const store = await signedIn()
  const relay = boxCalls()
  const controller = createAppController(store, silentAgent, relay.services)
  const outcome = await controller.commands.run(act.flow, REPO)
  const formId = `form-box.open-${act.flow}`
  expect(outcome).toEqual({ status: "executed", value: `Open a box for ${REPO}, then retry ${act.label} once it is ready.` })
  expect(store.collections.cards.get(formId)).toMatchObject({ kind: "flow-form",
    title: `Open a box for ${REPO}, then retry ${act.label} once it is ready`,
    payload: { flow: "box.open", via: "user", draft: { repo: REPO } } })
  expect(store.session().activeRepoKey).toBe(REPO)
  expect(inboxRequests(store)).toEqual([])
  expect([...store.collections.cards.values()].filter(card => card.kind === "run-list")).toEqual([])
  expect(relay.calls).toEqual([])
  expect((await controller.commands.run("card.dismiss", formId)).status).toBe("executed")
  expect(store.collections.cards.get(formId)).toBeUndefined()
  expect(inboxRequests(store)).toEqual([])
  expect(relay.calls).toEqual([])
  await controller.dispose()
})

for (const flow of ["approvals.list", "runs.list"] as const) test(`${flow} agent with no box keeps its refusal`, async () => {
  const store = await signedIn()
  const relay = boxCalls()
  const controller = createAppController(store, silentAgent, relay.services)
  const outcome = await controller.commands.runForAgent(flow, REPO)
  expect(outcome.status).toBe("failed")
  if (outcome.status === "failed") expect(outcome.error).toContain(`Open a box of ${REPO} first`)
  expect(store.collections.cards.get(`form-box.open-${flow}`)).toBeUndefined()
  expect(inboxRequests(store)).toEqual([])
  expect(relay.calls).toEqual([])
  await controller.dispose()
})

test("Inbox sees a starting box as settling, without offering another one", async () => {
  const store = await signedIn()
  await loadBox(store, REPO, BOX_A, "starting")
  const relay = boxCalls()
  const controller = createAppController(store, silentAgent, relay.services)
  const outcome = await controller.commands.run("approvals.list", REPO)
  expect(outcome.status).toBe("failed")
  if (outcome.status === "failed") expect(outcome.error).toBe(`A box of ${REPO} is starting.`)
  expect(store.collections.cards.get("form-box.open-approvals.list")).toBeUndefined()
  expect(relay.calls).toEqual([])
  await controller.dispose()
})

describe("a box-bound act on one branch", () => {
  test("one box needs no pick", async () => {
    const store = await signedIn()
    await loadBox(store, REPO, BOX_A)
    const relay = boxCalls()
    const controller = createAppController(store, silentAgent, relay.services)
    expect(await controller.commands.run("approvals.list", REPO)).toEqual({ status: "executed", value: "Approvals requested." })
    expect(pickForm(store)).toBeUndefined()
    expect(inboxRequests(store).map((request) => request.workspaceId)).toEqual([BOX_A])
  })
})
