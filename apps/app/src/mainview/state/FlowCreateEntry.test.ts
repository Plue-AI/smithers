/*
 * L106: `/flow.create` launched a flow no 1.0 composition has ever registered.
 *
 * `create-workflow` was the 0.x JSX workflow `.smithers/workflows/
 * create-workflow.tsx`, deleted with the reconciler architecture in
 * `2716e9855855`. Its six prompt bodies came back the next day as
 * `flows/create-flow/*` — staged, by that commit's own words, as migration-pack
 * inputs — and nothing registered them. The door kept the dead name, so the
 * headline "create a flow from a description" feature refused on every
 * workspace, twice measured on production.
 *
 * Two halves are pinned here, both about what a PERSON gets:
 *   1. the door launches the id the workspace host provisions, read from the
 *      one module both halves import; and
 *   2. a workspace that cannot resolve it is told which flow is missing and
 *      what to do, never the control plane's `No flow "…" is registered on
 *      this workspace.`, which names an internal id and no action.
 *
 * That the id resolves in the registry the coding host really composes is the
 * other half of this seam, proved against that composition in
 * `flows/test/coding-create-flow-registry.test.ts`.
 */
import { expect, test } from "bun:test"
import { FLOW_AUTHORING_ENTRY } from "@smthrs/rpc/FlowAuthoring"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { json, loadBox, memoryStorage, settle, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

const REPO = "codeplanesmithers/canary-sandbox"

/** The control plane's own words for an unresolved flow: an id and no action. */
const controlPlaneRefusal = (flow: string) => `No flow "${flow}" is registered on this workspace.`

const relay = (options: { readonly registered?: boolean } = {}) => {
  const launched: Array<{ flowId: string; input: unknown; repo: string }> = []
  let planned: { flowId: string; input: unknown; repo: string } | undefined
  const services: AppServices = {
    workflowPollMs: 1,
    toastDebounceMs: 0,
    toastAutoDismissMs: 10_000,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const absolute = new URL(url, "https://app.test")
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (absolute.pathname === "/api/workflow/provision") {
        return json(200, { status: "ready", repo: body?.repo, gatewayId: "gw-1" })
      }
      if (absolute.pathname === "/api/workflow/rpc") {
        /* The relay refuses a body that names no box, as the Worker does. */
        if (typeof body?.workspaceId !== "string") return json(400, { status: "error", code: "request_invalid", message: "Body must name a box: workspaceId." })
        const procedure = String(body?.procedure)
        const payload = (body?.payload ?? {}) as { flowId?: unknown; input?: unknown }
        const flowId = String(payload.flowId ?? "")
        if (procedure === "List") {
          return json(200, { ok: true, payload: { _tag: "flows", items: [{ flowId: "coding", description: "" }] } })
        }
        if (procedure === "Plan") {
          /* The host's typed FlowNotFound, in the wire shape production sent. */
          if (options.registered === false) {
            return json(200, {
              ok: false,
              error: {
                message: controlPlaneRefusal(flowId),
                detail: [{ _tag: "Fail", error: { _tag: "/control/FlowNotFound", code: "flow_not_found", flowId } }]
              }
            })
          }
          planned = { flowId, input: payload.input, repo: String(body?.repo) }
          return json(200, {
            ok: true,
            payload: { planId: "plan-1", flowId, digest: "d", envelope: { capabilities: [], flows: [], budget: {} },
              inputSummary: "", deployClass: false, nodes: [] }
          })
        }
        if (procedure === "Run") {
          if (planned !== undefined) launched.push(planned)
          return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: "run-1" } })
        }
        if (procedure === "Approval.Submit") {
          return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" }, resume: { _tag: "Accepted", receiptId: "b" } } })
        }
        if (procedure === "Projection.Snapshot") {
          return json(200, { ok: true, payload: { cursor: { projection: "run-summary", runId: "run-1", value: 1 }, rows: [] } })
        }
        return json(200, { ok: false, error: { message: `no ${procedure}` } })
      }
      return json(404, { status: "error", message: `no stub for ${absolute.pathname}` })
    }
  }
  return { services, launched }
}

