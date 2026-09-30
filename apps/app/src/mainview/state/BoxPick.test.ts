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
import { formRenderedText } from "./controller/forms"
import { json, loadBox, memoryStorage, silentAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()

const REPO = "will/flows"
const BOX_A = "0b0c0d0e-0000-4000-8000-00000000000a"
const BOX_B = "0b0c0d0e-0000-4000-8000-00000000000b"
const BOX_OTHER = "0b0c0d0e-0000-4000-8000-00000000000c"
const BOX_ELSEWHERE = "0b0c0d0e-0000-4000-8000-00000000000d"
const FORM = "form-box.select"

const signedIn = async (): Promise<AppStore> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: REPO, org: "will", ownerKind: "user", name: "flows", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: REPO }).isPersisted.promise
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
type Controller = ReturnType<typeof createAppController>

const unboundActs: ReadonlyArray<{ name: string; flow: string; args: string; invoke: (controller: Controller) => Promise<unknown> }> = [
  { name: "flow authoring", flow: "flow.create", args: JSON.stringify({ description: "Compare owner/other with today", repo: REPO }),
    invoke: controller => controller.commands.run("flow.create", `Compare owner/other with today ${REPO}`) },
  { name: "prototype onboarding", flow: "feature.prototype", args: JSON.stringify({ request: "Inspect owner/other first", repo: REPO }),
    invoke: controller => controller.commands.run("feature.prototype", `Inspect owner/other first ${REPO}`) },
  { name: "trigger registration", flow: "triggers.register", args: JSON.stringify({ repo: REPO, flow: "checks/fast", slug: "daily",
    schedule: "0 9 * * *", input: '{"severity":"high"}', tokens: "1000", minutes: "5" }),
    invoke: controller => controller.registerTrigger({ operation: "register", repo: REPO, flow: "checks/fast", slug: "daily",
      schedule: "0 9 * * *", input: '{"severity":"high"}', tokens: "1000", minutes: "5" }) },
  { name: "trigger launch", flow: "triggers.run", args: `daily ${REPO}`,
    invoke: controller => controller.registerTrigger({ operation: "run", repo: REPO, slug: "daily" }) },
  { name: "trigger resume", flow: "triggers.resume", args: `daily ${REPO}`,
    invoke: controller => controller.registerTrigger({ operation: "resume", repo: REPO, slug: "daily" }) }
]

for (const act of unboundActs) test(`${act.name} opens the same box pick before it mutates or calls a box`, async () => {
  const store = await signedIn()
  await loadBox(store, REPO, BOX_A)
  await loadBox(store, REPO, BOX_B)
  const relay = boxCalls()
  const controller = createAppController(store, silentAgent, relay.services)
  await act.invoke(controller)
  expect(pickForm(store)?.payload.given).toMatchObject({ repo: REPO, flow: act.flow, args: act.args })
  expect(pickForm(store)?.payload.fields[0]?.options?.map(option => option.value)).toEqual([BOX_A, BOX_B])
  expect(store.session().activeRepoKey).toBe(REPO)
  expect(relay.calls).toEqual([])
  expect([...store.collections.cards.values()].filter(card => card.kind === "run-trace")).toEqual([])
  await controller.dispose()
})

for (const act of [
  { name: "flow.run", args: `checks/fast ${REPO}` },
  { name: "issue.implement", args: `9 ${REPO}` }
] as const) for (const door of ["slash", "keyboard"] as const) test(`${act.name} ${door} door reaches the same chooser before work`, async () => {
  const store = await signedIn()
  await loadBox(store, REPO, BOX_A)
  await loadBox(store, REPO, BOX_B)
  const relay = boxCalls()
  const controller = createAppController(store, silentAgent, relay.services)
  const result = door === "slash"
    ? await controller.commands.run(act.name, act.args)
    : await controller.runCommandForResult(act.name, act.args)
  expect(result.status).toBe("executed")
  expect(pickForm(store)?.payload.given).toMatchObject({ repo: REPO, flow: act.name, args: act.args })
  expect(store.session().activeRepoKey).toBe(REPO)
  expect(relay.calls).toEqual([])
  await controller.dispose()
})

test("Inbox and Runs keep distinct prerequisite drafts beside a Flow's box form", async () => {
  const store = await signedIn()
  const controller = createAppController(store, silentAgent, boxCalls().services)
  await controller.commands.run("flow.create", `Review the repo ${REPO}`)
  await controller.commands.run("form.set", "form-box.open bookmark feature")
  await controller.commands.run("approvals.list", REPO)
  const flowForm = store.collections.cards.get("form-box.open")
  expect(flowForm?.kind === "flow-form" && flowForm.payload.draft).toEqual({ repo: REPO, bookmark: "feature" })
  await controller.commands.run("form.set", "form-box.open-approvals.list bookmark inbox")
  await controller.commands.run("runs.list", REPO)
  const inboxForm = store.collections.cards.get("form-box.open-approvals.list")
  const runsForm = store.collections.cards.get("form-box.open-runs.list")
  expect(inboxForm?.title).toBe(`Open a box for ${REPO}, then retry Inbox once it is ready`)
  expect(inboxForm?.kind === "flow-form" && inboxForm.payload.draft).toEqual({ repo: REPO, bookmark: "inbox" })
  expect(runsForm?.title).toBe(`Open a box for ${REPO}, then retry Runs once it is ready`)
  expect(runsForm?.kind === "flow-form" && runsForm.payload.draft).toEqual({ repo: REPO })
  await controller.dispose()
})

