import { expect, test } from "bun:test"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { json, loadBox, memoryStorage, settle, silentAgent, TEST_BOX, waitFor } from "./TestFixtures"

const controllerFor = scopedControllers()
const repo = "codeplanesmithers/canary-sandbox"
const id = `workflow-list@${encodeURIComponent(repo)}@${encodeURIComponent(TEST_BOX)}`
const toast = `toast-flow.catalog.${id}`
const ready = () => json(200, { status: "ready", repo, gatewayId: "gateway" })
const catalog = (flowId = "checks/fast") => json(200, { ok: true, payload: { _tag: "flows", items: [{ flowId, description: "Check" }] } })
const failure = () => json(502, { status: "error", code: "upstream_refused", message: "upstream unavailable" })
const deferred = () => {
  let resolve!: (value: Response) => void
  return { promise: new Promise<Response>(yes => { resolve = yes }), resolve: (value: Response) => resolve(value) }
}
async function fixture(options: {
  provision?: () => Promise<Response>; list?: () => Promise<Response>; storage?: ReturnType<typeof memoryStorage>
  boxStatus?: "none" | "running" | "pending" | "failed"
} = {}) {
  const storage = options.storage ?? memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const calls: Array<{ path: string; body: any }> = []
  const services: AppServices = { toastAutoDismissMs: 10_000, workflowPollMs: 1,
    fetchImpl: async (input, init) => {
      const path = new URL(String(input), "https://test.local").pathname
      if (!path.startsWith("/api/workflow/")) return json(404, {})
      const body = JSON.parse(String(init?.body))
      calls.push({ path, body })
      expect(body.workspaceId).toBe(TEST_BOX)
      if (path.endsWith("/provision")) {
        return options.provision?.() ?? ready()
      }
      expect(body).toMatchObject({ procedure: "List", payload: { _tag: "flows" } })
      return options.list?.() ?? catalog()
    } }
  const controller = controllerFor(store, silentAgent, services)
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "codeplanesmithers", ownerKind: "user", name: "canary-sandbox", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "codeplanesmithers", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  if (options.boxStatus !== "none") await loadBox(store, repo, TEST_BOX, options.boxStatus ?? "running")
  await settle(2)
  return { store, storage, controller, calls }
}
const acknowledged = async (promise: Promise<unknown>) => {
  expect(await Promise.race([promise, new Promise(resolve => setTimeout(() => resolve("blocked"), 300))]))
    .toMatchObject({ status: "executed", value: "Flows requested." })
}

test("Flows asks to open a box without entering an empty pane when the selected repository has none", async () => {
  const { controller, store, calls } = await fixture({ boxStatus: "none" })
  try {
    await store.dispatch({ type: "repo.selected", actor: "user", id: repo }).isPersisted.promise
    const outcome = await controller.commands.run("flows")
    expect(outcome.status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.get("form-box.open")).toMatchObject({ kind: "flow-form", payload: {
      flow: "box.open", via: "user", draft: { repo }
    } })
    expect([...store.collections.cards.values()].filter(card => card.kind === "workflow-list")).toEqual([])
    expect(calls).toEqual([])
    await controller.commands.run("flows")
    expect(store.session().surface).toBe("chat")
  } finally { await controller.dispose() }
})

test("a repository flow uses the same box prerequisite instead of a transient refusal", async () => {
  const { controller, store, calls } = await fixture({ boxStatus: "none" })
  try {
    const outcome = await controller.commands.run("flow.run", `checks/fast ${repo}`)
    expect(outcome.status).toBe("executed")
    expect(store.collections.cards.get("form-box.open")).toMatchObject({ kind: "flow-form", payload: {
      flow: "box.open", via: "user", draft: { repo }
    } })
    expect(store.session().surface).toBe("chat")
    expect(calls).toEqual([])
  } finally { await controller.dispose() }
})

test("an explicit unlisted repository stays the box form's repository, not its bookmark", async () => {
  const { controller, store, calls } = await fixture()
  try {
    const other = "someone/else"
    expect((await controller.commands.run("flow.run", `review ${other}`)).status).toBe("executed")
    expect(store.collections.cards.get("form-box.open")).toMatchObject({ kind: "flow-form", payload: {
      flow: "box.open", via: "user", draft: { repo: other }
    } })
    const form = store.collections.cards.get("form-box.open")
    if (form?.kind === "flow-form") expect(form.payload.draft).not.toHaveProperty("bookmark")
    expect(calls).toEqual([])
  } finally { await controller.dispose() }
})

