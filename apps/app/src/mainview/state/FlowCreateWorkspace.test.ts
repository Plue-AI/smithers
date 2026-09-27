/*
 * Walk run 3, defect D3-N1: `/flow.create` provisions the wrong box.
 *
 * The register door names the repository's job workspace (L89,
 * `TriggersSeam.jobWorkspace`); the flow-authoring door named none, so its
 * provision reached the product host and answered `502 upstream_refused`,
 * which the door then read out as the Worker's bare words. Both halves are
 * pinned here: which box the provision asks for, and what a refusal says.
 * That the Worker restates a refusal as prose with its code is pinned in
 * `apps/server/src/index.test.ts`.
 */
import { expect, test } from "bun:test"
import { initialSetup } from "@smthrs/rpc/RepositorySetup"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { json, memoryStorage, settle, silentAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()

const REPO = "codeplanesmithers/canary-sandbox"

/** The durable card `flow.create` mints: where a background refusal is stated and retried. */
const authoringCard = (store: Awaited<ReturnType<typeof createAppStore>>) => {
  const card = [...store.collections.cards.values()].find((entry) => entry.kind === "run-trace" && entry.payload.authoring !== undefined)
  return card?.kind === "run-trace" ? card : undefined
}
const JOB_WORKSPACE = "af1e3bc5-6388-419e-98cc-e13372a89646"

/* What the Worker answers for a refused provision: `refuse("upstream_refused", <the upstream's own prose>)`. */
const UPSTREAM_500 = {
  status: "error",
  code: "upstream_refused",
  message: "internal server error"
}

const relay = (options: { readonly provisionStatus?: number; readonly provision?: () => unknown } = {}) => {
  const calls: Array<{ path: string; method: string; body: { repo?: string; workspaceId?: string } | undefined }> = []
  const services: AppServices = {
    workflowPollMs: 1,
    toastDebounceMs: 0,
    toastAutoDismissMs: 10_000,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const absolute = new URL(url, "https://app.test")
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      calls.push({ path: absolute.pathname, method: init?.method ?? "GET", body })
      if (absolute.pathname === "/api/workflow/provision") {
        return json(options.provisionStatus ?? 200, options.provision?.() ?? { status: "ready", repo: body?.repo, gatewayId: "gw-1", workspaceId: body?.workspaceId })
      }
      if (absolute.pathname === "/api/workflow/rpc") {
        const procedure = String(body?.procedure)
        if (procedure === "List") return json(200, { ok: true, payload: { _tag: "flows", items: [{ flowId: "create-flow", description: "" }] } })
        if (procedure === "Plan") {
          return json(200, { ok: true, payload: { planId: "plan-1", flowId: "create-flow", digest: "d", envelope: { capabilities: [], flows: [], budget: {} }, inputSummary: "", deployClass: false, nodes: [] } })
        }
        if (procedure === "Run") return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: "run-1" } })
        return json(200, { ok: false, error: { message: `no ${procedure}` } })
      }
      return json(404, { status: "error", message: `no stub for ${absolute.pathname}` })
    }
  }
  return { services, calls }
}

const signedInStore = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in",
    login: "codeplanesmithers", allowlisted: true, admin: false, scopesPlain: null })
  store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{
    id: REPO, org: REPO.split("/")[0] ?? "", ownerKind: "user", name: REPO.split("/")[1] ?? "", head: null
  }] })
  /* The job workspace as the repository's own setups recorded it — the register door's only source. */
  await store.dispatch({ type: "card.upsert", actor: "system", card: {
    id: `setup:codeplanesmithers:${encodeURIComponent(REPO)}:feature`, kind: "repository-setup", title: "Build a feature",
    status: "active", createdAt: 1, ordinal: store.nextOrdinal(),
    payload: { ...initialSetup(REPO, "feature", "codeplanesmithers"), workspaceId: JOB_WORKSPACE }
  } }).isPersisted.promise
  await settle(2)
  return store
}

const said = (outcome: { status: string; value?: string; error?: string }): string =>
  outcome.status === "failed" ? (outcome.error ?? "") : (outcome.value ?? "")

