/*
 * The authoring canvas grows while the author works.
 *
 * Will asked for "an agent walking you through building a flow in real time".
 * The controller observed the journal only once the authoring run reached a
 * terminal status, so a `create-flow` that wrote the flow in its first minute
 * and kept working for another ten showed nothing until it ended. What a
 * reader can be shown is decided by the journal, not by the summary: a
 * `copy-back-settled` row naming `flows/<id>/flow.*` is a source that exists
 * on the workspace, and it is planned as soon as it lands.
 *
 * The run below NEVER settles — its summary answers `running` for as long as
 * the test asks — so a plan of the authored flow can only be a mid-run plan.
 */
import { expect, test } from "bun:test"
import { FLOW_AUTHORING_ENTRY } from "@smthrs/rpc/FlowAuthoring"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import { scopedControllers } from "../ControllerTestScope"
import { runtimeRunKey } from "../RuntimeProjection"
import { json, loadBox, memoryStorage, settle, silentAgent, waitFor } from "../TestFixtures"

const createAppController = scopedControllers()

const REPO = "codeplanesmithers/smithers-demo"
const AUTHORED = "review"
const RUN = "author-run-1"

/** One engine row in the shape the run-events projection serves it. */
const engineRow = (sequence: number, eventType: string, payload: unknown) => ({
  runId: RUN,
  sequence,
  kind: "control.engine.event",
  occurredAt: 1_000 + sequence,
  payload: {
    version: 1,
    executionId: "author",
    generation: 0,
    sequence,
    eventId: `event-${sequence}`,
    sourceId: "engine",
    sourceSequence: sequence,
    emittedAtMs: sequence,
    eventType,
    payload,
    meta: {}
  }
})

/** The pair that says a flow file reached the workspace: the bundle, then the copy-back. */
const attempt = { runId: "author", stepKeyDigest: "a".repeat(64), attempt: 1, bundleIdentity: "bundle-1" }
const WROTE_THE_FLOW = [
  engineRow(1, "flows.engine.diff-bundle-captured", { ...attempt, changedPaths: [`flows/${AUTHORED}/flow.ts`] }),
  engineRow(2, "flows.engine.copy-back-settled", { ...attempt, rebases: 0, queued: [], dispatched: [] })
]

/** A relay whose authoring run never settles, and whose journal can grow. */
const relay = (options: { readonly events?: ReadonlyArray<unknown> } = {}) => {
  const plans: Array<string> = []
  let events: ReadonlyArray<unknown> = options.events ?? []
  const rows = (projection: string, values: ReadonlyArray<unknown>): Response =>
    json(200, { ok: true, payload: { cursor: { projection, runId: RUN, value: values.length }, rows: values } })
  const procedure = (name: string, payload: Record<string, unknown>): Response => {
    const flowId = String((payload as { flowId?: unknown }).flowId ?? "")
    switch (name) {
      case "List":
        return json(200, { ok: true, payload: { _tag: "flows", items: [{ flowId: FLOW_AUTHORING_ENTRY, description: "" }] } })
      case "Plan":
        plans.push(flowId)
        return json(200, {
          ok: true,
          payload: {
            planId: `plan-${flowId}`,
            flowId,
            digest: "d".repeat(64),
            inputSummary: "{}",
            envelope: { capabilities: [], flows: [], budget: {} },
            deployClass: false,
            nodes: [{
              id: "root",
              kind: "step",
              key: `key1_${"0".repeat(64)}`,
              material: { version: "flows/key-material/v2", kind: "sealed", body: { action: `${flowId}/root` }, inputs: [], layers: [], capabilities: [] },
              effects: { reads: [], writes: [], boundaryMode: "hard" },
              dependsOn: [],
              conflicts: [],
              strategy: "serialize",
              runtime: "delay-rebase",
              priority: 0,
              generation: 0,
              status: "run"
            }],
            graph: { edges: [] },
            approval: {
              target: { _tag: "Plan", planId: `plan-${flowId}`, digest: "d".repeat(64), envelope: { capabilities: [], flows: [], budget: {} } },
              scope: "run",
              idempotencyKey: `approve:plan-${flowId}`
            }
          }
        })
      case "Approval.Submit":
        return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } })
      case "Run":
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: RUN } })
      case "Projection.Snapshot": {
        const selector = (payload.selector ?? {}) as { _tag?: string }
        if (selector._tag === "run-summary") {
          return rows("run-summary", [{
            runId: RUN,
            flowId: FLOW_AUTHORING_ENTRY,
            status: "running",
            createdAt: 1,
            updatedAt: 2,
            turns: 0,
            calls: 0,
            callsFailed: 0,
            editsAttempted: 0,
            editsSucceeded: 0,
            inputTokens: 0,
            outputTokens: 0,
            verdict: "running",
            diagnosis: "Verdict   running."
          }])
        }
        if (selector._tag === "run-events") {
          /* A bounded page AFTER the cursor the reader reached, as the gateway answers it. */
          const after = payload.after as { readonly value?: number } | undefined
          const from = typeof after?.value === "number" ? after.value : 0
          return rows("run-events", events.filter(row => (row as { readonly sequence: number }).sequence > from))
        }
        return rows(String(selector._tag), [])
      }
      default:
        return json(200, { ok: false, error: { message: `no ${name}` } })
    }
  }
  const services: AppServices = {
    workflowPollMs: 1,
    toastDebounceMs: 0,
    toastAutoDismissMs: 10_000,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const absolute = new URL(url, "https://app.test")
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (absolute.pathname.endsWith("/contents/.smithers/factory.json")) return json(404, { status: "error", message: "no projection" })
      if (absolute.pathname === "/api/workflow/provision") return json(200, { status: "ready", repo: body?.repo, gatewayId: "gw-1" })
      if (absolute.pathname === "/api/workflow/rpc") return procedure(String(body.procedure), (body.payload ?? {}) as Record<string, unknown>)
      return json(404, { status: "error", message: `no stub for ${absolute.pathname}` })
    }
  }
  return { services, plans, write: (next: ReadonlyArray<unknown>) => { events = next } }
}