test("background registration launch keeps its refusal and never creates a human box form", async () => {
  const { controller, store, calls } = await fixture({ boxStatus: "none" })
  try {
    expect(await controller.runWorkflow("register-repository", repo, { link: "https://github.com/example/repo" }))
      .toContain("Open a box")
    expect(store.collections.cards.get("form-box.open")).toBeUndefined()
    expect(calls).toEqual([])
  } finally { await controller.dispose() }
})

test("an agent flow.run with no box keeps the refusal and cannot render a human form", async () => {
  const { controller, store, calls } = await fixture({ boxStatus: "none" })
  try {
    const outcome = await controller.commands.runForAgent("flow.run", `checks/fast ${repo}`)
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("Open a box")
    expect(store.collections.cards.get("form-box.open")).toBeUndefined()
    expect(calls).toEqual([])
  } finally { await controller.dispose() }
})

test("explicit plan and change doors offer a box form while direct background calls keep refusals", async () => {
  const { controller, store, calls } = await fixture({ boxStatus: "none" })
  try {
    expect((await controller.commands.run("flow.plan", `checks/fast ${repo}`)).status).toBe("executed")
    expect(store.collections.cards.get("form-box.open")).toMatchObject({ kind: "flow-form", payload: { flow: "box.open", via: "user", draft: { repo } } })
    await store.dispatch({ type: "card.removed", actor: "user", id: "form-box.open" }).isPersisted.promise
    expect((await controller.commands.run("change.request", `Fix the flaky check ${repo}`)).status).toBe("executed")
    expect(store.collections.cards.get("form-box.open")).toMatchObject({ kind: "flow-form", payload: { flow: "box.open", via: "user", draft: { repo } } })
    await store.dispatch({ type: "card.removed", actor: "user", id: "form-box.open" }).isPersisted.promise
    expect(await controller.planFlow("checks/fast", repo)).toContain("Open a box")
    expect(await controller.requestChange("Fix the flaky check", repo)).toContain("Open a box")
    expect(store.collections.cards.get("form-box.open")).toBeUndefined()
    expect(calls).toEqual([])
  } finally { await controller.dispose() }
})

test("agent planning refuses a missing box and change.request waits for human confirmation without a form", async () => {
  const { controller, store } = await fixture({ boxStatus: "none" })
  try {
    const plan = await controller.commands.runForAgent("flow.plan", `checks/fast ${repo}`)
    expect(plan.status).toBe("failed")
    if (plan.status === "failed") expect(plan.error).toContain("Open a box")
    const change = await controller.commands.runForAgent("change.request", `Fix the flaky check ${repo}`)
    expect(change).toMatchObject({ status: "executed", value: expect.stringContaining("asked the user to confirm") })
    expect(store.collections.cards.get("form-box.open")).toBeUndefined()
  } finally { await controller.dispose() }
})

test("Review a PR asks for a box before reading its context, and its agent request only asks for confirmation", async () => {
  const { controller, store, calls } = await fixture({ boxStatus: "none" })
  try {
    expect((await controller.commands.run("prs.triage", `4 ${repo}`)).status).toBe("executed")
    const form = [...store.collections.cards.values()].find(card =>
      card.kind === "flow-form" && card.payload.flow === "box.open" && card.payload.afterBox?.kind === "prs.triage")
    expect(form).toMatchObject({ kind: "flow-form", payload: { flow: "box.open", draft: { repo },
      afterBox: { repo, number: 4 } } })
    if (form === undefined) throw new Error("PR review box form was not rendered")
    await store.dispatch({ type: "card.removed", actor: "user", id: form.id }).isPersisted.promise
    const agent = await controller.commands.runForAgent("prs.triage", `4 ${repo}`)
    expect(agent).toMatchObject({ status: "executed", value: expect.stringContaining("asked the user to confirm") })
    expect([...store.collections.cards.values()].filter(card =>
      card.kind === "flow-form" && card.payload.flow === "box.open")).toEqual([])
    expect(calls).toEqual([])
  } finally { await controller.dispose() }
})

