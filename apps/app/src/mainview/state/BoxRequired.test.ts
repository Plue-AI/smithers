/*
 * Every flow call names a box (#2194). The one rule for which box a call on a
 * repository means lives in RepoContext: a recorded run's own box, else the
 * selected box, else the repository's default box. There is no box-less call:
 * with no box to name, the act refuses before anything reaches the network,
 * says which box to open or pick, and Chat stays usable.
 */
import { describe, expect, test } from "bun:test"
import type { Card } from "./AppState"
import { createAppStore, type AppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { defaultBoxBinding, gatewayBindingFor, repositoryBoxOf, RUN_BOX_GONE } from "./RepoContext"
import { json, loadBox, memoryStorage, settle, silentAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()

const REPO = "will/flows"
const BOX_A = "0b0c0d0e-0000-4000-8000-00000000000a"
const BOX_B = "0b0c0d0e-0000-4000-8000-00000000000b"

const signedIn = async (): Promise<AppStore> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: REPO, org: "will", ownerKind: "user", name: "flows", head: null }] }).isPersisted.promise
  return store
}

const runCard = (runId: string, workspaceId?: string): Card => ({
  id: `flow-run-${runId}`, kind: "run-trace", title: "review", status: "active", createdAt: 1, ordinal: 1,
  payload: { repo: REPO, runId, workflow: "review", phase: "running", steps: [], result: null, lastSeq: 0,
    ...(workspaceId === undefined ? {} : { workspaceId }) }
})

describe("the repository's default box", () => {
  test("exactly one running box is the answer", async () => {
    const store = await signedIn()
    await loadBox(store, REPO, BOX_A)
    await loadBox(store, "will/other", BOX_B)
    expect(repositoryBoxOf(store, REPO)).toMatchObject({ kind: "box", box: { id: BOX_A } })
    expect(defaultBoxBinding(store, REPO)).toEqual({ workspaceId: BOX_A })
    expect(gatewayBindingFor(store, REPO)).toEqual({ workspaceId: BOX_A })
  })

  test("several running boxes ask for a selection", async () => {
    const store = await signedIn()
    await loadBox(store, REPO, BOX_A)
    await loadBox(store, REPO, BOX_B)
    const binding = gatewayBindingFor(store, REPO)
    expect(binding).toMatchObject({ error: `Select a box of ${REPO} first.` })
    // The refusal carries the boxes to pick from (controller/boxChoice.ts).
    expect("error" in binding ? binding.choices?.map((box) => box.id) : undefined).toEqual([BOX_A, BOX_B])
  })

  test("with none running, the one suspended or stopped box is the answer, as a selected one is: provisioning resumes it", async () => {
    for (const status of ["suspended", "stopped"] as const) {
      const store = await signedIn()
      await loadBox(store, REPO, BOX_A, status)
      expect(gatewayBindingFor(store, REPO)).toEqual({ workspaceId: BOX_A })
      await store.dispatch({ type: "repo.selected", actor: "user", id: `${REPO}#workspace:${BOX_A}` }).isPersisted.promise
      expect(gatewayBindingFor(store, REPO)).toEqual({ workspaceId: BOX_A })
    }
  })

  test("several suspended or stopped boxes ask for a selection", async () => {
    const store = await signedIn()
    await loadBox(store, REPO, BOX_A, "suspended")
    await loadBox(store, REPO, BOX_B, "stopped")
    const binding = gatewayBindingFor(store, REPO)
    expect(binding).toMatchObject({ error: `Select a box of ${REPO} first.` })
    expect("error" in binding ? binding.choices?.map((box) => box.id) : undefined).toEqual([BOX_A, BOX_B])
  })

  test("a box still starting says so", async () => {
    for (const status of ["pending", "starting"] as const) {
      const store = await signedIn()
      await loadBox(store, REPO, BOX_A, status)
      expect(gatewayBindingFor(store, REPO)).toEqual({ error: `A box of ${REPO} is starting.` })
    }
  })

  test("no box asks for one to be opened; a failed box is no box", async () => {
    const store = await signedIn()
    expect(gatewayBindingFor(store, REPO)).toEqual({ error: `Open a box of ${REPO} first: /box.open ${REPO}`, noBox: true })
    await loadBox(store, REPO, BOX_A, "failed")
    expect(gatewayBindingFor(store, REPO)).toEqual({ error: `Open a box of ${REPO} first: /box.open ${REPO}`, noBox: true })
  })

  test("the selected box wins over the default, whatever its state", async () => {
    const store = await signedIn()
    await loadBox(store, REPO, BOX_A)
    await loadBox(store, REPO, BOX_B, "suspended")
    await store.dispatch({ type: "repo.selected", actor: "user", id: `${REPO}#workspace:${BOX_B}` }).isPersisted.promise
    expect(gatewayBindingFor(store, REPO)).toEqual({ workspaceId: BOX_B })
  })
})