test("the flow-authoring door provisions the box the repository's jobs run on", async () => {
  const store = await signedInStore()
  const double = relay()
  const controller = createAppController(store, silentAgent, double.services)
  try {
    await controller.commands.run("flow.create", `summarise my issues ${REPO}`)
    /* The door answers first and provisions in the background (AGENTS.md instant chat). */
    await waitFor(() => double.calls.some(call => call.path === "/api/workflow/rpc"))
    const provisions = double.calls.filter(call => call.path === "/api/workflow/provision")
    expect(provisions).toHaveLength(1)
    expect(provisions[0]?.body).toEqual({ repo: REPO, workspaceId: JOB_WORKSPACE })
    expect(double.calls.filter(call => call.path === "/api/workflow/rpc").every(call => call.body?.workspaceId === JOB_WORKSPACE)).toBe(true)
  } finally { await controller.dispose(); await store.dispose?.() }
})

test("a refused provision reaches the person as its registered refusal, with its fault class", async () => {
  const store = await signedInStore()
  const double = relay({ provisionStatus: 502, provision: () => UPSTREAM_500 })
  const controller = createAppController(store, silentAgent, double.services)
  try {
    expect(said(await controller.commands.run("flow.create", `summarise my issues ${REPO}`))).toBe(`flow-requested repo=${REPO}`)
    /* The refusal stays where the person is looking after the toast goes: the durable card. */
    await waitFor(() => authoringCard(store)?.payload.authoring?.launchError !== undefined)
    expect(authoringCard(store)?.payload.authoring?.launchError)
      .toBe("upstream_refused — internal server error. Something Smithers depends on refused that. Not your doing.")
    expect(authoringCard(store)?.status).toBe("error")
  } finally { await controller.dispose(); await store.dispose?.() }
})

/*
 * Walk W1, item 7 — the "dropped submission", read from its own receipt.
 *
 * With a setup card and a form card both open, one `/flow.create …` added
 * nothing to the transcript over 100 s, and the identical line answered in
 * ~25 s in the next script (W1-c-doors.json vs W1-d-doors.json). The network
 * says what happened: EIGHT `POST /api/workflow/provision 200` at a steady
 * 14.7 s and no rpc at all, from 23:27:59 to 23:29:42 — the door was polling a
 * cold workspace, inside its own 180 s deadline, and the observer stopped
 * watching at 103 s. The next script's provision answered in 0.7 s because
 * that workspace was up by then. Nothing was dropped and the open cards
 * changed nothing; a second sighting of this shape is a slow provision, and
 * the way to tell is the provision count and the absent rpc.
 */
test("a cold workspace keeps the flow-authoring door polling: no rpc, no transcript line, and the preparing notice up", async () => {
  const store = await signedInStore()
  let provisioning = 8
  const double = relay({ provision: () => provisioning-- > 0 ? { status: "provisioning" } : { status: "ready", gatewayId: "gw-1" } })
  const controller = createAppController(store, silentAgent, {
    ...double.services,
    toastDebounceMs: 0
  })
  try {
    /* The two cards the walk had open: neither is on the submission's path. */
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: "card-form-triggers.pause", kind: "status", title: "Pause a schedule",
      status: "active", createdAt: 1, ordinal: store.nextOrdinal(), payload: { progress: 0.5 }
    } }).isPersisted.promise
    const pending = controller.commands.run("flow.create", `print the repository name and the current date ${REPO}`)
    await settle(4)
    /* Mid-flight, exactly what the walk read: nothing said, and nothing planned. */
    expect(double.calls.filter(call => call.path === "/api/workflow/rpc")).toEqual([])
    expect([...store.collections.messages.values()]).toEqual([])
    /* The progress the walk never looked at: a running notice naming the repository. */
    expect([...store.collections.toasts.values()].map(toast => toast.title)).toContain(`Preparing your ${REPO} box…`)
    await pending
    /* The same line, once the workspace is up, reaches the plan the next script saw. */
    await waitFor(() => double.calls.some(call => call.path === "/api/workflow/rpc"), 10_000)
    expect(double.calls.filter(call => call.path === "/api/workflow/provision").length).toBeGreaterThan(1)
    expect(double.calls.filter(call => call.path === "/api/workflow/rpc").map(call => call.body).length).toBeGreaterThan(0)
  } finally { await controller.dispose(); await store.dispose?.() }
})