const signedInStore = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in",
    login: "codeplanesmithers", admin: false, scopesPlain: null })
  store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{
    id: REPO, org: REPO.split("/")[0] ?? "", ownerKind: "user", name: REPO.split("/")[1] ?? "", head: null
  }] })
  await loadBox(store, REPO)
  await settle(2)
  return store
}

const said = (outcome: { status: string; value?: string; error?: string }): string =>
  outcome.status === "failed" ? (outcome.error ?? "") : (outcome.value ?? "")

/** The durable card `flow.create` mints: where a background refusal is stated and retried. */
const authoringCard = (store: Awaited<ReturnType<typeof createAppStore>>) => {
  const card = [...store.collections.cards.values()].find((entry) => entry.kind === "run-trace" && entry.payload.authoring !== undefined)
  return card?.kind === "run-trace" ? card : undefined
}

/** Wait for a condition rather than a fixed sleep. */
const until = async (done: () => boolean): Promise<void> => {
  for (let tick = 0; tick < 200 && !done(); tick += 1) await settle(1)
  if (!done()) throw new Error("condition never held")
}

test("the flow-authoring door launches the id the workspace host provisions", async () => {
  const store = await signedInStore()
  const double = relay()
  const controller = createAppController(store, silentAgent, double.services)
  try {
    const outcome = await controller.commands.run("flow.create", `summarise my issues ${REPO}`)
    /* The door SAVES the request and answers; the launch rides the background. */
    expect(said(outcome)).toBe(`flow-requested repo=${REPO}`)
    await until(() => double.launched.length > 0)
    expect(double.launched.map(entry => entry.flowId)).toEqual([FLOW_AUTHORING_ENTRY])
    /* A prompt body takes the fixed `{ args }` marker, never a field of the door's choosing. */
    expect(double.launched[0]?.input).toEqual({ args: "summarise my issues" })
    /* The 0.x name, so a regression names itself rather than just failing an equality. */
    expect(double.launched.map(entry => entry.flowId)).not.toContain("create-workflow")
  } finally { await controller.dispose(); await store.dispose?.() }
})

test("a workspace without the authoring flow is told what to do, not handed an internal id", async () => {
  const store = await signedInStore()
  const double = relay({ registered: false })
  const controller = createAppController(store, silentAgent, double.services)
  try {
    await controller.commands.run("flow.create", `summarise my issues ${REPO}`)
    await until(() => authoringCard(store)?.payload.authoring?.launchError !== undefined)
    const answer = authoringCard(store)?.payload.authoring?.launchError ?? ""
    expect(answer).not.toContain(controlPlaneRefusal(FLOW_AUTHORING_ENTRY))
    expect(answer).not.toContain("is registered on this workspace")
    expect(answer).toContain(REPO)
    expect(answer).toContain("flow-authoring flow")
    expect(answer).toContain("/flow.create")
    /* A toast dismisses in four seconds; the durable card is what is still there. */
    expect(authoringCard(store)?.status).toBe("error")
    expect(authoringCard(store)?.payload.observationError).toBe(answer)
  } finally { await controller.dispose(); await store.dispose?.() }
})


test("a flow-authoring form honors its named repository instead of the loaded default", async () => {
  const store = await signedInStore()
  const double = relay()
  const controller = createAppController(store, silentAgent, double.services)
  const target = "codeplanesmithers/other-repository"
  await loadBox(store, target, "0b0c0d0e-0000-4000-8000-000000000002")
  try {
    const outcome = await controller.commands.submit({ name: "flow.create", actor: "user",
      payload: { description: "summarise my issues", repo: target } })
    expect(said(outcome)).toContain(`repo=${target}`)
    await until(() => double.launched.length === 1)
    expect(double.launched[0]).toEqual({ flowId: FLOW_AUTHORING_ENTRY, input: { args: "summarise my issues" }, repo: target })
  } finally { await controller.dispose(); await store.dispose?.() }
})