test("a new Inbox repository replaces its own old draft instead of opening the previous repository", async () => {
  const store = await signedIn()
  const controller = createAppController(store, silentAgent, boxCalls().services)
  await controller.commands.run("approvals.list", REPO)
  await controller.commands.run("form.set", "form-box.open-approvals.list bookmark feature")
  await controller.commands.run("approvals.list", "other/repo")
  const form = store.collections.cards.get("form-box.open-approvals.list")
  expect(form?.title).toBe("Open a box for other/repo, then retry Inbox once it is ready")
  expect(form?.kind === "flow-form" && form.payload.draft).toEqual({ repo: "other/repo" })
  await controller.dispose()
})

test("submitting the Inbox prerequisite opens one box and never silently reads Inbox or Runs", async () => {
  const store = await signedIn()
  await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null }).isPersisted.promise
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
  ["feature.prototype", `Prototype the lint flow ${REPO}`],
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

test("trigger registration resumes once on the chosen box after Submit", async () => {
  const store = await signedIn()
  await loadBox(store, REPO, BOX_A)
  await loadBox(store, REPO, BOX_B)
  const relay = boxCalls()
  const controller = createAppController(store, silentAgent, relay.services)
  await controller.registerTrigger({ operation: "register", repo: REPO, flow: "checks/fast", slug: "daily",
    schedule: "0 9 * * *", input: '{"severity":"high"}', tokens: "1000", minutes: "5" })
  expect([...store.collections.cards.values()].filter(card => card.kind === "trigger-list")).toEqual([])
  await controller.commands.run("form.set", `${FORM} workspaceId ${BOX_B}`)
  expect((await controller.commands.run("form.submit", FORM)).status).toBe("executed")
  expect(store.session().activeRepoKey).toBe(`${REPO}#workspace:${BOX_B}`)
  const preparations = [...store.collections.cards.values()].flatMap(card => card.kind === "trigger-list" ? card.payload.preparations ?? [] : [])
  expect(preparations).toHaveLength(1)
  expect(preparations[0]?.workspaceId).toBe(BOX_B)
  expect(preparations[0]?.draft).toMatchObject({ flow: "checks/fast", slug: "daily", schedule: "0 9 * * *",
    input: '{"severity":"high"}', tokens: 1000, minutes: 5 })
  expect((await controller.commands.run("form.submit", FORM)).status).toBe("failed")
  const after = [...store.collections.cards.values()].flatMap(card => card.kind === "trigger-list" ? card.payload.preparations ?? [] : [])
  expect(after).toHaveLength(1)
  await controller.dispose()
})

for (const operation of ["run", "resume"] as const) test(`trigger ${operation} resumes once on the selected box`, async () => {
  const store = await signedIn()
  await loadBox(store, REPO, BOX_A)
  await loadBox(store, REPO, BOX_B)
  const relay = boxCalls()
  const controller = createAppController(store, silentAgent, relay.services)
  await controller.registerTrigger({ operation, repo: REPO, slug: "daily" })
  expect(pickForm(store)?.payload.given).toMatchObject({ repo: REPO, flow: `triggers.${operation}`, args: `daily ${REPO}` })
  expect(relay.calls).toEqual([])
  await controller.commands.run("form.set", `${FORM} workspaceId ${BOX_B}`)
  expect((await controller.commands.run("form.submit", FORM)).status).toBe("executed")
  expect(store.session().activeRepoKey).toBe(`${REPO}#workspace:${BOX_B}`)
  const requests = [...store.collections.cards.values()].filter(card => card.kind === "run-trace" && card.payload.workflow === "repository/trigger")
  expect(requests).toHaveLength(1)
  expect(requests[0]?.payload).toMatchObject({ repo: REPO, workspaceId: BOX_B,
    input: { operation: operation === "run" ? "fire" : "resume", slug: "daily" } })
  expect((await controller.commands.run("form.submit", FORM)).status).toBe("failed")
  expect([...store.collections.cards.values()].filter(card => card.kind === "run-trace" && card.payload.workflow === "repository/trigger")).toHaveLength(1)
  await controller.dispose()
})