test("Review a PR carries its act through the several-box chooser without reading the PR", async () => {
  const { controller, store, calls } = await fixture()
  try {
    await loadBox(store, repo, "0b0c0d0e-0000-4000-8000-000000000002")
    expect((await controller.commands.run("prs.triage", `4 ${repo}`)).status).toBe("executed")
    const form = store.collections.cards.get("form-box.select")
    expect(form).toMatchObject({ kind: "flow-form", payload: { flow: "box.select",
      given: { repo, flow: "prs.triage", args: `4 ${repo}` } } })
    if (form?.kind !== "flow-form") throw new Error("PR review box picker was not rendered")
    expect(form.payload.draft).toEqual({})
    expect(form.payload.error).toBeUndefined()
    expect(form.payload.fields.find(field => field.name === "workspaceId")?.options?.map(option => option.value))
      .toEqual([TEST_BOX, "0b0c0d0e-0000-4000-8000-000000000002"])
    expect(calls).toEqual([])
  } finally { await controller.dispose() }
})

test("explicit issue flow inspection and launch offer the existing box form", async () => {
  const { controller, store, calls } = await fixture({ boxStatus: "none" })
  try {
    await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "cloud-issue", kind: "issue", title: "A bug", status: "active", createdAt: 1, ordinal: 1,
      payload: { number: 9, repo, title: "A bug", state: "open", author: "ada", issueBody: "Details", labels: [], comments: [] } } }).isPersisted.promise
    for (const name of ["issue.flows", "issue.repro", "issue.poc", "issue.implement"] as const) {
      expect((await controller.commands.run(name, `9 ${repo}`)).status).toBe("executed")
      expect(store.collections.cards.get("form-box.open")).toMatchObject({ kind: "flow-form", payload: { flow: "box.open", draft: { repo } } })
      await store.dispatch({ type: "card.removed", actor: "user", id: "form-box.open" }).isPersisted.promise
    }
    const agent = await controller.commands.runForAgent("issue.repro", `9 ${repo}`)
    expect(agent.status).toBe("failed")
    if (agent.status === "failed") expect(agent.error).toContain("Open a box")
    expect(store.collections.cards.get("form-box.open")).toBeUndefined()
    expect(calls).toEqual([])
  } finally { await controller.dispose() }
})

test("direct issue controller calls keep no-box refusal semantics and create no human form", async () => {
  const { controller, store } = await fixture({ boxStatus: "none" })
  try {
    await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "cloud-issue", kind: "issue", title: "A bug", status: "active", createdAt: 1, ordinal: 1,
      payload: { number: 9, repo, title: "A bug", state: "open", author: "ada", issueBody: "Details", labels: [], comments: [] } } }).isPersisted.promise
    for (const result of [
      await controller.inspectIssueFlows(9, repo),
      await controller.runIssueFlow("repro", 9, repo),
      await controller.runIssueImplementation(9, repo)
    ]) expect(result).toContain("Open a box")
    expect(store.collections.cards.get("form-box.open")).toBeUndefined()
  } finally { await controller.dispose() }
})

test("Fix an issue app asks for a box before fetching an issue when no issue card is open", async () => {
  const { controller, store, calls } = await fixture({ boxStatus: "none" })
  try {
    expect((await controller.commands.run("issue.implement", `9 ${repo}`)).status).toBe("executed")
    expect(store.collections.cards.get("form-box.open")).toMatchObject({ kind: "flow-form", payload: { flow: "box.open", draft: { repo } } })
    expect(calls).toEqual([])
  } finally { await controller.dispose() }
})

test("issue flow chooser retains the issue command, while an agent gets no human form", async () => {
  const { controller, store, calls } = await fixture()
  const second = "0b0c0d0e-0000-4000-8000-000000000002"
  try {
    await loadBox(store, repo, second)
    await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "cloud-issue", kind: "issue", title: "A bug", status: "active", createdAt: 1, ordinal: 1,
      payload: { number: 9, repo, title: "A bug", state: "open", author: "ada", issueBody: "Details", labels: [], comments: [] } } }).isPersisted.promise
    for (const name of ["issue.flows", "issue.repro", "issue.poc", "issue.implement"] as const) {
      expect((await controller.commands.run(name, `9 ${repo}`)).status).toBe("executed")
      expect(store.collections.cards.get("form-box.select")).toMatchObject({ kind: "flow-form", payload: { given: { repo, flow: name, args: `9 ${repo}` } } })
      await store.dispatch({ type: "card.removed", actor: "user", id: "form-box.select" }).isPersisted.promise
    }
    for (const name of ["issue.flows", "issue.repro"] as const) {
      const agent = await controller.commands.runForAgent(name, `9 ${repo}`)
      expect(agent.status).toBe("failed")
      if (agent.status === "failed") expect(agent.error).toContain("Select a box")
    }
    expect(store.collections.cards.get("form-box.select")).toBeUndefined()
    expect(calls).toEqual([])
  } finally { await controller.dispose() }
})

