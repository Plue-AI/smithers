import { runsArgs } from "../flows/RunsPayload"
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
  await controller.commands.run("flow.new", `Review the repo ${REPO}`)
  await controller.commands.run("runs", runsArgs("approval-list", REPO))
  const formId = "form-box.open-runs"
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

test("review requests host admission without creating a machine or fetching PR code", async () => {
  const store = await signedIn()
  await store.dispatch({ type: "workspaces.loaded", actor: "system", repoId: REPO, workspaces: [] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: REPO }).isPersisted.promise
  const calls: string[] = []
  const controller = createAppController(store, silentAgent, { fetchImpl: async (input: RequestInfo | URL) => {
    calls.push(new URL(String(input), "https://app.test").pathname)
    return json(503, { code: "unavailable", message: "Review unavailable" })
  } })
  expect(await controller.commands.run("review", `17 ${REPO}`)).toEqual({ status: "executed", value: "Requested" })
  await waitFor(() => store.session().reviewRequests?.some(request => request.state === "failed") ?? false)
  expect(calls.filter(path => path === "/api/reviews")).toHaveLength(1)
  expect(await controller.commands.runForAgent("review", `17 ${REPO}`)).toMatchObject({ status: "executed", value: expect.stringContaining("it runs only when they confirm") })
  expect(calls.filter(path => path === "/api/reviews")).toHaveLength(1)
  expect([...store.collections.messages.values()].some(message => message.action?.flow === "review" && message.action.args === `17 ${REPO}`)).toBe(true)
  expect([...store.collections.messages.values()].some(message => message.action?.flow === "prs.triage")).toBe(false)
  expect(calls.filter(path => path.includes("/workspaces") || path.includes("/pulls/") || path.startsWith("/api/workflow/"))).toEqual([])
  expect([...store.collections.cards.values()].filter(card => card.kind === "flow-form" && card.payload.afterBox?.kind === "prs.triage")).toEqual([])
  await controller.dispose()
  await store.dispose?.()
})

test("review host failures remain visible without choosing a box, including after reload", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "workspaces.loaded", actor: "system", repoId: REPO, workspaces: [] }).isPersisted.promise
  const calls: string[] = []
  const services = { fetchImpl: async (input: RequestInfo | URL) => {
    calls.push(new URL(String(input), "https://app.test").pathname)
    return json(503, { code: "unavailable", message: "No review composition" })
  } }
  const check = async (current: AppStore) => {
    const controller = createAppController(current, silentAgent, services)
    expect(await controller.commands.run("review", `17 ${REPO}`)).toEqual({ status: "executed", value: "Requested" })
    const requested = current.session().reviewRequests!.at(-1)!.id
    await waitFor(() => current.session().reviewRequests?.some(request => request.id === requested && request.state === "failed") ?? false)
    expect([...current.collections.cards.values()].filter(card => card.kind === "flow-form" && card.payload.afterBox?.kind === "prs.triage")).toEqual([])
    expect(calls.filter(path => path.includes("pulls/") || path.startsWith("/api/workflow/") || path.endsWith("/workspaces"))).toEqual([])
    await controller.dispose()
  }
  await check(store)
  const restored = await createAppStore({ kind: "localStorage", storage })
  await check(restored)
})

test("a retained PR review uses the canonical admission once and stays consumed after failure", async () => {
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
  expect((await controller.commands.run("form.submit", formId)).status).toBe("executed")
  await waitFor(() => store.session().reviewRequests?.some(request => request.state === "failed") ?? false)
  expect(calls.filter(path => path === "/api/reviews")).toHaveLength(1)
  expect(store.collections.cards.get(formId)).toMatchObject({ status: "acted", payload: {
    flow: "branch", given: { repo: REPO, operation: "workspace-open" }, afterBox: { consumed: true } } })
  expect((await controller.commands.run("form.submit", formId)).status).toBe("failed")
  expect(calls.filter(path => path === "/api/reviews")).toHaveLength(1)
  expect(calls.filter(path => path === `/api/repos/${REPO}`)).toHaveLength(0)
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
  ["flow.new", `Create a lint flow ${REPO}`],
  ["triggers.register", `${REPO} --flow checks/fast`]
] as const) test(`${flow} keeps the agent on the refusal path`, async () => {
  const store = await signedIn()
  await loadBox(store, REPO, BOX_A)
  await loadBox(store, REPO, BOX_B)
  const relay = boxCalls()
  const controller = createAppController(store, silentAgent, relay.services)
  const outcome = await controller.commands.runForAgent(flow, args)
  if (flow === "flow.new") {
    expect(outcome.status).toBe("executed")
    expect("value" in outcome ? outcome.value : "").toContain("asked the user to confirm")
  } else {
    expect(outcome.status).toBe("failed")
  }
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
  expect((await controller.commands.runForAgent(flow, `daily ${REPO}`)).status).toBe("failed")
  expect(pickForm(store)).toBeUndefined()
  expect(relay.calls).toEqual([])
  await controller.dispose()
})

test("flow authoring with no box opens the prerequisite form before creating a run", async () => {
  const store = await signedIn()
  const relay = boxCalls()
  const controller = createAppController(store, silentAgent, relay.services)
  expect((await controller.commands.run("flow.new", `Review the repo ${REPO}`)).status).toBe("executed")
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
  const outcome = await controller.commands.run(act.flow === "approvals.list" ? "runs" : act.flow, act.flow === "approvals.list" ? runsArgs("approval-list", REPO) : REPO)
  const formId = `form-box.open-${act.flow === "approvals.list" ? "runs" : act.flow}`
  expect(outcome).toEqual({ status: "executed", value: `Open a box for ${REPO}, then retry ${act.label} once it is ready.` })
  expect(store.collections.cards.get(formId)).toMatchObject({ kind: "flow-form",
    title: `Open a box for ${REPO}, then retry ${act.label} once it is ready`,
    payload: { flow: "branch", via: "user", draft: { repo: REPO } } })
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
  const outcome = await controller.commands.runForAgent(flow === "approvals.list" ? "runs" : flow, flow === "approvals.list" ? runsArgs("approval-list", REPO) : REPO)
  expect(outcome.status).toBe("failed")
  if (outcome.status === "failed") expect(outcome.error).toContain(`No branch is available for ${REPO}`)
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
  const outcome = await controller.commands.run("runs", runsArgs("approval-list", REPO))
  expect(outcome.status).toBe("failed")
  if (outcome.status === "failed") expect(outcome.error).toBe(`A box of ${REPO} is starting.`)
  expect(store.collections.cards.get("form-box.open-runs")).toBeUndefined()
  expect(relay.calls).toEqual([])
  await controller.dispose()
})

describe("a box-bound act on one branch", () => {
  test("one box needs no pick", async () => {
    const store = await signedIn()
    await loadBox(store, REPO, BOX_A)
    const relay = boxCalls()
    const controller = createAppController(store, silentAgent, relay.services)
    expect(await controller.commands.run("runs", runsArgs("approval-list", REPO))).toEqual({ status: "executed", value: "Approvals requested." })
    expect(pickForm(store)).toBeUndefined()
    expect(inboxRequests(store).map((request) => request.workspaceId)).toEqual([BOX_A])
  })
})