describe("a recorded run's box", () => {
  test("a recorded run is addressed on its own box, not the selection", async () => {
    const store = await signedIn()
    await loadBox(store, REPO, BOX_A)
    await store.dispatch({ type: "card.upsert", actor: "system", card: runCard("run-1", BOX_B) }).isPersisted.promise
    expect(gatewayBindingFor(store, REPO, "run-1")).toEqual({ workspaceId: BOX_B })
  })

  test("a run recorded with no box refuses, even while the repository has a box", async () => {
    const store = await signedIn()
    await loadBox(store, REPO, BOX_A)
    await store.dispatch({ type: "card.upsert", actor: "system", card: runCard("run-old") }).isPersisted.promise
    expect(gatewayBindingFor(store, REPO, "run-old")).toEqual({ error: RUN_BOX_GONE })
  })

  test("resuming a box-less recorded run calls nothing and says the box is gone", async () => {
    const store = await signedIn()
    await loadBox(store, REPO, BOX_A)
    await store.dispatch({ type: "card.upsert", actor: "system", card: runCard("run-old") }).isPersisted.promise
    const calls: string[] = []
    const controller = createAppController(store, silentAgent, { fetchImpl: async (input) => { calls.push(String(input)); return json(404, {}) } })
    const outcome = await controller.commands.run("runs.resume", "run-old")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe(RUN_BOX_GONE)
    expect(calls.filter((url) => url.includes("/api/workflow/"))).toEqual([])
  })
})