test("plan and change keep their original act in the several-box chooser", async () => {
  const { controller, store, calls } = await fixture()
  const second = "0b0c0d0e-0000-4000-8000-000000000002"
  try {
    await loadBox(store, repo, second)
    expect((await controller.commands.run("flow.plan", `checks/fast ${repo}`)).status).toBe("executed")
    expect(store.collections.cards.get("form-box.select")).toMatchObject({ kind: "flow-form", payload: { given: { repo, flow: "flow.plan", args: `checks/fast ${repo}` } } })
    expect((await controller.commands.run("change.request", `Fix the flaky check from:topic ${repo}`)).status).toBe("executed")
    expect(store.collections.cards.get("form-box.select")).toMatchObject({ kind: "flow-form", payload: { given: { repo, flow: "change.request", args: `Fix the flaky check from:topic ${repo}` } } })
    expect(calls).toEqual([])
  } finally { await controller.dispose() }
})

test("Flows offers the existing box chooser when several boxes could answer", async () => {
  const { controller, store, calls } = await fixture()
  const second = "0b0c0d0e-0000-4000-8000-000000000002"
  try {
    await loadBox(store, repo, second)
    const outcome = await controller.commands.run("flows")
    expect(outcome.status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    const form = store.collections.cards.get("form-box.select")
    expect(form).toMatchObject({ kind: "flow-form", payload: { flow: "box.select", given: { repo, flow: "flows" } } })
    if (form?.kind !== "flow-form") throw new Error("Box chooser was not rendered")
    expect(form.payload.fields.find(field => field.name === "workspaceId")?.options?.map(option => option.value)).toEqual([TEST_BOX, second])
    expect(calls).toEqual([])
    await controller.commands.run("box.select", JSON.stringify({ workspaceId: TEST_BOX, repo, flow: "flows" }))
    expect(store.session().surface).toBe("flows")
    await waitFor(() => calls.length === 2)
  } finally { await controller.dispose() }
})

test("Flows keeps Chat visible while a box is starting", async () => {
  const { controller, store, calls } = await fixture({ boxStatus: "pending" })
  try {
    const outcome = await controller.commands.run("flows")
    expect(outcome.status).toBe("failed")
    expect(store.session().surface).toBe("chat")
    expect([...store.collections.cards.values()].filter(card => card.kind === "workflow-list" || card.kind === "flow-form")).toEqual([])
    expect(calls).toEqual([])
  } finally { await controller.dispose() }
})

test("Flows offers a fresh box when the only recorded box failed", async () => {
  const { controller, store, calls } = await fixture({ boxStatus: "failed" })
  try {
    expect((await controller.commands.run("flows")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.get("form-box.open")).toMatchObject({ kind: "flow-form", payload: { draft: { repo } } })
    expect(calls).toEqual([])
  } finally { await controller.dispose() }
})

test("rapid repeated Flows activation returns to Chat instead of reopening the pane", async () => {
  const { controller, store } = await fixture()
  try {
    const first = controller.commands.run("flows")
    const second = controller.commands.run("flows")
    await Promise.all([first, second])
    expect(store.session().surface).toBe("chat")
  } finally { await controller.dispose() }
})

test("CAP-001: no hover provisioning; activation returns before preparation and catalog, deduplicates, and keeps Chat usable", async () => {
  const provision = deferred(), list = deferred()
  const { controller, store, calls } = await fixture({ provision: () => provision.promise, list: () => list.promise })
  await controller.commands.preload!("flows")
  await controller.commands.preload!("flow.list")
  expect(calls).toHaveLength(0)
  await acknowledged(controller.commands.run("flows"))
  await waitFor(() => calls.length === 1)
  expect(store.collections.cards.get(id)?.loading).toBe(true)
  expect(store.collections.toasts.has(toast)).toBe(false)
  await acknowledged(controller.commands.run("flow.list"))
  expect(calls).toHaveLength(1)
  expect((await controller.commands.run("chat")).status).toBe("executed")
  expect(store.session().surface).toBe("chat")
  await waitFor(() => store.collections.toasts.get(toast)?.status === "running")
  provision.resolve(ready())
  await waitFor(() => calls.length === 2)
  expect(store.collections.toasts.get(toast)?.status).toBe("running")
  expect(store.collections.cards.get(id)?.loading).toBe(true)
  list.resolve(catalog())
  await waitFor(() => store.collections.toasts.get(toast)?.status === "ok")
  expect(store.collections.cards.get(id)).toMatchObject({ loading: false, payload: { workflows: [{ key: "checks/fast" }] } })
  expect(calls.map(call => call.body.procedure).filter(Boolean)).toEqual(["List"])
  expect(store.session().surface).toBe("chat")
})

for (const step of ["provision", "list"] as const) test(`CAP-001: ${step} failure stays visible, survives reload, and retries only on request`, async () => {
  let refused = true
  const { controller, store, storage, calls } = await fixture({
    provision: async () => step === "provision" && refused ? failure() : ready(),
    list: async () => refused ? failure() : catalog()
  })
  await acknowledged(controller.commands.run("flow.list"))
  await waitFor(() => store.collections.toasts.get(toast)?.status === "failed")
  expect(store.collections.cards.get(id)).toMatchObject({ loading: false, status: "error", payload: { catalogRequest: { state: "failed" } } })
  if (step === "provision") expect(calls).toHaveLength(1)
  await store.settled?.()
  await controller.dispose()
  const reloaded = await fixture({ storage })
  await settle(5)
  expect(reloaded.calls).toHaveLength(0)
  expect(reloaded.store.collections.cards.get(id)?.status).toBe("error")
  refused = false
  await acknowledged(reloaded.controller.commands.run("flow.list", `sourceCard=${id}`))
  await waitFor(() => reloaded.store.collections.cards.get(id)?.status === "active" && !reloaded.store.collections.cards.get(id)?.loading)
  expect(reloaded.calls.map(call => call.body.procedure).filter(Boolean)).toEqual(["List"])
})

test("pending catalog reconnects after reload and the old completion cannot overwrite it", async () => {
  const oldRead = deferred()
  const first = await fixture({ list: () => oldRead.promise })
  await acknowledged(first.controller.commands.run("flow.list"))
  await waitFor(() => first.calls.length === 2)
  await first.store.settled?.()
  await first.controller.dispose()
  const next = await fixture({ storage: first.storage })
  await waitFor(() => next.calls.length === 2 && next.store.collections.cards.get(id)?.loading === false)
  oldRead.resolve(catalog("stale"))
  await settle(5)
  expect(next.store.collections.cards.get(id)).toMatchObject({ payload: { workflows: [{ key: "checks/fast" }] } })
})

test("an account change fences a pending catalog and never resumes another owner's request", async () => {
  const provision = deferred()
  const { controller, store, calls } = await fixture({ provision: () => provision.promise })
  await acknowledged(controller.commands.run("flow.list"))
  await waitFor(() => calls.length === 1)
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "another-user", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  provision.resolve(ready())
  await settle(5)
  expect(calls).toHaveLength(1)
  expect(store.collections.toasts.get(toast)?.status).not.toBe("ok")
})

test("a later ready workspace clears earlier preparation refusals without hiding the failed catalog card", async () => {
  const waiting = `The workspace for ${repo} is still being prepared. Try again in a moment.`
  let prepared = false
  const { controller, store, calls } = await fixture({ provision: async () => prepared ? ready() : json(503, { code: "workspace_starting", message: waiting }) })
  try {
    await acknowledged(controller.commands.run("flow.list"))
    await waitFor(() => store.collections.toasts.get(toast)?.status === "failed", 10_000)
    expect(store.collections.toasts.get(toast)?.detail).toStartWith("workspace_starting — ")
    const preparationKey = `flow.provision.${repo}.${TEST_BOX}`
    store.dispatch({ type: "toast.shown", actor: "system", key: preparationKey, title: `Preparing your ${repo} box…` })
    store.dispatch({ type: "toast.resolved", actor: "system", key: preparationKey, status: "failed", detail: waiting })
    expect([...store.collections.toasts.values()].filter(entry => entry.status === "failed")).toHaveLength(2)
    prepared = true
    expect(await controller.commands.run("flow.run", `checks/fast ${repo}`)).toMatchObject({ status: "executed" })
    await waitFor(() => calls.filter(call => call.path.endsWith("/provision")).length === 2, 10_000)
    await waitFor(() => store.collections.toasts.get(toast) === undefined, 10_000)
    expect(store.collections.toasts.get(`toast-${preparationKey}`)).toBeUndefined()
    expect(store.collections.cards.get(id)).toMatchObject({ status: "error", payload: { catalogRequest: { state: "failed" } } })
  } finally { await controller.dispose(); await store.dispose?.() }
}, 20_000)