const signedIn = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  store.dispatch({
    type: "identity.session.loaded", actor: "system", state: "signed-in",
    login: "codeplanesmithers", allowlisted: true, admin: false, scopesPlain: null
  })
  store.dispatch({
    type: "repositories.loaded", actor: "system",
    repositories: [{ id: REPO, org: REPO.split("/")[0] ?? "", ownerKind: "user", name: REPO.split("/")[1] ?? "", head: null }]
  })
  await loadBox(store, REPO)
  await settle(2)
  return store
}

const planCards = (store: Awaited<ReturnType<typeof signedIn>>) =>
  [...store.collections.cards.values()].filter(card => card.kind === "flow-plan")

test("a flow file written mid-run is planned before the authoring run settles", async () => {
  const store = await signedIn()
  const served = relay()
  const controller = createAppController(store, silentAgent, served.services)
  try {
    await controller.commands.run("flow.create", `review my pull requests ${REPO}`)
    await waitFor(() => served.plans.includes(FLOW_AUTHORING_ENTRY))
    /* Nothing is planned while the author has written nothing. */
    await settle(5)
    expect(served.plans).not.toContain(AUTHORED)

    /* The next journal page carries the copy-back for `flows/review/flow.ts`. */
    served.write(WROTE_THE_FLOW)
    await waitFor(() => served.plans.includes(AUTHORED))

    /* And the canvas holds its card, while the run is still running. */
    await waitFor(() => planCards(store).some(card => card.kind === "flow-plan" && card.payload.flowId === AUTHORED))
    const authored = planCards(store).find(card => card.kind === "flow-plan" && card.payload.flowId === AUTHORED)
    expect(authored?.kind === "flow-plan" ? authored.payload.status : undefined).toBe("done")
    const run = [...store.collections.cards.values()].find(card => card.kind === "run-trace" && card.payload.runId === RUN)
    expect(run?.kind === "run-trace" ? run.payload.workflow : undefined).toBe(FLOW_AUTHORING_ENTRY)
    const live = run?.kind === "run-trace" ? store.committedRuntimeRun(runtimeRunKey(run.payload)) : undefined
    expect(live?.summary?.status).toBe("running")
    /* And it is still being watched: an observer that fell over would have
     * ended the wait and made this a plan AFTER the run, not during it. */
    expect(live?.observer?.error).toBeUndefined()
    expect(run?.kind === "run-trace" ? run.payload.phase : undefined).toBe("running")
  } finally { await controller.dispose(); await store.dispose?.() }
}, 30_000)