test("flow authoring resumes the original prose once on the selected box", async () => {
  const store = await signedIn()
  await loadBox(store, REPO, BOX_A)
  await loadBox(store, REPO, BOX_B)
  const relay = boxCalls()
  const controller = createAppController(store, silentAgent, relay.services)
  const description = "Compare owner/other with today"
  expect((await controller.commands.run("flow.create", `${description} ${REPO}`)).status).toBe("executed")
  expect(pickForm(store)?.payload.given).toMatchObject({ repo: REPO, flow: "flow.create", args: JSON.stringify({ description, repo: REPO }) })
  expect(relay.calls).toEqual([])
  await controller.commands.run("form.set", `${FORM} workspaceId ${BOX_B}`)
  expect((await controller.commands.run("form.submit", FORM)).status).toBe("executed")
  expect(store.session().activeRepoKey).toBe(`${REPO}#workspace:${BOX_B}`)
  const authoring = [...store.collections.cards.values()].filter(card => card.kind === "run-trace" && card.payload.workflow === "create-flow")
  expect(authoring).toHaveLength(1)
  expect(authoring[0]?.payload).toMatchObject({ repo: REPO, workspaceId: BOX_B, input: { args: description } })
  expect((await controller.commands.run("form.submit", FORM)).status).toBe("failed")
  expect([...store.collections.cards.values()].filter(card => card.kind === "run-trace" && card.payload.workflow === "create-flow")).toHaveLength(1)
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

test("an agent with no box gets the prototype refusal without a human form", async () => {
  const store = await signedIn()
  const relay = boxCalls()
  const controller = createAppController(store, silentAgent, relay.services)
  const result = await controller.commands.runForAgent("feature.prototype", `Inspect the repo ${REPO}`)
  expect(result.status).toBe("failed")
  if (result.status === "failed") expect(result.error).toContain(`Open a box of ${REPO}`)
  expect(store.collections.cards.get("form-box.open")).toBeUndefined()
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

describe("a box-bound act with several boxes to mean", () => {
  const cases = [
    { name: "several running boxes", seed: [[BOX_A, "running"], [BOX_B, "running"], [BOX_OTHER, "suspended"]], offered: [BOX_A, BOX_B] },
    { name: "several stopped or suspended boxes", seed: [[BOX_A, "stopped"], [BOX_B, "suspended"]], offered: [BOX_A, BOX_B] }
  ] as const

  for (const scenario of cases) {
    test(`${scenario.name}: the Inbox renders the pick, then runs once on the chosen box`, async () => {
      const store = await signedIn()
      for (const [id, status] of scenario.seed) await loadBox(store, REPO, id, status)
      await loadBox(store, "will/other", BOX_ELSEWHERE)
      const relay = boxCalls()
      const controller = createAppController(store, silentAgent, relay.services)

      const asked = await controller.commands.run("approvals.list", REPO)
      expect(asked).toEqual({ status: "executed", value: formRenderedText(["workspaceId"]) })
      const form = pickForm(store)
      expect(form?.payload.flow).toBe("box.select")
      expect(form?.payload.fields.map((field) => field.name)).toEqual(["workspaceId"])
      expect(form?.payload.fields[0]?.options?.map((option) => option.value)).toEqual([...scenario.offered])
      expect(form?.payload.given).toMatchObject({ repo: REPO, flow: "approvals.list", args: REPO })
      // Nothing ran and nothing was chosen before the pick.
      expect(relay.calls).toEqual([])
      expect(inboxRequests(store)).toEqual([])
      expect(store.session().activeRepoKey).toBe(REPO)

      expect((await controller.commands.run("form.set", `${FORM} workspaceId ${BOX_B}`)).status).toBe("executed")
      expect((await controller.commands.run("form.submit", FORM)).status).toBe("executed")
      expect(store.session().activeRepoKey).toBe(`${REPO}#workspace:${BOX_B}`)
      expect(inboxRequests(store).map((request) => request.workspaceId)).toEqual([BOX_B])
      await waitFor(() => relay.calls.length > 0)
      expect(relay.calls.every((call) => call.body.workspaceId === BOX_B)).toBe(true)
      expect(pickForm(store)?.status).toBe("acted")

      // A second Submit runs nothing more.
      const again = await controller.commands.run("form.submit", FORM)
      expect(again.status).toBe("failed")
      expect(inboxRequests(store)).toHaveLength(1)
    })
  }

  test("a box that is gone by Submit runs nothing and selects nothing", async () => {
    const store = await signedIn()
    await loadBox(store, REPO, BOX_A)
    await loadBox(store, REPO, BOX_B)
    const relay = boxCalls()
    const controller = createAppController(store, silentAgent, relay.services)
    await controller.commands.run("approvals.list", REPO)
    await controller.commands.run("form.set", `${FORM} workspaceId ${BOX_B}`)
    await loadBox(store, REPO, BOX_B, "failed")
    await controller.commands.run("form.submit", FORM)
    expect(pickForm(store)?.payload.error).toBe("That box is no longer available.")
    expect(store.session().activeRepoKey).toBe(REPO)
    expect(inboxRequests(store)).toEqual([])
    expect(relay.calls).toEqual([])
  })

  test("the agent keeps the sentence: which box an act runs on is the human's pick", async () => {
    const store = await signedIn()
    await loadBox(store, REPO, BOX_A)
    await loadBox(store, REPO, BOX_B)
    const relay = boxCalls()
    const controller = createAppController(store, silentAgent, relay.services)
    const outcome = await controller.commands.runForAgent("approvals.list", REPO)
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain(`Select a box of ${REPO} first.`)
    expect(pickForm(store)).toBeUndefined()
    expect(relay.calls).toEqual([])
  })

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