describe("a flow launch with no box", () => {
  test("asks for a box before any call, keeps Chat usable, and launches once a box is open", async () => {
    const store = await signedIn()
    const workflowCalls: Array<{ path: string; body: Record<string, unknown> }> = []
    let turns = 0
    const controller = createAppController(store, { ...silentAgent, startTurn: async () => { turns += 1; return { status: "started" } } }, {
      toastDebounceMs: 0,
      toastAutoDismissMs: 60_000,
      workflowPollMs: 5,
      fetchImpl: async (input, init) => {
        const path = new URL(String(input), "https://app.test").pathname
        if (path.startsWith("/api/workflow/")) {
          workflowCalls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> })
          return new Promise<Response>(() => {})
        }
        return json(404, { status: "error" })
      }
    })
    const refusal = `Open a box of ${REPO} first: /box.open ${REPO}`
    // The button door: the box form for this repository, and no failure toast.
    controller.runCommand("flow.run", `review ${REPO}`)
    await waitFor(() => store.collections.cards.get("form-box.open") !== undefined)
    const form = store.collections.cards.get("form-box.open")
    expect(form).toMatchObject({ kind: "flow-form", payload: { flow: "box.open", via: "user" } })
    if (form?.kind === "flow-form") expect(form.payload.draft).toEqual({ repo: REPO })
    expect([...store.collections.toasts.values()].filter((toast) => toast.status === "failed")).toEqual([])
    expect(workflowCalls).toEqual([])
    expect([...store.collections.cards.values()].filter((card) => card.kind === "run-trace")).toEqual([])
    // The slash door renders the same form.
    const outcome = await controller.commands.run("flow.run", `review ${REPO}`)
    expect(outcome).toMatchObject({ status: "executed", value: expect.stringContaining("rendered a form for") })
    // The agent door keeps the refusal sentence.
    const agent = await controller.commands.runForAgent("flow.run", `review ${REPO}`)
    expect(agent.status).toBe("failed")
    if (agent.status === "failed") expect(agent.error).toBe(refusal)
    expect(workflowCalls).toEqual([])
    // Chat is untouched.
    controller.send("what should I do?")
    await settle()
    expect(turns).toBe(1)
    expect(store.session().phase).not.toBe("busy")
    // Retry after opening the box: the request is acknowledged at once and names the box.
    await loadBox(store, REPO, BOX_A)
    const retried = await controller.commands.run("flow.run", `review ${REPO}`)
    expect(retried.status).toBe("executed")
    await waitFor(() => workflowCalls.length > 0)
    expect(workflowCalls[0]).toMatchObject({ path: "/api/workflow/provision", body: { repo: REPO, workspaceId: BOX_A } })
    // The provision is held open: the new request's toast is still running, not settled.
    await waitFor(() => [...store.collections.toasts.values()].some((entry) => entry.status === "running"))
    expect([...store.collections.toasts.values()].filter((entry) => entry.status === "running").length).toBeGreaterThan(0)
  })
})

describe("a request saved with no box", () => {
  const REQUEST_CARD = "flow-request-old"
  const gone = "This request's box is gone."
  const storedRequest = (): Card => ({
    id: REQUEST_CARD, kind: "run-trace", title: `review · ${REPO}`, status: "error", createdAt: 1, ordinal: 1,
    payload: { repo: REPO, workflow: "review", runId: "pending-old", phase: "failed", error: gone, steps: [], result: null, lastSeq: 0,
      input: { _workflowLaunch: { version: 1, id: "old", owner: "will", repo: REPO, workflow: "review", input: {},
        error: { stage: "preparation", code: "box_gone", message: gone } } } }
  })

  test("Retry binds the box a new request would name, and says which box to open while there is none", async () => {
    const store = await signedIn()
    await store.dispatch({ type: "card.upsert", actor: "system", card: storedRequest() }).isPersisted.promise
    const workflowCalls: Array<{ path: string; body: Record<string, unknown> }> = []
    const controller = createAppController(store, silentAgent, {
      toastDebounceMs: 0,
      toastAutoDismissMs: 60_000,
      workflowPollMs: 5,
      fetchImpl: async (input, init) => {
        const path = new URL(String(input), "https://app.test").pathname
        if (path.startsWith("/api/workflow/")) {
          workflowCalls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> })
          return new Promise<Response>(() => {})
        }
        return json(404, { status: "error" })
      }
    })
    const refusal = `Open a box of ${REPO} first: /box.open ${REPO}`
    expect((await controller.commands.run("flow.run.retry", REQUEST_CARD)).status).toBe("executed")
    await waitFor(() => {
      const card = store.collections.cards.get(REQUEST_CARD)
      return card?.kind === "run-trace" && card.payload.error === refusal
    })
    expect(workflowCalls).toEqual([])
    // Once a box is open, Retry launches on it.
    await loadBox(store, REPO, BOX_A)
    expect((await controller.commands.run("flow.run.retry", REQUEST_CARD)).status).toBe("executed")
    await waitFor(() => workflowCalls.length > 0)
    expect(workflowCalls[0]).toMatchObject({ path: "/api/workflow/provision", body: { repo: REPO, workspaceId: BOX_A } })
    expect(store.collections.cards.get(REQUEST_CARD)).toMatchObject({ payload: { workspaceId: BOX_A, phase: "launching" } })
  })
})
