import { workflowLaunchOf, workflowInputOf } from "./WorkflowLaunch"
import { decodeEventValue } from "./EventValue"
import { flowArgs } from "../flows/FlowArgs"
import { runtimeRunKey } from "./RuntimeProjection"
import { approvalActionId } from "./ApprovalReference"
/*
 * Lane runs — the run lifecycle beyond launch, through the real controller
 * against a relay double speaking the wire's own shapes.
 *
 * Pinned here: the run inbox (runs.list, its filters, and the honest by=
 * refusal — the wire records no launcher), opening a run as a card, the
 * lifecycle acts (resume, rerun with its launch input or the honest refusal,
 * signal, the steer family), the facets (transcript with follow, the
 * verbose-gated events tab), the trace's reader gestures, stop-all, and the
 * approvals inbox, including the `inboxCardId:requestId` decision routing
 * that lets a human decide a gate whose own approval card never landed.
 */
import { CODING_PLAN } from "../cards/fixtures/CodingPlan"
import { preparedCodingJournal } from "../cards/fixtures/CodingJournal"
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Card } from "@smthrs/rpc/Cards"
import { runCardInScope, approvalCardIdFor } from "./RunReference"
import { gatewayRunContextFor } from "./RepoContext"
import { scopedControllers } from "./ControllerTestScope"
import type { AppController, AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { json, loadBox, memoryStorage, settle, silentAgent, TEST_BOX, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const REPO = "codeplanesmithers/smithers-demo"

/** The card id a run on the test box gets: runCardIdFor qualifies every box-bound run. */
const boxRunCard = (runId: string): string => `flow-run@${[REPO, TEST_BOX, runId].map(encodeURIComponent).join("@")}`

const said = (outcome: { status: string; value?: string; error?: string }): string =>
  outcome.status === "failed" ? (outcome.error ?? "") : (outcome.value ?? "")

const waitForFacet = (store: Awaited<ReturnType<typeof webStore>>, id: string) => waitFor(() => {
  const card = store.collections.cards.get(id)
  return card?.kind === "run-trace" && card.payload.facetRequest?.state === "complete"
})

interface SummarySpec {
  readonly runId: string
  readonly flowId: string
  readonly status: string
  readonly waitingReason?: string
  readonly lineageId?: string
  readonly steeringPending?: number
  readonly createdAt?: number
  readonly turns?: number
  readonly calls?: number
}

const summaryRow = (spec: SummarySpec) => ({
  runId: spec.runId,
  flowId: spec.flowId,
  status: spec.status,
  createdAt: spec.createdAt ?? 1,
  updatedAt: 2,
  ...(spec.waitingReason === undefined ? {} : { waitingReason: spec.waitingReason }),
  ...(spec.lineageId === undefined ? {} : { lineageId: spec.lineageId }),
  ...(spec.steeringPending === undefined ? {} : { steeringPending: spec.steeringPending }),
  turns: spec.turns ?? 0,
  calls: spec.calls ?? 0,
  callsFailed: 0,
  editsAttempted: 0,
  editsSucceeded: 0,
  inputTokens: 0,
  outputTokens: 0,
  verdict: spec.status,
  diagnosis: "Verdict   done."
})

const approvalRow = (runId: string, requestId: string, title: string) => ({
  runId,
  requestId,
  title,
  request: { question: title },
  payload: {
    target: {
      _tag: "Node",
      runId,
      requestId,
      digest: "sha256:test",
      envelope: { capabilities: [], flows: [], budget: {} }
    },
    scope: "run",
    idempotencyKey: `approve:${requestId}`
  },
  requestedAt: 1500,
  status: "pending"
})

/** A relay double that speaks every selector and procedure the lane rides. */
const relay = (options: {
  readonly runs?: ReadonlyArray<SummarySpec>
  /**
   * The rows the approvals projection serves. `request` is the whole journaled
   * request payload for a capability gate and the declared question for a
   * human wait, so it is as loose here as it is on the wire.
   */
  readonly approvals?: ReadonlyArray<
    Omit<ReturnType<typeof approvalRow>, "request"> & {
      readonly request: Record<string, unknown>
      readonly waitRunId?: string
    }
  >
  readonly transcriptLines?: ReadonlyArray<
    { runId: string; sequence: number; turn: number; at: number; kind: string; text: string }
  >
  readonly events?: ReadonlyArray<Record<string, unknown>>
  readonly refusals?: Readonly<Record<string, string>>
  readonly projectionRefusals?: Readonly<Record<string, string>>
} = {}) => {
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const state = {
    launched: [] as Array<{ workflow: string; input: unknown; repo: string }>,
    resumed: [] as Array<{ runId: string; reason?: string }>,
    signaled: [] as Array<{ runId: string; signal: unknown }>,
    steered: [] as Array<{ runId: string; message: Record<string, unknown> }>,
    cancelled: [] as Array<{ runId: string; reason?: string }>,
    submitted: [] as Array<{ approval: unknown; decision: string }>
  }
  let runCounter = 0
  let planned: { flowId: string; input: unknown } | undefined

  const rowsAnswer = (projection: string, rows: ReadonlyArray<unknown>): Response =>
    json(200, { ok: true, payload: { cursor: { projection, runId: null, value: 0 }, rows } })

  const procedure = (repo: string, name: string, payload: Record<string, unknown>): Response => {
    const refusal = options.refusals?.[name]
    if (refusal !== undefined) return json(200, { ok: false, error: { message: refusal } })
    switch (name) {
      case "List":
        return json(200, {
          ok: true,
          payload: { _tag: "flows", items: [{ flowId: "review-pr", description: "" }] }
        })
      case "Plan":
        planned = { flowId: String(payload.flowId), input: payload.input }
        return json(200, {
          ok: true,
          payload: {
            planId: "plan-1",
            flowId: planned.flowId,
            digest: "digest-1",
            envelope: { capabilities: [], flows: [], budget: {} },
            inputSummary: "",
            deployClass: false,
            nodes: []
          }
        })
      case "Run": {
        runCounter += 1
        state.launched.push({ workflow: planned?.flowId ?? "?", input: planned?.input, repo })
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: `run-${runCounter}` } })
      }
      case "Resume":
        state.resumed.push({ runId: String(payload.runId), reason: payload.reason as string | undefined })
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "re" } })
      case "Signal":
        state.signaled.push({ runId: String(payload.runId), signal: payload.signal })
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "s" } })
      case "Steer":
        state.steered.push({ runId: String(payload.runId), message: payload.message as Record<string, unknown> })
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "st" } })
      case "Cancel":
        state.cancelled.push({ runId: String(payload.runId), reason: payload.reason as string | undefined })
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "c" } })
      case "Approval.Submit": {
        // The seam sends the envelope spread flat beside the decision.
        const { decision, ...approval } = payload
        state.submitted.push({ approval, decision: String(decision) })
        return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } })
      }
      case "Projection.Snapshot": {
        const selector = (payload.selector ?? {}) as { _tag?: string; runId?: string }
        const refusal = options.projectionRefusals?.[selector._tag ?? ""]
        if (refusal !== undefined) return json(200, { ok: false, error: { message: refusal } })
        switch (selector._tag) {
          case "workspace-runs":
            return rowsAnswer("workspace-runs", (options.runs ?? []).map(summaryRow))
          case "run-summary": {
            const spec = (options.runs ?? []).find((run) => run.runId === selector.runId)
            // The control plane counts the steers it holds for the run, so the summary reports them once a Steer landed.
            const steeringPending = state.steered.filter((steer) => steer.runId === selector.runId).length
            return rowsAnswer(
              "run-summary",
              spec === undefined ? [] : [summaryRow(spec.steeringPending === undefined && steeringPending > 0 ? { ...spec, steeringPending } : spec)]
            )
          }
          case "approvals": {
            const rows = (options.approvals ?? []).filter((row) =>
              selector.runId === undefined || row.runId === selector.runId
            )
            return rowsAnswer("approvals", rows)
          }
          case "transcript":
            return rowsAnswer("transcript", options.transcriptLines ?? [])
          case "run-events": {
            const after = payload.after as { value: number; offset: number } | undefined
            let offset = 0
            const events = options.events ?? []
            return rowsAnswer("run-events", events.filter((event, i) => {
              offset = i > 0 && events[i - 1]?.sequence === event.sequence ? offset + 1 : 0
              return after === undefined || Number(event.sequence) > after.value ||
                (event.sequence === after.value && offset > after.offset)
            }))
          }
          default:
            return rowsAnswer(String(selector._tag), [])
        }
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
      // The repository-flows seam reads .smithers/factory.json in the background whenever the target repository changes (the slash leaves); it is not this test's request.
      if (absolute.pathname.endsWith("/contents/.smithers/factory.json")) return json(404, { status: "error", message: "no projection" })
      // The same seam reads the repository homepage beside it.
      if (/^\/api\/repos\/[^/]+\/[^/]+\/home$/.test(absolute.pathname)) return json(404, { status: "error", message: "no homepage" })
      calls.push({ path: absolute.pathname + absolute.search, method: init?.method ?? "GET", body })
      if (absolute.pathname === "/api/workflow/provision") {
        return json(200, { status: "ready", repo: body?.repo, gatewayId: "gw-1" })
      }
      if (absolute.pathname === "/api/workflow/rpc") {
        return procedure(String(body.repo), String(body.procedure), (body.payload ?? {}) as Record<string, unknown>)
      }
      return json(404, { status: "error", message: `no stub for ${absolute.pathname}` })
    }
  }

  return { services, calls, state }
}

const signIn = async (store: Awaited<ReturnType<typeof webStore>>, loaded: Array<string> = [REPO]) => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "codeplanesmithers",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: loaded.map((fullName) => ({
      id: fullName,
      org: fullName.split("/")[0] ?? "",
      ownerKind: "user",
      name: fullName.split("/")[1] ?? "",
      head: null
    }))
  })
  for (const [index, fullName] of loaded.entries()) await loadBox(store, fullName, index === 0 ? TEST_BOX : `0b0c0d0e-0000-4000-8000-00000000000${index + 1}`)
  await settle(2)
}

const runListCard = (store: Awaited<ReturnType<typeof webStore>>): Extract<Card, { kind: "run-list" }> | undefined => {
  const card = store.collections.cards.get(`run-list-${REPO}-${TEST_BOX}`)
  return card?.kind === "run-list" ? card : undefined
}

const openMonitor = async (controller: AppController, store: Awaited<ReturnType<typeof webStore>>, args?: string) => {
  const result = await controller.commands.run("runs.open", args)
  if (result.status === "executed") {
    await waitFor(() => (store.session().runOpenRequests ?? []).every(request => request.error !== undefined))
    await store.settled?.()
  }
  return result
}

const listInventory = async (controller: AppController, store: Awaited<ReturnType<typeof webStore>>, flow: "runs.list" | "runs.attention", args?: string) => {
  const result = await controller.commands.run(flow, args)
  if (result.status === "executed") {
    await waitFor(() => [...store.collections.cards.values()].every(card => card.kind !== "run-list" || card.payload.listRequest?.state !== "pending"))
    await store.settled?.()
  }
  return result
}

const inboxCard = (
  store: Awaited<ReturnType<typeof webStore>>
): Extract<Card, { kind: "approvals-inbox" }> | undefined => {
  const card = store.collections.cards.get(`approvals-inbox-${REPO}-${TEST_BOX}`)
  return card?.kind === "approvals-inbox" ? card : undefined
}

/** The persisted approval reads still owed (or last failed) for this session. */
const inboxRequests = (store: Awaited<ReturnType<typeof webStore>>) => store.session().approvalsInboxRequests ?? []

/**
 * `approvals.list` persists its request and acknowledges at once; the inbox
 * card is published only when the background read settles. Callers that need
 * the rows wait for that receipt.
 */
const listInbox = async (controller: AppController, store: Awaited<ReturnType<typeof webStore>>, repo?: string) => {
  const outcome = await controller.commands.run("approvals.list", repo)
  expect(said(outcome)).toBe("Approvals requested.")
  await waitFor(() => inboxRequests(store).length === 0, 10_000)
  await store.settled?.()
  return outcome
}

test("attention combines explicit blockers and pending gates, and refresh removes cleared work", async () => {
  const store = await webStore()
  const runs = [
    { runId: "failed", flowId: "review-pr", status: "failed" },
    { runId: "parked", flowId: "review-pr", status: "parked" },
    { runId: "healthy", flowId: "review-pr", status: "running" }
  ]
  const approvals = [approvalRow("uncarded", "gate-1", "Review this request")]
  const double = relay({ runs, approvals })
  const controller = createAppController(store, silentAgent, double.services)
  await signIn(store)
  await listInventory(controller, store, "runs.attention")
  expect(runListCard(store)?.payload.runs.map(row => row.runId)).toEqual(["failed", "parked"])
  expect(runListCard(store)?.payload.approvals).toEqual([{ runId: "uncarded", requestId: "gate-1", title: "Review this request" }])
  expect(double.state.submitted).toEqual([])
  approvals.splice(0)
  runs.splice(0, 2)
  await listInventory(controller, store, "runs.attention", `sourceCard=run-list-${REPO}-${TEST_BOX} ${REPO}`)
  expect(runListCard(store)?.payload.runs).toEqual([])
  expect(runListCard(store)?.payload.approvals).toEqual([])
})

test("attention reports unreadable observations instead of claiming the inbox is clear", async () => {
  const store = await webStore()
  const double = relay({ refusals: { "Projection.Snapshot": "Gateway unreachable" } })
  const controller = createAppController(store, silentAgent, double.services)
  await signIn(store)
  await listInventory(controller, store, "runs.attention")
  expect(runListCard(store)?.payload.observationError).toContain("Gateway unreachable")
})

test("attention retains pending approvals when the run inventory cannot be read", async () => {
  const store = await webStore()
  const double = relay({ approvals: [approvalRow("uncarded", "gate", "Review deployment")],
    projectionRefusals: { "workspace-runs": "Run inventory unavailable" } })
  const controller = createAppController(store, silentAgent, double.services)
  await signIn(store)
  await listInventory(controller, store, "runs.attention")
  expect(runListCard(store)?.payload.approvals?.[0]?.requestId).toBe("gate")
  expect(runListCard(store)?.payload.observationError).toContain("Run inventory unavailable")
  await controller.commands.run("approvals.open", `sourceCard=run-list-${REPO}-${TEST_BOX} uncarded`)
  expect([...store.collections.cards.values()].some(card => card.kind === "approval" && card.payload.runId === "uncarded")).toBe(true)
})

test("handoff drafts preserve edits across reopening and reload, without copying launch secrets", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const double = relay({ runs: [{ runId: "run-handoff", flowId: "review-pr", status: "completed" }] })
  const controller = createAppController(store, silentAgent, double.services)
  await signIn(store)
  await openMonitor(controller, store, "run-handoff")
  const run = [...store.collections.cards.values()].find(card => card.kind === "run-trace")!
  store.dispatch({ type: "card.updated", actor: "system", id: run.id, patch: { payload: {
    ...run.payload, input: { prompt: "Fix retries", apiKey: "secret-that-must-not-be-copied" }
  } } })
  await controller.commands.run("runs.handoff", `sourceCard=${run.id} run-handoff`)
  const id = `handoff-${run.id}`
  const draft = store.collections.cards.get(id)
  expect(draft?.kind).toBe("flow-form")
  if (draft?.kind !== "flow-form") throw new Error("handoff missing")
  expect(draft.payload.draft.text).toContain("Fix retries")
  expect(draft.payload.draft.text).not.toContain("secret-that-must-not-be-copied")
  expect(draft.payload.draft.text).toContain("does not establish human acceptance")
  const copyByAgent = await controller.commands.runForAgent("form.submit", id)
  expect(said(copyByAgent)).toContain("user")
  expect(store.collections.cards.get(id)?.status).not.toBe("acted")
  await controller.commands.run("form.set", `${id} text Remaining: verify retries\nNext: run the integration suite`)
  await controller.commands.run("runs.handoff", `sourceCard=${run.id} run-handoff`)
  await settle()
  controller.dispose()
  await store.dispose?.()
  const restored = await createAppStore({ kind: "localStorage", storage })
  const saved = restored.collections.cards.get(id)
  expect(saved?.kind === "flow-form" && saved.payload.draft.text).toBe("Remaining: verify retries\nNext: run the integration suite")
  await restored.dispose?.()
})

test("declared flow inputs reuse persisted forms and the existing named launch path", async () => {
  const store = await webStore()
  const double = relay()
  const controller = createAppController(store, silentAgent, double.services)
  await signIn(store)
  store.dispatch({ type: "repository-flows.loaded", actor: "system", repo: REPO, flows: [{
    id: "review-pr", description: "Review selected paths", summary: null, featured: true, model: null, modelInvocable: true,
    inputSchema: Schema.toJsonSchemaDocument(Schema.Struct({
      path: Schema.String, attempts: Schema.Number, mode: Schema.Literals(["quick", "thorough"]), draft: Schema.Boolean
    }))
  }] })
  await controller.commands.run("review-pr", '{"path":"src/retries.ts"}')
  expect(double.state.launched).toEqual([])
  const form = [...store.collections.cards.values()].find(card => card.kind === "flow-form")
  if (form?.kind !== "flow-form") throw new Error("input form missing")
  expect(form.payload.fields.map(field => [field.name, field.kind])).toEqual([
    ["attempts", "number"], ["draft", "boolean"], ["mode", "select"], ["path", "text"]
  ])
  expect(form.payload.draft.path).toBe("src/retries.ts")
  await controller.commands.run("form.set", `${form.id} attempts 2`)
  await controller.commands.run("form.set", `${form.id} mode thorough`)
  await controller.commands.run("form.submit", form.id)
  await waitFor(() => double.state.launched.length === 1)
  expect(double.state.launched).toEqual([{ workflow: "review-pr", repo: REPO,
    input: { path: "src/retries.ts", attempts: 2, mode: "thorough", draft: false } }])
})

test("optional flow inputs are offered before launch, while an empty schema can run directly", async () => {
  const store = await webStore()
  const double = relay()
  const controller = createAppController(store, silentAgent, double.services)
  await signIn(store)
  const declare = (input: Schema.Top) => store.dispatch({ type: "repository-flows.loaded", actor: "system", repo: REPO, flows: [{
    id: "review-pr", description: "Review", summary: null, featured: true, model: null, modelInvocable: true,
    inputSchema: Schema.toJsonSchemaDocument(input)
  }] })
  declare(Schema.Struct({ path: Schema.optional(Schema.String) }))
  await controller.commands.run("flow.run", "review-pr")
  expect(double.state.launched).toHaveLength(0)
  const form = [...store.collections.cards.values()].find(card => card.kind === "flow-form")!
  await controller.commands.run("form.submit", form.id)
  await waitFor(() => double.state.launched.length === 1)
  expect(double.state.launched).toHaveLength(1)
  expect(double.state.launched[0]?.input).toEqual({})
  declare(Schema.Struct({}))
  await controller.commands.run("flow.run", "review-pr")
  expect(double.state.launched).toHaveLength(1)
})

describe("runs.list — the run inbox", () => {
  test("lists the workspace's runs as a card, filtered and sorted newest first", async () => {
    const store = await webStore()
    const double = relay({
      runs: [
        { runId: "run-old", flowId: "review-pr", status: "completed", createdAt: 1, turns: 4, calls: 9 },
        { runId: "run-new", flowId: "deploy", status: "parked", waitingReason: "approval", createdAt: 5, turns: 1, calls: 2 },
        { runId: "run-mid", flowId: "review-pr", status: "accepted", createdAt: 3 }
      ]
    })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    const listed = await listInventory(controller, store, "runs.list")
    expect(said(listed)).toBe("Runs requested.")
    const card = runListCard(store)
    expect(card?.payload.runs.map((run) => run.runId)).toEqual(["run-new", "run-mid", "run-old"])
    // The parked run names its wait; the accepted one names the executor convention.
    expect(card?.payload.runs[0]).toMatchObject({ waiting: "approval" })
    expect(card?.payload.runs[1]).toMatchObject({ waiting: "executor" })
    expect(card?.payload.runs[2]?.waiting).toBeUndefined()
    expect(double.calls.some((call) =>
      JSON.stringify(call.body).includes("\"workspace-runs\"")
    )).toBe(true)

    const filtered = await listInventory(controller, store, "runs.list", "parked")
    expect(said(filtered)).toBe("Runs requested.")
    expect(runListCard(store)?.payload.runs.map((run) => run.runId)).toEqual(["run-new"])
    expect(runListCard(store)?.payload.status).toBe("parked")
  })

  test("by= refuses honestly — the wire records no launcher — and asks nothing", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-1", flowId: "review-pr", status: "running" }] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    const before = double.calls.length
    const refused = await listInventory(controller, store, "runs.list", "by=octocat")
    expect(said(refused)).toContain("no by=")
    expect(double.calls.length).toBe(before)
    expect(runListCard(store)).toBeUndefined()
  })

  test("signed-out is the identity guard's refusal, not a workspace call", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    const refused = await listInventory(controller, store, "runs.list")
    expect(said(refused)).toContain("Sign in with GitHub first")
    expect(double.calls).toHaveLength(0)
  })
})

describe("runs.open / resume / signal / steer — the run's acts", () => {
  test("runs.open materializes the run's card from its summary", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-9", flowId: "deploy", status: "running" }] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    const opened = await openMonitor(controller, store, "run-9")
    expect(said(opened)).toBe("Run requested: run-9.")
    const card = store.collections.cards.get(boxRunCard("run-9"))
    expect(card?.kind === "run-trace" && card.payload.workflow).toBe("deploy")
    expect(card?.kind === "run-trace" && card.payload.repo).toBe(REPO)
  })

  test("runs.open of a finished run reads its recorded journal once (#1936)", async () => {
    const store = await webStore()
    const double = relay({
      runs: [{ runId: "run-done", flowId: "coding", status: "failed" }],
      events: [
        { kind: "control.agent.turn-opened", payload: { seat: "openai:gpt-5.6-sol", at: 100 }, sequence: 1, occurredAt: 100 },
        { kind: "control.run.failed", payload: {}, sequence: 2, occurredAt: 200 }
      ]
    })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    await openMonitor(controller, store, "run-done")
    await waitFor(() => {
      const card = store.collections.cards.get(boxRunCard("run-done"))
      return card?.kind === "run-trace" && (card.payload.events?.length ?? 0) === 2
    })
    const card = store.collections.cards.get(boxRunCard("run-done"))
    expect(card?.kind === "run-trace" && card.payload.phase).toBe("failed")
    await settle()
    expect(double.calls.filter((call) => JSON.stringify(call.body).includes("\"run-events\"")).length).toBe(1)
  })

  test("runs.open names the miss honestly", async () => {
    const store = await webStore()
    const double = relay({ runs: [] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    const opened = await openMonitor(controller, store, "run-absent")
    expect(said(opened)).toBe("Run requested: run-absent.")
    expect(store.session().runOpenRequests?.[0]?.error).toContain("no run run-absent")
  })

  test("runs.resume sends the control Resume with an idempotency key", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-2", flowId: "review-pr", status: "parked", waitingReason: "quota" }] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    const resumed = await controller.commands.run("runs.resume", "run-2")
    expect(said(resumed)).toContain("resume-requested run=run-2")
    expect(double.state.resumed).toEqual([{ runId: "run-2", reason: undefined }])
  })

  test("a resume refusal crosses as the flow's error", async () => {
    const store = await webStore()
    const double = relay({
      runs: [{ runId: "run-2", flowId: "review-pr", status: "completed" }],
      refusals: { Resume: "Terminal: the run is completed" }
    })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    const resumed = await controller.commands.run("runs.resume", "run-2")
    expect(resumed.status).toBe("failed")
    expect(said(resumed)).toContain("Terminal: the run is completed")
  })

  test("runs.signal parses the JSON payload; invalid JSON refuses without a call", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-3", flowId: "deploy", status: "parked", waitingReason: "event" }] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    const sent = await controller.commands.run("runs.signal", `run-3 deploy-done {"ok":true}`)
    expect(said(sent)).toContain("signal-sent")
    expect(double.state.signaled).toEqual([{ runId: "run-3", signal: { name: "deploy-done", payload: { ok: true } } }])

    const before = double.state.signaled.length
    const refused = await controller.commands.run("runs.signal", "run-3 deploy-done {not json}")
    expect(said(refused)).toContain("isn't JSON")
    expect(double.state.signaled.length).toBe(before)
  })

  test("the steer family sends the steer envelope; the card notes the queued steer", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-4", flowId: "review-pr", status: "running" }] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    await openMonitor(controller, store, "run-4")

    const steered = await controller.commands.run("runs.steer", "run-4 use the smaller diff")
    expect(said(steered)).toContain("steered run=run-4")
    expect(double.state.steered[0]?.message).toMatchObject({ kind: "Message", body: "use the smaller diff", runId: "run-4" })

    await controller.commands.run("runs.seat", "run-4 anthropic:claude-opus-4-1")
    expect(double.state.steered[1]?.message).toMatchObject({ kind: "Seat", seat: "anthropic:claude-opus-4-1" })
    await controller.commands.run("runs.tools", "run-4 bash, edit")
    expect(double.state.steered[2]?.message).toMatchObject({ kind: "Tools", toolNames: ["bash", "edit"] })

    const card = store.collections.cards.get(boxRunCard("run-4"))
    expect(card?.kind === "run-trace" && card.payload.steeringPending).toBe(true)
  })
})

describe("source-bound durable reruns", () => {
  const source = (id: string, input?: Record<string, unknown>): Extract<Card, { kind: "run-trace" }> => ({
    id, kind: "run-trace", title: id, status: "acted", createdAt: 1, ordinal: 1,
    payload: { repo: REPO, workspaceId: TEST_BOX, runId: "original", workflow: "review-pr", phase: "completed", steps: [], result: null,
      lastSeq: 0, gatewayBindingVersion: 1, ...(input === undefined ? {} : { input }) }
  })
  const ready = async (services?: AppServices, storage = memoryStorage()) => {
    const store = await createAppStore({ kind: "localStorage", storage })
    await signIn(store)
    for (const id of ["a", "b"]) await store.dispatch({ type: "card.upsert", actor: "system", card: source(id, { args: id }) }).isPersisted.promise
    const double = relay()
    const controller = createAppController(store, silentAgent, services ?? double.services)
    return { store, controller, double, storage }
  }
  const requests = (store: Awaited<ReturnType<typeof webStore>>) => [...store.collections.cards.values()]
    .map(workflowLaunchOf).filter(request => request !== undefined)

  test("the explicit view supplies the rerun's input", async () => {
    const { controller, double } = await ready()
    const result = await controller.commands.run("runs.rerun", "sourceCard=b original")
    expect(result.status).toBe("executed")
    await waitFor(() => double.state.launched.length === 1)
    expect(double.state.launched[0]).toMatchObject({ input: { args: "b" } })
  })

  test("rerun metadata never replaces colliding keys in the flow's input", async () => {
    const { store, controller, double } = await ready()
    const input = { args: "b", rerunOf: "user value", _workflowLaunch: { user: "input" } }
    await store.dispatch({ type: "card.upsert", actor: "system", card: source("b", input) }).isPersisted.promise
    await controller.commands.run("runs.rerun", "sourceCard=b original")
    await waitFor(() => double.state.launched.length === 1)
    expect(double.state.launched[0]?.input).toEqual(input)
    await waitFor(() => requests(store)[0]?.runId === "run-1")
    expect(workflowInputOf(runCardInScope(store, { repo: REPO, workspaceId: TEST_BOX, runId: "run-1" })!)).toEqual(input)
  })

  test("a refused rerun launch remains retryable with the same saved input", async () => {
    const refusals: Record<string, string> = { Plan: "Launch unavailable" }
    const double = relay({ refusals })
    const { store, controller } = await ready(double.services)
    await controller.commands.run("runs.rerun", "sourceCard=b original")
    await waitFor(() => requests(store)[0]?.error !== undefined)
    const request = requests(store)[0]!
    expect(request.error?.message).toContain("Launch unavailable")
    expect(double.state.launched).toHaveLength(0)
    delete refusals.Plan
    await controller.commands.run("flow.run.retry", `flow-request-${request.id}`)
    await waitFor(() => double.state.launched.length === 1)
    expect(requests(store)[0]?.id).toBe(request.id)
    expect(double.state.launched[0]?.input).toEqual({ args: "b" })
  })

  test("a view without input cannot borrow another view's input", async () => {
    const { store, controller, double } = await ready()
    await store.dispatch({ type: "card.upsert", actor: "system", card: source("b") }).isPersisted.promise
    const result = await controller.commands.run("runs.rerun", "sourceCard=b original")
    expect(result.status).toBe("failed")
    expect(said(result)).toContain("nothing faithful to rerun")
    expect(double.state.launched).toHaveLength(0)
  })

  test("a rerun acknowledges its saved request while provisioning waits and shares duplicate input", async () => {
    const gate = Promise.withResolvers<void>()
    const double = relay()
    let provisions = 0
    const fixture = await ready({ ...double.services, fetchImpl: async (input, init) => {
      if (String(input).endsWith("/api/workflow/provision")) { provisions += 1; await gate.promise }
      return double.services.fetchImpl!(input, init)
    } })
    let answered = false
    const result = fixture.controller.commands.run("runs.rerun", "sourceCard=b original").then(result => { answered = true; return result })
    try {
      await waitFor(() => provisions === 1)
      await waitFor(() => answered)
      expect(said(await result)).toContain("run-requested")
      expect(requests(fixture.store)).toHaveLength(1)
      expect(requests(fixture.store)[0]?.input).toEqual({ args: "b" })
      await fixture.controller.commands.run("runs.rerun", "sourceCard=b original")
      expect(requests(fixture.store)).toHaveLength(1)
      expect(provisions).toBe(1)
      await fixture.store.dispatch({ type: "composer.changed", actor: "user", draft: "Chat while rerunning" }).isPersisted.promise
      expect(double.state.launched).toHaveLength(0)
      gate.resolve()
      await waitFor(() => double.state.launched.length === 1)
    } finally { gate.resolve(); await result }
  })

  test("the agent asks before launching the selected view's input", async () => {
    const { store, controller, double } = await ready()
    const result = await controller.commands.executeForAgent({ name: "commands", arguments: JSON.stringify({
      action: "execute", name: "runs.rerun", args: "sourceCard=b original"
    }) })
    expect(result).toContain("asked the user to confirm")
    expect(requests(store)).toHaveLength(0)
    expect(double.state.launched).toHaveLength(0)
    const action = [...store.collections.messages.values()].find(message => message.action?.flow === "runs.rerun")?.action
    expect(action?.args).toBe("sourceCard=b original")
    await controller.commands.run(action!.flow, action!.args)
    await waitFor(() => double.state.launched.length === 1)
    expect(double.state.launched[0]?.input).toEqual({ args: "b" })
  })

  for (const args of ["sourceCard=missing original", "sourceCard=b another-run"]) {
    test(`invalid rerun source refuses: ${args}`, async () => {
      const { store, controller, double } = await ready()
      expect((await controller.commands.run("runs.rerun", args)).status).toBe("failed")
      expect(requests(store)).toHaveLength(0)
      expect(double.state.launched).toHaveLength(0)
    })
  }

  test("a refused admission saves no request, launches nothing, and can retry", async () => {
    const backing = memoryStorage()
    let armed = false
    let refused = 0
    const storage = { ...backing, setItem: (key: string, value: string) => {
      if (armed && key.endsWith(".staged") && value.includes("rerunOf")) {
        armed = false; refused += 1
        throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError", code: 22 })
      }
      backing.setItem(key, value)
    } }
    const { store, controller, double } = await ready(undefined, storage)
    armed = true
    const result = await controller.commands.run("runs.rerun", "sourceCard=b original")
    expect(result.status).toBe("failed")
    expect(said(result)).toContain("could not be saved")
    expect(refused).toBe(1)
    expect(requests(store)).toHaveLength(0)
    expect(double.state.launched).toHaveLength(0)
    await controller.commands.run("runs.rerun", "sourceCard=b original")
    await waitFor(() => double.state.launched.length === 1)
    expect(double.state.launched[0]?.input).toEqual({ args: "b" })
  })

  test("reload resumes the same rerun request and its saved input", async () => {
    const gate = Promise.withResolvers<void>()
    const double = relay()
    let provisions = 0
    const services = { ...double.services, fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/workflow/provision")) { provisions += 1; await gate.promise }
      return double.services.fetchImpl!(input, init)
    } }
    const fixture = await ready(services)
    let restored: Awaited<ReturnType<typeof webStore>> | undefined
    let reopened: AppController | undefined
    try {
      await fixture.controller.commands.run("runs.rerun", "sourceCard=b original")
      await waitFor(() => provisions === 1)
      const id = requests(fixture.store)[0]!.id
      await fixture.controller.dispose()
      await fixture.store.dispose?.()
      restored = await createAppStore({ kind: "localStorage", storage: fixture.storage })
      reopened = createAppController(restored, silentAgent, services)
      await reopened.adoptSession({ state: "signed-in", login: "codeplanesmithers", allowlisted: true, admin: false })
      await waitFor(() => provisions === 2)
      expect(requests(restored)[0]?.id).toBe(id)
      expect(requests(restored)[0]?.rerunOf).toBe("original")
      gate.resolve()
      await waitFor(() => double.state.launched.length === 1)
      await waitFor(() => requests(restored!)[0]?.runId === "run-1")
      expect(double.state.launched[0]?.input).toEqual({ args: "b" })
    } finally { gate.resolve(); await reopened?.dispose(); await restored?.dispose?.() }
  })

  for (const change of ["source", "account"] as const) {
    test(`held rerun preparation respects a later ${change} change`, async () => {
      const gate = Promise.withResolvers<void>()
      const double = relay()
      let entered = false
      let returned = false
      const fixture = await ready({ ...double.services, fetchImpl: async (input, init) => {
        if (String(input).endsWith("/api/workflow/provision")) { entered = true; await gate.promise; returned = true }
        return double.services.fetchImpl!(input, init)
      } })
      try {
        await fixture.controller.commands.run("runs.rerun", "sourceCard=b original")
        await waitFor(() => entered)
        if (change === "account") await fixture.controller.adoptSession({ state: "signed-in", login: "another-owner", allowlisted: true, admin: false })
        else await fixture.store.dispatch({ type: "card.upsert", actor: "system", card: source("b", { args: "changed later" }) }).isPersisted.promise
        gate.resolve()
        await waitFor(() => returned)
        if (change === "account") {
          await settle(30)
          expect(double.state.launched).toHaveLength(0)
        } else {
          // The admitted request owns its snapshot independently of the original view.
          await waitFor(() => double.state.launched.length === 1)
          expect(double.state.launched[0]?.input).toEqual({ args: "b" })
        }
      } finally { gate.resolve() }
    })
  }
})

describe("runs.rerun — the same flow, the same input, or the honest refusal", () => {
  test("a run launched from here reruns with its recorded input as a NEW run", async () => {
    const store = await webStore()
    const double = relay({ runs: [] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    await controller.commands.run("flow.run", 'review-pr {"args":"summarize my open issues"}')
    await waitFor(() => double.state.launched.length === 1)
    const firstRunId = "run-1"
    await waitFor(() => runCardInScope(store, { repo: REPO, workspaceId: TEST_BOX, runId: firstRunId }) !== undefined)

    const reran = await controller.commands.run("runs.rerun", firstRunId)
    expect(said(reran)).toContain("run-requested")
    await waitFor(() => double.state.launched.length === 2)
    expect(double.state.launched).toHaveLength(2)
    expect(double.state.launched[1]).toMatchObject({
      workflow: "review-pr",
      input: { args: "summarize my open issues" },
      repo: REPO
    })
  })

  test("a run whose input was never recorded refuses instead of guessing", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-5", flowId: "deploy", status: "completed" }] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    // Opened from the inbox: the client never saw this run's launch input.
    await openMonitor(controller, store, "run-5")
    const before = double.state.launched.length
    const refused = await controller.commands.run("runs.rerun", "run-5")
    expect(said(refused)).toContain("nothing faithful to rerun")
    expect(double.state.launched.length).toBe(before)
  })
})

describe("the run card's facets — transcript, follow, and the verbose events tab", () => {
  // The served transcript row names its run; the seam decodes these against the gateway's schema.
  const lines = [
    { runId: "run-6", sequence: 1, turn: 1, at: 100, kind: "agent.turn.started", text: "turn 1 begins" },
    { runId: "run-6", sequence: 2, turn: 1, at: 200, kind: "control.approval.requested", text: "asks: deploy?" }
  ]

  test("runs.logs shows the transcript; --follow toggles the live merge", async () => {
    const store = await webStore()
    const double = relay({
      runs: [{ runId: "run-6", flowId: "deploy", status: "running" }],
      transcriptLines: lines
    })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    await openMonitor(controller, store, "run-6")

    const shown = await controller.commands.run("runs.logs", "run-6")
    expect(said(shown)).toBe("Transcript requested.")
    await waitForFacet(store, boxRunCard("run-6"))
    let card = store.collections.cards.get(boxRunCard("run-6"))
    expect(card?.kind === "run-trace" && card.payload.facet).toBe("transcript")
    expect(card?.kind === "run-trace" && card.payload.follow).toBe(false)
    expect(card?.kind === "run-trace" && card.payload.transcriptRows?.map((row) => row.text))
      .toEqual(["turn 1 begins", "asks: deploy?"])

    const followed = await controller.commands.run("runs.logs", "run-6 --follow")
    expect(said(followed)).toBe("Transcript requested.")
    await waitForFacet(store, boxRunCard("run-6"))
    card = store.collections.cards.get(boxRunCard("run-6"))
    expect(card?.kind === "run-trace" && card.payload.follow).toBe(true)
    // The pump merges the transcript on its own cycle while follow holds.
    await waitFor(() => {
      const current = store.collections.cards.get(boxRunCard("run-6"))
      return current?.kind === "run-trace" && (current.payload.transcriptRows?.length ?? 0) === 2
    })
    // Following again unfollows.
    await controller.commands.run("runs.logs", "run-6 --follow")
    await waitForFacet(store, boxRunCard("run-6"))
    card = store.collections.cards.get(boxRunCard("run-6"))
    expect(card?.kind === "run-trace" && card.payload.follow).toBe(false)
    // And the Steps tab is the way back.
    await controller.commands.run("runs.steps", "run-6")
    card = store.collections.cards.get(boxRunCard("run-6"))
    expect(card?.kind === "run-trace" && card.payload.facet).toBe("steps")
  })

  test("runs.events exists only where verbose does", async () => {
    const store = await webStore()
    const double = relay({
      runs: [{ runId: "run-7", flowId: "deploy", status: "running" }],
      events: [{ kind: "control.run.accepted", payload: {}, sequence: 1, occurredAt: 100 }]
    })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    await openMonitor(controller, store, "run-7")

    const refused = await controller.commands.run("runs.events", "run-7")
    expect(said(refused)).toContain("/debug.verbose")

    await controller.commands.run("debug.verbose")
    const shown = await controller.commands.run("runs.events", "run-7")
    expect(said(shown)).toBe("Events requested.")
    await waitForFacet(store, boxRunCard("run-7"))
    const card = store.collections.cards.get(boxRunCard("run-7"))
    expect(card?.kind === "run-trace" && card.payload.facet).toBe("events")
    expect(card?.kind === "run-trace" && card.payload.events).toHaveLength(1)
  })
})

describe("the run trace's reader gestures and the pump's tail (spec 06 §5, §6)", () => {
  test("an incomplete agent request renders the view form with the known run prefilled", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, relay().services)
    await signIn(store)
    const result = await controller.commands.runForAgent("runs.trace.view", "run-8")
    expect(result).toMatchObject({ status: "form", flow: "runs.trace.view", fields: ["view"] })
    const form = store.collections.cards.get("form-runs.trace.view")
    expect(form?.kind === "flow-form" && form.payload).toMatchObject({
      flow: "runs.trace.view", via: "agent", draft: { runId: "run-8" }, given: { runId: "run-8" }
    })
    expect(form?.kind === "flow-form" && form.payload.fields.find((field) => field.name === "view")?.options?.map((option) => option.value))
      .toEqual(["turns", "timeline", "graph", "steps"])
  })

  test("runs.open builds the run-trace card under the flow-run id, on live tail, and the pump keeps its journal current", async () => {
    const store = await webStore()
    const journal: Array<Record<string, unknown>> = [
      { kind: "control.agent.turn-opened", payload: { seat: "openai:gpt-5.6-sol", at: 100 }, sequence: 1, occurredAt: 100 }
    ]
    const double = relay({
      runs: [{ runId: "run-8", flowId: "deploy", status: "running" }],
      events: journal
    })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    await openMonitor(controller, store, "run-8")
    let card = store.collections.cards.get(boxRunCard("run-8"))
    expect(card?.kind).toBe("run-trace")
    expect(card?.kind === "run-trace" && card.payload.kind).toBeUndefined()
    expect(card?.kind === "run-trace" && card.payload.liveTail).toBe(true)
    // The trace is the card's body, so the journal arrives without a further act.
    await waitFor(() => {
      const current = store.collections.cards.get(boxRunCard("run-8"))
      return current?.kind === "run-trace" && (current.payload.events?.length ?? 0) === 1
    })

    // The workspace journals a call; the pump's next cycle carries it onto the card.
    journal.push({ kind: "control.agent.cell-call-started", payload: { flowName: "files.read", input: { path: "README.md" }, at: 250 }, sequence: 2, occurredAt: 250 })
    await waitFor(() => {
      const current = store.collections.cards.get(boxRunCard("run-8"))
      return current?.kind === "run-trace" && (current.payload.events?.length ?? 0) === 2
    })
    expect(double.calls.filter((call) => JSON.stringify(call.body).includes("\"run-events\"")).length).toBeGreaterThanOrEqual(2)

    // A filter is one word on the payload; nothing leaves the browser for it.
    const reads = double.calls.length
    const filtered = await controller.commands.run("runs.trace.filter", "run-8 failed")
    expect(said(filtered)).toBe("trace-filter run=run-8 filter=failed")
    card = store.collections.cards.get(boxRunCard("run-8"))
    expect(card?.kind === "run-trace" && card.payload.filter).toBe("failed")
    expect(double.calls.length).toBe(reads)

    // A selection names a node the journal in hand folds to, leaves live tail, and may scrub to a seq.
    const selected = await controller.commands.run("runs.trace.select", "run-8 call-1 2")
    expect(said(selected)).toBe("trace-select run=run-8 node=call-1 seq=2")
    card = store.collections.cards.get(boxRunCard("run-8"))
    expect(card?.kind === "run-trace" && card.payload).toMatchObject({ selection: "call-1", liveTail: false, cursorSeq: 2, filter: "failed" })
    const invented = await controller.commands.run("runs.trace.select", "run-8 call-9")
    expect(said(invented)).toBe("Run run-8 has no trace node call-9.")
    card = store.collections.cards.get(boxRunCard("run-8"))
    expect(card?.kind === "run-trace" && card.payload.selection).toBe("call-1")
    // A sequence before this call, or beyond the journal, cannot quietly select current data.
    expect(said(await controller.commands.run("runs.trace.select", "run-8 call-1 1"))).toContain("no trace node call-1")
    expect(said(await controller.commands.run("runs.trace.select", "run-8 call-1 3"))).toContain("no recorded journal sequence 3")
    await controller.commands.runForAgent("runs.trace.view", "run-8 timeline")
    card = store.collections.cards.get(boxRunCard("run-8"))
    expect(card?.kind === "run-trace" && card.payload.traceView).toBe("timeline")
    // The background pump may append a system update after this command.
    // Assert the persisted gesture itself, not the last unrelated update.
    expect([...store.collections.transitions.values()].some((record) => {
      if (record.type !== "card.updated" || record.actor !== "smithers") return false
      const payload = JSON.parse(record.payload)
      return payload.id === boxRunCard("run-8") && payload.patch?.payload?.traceView === "timeline"
    })).toBe(true)

    // A re-open keeps the reader's view (§5): filter, selection, cursor and live tail survive.
    await openMonitor(controller, store, "run-8")
    card = store.collections.cards.get(boxRunCard("run-8"))
    expect(card?.kind === "run-trace" && card.payload).toMatchObject({ selection: "call-1", liveTail: false, cursorSeq: 2, filter: "failed", traceView: "timeline" })
    await controller.commands.runForAgent("runs.trace.live", "run-8")
    card = store.collections.cards.get(boxRunCard("run-8"))
    expect(card?.kind === "run-trace" && card.payload).toMatchObject({ liveTail: true, filter: "failed", traceView: "timeline" })
    expect(card?.kind === "run-trace" && card.payload.cursorSeq).toBeUndefined()
    expect(card?.kind === "run-trace" && card.payload.selection).toBeUndefined()
    // Omitting seq now pins the record in hand; a later settlement must not change that inspected value.
    await controller.commands.runForAgent("runs.trace.select", "run-8 call-1")
    card = store.collections.cards.get(boxRunCard("run-8"))
    expect(card?.kind === "run-trace" && card.payload.cursorSeq).toBe(2)
  })

  test("every reader gesture answers only once the card it changed is durable", async () => {
    /*
     * Reading a trace is durable state: the reader who returns to Latest and
     * reloads must find the run at its tail. A gesture that answers before its
     * write is durable loses that write to the reload, which is what a
     * production keyboard walk found: `Latest` was still on the card after the
     * reload that followed it.
     */
    const store = await webStore()
    const journal = [
      { kind: "control.agent.turn-opened", payload: { seat: "openai:gpt-5.6-sol", at: 100 }, sequence: 1, occurredAt: 100 }
    ]
    const double = relay({ runs: [{ runId: "run-7", flowId: "deploy", status: "running" }], events: journal })
    let holding = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const guarded = new Proxy(store, {
      get: (target, key, receiver) => key !== "dispatch" ? Reflect.get(target, key, receiver)
        : (transition: Parameters<typeof store.dispatch>[0]) => {
          const transaction = target.dispatch(transition)
          // Hold only the run card's own write. Every other dispatch settles as
          // usual, so a gesture that answers without waiting for ITS write is
          // what this catches, not a gesture waiting for its transcript line.
          const changed = transition.type === "card.upsert"
            ? (transition as { card: { id: string } }).card.id
            : transition.type === "card.updated" ? (transition as { id: string }).id : undefined
          if (!holding || changed !== boxRunCard("run-7")) return transaction
          return new Proxy(transaction, { get: (owner, name, self) => name === "isPersisted"
            ? { ...owner.isPersisted, promise: gate.then(() => owner.isPersisted.promise) }
            : Reflect.get(owner, name, self) })
        }
    })
    const controller = createAppController(guarded as typeof store, silentAgent, double.services)
    await signIn(store)
    await openMonitor(controller, store, "run-7")
    await waitFor(() => {
      const current = store.collections.cards.get(boxRunCard("run-7"))
      return current?.kind === "run-trace" && (current.payload.events?.length ?? 0) === 1
    })
    await controller.commands.run("runs.trace.select", "run-7 frame-1 1")
    const gestures = [
      ["runs.trace.live", "run-7"],
      ["runs.trace.view", "run-7 timeline"],
      ["runs.trace.filter", "run-7 failed"]
    ] as const
    holding = true
    const answered = gestures.map(([flow, args]) => {
      let settled = false
      const promise = controller.commands.run(flow, args).then((result) => { settled = true; return result })
      return { flow, promise, said: () => settled }
    })
    for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
    for (const gesture of answered) {
      expect(gesture.said(), `${gesture.flow} answered before its card was durable`).toBe(false)
    }
    release()
    for (const gesture of answered) expect(said(await gesture.promise)).not.toContain("runs.open")
    holding = false
    const card = store.collections.cards.get(boxRunCard("run-7"))
    expect(card?.kind === "run-trace" && card.payload).toMatchObject({ liveTail: true, traceView: "timeline", filter: "failed" })
    expect(card?.kind === "run-trace" && card.payload.cursorSeq).toBeUndefined()
  })

  test("both gestures need the run's card first", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-9", flowId: "deploy", status: "running" }] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    expect(said(await controller.commands.run("runs.trace.filter", "run-9 failed"))).toContain("runs.open run-9")
    expect(said(await controller.commands.run("runs.trace.select", "run-9 frame-1"))).toContain("runs.open run-9")
    expect(said(await controller.commands.run("runs.trace.view", "run-9 turns"))).toContain("runs.open run-9")
    expect(said(await controller.commands.run("runs.trace.live", "run-9"))).toContain("runs.open run-9")
  })
})

describe("flow.run.stop-all — every live run, cancelled", () => {
  test("cancels each live run card's run and reports the count", async () => {
    const store = await webStore()
    const double = relay({
      runs: [
        { runId: "run-a", flowId: "deploy", status: "running" },
        { runId: "run-b", flowId: "review-pr", status: "running" }
      ]
    })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    await openMonitor(controller, store, "run-a")
    await openMonitor(controller, store, "run-b")

    const stopped = await controller.commands.run("flow.run.stop-all")
    expect(said(stopped)).toContain("stopped=2 of 2")
    expect(double.state.cancelled.map((entry) => entry.runId).sort()).toEqual(["run-a", "run-b"])
    expect(double.state.cancelled[0]?.reason).toContain("every run")
  })

  test("with nothing live there is nothing to stop", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    const stopped = await controller.commands.run("flow.run.stop-all")
    expect(said(stopped)).toContain("No runs are live")
    expect(double.state.cancelled).toHaveLength(0)
  })
})

describe("the approvals inbox — list, open, and the row decision", () => {
  test("approvals.list upserts the workspace's pending gates as one card", async () => {
    const store = await webStore()
    const double = relay({
      approvals: [approvalRow("run-a", "req-1", "Run the deploy script?"), approvalRow("run-b", "req-2", "Push the branch?")]
    })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    const listed = await listInbox(controller, store)
    expect(said(listed)).toBe("Approvals requested.")
    const card = inboxCard(store)
    expect(card?.payload.approvals.map((row) => row.title)).toEqual(["Run the deploy script?", "Push the branch?"])
    // The inbox selected WITHOUT a run id — the whole workspace's gates.
    expect(double.calls.some((call) =>
      JSON.stringify(call.body).includes("\"_tag\":\"approvals\"}") ||
      JSON.stringify(call.body).includes("\"selector\":{\"_tag\":\"approvals\"}")
    )).toBe(true)
  })

  test("a row decision submits the gateway's own envelope unchanged and freezes the row", async () => {
    const store = await webStore()
    const double = relay({ approvals: [approvalRow("run-a", "req-1", "Run the deploy script?")] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    await listInbox(controller, store)

    // The exact dispatch the card's Approve button makes (approval.approve with the row id).
    const decided = await controller.commands.run("approval.approve", `approvals-inbox-${REPO}-${TEST_BOX}:req-1`)
    await settle(4)
    expect(decided.status).not.toBe("failed")
    expect(double.state.submitted).toHaveLength(1)
    expect(double.state.submitted[0]?.decision).toBe("approve")
    // The envelope went back byte-for-byte: no client reconstructs authority.
    expect(double.state.submitted[0]?.approval).toEqual(approvalRow("run-a", "req-1", "Run the deploy script?").payload)
    const card = inboxCard(store)
    expect(card?.payload.approvals[0]?.decision).toBe("approved")
    expect(card?.payload.approvals[0]?.decisionError).toBeUndefined()
  })

  /**
   * A gate that asks a QUESTION is answered, not granted.
   *
   * The per-run approval card renders the same answer box the inbox row does,
   * and its decision goes through a different forwarder. That forwarder
   * dropped the value, so the workspace received an ordinary approve, looked
   * for an approval token a HumanTask never registers, and answered
   * `/control/RunNotFound` for a run that was open on screen — which the card
   * showed as "Approval submission failed" (workspace 4bb93306, run-1).
   */
  const askRow = (runId: string, requestId: string) => {
    const { request: _grantRequest, ...row } = approvalRow(runId, requestId, "Which service owns the retry budget?")
    return {
      ...row,
      // `waitRunId` is the gateway's marker that this gate is a human wait
      // rolled up from an execution below the run.
      waitRunId: `${runId}-prepare-plan`,
      request: {
        task: "human",
        name: "coding-clarification",
        kind: "ask",
        prompt: "Which service owns the retry budget?",
        attempt: 1,
        maxAttempts: 3
      }
    }
  }

  test("a per-run approval card sends the answer with the decision", async () => {
    const store = await webStore()
    const row = askRow("run-a", "coding-clarification#1")
    const double = relay({ approvals: [row], runs: [{ runId: "run-a", flowId: "coding/request", status: "waiting-approval" }] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    await controller.commands.run("approvals.open", "run-a")
    await settle(4)

    const card = [...store.collections.cards.values()].find((entry) => entry.kind === "approval")
    expect(card).toBeDefined()
    // The card carries the question, which is what puts the box on screen.
    expect(card?.kind === "approval" ? card.payload.question?.kind : undefined).toBe("ask")

    controller.answerApproval(card!.id, "the scheduler owns it")
    await settle(4)

    expect(double.state.submitted).toHaveLength(1)
    expect(double.state.submitted[0]?.decision).toBe("approve")
    // The value the person typed reached the workspace with the envelope.
    expect((double.state.submitted[0]?.approval as { answer?: unknown }).answer).toBe("the scheduler owns it")
  })

  test("an inbox row sends the answer with the decision", async () => {
    const store = await webStore()
    const row = askRow("run-a", "coding-clarification#1")
    const double = relay({ approvals: [row] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    await listInbox(controller, store)
    const id = inboxCard(store)!.id
    expect(inboxCard(store)?.payload.approvals[0]?.question?.prompt).toBe("Which service owns the retry budget?")

    controller.answerApproval(approvalActionId(id, row), "the scheduler owns it")
    await settle(4)

    expect((double.state.submitted[0]?.approval as { answer?: unknown }).answer).toBe("the scheduler owns it")
  })

  test("a nested human question keeps its structured answer through normalized inbox and individual card submissions", async () => {
    for (const door of ["inbox", "card"] as const) {
      const store = await webStore()
      const question = { ...approvalRow("run-a", "question:1", "Which services?"), waitRunId: "child-run", request: { question: "Which services?", kind: "json", prompt: "Which services?" } }
      const double = relay({ approvals: [question], runs: [{ runId: "run-a", flowId: "review-pr", status: "waiting-approval" }] })
      const controller = createAppController(store, silentAgent, double.services)
      await signIn(store)
      await listInbox(controller, store)
      const currentInbox = inboxCard(store)!
      expect(currentInbox.payload.approvals[0]?.question?.prompt).toBe("Which services?")
      let id = approvalActionId(currentInbox.id, question)
      if (door === "card") {
        await controller.commands.run("approvals.open", "run-a")
        const approval = [...store.collections.cards.values()].find(card => card.kind === "approval" && card.payload.requestId === question.requestId)
        expect(approval?.kind).toBe("approval")
        id = approval!.id
      }
      const answer = { services: ["api", "worker"], note: 'Keep "the retry" budget\nwith the owner.' }
      controller.answerApproval(id, answer)
      await waitFor(() => double.state.submitted.length === 1)
      expect(double.state.submitted[0]).toEqual({ approval: { ...question.payload, answer }, decision: "approve" })
      await waitFor(() => [...store.collections.runtimeApprovals.values()].some(row => row.row.status === "approved"))
      expect([...store.collections.runtimeApprovals.values()].every(row => row.pending !== true)).toBe(true)
    }
  })

  test("two runs with the same request ID have independent actions, pending state and refresh receipts", async () => {
    const store = await webStore()
    const first = approvalRow("run-a", "deploy:gate", "Deploy A?")
    const second = approvalRow("run-b", "deploy:gate", "Deploy B?")
    const double = relay({ approvals: [first, second] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    await listInbox(controller, store)
    const id = inboxCard(store)!.id
    // Legacy addresses must fail closed when more than one run owns the name.
    controller.decideApproval(`${id}:deploy:gate`, "approved")
    await settle(4)
    expect(double.state.submitted).toHaveLength(0)
    await controller.commands.run("approval.deny", approvalActionId(id, second))
    await settle(4)
    expect(double.state.submitted).toEqual([{ approval: second.payload, decision: "deny" }])
    expect(inboxCard(store)!.payload.approvals.map((row) => row.decision)).toEqual([undefined, "denied"])
    await listInbox(controller, store)
    expect(inboxCard(store)!.payload.approvals.map((row) => row.decision)).toEqual([undefined, "denied"])
    await controller.commands.run("approval.approve", approvalActionId(id, first))
    await settle(4)
    expect(double.state.submitted[1]).toEqual({ approval: first.payload, decision: "approve" })
    expect(inboxCard(store)!.payload.approvals.map((row) => row.decision)).toEqual(["approved", "denied"])
  })

  test("a refused decision lands on the row as the error, never a fake freeze", async () => {
    const store = await webStore()
    const double = relay({
      approvals: [approvalRow("run-a", "req-1", "Run the deploy script?")],
      refusals: { "Approval.Submit": "Stale: the gate was already decided" }
    })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    await listInbox(controller, store)
    await controller.commands.run("approval.deny", `approvals-inbox-${REPO}-${TEST_BOX}:req-1`)
    await settle(4)
    const card = inboxCard(store)
    expect(card?.payload.approvals[0]?.decision).toBeUndefined()
    expect(card?.payload.approvals[0]?.decisionError).toContain("Stale")
  })

  test("approvals.open materializes a run's pending gates as ordinary approval cards", async () => {
    const store = await webStore()
    const double = relay({ approvals: [approvalRow("run-a", "req-1", "Run the deploy script?")] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    const opened = await controller.commands.run("approvals.open", "run-a")
    expect(said(opened)).toContain("1 approval opened for run run-a")
    const card = store.collections.cards.get(approvalCardIdFor(store, { repo: REPO, workspaceId: TEST_BOX, runId: "run-a" }, "req-1"))
    expect(card?.kind === "approval" && card.payload.runId).toBe("run-a")
    expect(card?.kind === "approval" && card.payload.repo).toBe(REPO)

    // And those cards decide through the ordinary per-card path.
    await controller.commands.run("approval.approve", approvalCardIdFor(store, { repo: REPO, workspaceId: TEST_BOX, runId: "run-a" }, "req-1"))
    await settle(4)
    expect(double.state.submitted).toHaveLength(1)
  })

  /*
   * The read is slow on purpose here: provisioning and the inbox projection
   * each wait for the test to release them, the way a sleeping workspace
   * holds Projection.Snapshot in the gateway's resume loop. The ask must
   * answer before either finishes, and nothing may claim rows it has not
   * received.
   */
  const heldRelay = (options: Parameters<typeof relay>[0] = {}) => {
    const double = relay(options)
    const original = double.services.fetchImpl!
    const gate = { provision: Promise.resolve(), read: Promise.resolve() }
    const started = { provision: 0, read: 0 }
    const hold = (name: "provision" | "read") => {
      let release!: () => void
      gate[name] = new Promise<void>((resolve) => { release = resolve })
      return release
    }
    const services: AppServices = { ...double.services, fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { procedure?: string; payload?: { selector?: { _tag?: string } } } : undefined
      if (url.endsWith("/api/workflow/provision")) { started.provision += 1; await gate.provision }
      if (body?.procedure === "Projection.Snapshot" && body.payload?.selector?._tag === "approvals") { started.read += 1; await gate.read }
      return original(input, init)
    } }
    return { double, services, hold, started }
  }
  const inboxToastId = `toast-approvals.list.approvals-inbox-${REPO}-${TEST_BOX}`
  const inboxToasts = (store: Awaited<ReturnType<typeof webStore>>) => [...store.collections.toasts.values()].filter((toast) => toast.key.startsWith("approvals.list."))
  const mutations = (double: ReturnType<typeof relay>) => double.calls.filter((call) => {
    const procedure = (call.body as { procedure?: string } | undefined)?.procedure
    return procedure === "Approval.Submit" || procedure === "Run" || procedure === "Resume"
  })

  const interceptInboxDispatch = (store: Awaited<ReturnType<typeof webStore>>, dispatch: typeof store.dispatch) =>
    new Proxy(store, { get: (target, key, receiver) => key === "dispatch" ? dispatch : Reflect.get(target, key, receiver) })
  const holdInboxReceipt = (transaction: ReturnType<Awaited<ReturnType<typeof webStore>>["dispatch"]>, wait: Promise<void>) => {
    const receipt = wait.then(() => transaction.isPersisted.promise)
    return new Proxy(transaction, { get: (target, key, receiver) => key === "isPersisted"
      ? { ...target.isPersisted, promise: receipt } : Reflect.get(target, key, receiver) })
  }

  test("approvals.list waits for the inbox result receipt before retiring its request or claiming success", async () => {
    const store = await webStore()
    let release!: () => void
    const saving = new Promise<void>((resolve) => { release = resolve })
    let held = false
    const guarded = interceptInboxDispatch(store, (transition) => {
      const transaction = store.dispatch(transition)
      if (transition.type === "card.upsert" && transition.card.kind === "approvals-inbox") {
        held = true
        return holdInboxReceipt(transaction, saving)
      }
      return transaction
    })
    const double = relay()
    const controller = createAppController(guarded, silentAgent, double.services)
    await signIn(store)
    try {
      await controller.commands.run("approvals.list")
      await waitFor(() => held)
      await settle(4)
      expect(inboxRequests(store)).toHaveLength(1)
      expect(store.collections.toasts.get(inboxToastId)?.status).not.toBe("ok")
      release()
      await waitFor(() => inboxRequests(store).length === 0)
      expect(store.collections.toasts.get(inboxToastId)?.status).toBe("ok")
      expect(mutations(double)).toEqual([])
    } finally { release() }
  })

  for (const failedStep of ["card.upsert", "approvals.inbox.settled"] as const) {
    test(`approvals.list keeps an honest retryable failure when ${failedStep} cannot persist`, async () => {
      const storage = memoryStorage()
      let failNextWrite = false
      let failedWrites = 0
      const store = await createAppStore({ kind: "localStorage", storage: { ...storage, setItem: (key, value) => {
        if (failNextWrite) { failNextWrite = false; failedWrites += 1; throw new Error("approval storage refused") }
        storage.setItem(key, value)
      } } })
      let refuse = true
      const guarded = interceptInboxDispatch(store, (transition) => {
        if (refuse && ((failedStep === "card.upsert" && transition.type === "card.upsert" && transition.card.kind === "approvals-inbox") ||
          (failedStep === "approvals.inbox.settled" && transition.type === "approvals.inbox.settled" && transition.error === undefined))) {
          refuse = false
          failNextWrite = true
        }
        return store.dispatch(transition)
      })
      const double = relay()
      const controller = createAppController(guarded, silentAgent, double.services)
      await signIn(store)
      await controller.commands.run("approvals.list")
      await waitFor(() => failedWrites === 1)
      await settle(8)
      await store.settled?.().catch(() => {})
      expect(store.collections.toasts.get(inboxToastId)?.status).toBe("failed")
      expect(inboxRequests(store)).toHaveLength(1)
      expect(inboxRequests(store)[0]?.error).toContain("could not be saved")
      if (failedStep === "card.upsert") expect(inboxCard(store)).toBeUndefined()
      else expect(inboxCard(store)).toBeDefined()
      await signIn(store)
      await settle(6)
      expect(double.calls.filter((call) => (call.body as { procedure?: string } | undefined)?.procedure === "Projection.Snapshot")).toHaveLength(1)
      expect(mutations(double)).toEqual([])
    })
  }

  test("an approvals failure that also cannot persist leaves the original request owed", async () => {
    const storage = memoryStorage()
    let failNextWrite = false
    let failedWrites = 0
    const store = await createAppStore({ kind: "localStorage", storage: { ...storage, setItem: (key, value) => {
      if (failNextWrite) { failNextWrite = false; failedWrites += 1; throw new Error("approval storage refused") }
      storage.setItem(key, value)
    } } })
    const guarded = interceptInboxDispatch(store, (transition) => {
      if ((transition.type === "card.upsert" && transition.card.kind === "approvals-inbox") || transition.type === "approvals.inbox.settled") failNextWrite = true
      return store.dispatch(transition)
    })
    const double = relay()
    const controller = createAppController(guarded, silentAgent, double.services)
    await signIn(store)
    await controller.commands.run("approvals.list")
    await waitFor(() => failedWrites === 2)
    await settle(8)
    await store.settled?.().catch(() => {})
    expect(inboxRequests(store)).toHaveLength(1)
    expect(inboxRequests(store)[0]?.error).toBeUndefined()
    expect(inboxCard(store)).toBeUndefined()
    expect(store.collections.toasts.get(inboxToastId)).toMatchObject({ status: "failed", detail: "Approvals could not be saved. Try again." })
    expect(mutations(double)).toEqual([])
  })

  test("a duplicate approvals ask waiting for persistence cannot write into a replacement account", async () => {
    const store = await webStore()
    let release!: () => void
    const saving = new Promise<void>((resolve) => { release = resolve })
    let requests = 0
    const guarded = interceptInboxDispatch(store, (transition) => {
      const transaction = store.dispatch(transition)
      if (transition.type === "approvals.inbox.requested" && ++requests === 1) return holdInboxReceipt(transaction, saving)
      return transaction
    })
    const double = relay()
    const controller = createAppController(guarded, silentAgent, double.services)
    await signIn(store)
    try {
      const first = controller.commands.run("approvals.list")
      await waitFor(() => requests === 1)
      const second = controller.commands.runForAgent("approvals.list")
      await settle(3)
      await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "someone-else", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      release()
      await Promise.all([first, second])
      await settle(6)
      expect(requests).toBe(1)
      expect(inboxRequests(store)).toEqual([])
      expect(inboxCard(store)).toBeUndefined()
      expect(double.calls.filter((call) => call.path.startsWith("/api/workflow/"))).toEqual([])
      expect(mutations(double)).toEqual([])
    } finally { release() }
  })

  test("a duplicate approvals ask waiting for persistence cannot cross a failed sign-out epoch", async () => {
    const store = await webStore()
    let release!: () => void
    const saving = new Promise<void>((resolve) => { release = resolve })
    let requests = 0
    const guarded = interceptInboxDispatch(store, (transition) => {
      if (transition.type === "identity.session.cleared") throw new Error("privacy cleanup refused")
      const transaction = store.dispatch(transition)
      if (transition.type === "approvals.inbox.requested" && ++requests === 1) return holdInboxReceipt(transaction, saving)
      return transaction
    })
    const double = relay()
    const controller = createAppController(guarded, silentAgent, { ...double.services, fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      return url.endsWith("/api/auth/logout") ? json(200, { ok: true }) : double.services.fetchImpl!(input, init)
    } })
    await signIn(store)
    try {
      const first = controller.commands.run("approvals.list")
      await waitFor(() => requests === 1)
      const second = controller.commands.runForAgent("approvals.list")
      await settle(3)
      expect(await controller.signOut()).toContain("cleanup is incomplete")
      release()
      await Promise.all([first, second])
      await settle(6)
      expect(requests).toBe(1)
      expect(inboxRequests(store)).toHaveLength(1)
      expect(inboxCard(store)).toBeUndefined()
      expect(double.calls.filter((call) => call.path.startsWith("/api/workflow/"))).toEqual([])
      expect(mutations(double)).toEqual([])
    } finally { release() }
  })

  test("failed sign-out cleanup still fences an already running approvals read by account epoch", async () => {
    const store = await webStore()
    const guarded = interceptInboxDispatch(store, (transition) => {
      if (transition.type === "identity.session.cleared") throw new Error("privacy cleanup refused")
      return store.dispatch(transition)
    })
    const { double, services, hold, started } = heldRelay({ approvals: [approvalRow("run-a", "req-1", "Private approval")] })
    const releaseRead = hold("read")
    const controller = createAppController(guarded, silentAgent, { ...services, fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      return url.endsWith("/api/auth/logout") ? json(200, { ok: true }) : services.fetchImpl!(input, init)
    } })
    await signIn(store)
    try {
      await controller.commands.run("approvals.list")
      await waitFor(() => started.read === 1)
      const request = inboxRequests(store)[0]!
      expect(await controller.signOut()).toContain("cleanup is incomplete")
      expect(store.collections.identitySessions.get("identity")?.login).toBe(request.owner)
      releaseRead()
      await settle(10)
      expect(inboxCard(store)).toBeUndefined()
      expect(inboxRequests(store)).toEqual([request])
      expect(store.collections.toasts.get(inboxToastId)).toBeUndefined()
      expect(mutations(double)).toEqual([])
    } finally { releaseRead() }
  })

  test("approvals.list persists its request and acknowledges before provision or the read answers; one toast runs through both", async () => {
    const store = await webStore()
    const { double, services, hold, started } = heldRelay({ approvals: [approvalRow("run-a", "req-1", "Run the deploy script?")] })
    const releaseProvision = hold("provision")
    const releaseRead = hold("read")
    const controller = createAppController(store, silentAgent, services)
    await signIn(store)

    const outcome = await controller.commands.run("approvals.list")
    expect(said(outcome)).toBe("Approvals requested.")
    // The request is on record before the acknowledgment, with its target and owner fixed.
    expect(inboxRequests(store)).toMatchObject([{ repo: REPO, owner: "codeplanesmithers" }])
    expect(inboxRequests(store)[0]?.error).toBeUndefined()
    expect(inboxCard(store)).toBeUndefined()
    await waitFor(() => started.provision === 1)
    expect(started.read).toBe(0)
    await waitFor(() => store.collections.toasts.get(inboxToastId)?.status === "running")

    // Chat and unrelated acts stay usable while both waits are held.
    expect((await controller.commands.run("appearance.dark-mode")).status).toBe("executed")
    controller.send("still chatting")
    await waitFor(() => [...store.collections.messages.values()].some((row) => row.role === "user" && row.text === "still chatting"))

    releaseProvision()
    await waitFor(() => started.read === 1)
    await settle(4)
    // Provisioning settled, the read is still owed: no rows, no receipt, the notice still runs.
    expect(store.collections.toasts.get(inboxToastId)?.status).toBe("running")
    expect(inboxCard(store)).toBeUndefined()
    expect(inboxRequests(store)).toHaveLength(1)

    releaseRead()
    await waitFor(() => inboxCard(store) !== undefined)
    expect(inboxCard(store)?.payload.approvals.map((row) => row.title)).toEqual(["Run the deploy script?"])
    await waitFor(() => inboxRequests(store).length === 0)
    expect(store.collections.toasts.get(inboxToastId)).toMatchObject({ status: "ok", title: "Approvals loaded" })
    expect(mutations(double)).toEqual([])
  })

  test("duplicate asks share one read across the user and agent doors", async () => {
    const store = await webStore()
    const { double, services, hold, started } = heldRelay({ approvals: [approvalRow("run-a", "req-1", "Run the deploy script?")] })
    const releaseRead = hold("read")
    const controller = createAppController(store, silentAgent, services)
    await signIn(store)

    const asks = await Promise.all([
      controller.commands.run("approvals.list"),
      controller.commands.run("approvals.list", REPO),
      controller.commands.runForAgent("approvals.list")
    ])
    for (const ask of asks) expect(said(ask)).toBe("Approvals requested.")
    await waitFor(() => started.read === 1)
    expect(said(await controller.commands.run("approvals.list"))).toBe("Approvals requested.")
    await settle(6)
    expect(started.provision).toBe(1)
    expect(started.read).toBe(1)
    expect(inboxRequests(store)).toHaveLength(1)
    expect(inboxToasts(store)).toHaveLength(1)

    releaseRead()
    await waitFor(() => inboxRequests(store).length === 0)
    expect(inboxCard(store)?.payload.approvals).toHaveLength(1)
    expect(started.read).toBe(1)
    expect(mutations(double)).toEqual([])
  })

  test("a refused read stays a visible, retryable failure and publishes no card", async () => {
    const store = await webStore()
    const refusals: Record<string, string> = { approvals: "The workspace is still waking up" }
    const { double, services, started } = heldRelay({ approvals: [approvalRow("run-a", "req-1", "Run the deploy script?")], projectionRefusals: refusals })
    const controller = createAppController(store, silentAgent, services)
    await signIn(store)

    expect(said(await controller.commands.run("approvals.list"))).toBe("Approvals requested.")
    await waitFor(() => inboxRequests(store)[0]?.error !== undefined)
    const failed = inboxRequests(store)[0]!
    expect(failed.error).toContain("still waking up")
    expect(inboxCard(store)).toBeUndefined()
    await waitFor(() => store.collections.toasts.get(inboxToastId)?.status === "failed")
    expect(store.collections.toasts.get(inboxToastId)?.detail).toContain("still waking up")

    // A recorded failure never restarts by itself; the identity answer that resumes owed reads skips it.
    await signIn(store)
    await settle(6)
    expect(started.read).toBe(1)

    // An explicit ask again is the retry: a new request replaces the failed one and the rows land.
    delete refusals.approvals
    expect(said(await controller.commands.run("approvals.list"))).toBe("Approvals requested.")
    expect(inboxRequests(store)[0]?.id).not.toBe(failed.id)
    expect(inboxRequests(store)[0]?.error).toBeUndefined()
    await waitFor(() => inboxRequests(store).length === 0)
    expect(inboxCard(store)?.payload.approvals).toHaveLength(1)
    expect(store.collections.toasts.get(inboxToastId)?.status).toBe("ok")
    expect(started.read).toBe(2)
    expect(mutations(double)).toEqual([])
  })

  test("a reload reconnects the request to its original target, not the repository selected since", async () => {
    const workspaceA = "83e75ae5-0920-4000-8000-00000000000a"
    const workspaceB = "83e75ae5-0920-4000-8000-00000000000b"
    const selectWorkspace = async (store: Awaited<ReturnType<typeof webStore>>, id: string) => {
      await store.dispatch({ type: "workspace.updated", actor: "system", workspace: {
        id, repoId: REPO, name: "Coding", status: "running", targetBookmark: "main", provisioningStage: null, suspendedAt: null, createdAt: null, head: null
      } }).isPersisted.promise
      await settle(2)
      store.dispatch({ type: "repo.selected", actor: "user", id: `${REPO}#workspace:${id}` })
      expect(store.session().activeRepoKey).toBe(`${REPO}#workspace:${id}`)
    }
    const storage = memoryStorage()
    let store = await createAppStore({ kind: "localStorage", storage })
    const first = heldRelay({ approvals: [approvalRow("run-a", "req-1", "Run the deploy script?")] })
    first.hold("read")
    let controller = createAppController(store, silentAgent, first.services)
    await signIn(store)
    await selectWorkspace(store, workspaceA)
    expect(said(await controller.commands.run("approvals.list", REPO))).toBe("Approvals requested.")
    await waitFor(() => first.started.read === 1)
    expect(inboxRequests(store)).toMatchObject([{ repo: REPO, workspaceId: workspaceA, owner: "codeplanesmithers" }])
    // The page closes with the read still held: nothing was published.
    await controller.dispose()
    expect(store.collections.cards.get(`approvals-inbox-${REPO}-${workspaceA}`)).toBeUndefined()

    store = await createAppStore({ kind: "localStorage", storage })
    expect(inboxRequests(store)).toMatchObject([{ repo: REPO, workspaceId: workspaceA }])
    const second = heldRelay({ approvals: [approvalRow("run-a", "req-1", "Run the deploy script?")] })
    const releaseSecondRead = second.hold("read")
    controller = createAppController(store, silentAgent, second.services)
    // A different workspace is selected before the identity answer reconnects the owed read.
    await selectWorkspace(store, workspaceB)
    await signIn(store)
    await waitFor(() => second.started.read === 1, 10_000)
    const toastId = `toast-approvals.list.approvals-inbox-${REPO}-${workspaceA}`
    await waitFor(() => store.collections.toasts.get(toastId)?.status === "running")
    // Reconnected to the recorded target, still owed: no card yet, on either workspace.
    expect(inboxRequests(store)).toMatchObject([{ workspaceId: workspaceA }])
    expect(store.collections.cards.get(`approvals-inbox-${REPO}-${workspaceA}`)).toBeUndefined()
    releaseSecondRead()
    await waitFor(() => inboxRequests(store).length === 0, 10_000)
    expect(store.collections.cards.get(`approvals-inbox-${REPO}-${workspaceA}`)).toMatchObject({ payload: { workspaceId: workspaceA } })
    expect(store.collections.cards.get(`approvals-inbox-${REPO}-${workspaceB}`)).toBeUndefined()
    for (const call of second.double.calls.filter((call) => call.path.startsWith("/api/workflow/"))) expect(call.body).toMatchObject({ workspaceId: workspaceA })
    expect(second.started.read).toBe(1)
    expect(store.collections.toasts.get(toastId)).toMatchObject({ status: "ok", title: "Approvals loaded" })
    expect(mutations(first.double)).toEqual([])
    expect(mutations(second.double)).toEqual([])
  }, 20_000)

  test("an account change while the read is held publishes nothing and leaves no request behind", async () => {
    const store = await webStore()
    const { double, services, hold, started } = heldRelay({ approvals: [approvalRow("run-a", "req-1", "Run the deploy script?")] })
    const releaseRead = hold("read")
    const controller = createAppController(store, silentAgent, services)
    await signIn(store)
    expect(said(await controller.commands.run("approvals.list"))).toBe("Approvals requested.")
    await waitFor(() => started.read === 1)
    await waitFor(() => store.collections.toasts.get(inboxToastId)?.status === "running")

    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "someone-else", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    expect(inboxRequests(store)).toEqual([])
    releaseRead()
    await settle(10)
    expect(inboxCard(store)).toBeUndefined()
    expect(inboxRequests(store)).toEqual([])
    expect(store.collections.toasts.get(inboxToastId)).toBeUndefined()
    expect(started.read).toBe(1)
    expect(mutations(double)).toEqual([])
  })

  test("disposal while the read is held writes neither rows nor a receipt", async () => {
    const store = await webStore()
    const { double, services, hold, started } = heldRelay({ approvals: [approvalRow("run-a", "req-1", "Run the deploy script?")] })
    const releaseRead = hold("read")
    const controller = createAppController(store, silentAgent, services)
    await signIn(store)
    expect(said(await controller.commands.run("approvals.list"))).toBe("Approvals requested.")
    await waitFor(() => started.read === 1)
    const request = inboxRequests(store)[0]!
    await controller.dispose()
    releaseRead()
    await settle(10)
    expect(inboxCard(store)).toBeUndefined()
    expect(inboxRequests(store)).toEqual([request])
    expect(mutations(double)).toEqual([])
  })
})

describe("typed coding launch and plan inspection", () => {
  test("the existing actor-tagged selection command reads prepared native plan evidence and respects the cursor", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-1", flowId: "coding", status: "running" }] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    await openMonitor(controller, store, `run-1 ${REPO}`)
    const original = store.collections.cards.get(boxRunCard("run-1")) as Extract<Card, { kind: "run-trace" }>
    await store.dispatch({ type: "card.upsert", actor: "system", card: { ...original,
      payload: { ...original.payload, input: { prompt: CODING_PLAN.prompt }, events: preparedCodingJournal(), lastSeq: 5 } } })
    expect((await controller.commands.runForAgent("runs.coding.select", `sourceCard=${original.id} run-1 memory`)).status).toBe("executed")
    const selected = store.collections.cards.get(original.id) as typeof original
    expect(selected.payload.codingChangeId).toBe("memory")
    expect([...store.collections.transitions.values()].filter(row => row.type === "card.upsert").sort((a, b) => a.revision - b.revision).at(-1)?.actor).toBe("smithers")
    await store.dispatch({ type: "card.upsert", actor: "user", card: { ...selected, payload: { ...selected.payload, cursorSeq: 3, liveTail: false } } })
    expect(said(await controller.commands.run("runs.coding.select", `sourceCard=${original.id} run-1 memory`))).toContain("no recorded planned Change")
  })

  test("flow.run preserves structured input, selection is actor-tagged and persisted, and reopening retains the plan", async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    const double = relay({ runs: [{ runId: "run-1", flowId: "coding", status: "running" }] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    const launched = await controller.commands.run("flow.run", `coding ${REPO} ${JSON.stringify({ plan: CODING_PLAN })}`)
    expect(launched.status).toBe("executed")
    await waitFor(() => runCardInScope(store, { repo: REPO, workspaceId: TEST_BOX, runId: "run-1" }) !== undefined)
    expect(double.state.launched[0]).toEqual({ workflow: "coding", input: { plan: CODING_PLAN }, repo: REPO })
    expect((await controller.commands.runForAgent("runs.coding.select", "run-1 memory")).status).toBe("executed")
    let card = runCardInScope(store, { repo: REPO, workspaceId: TEST_BOX, runId: "run-1" }) as Extract<Card, { kind: "run-trace" }>
    expect(card.payload.codingChangeId).toBe("memory")
    expect([...store.collections.transitions.values()].filter((row) => row.type === "card.upsert").sort((a, b) => a.revision - b.revision).at(-1)?.actor).toBe("smithers")
    await openMonitor(controller, store, `run-1 ${REPO}`)
    card = runCardInScope(store, { repo: REPO, workspaceId: TEST_BOX, runId: "run-1" }) as typeof card
    expect(workflowInputOf(card)).toEqual({ plan: CODING_PLAN })
    expect(card.payload.codingChangeId).toBe("memory")
    expect(said(await controller.commands.run("runs.coding.select", "run-1 fabricated"))).toContain("no recorded planned Change")
    await settle()
    controller.dispose()
    await store.dispose?.()
    const reloaded = await createAppStore({ kind: "localStorage", storage })
    const restored = runCardInScope(reloaded, { repo: REPO, workspaceId: TEST_BOX, runId: "run-1" }) as typeof card
    expect(restored.payload.codingChangeId).toBe("memory")
    expect(workflowInputOf(restored)).toEqual({ plan: CODING_PLAN })
    const second = createAppController(reloaded, silentAgent, double.services)
    await second.commands.run("runs.coding.select", "run-1 memory")
    expect((reloaded.collections.cards.get(card.id) as typeof card).payload.codingChangeId).toBeUndefined()
    second.dispose()
    await reloaded.dispose?.()
  })

  test("JSON input uses the existing schema form and malformed JSON launches nothing", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    const invalid = await controller.commands.run("flow.run", `coding ${REPO} {invalid`)
    expect(invalid.status).toBe("form")
    expect(double.state.launched).toHaveLength(0)
    const form = store.collections.cards.get("form-flow.run")
    expect(form?.kind === "flow-form" && form.payload.draft).toMatchObject({ name: "coding", repo: REPO, input: "{invalid" })
    expect(form?.kind === "flow-form" && form.payload.fields.some((field) => field.name === "input" && field.label === "Input JSON")).toBe(true)
    expect(form?.kind === "flow-form" && form.payload.error).toContain("not valid JSON")
    expect(said(await controller.commands.run("form.submit", "form-flow.run"))).toContain("not valid JSON")
    expect(double.state.launched).toHaveLength(0)
    await controller.commands.run("form.set", `form-flow.run input ${JSON.stringify({ plan: CODING_PLAN })}`)
    const result = await controller.commands.run("form.submit", "form-flow.run")
    expect(result.status).toBe("executed")
    expect(double.state.launched[0]?.input).toEqual({ plan: CODING_PLAN })
    const missing = await controller.commands.runForAgent("runs.coding.select", "run-1")
    expect(missing).toMatchObject({ status: "form", fields: ["changeId"] })
  })
})

describe("workspace-bound run cards", () => {
  const workspaceId = "83e75ae5-0920-4000-8000-000000000001"
  const selectWorkspace = async (store: Awaited<ReturnType<typeof webStore>>, id = workspaceId) => {
    await store.dispatch({
      type: "workspace.updated", actor: "system", workspace: {
        id, repoId: REPO, name: "Coding", status: "running", targetBookmark: "main",
        provisioningStage: null, suspendedAt: null, createdAt: null, head: null
      }
    }).isPersisted.promise
    await settle(2)
    store.dispatch({ type: "repo.selected", actor: "user", id: `${REPO}#workspace:${id}` })
    expect(store.session().activeRepoKey).toBe(`${REPO}#workspace:${id}`)
  }

  test("source-qualified flow catalogs and launches retain the original host through selection and reload", async () => {
    const storage = memoryStorage()
    let store = await createAppStore({ kind: "localStorage", storage })
    const double = relay({ runs: [{ runId: "run-1", flowId: "coding/request", status: "completed" }] })
    let controller = createAppController(store, silentAgent, double.services)
    await signIn(store, [REPO, "other/repo"])
    await selectWorkspace(store)
    expect((await controller.commands.run("flow.run", "coding/request")).status).toBe("executed")
    await waitFor(() => runCardInScope(store, { repo: REPO, workspaceId, runId: "run-1" }) !== undefined)
    const source = runCardInScope(store, { repo: REPO, workspaceId, runId: "run-1" })!
    await waitFor(() => runCardInScope(store, source.payload)?.payload.phase === "completed")
    await selectWorkspace(store, "ffffffff-ffff-ffff-ffff-ffffffffffff")
    const before = double.calls.length
    expect((await controller.commands.run("flow.list", `sourceCard=${source.id}`)).status).toBe("executed")
    await waitFor(() => [...store.collections.cards.values()].some(card => card.kind === "workflow-list" && card.payload.workspaceId === workspaceId && !card.loading))
    const catalog = [...store.collections.cards.values()].find(card => card.kind === "workflow-list" && card.payload.workspaceId === workspaceId)!
    expect(catalog).toMatchObject({ payload: { repo: REPO, workspaceId, gatewayBindingVersion: 1 } })
    expect(catalog.id).not.toBe(`workflow-list-${REPO}`)
    const missing = await controller.commands.runForAgent("flow.run", `sourceCard=${source.id}`)
    expect(missing).toMatchObject({ status: "form", fields: ["name"] })
    expect(store.collections.cards.get("form-flow.run")).toMatchObject({ payload: { draft: { sourceCard: source.id } } })
    expect((await controller.commands.run("flow.run", `sourceCard=${source.id} coding/vibe {"requestExecutionId":"native-request"}`)).status).toBe("executed")
    await waitFor(() => double.state.launched.at(-1)?.workflow === "coding/vibe")
    expect(double.state.launched.at(-1)).toMatchObject({ workflow: "coding/vibe", input: { requestExecutionId: "native-request" } })
    for (const call of double.calls.slice(before).filter(call => call.path.startsWith("/api/workflow/"))) expect(call.body).toMatchObject({ workspaceId })
    const refused = double.calls.length
    expect(said(await controller.commands.run("flow.run", `sourceCard=${source.id} coding/vibe other/repo`))).toContain("another repository")
    expect(said(await controller.commands.run("flow.list", "sourceCard=missing"))).toContain("unavailable")
    expect(double.calls.length).toBe(refused)
    await settle()
    await controller.dispose()
    store = await createAppStore({ kind: "localStorage", storage })
    controller = createAppController(store, silentAgent, double.services)
    expect(store.collections.cards.get(catalog.id)).toMatchObject({ payload: { workspaceId, gatewayBindingVersion: 1 } })
    const afterReload = double.calls.length
    expect((await controller.commands.run("flow.run", `sourceCard=${catalog.id} review-pr`)).status).toBe("executed")
    await waitFor(() => double.state.launched.at(-1)?.workflow === "review-pr")
    for (const call of double.calls.slice(afterReload).filter(call => call.path.startsWith("/api/workflow/"))) expect(call.body).toMatchObject({ workspaceId })
  })

  test("list and inbox cards retain their gateway across provision, reload, filters and uncarded row actions", async () => {
    const storage = memoryStorage()
    let store = await createAppStore({ kind: "localStorage", storage })
    const double = relay({
      runs: [{ runId: "listed", flowId: "review-pr", status: "completed" }],
      approvals: [approvalRow("gated", "gate-a", "Review the change"), approvalRow("direct", "gate-b", "Apply the change")]
    })
    const fetch = double.services.fetchImpl!
    const services = { ...double.services, fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/api/workflow/provision")) store.dispatch({ type: "repo.selected", actor: "user", id: REPO })
      return fetch(input, init)
    } }
    let controller = createAppController(store, silentAgent, services)
    await signIn(store)
    await selectWorkspace(store)
    expect((await listInventory(controller, store, "runs.list", REPO)).status).toBe("executed")
    await selectWorkspace(store)
    await listInbox(controller, store, REPO)
    const listId = `run-list-${REPO}-${workspaceId}`
    const inboxId = `approvals-inbox-${REPO}-${workspaceId}`
    expect(store.collections.cards.get(listId)).toMatchObject({ payload: { workspaceId } })
    expect(store.collections.cards.get(inboxId)).toMatchObject({ payload: { workspaceId } })
    await settle(10)
    await controller.dispose()
    store = await createAppStore({ kind: "localStorage", storage })
    controller = createAppController(store, silentAgent, services)
    await signIn(store)
    await selectWorkspace(store, "ffffffff-ffff-ffff-ffff-ffffffffffff")
    await listInventory(controller, store, "runs.list", `completed sourceCard=${listId} ${REPO}`)
    await openMonitor(controller, store, "listed")
    await controller.commands.run("approvals.open", "gated")
    expect(runCardInScope(store, { repo: REPO, runId: "listed", workspaceId })).toMatchObject({ payload: { workspaceId } })
    expect(store.collections.cards.get(approvalCardIdFor(store, { repo: REPO, runId: "gated", workspaceId }, "gate-a"))).toMatchObject({ payload: { workspaceId } })
    await controller.commands.run("approval.approve", approvalCardIdFor(store, { repo: REPO, runId: "gated", workspaceId }, "gate-a"))
    await controller.commands.run("approval.approve", `${inboxId}:gate-b`)
    await waitFor(() => double.state.submitted.length === 2, 10_000)
    for (const call of double.calls.filter((call) => call.path.startsWith("/api/workflow/"))) expect(call.body).toMatchObject({ workspaceId })
  })

  test("older ancillary omissions use the already-recorded bound run after persistence reload", async () => {
    const storage = memoryStorage()
    let store = await createAppStore({ kind: "localStorage", storage })
    const double = relay({ runs: [{ runId: "run-1", flowId: "review-pr", status: "completed" }], approvals: [approvalRow("run-1", "old-gate", "Approve")] })
    let controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    // Actual pre-binding rows: persisted before the new writer/version existed.
    const approval = approvalRow("run-1", "old-gate", "Approve")
    const base = { title: "Old", status: "active" as const, createdAt: 1, ordinal: 1 }
    for (const card of [
      { ...base, id: "flow-run-run-1", kind: "run-trace", payload: { repo: REPO, workspaceId, runId: "run-1", workflow: "review-pr", phase: "completed", steps: [], result: null, lastSeq: 0 } },
      { ...base, id: `run-list-${REPO}`, kind: "run-list", payload: { repo: REPO, runs: [{ runId: "run-1", flowId: "review-pr", status: "completed", createdAt: 1, turns: 0, calls: 0 }] } },
      { ...base, id: "approval-run-1-old-gate", kind: "approval", payload: { repo: REPO, runId: "run-1", requestId: "old-gate", capability: "Approve", approval: approval.payload } },
      { ...base, id: `approvals-inbox-${REPO}`, kind: "approvals-inbox", payload: { repo: REPO, approvals: [{ runId: "run-1", requestId: "old-gate", title: "Approve", approval: approval.payload, requestedAt: 1 }] } }
    ] as Array<Card>) await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    await settle(10)
    await controller.dispose()
    store = await createAppStore({ kind: "localStorage", storage })
    controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    await selectWorkspace(store, "ffffffff-ffff-ffff-ffff-ffffffffffff")
    expect(gatewayRunContextFor(store, "run-1")).toEqual({ repo: REPO, workspaceId })
    const before = double.calls.length
    const submittedBefore = double.state.submitted.length
    await controller.commands.run("approval.approve", "approval-run-1-old-gate")
    await controller.commands.run("approval.approve", `approvals-inbox-${REPO}:old-gate`)
    await waitFor(() => double.state.submitted.length === submittedBefore + 2, 10_000)
    await controller.commands.run("runs.resume", "run-1")
    const historicalList = store.collections.cards.get(`run-list-${REPO}`)!
    if (historicalList.kind !== "run-list") throw new Error("missing historical list")
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      ...historicalList, payload: { ...historicalList.payload, runs: [...historicalList.payload.runs,
        { runId: "unbound-run", flowId: "review-pr", status: "completed", createdAt: 1, turns: 0, calls: 0 }
      ] }
    } }).isPersisted.promise
    const beforeMixedRefresh = double.calls.length
    expect(said(await listInventory(controller, store, "runs.list", `completed sourceCard=run-list-${REPO} ${REPO}`))).toContain("several boxes")
    expect(double.calls.length).toBe(beforeMixedRefresh)
    await store.dispatch({ type: "card.upsert", actor: "system", card: historicalList }).isPersisted.promise
    await listInventory(controller, store, "runs.list", `completed sourceCard=run-list-${REPO} ${REPO}`)
    expect(store.collections.cards.get(`run-list-${REPO}`)).toMatchObject({ payload: { workspaceId, gatewayBindingVersion: 1 } })
    for (const call of double.calls.slice(before).filter((call) => call.path.startsWith("/api/workflow/"))) expect(call.body).toMatchObject({ workspaceId })
  })

  test("a run recorded with no box refuses every act without a call, and conflicting recorded boxes refuse", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "legacy", flowId: "review-pr", status: "completed" }] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    // A run card persisted before every run named its box.
    const legacy: Extract<Card, { kind: "run-trace" }> = {
      id: "flow-run-legacy", kind: "run-trace", title: "Old", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: REPO, runId: "legacy", workflow: "review-pr", phase: "completed", steps: [], result: null, lastSeq: 0 }
    }
    await store.dispatch({ type: "card.upsert", actor: "system", card: legacy }).isPersisted.promise
    await settle()
    expect(gatewayRunContextFor(store, "legacy")).toEqual({ repo: REPO })
    const callsBefore = double.calls.length
    for (const [flow, args] of [["runs.resume", "legacy"], ["runs.signal", "legacy go"], ["runs.steer", "legacy hello"], ["approvals.open", "legacy"]] as const) {
      const outcome = await controller.commands.run(flow, args)
      expect(outcome.status).toBe("failed")
      expect(said(outcome)).toBe("This run's box is gone.")
    }
    expect(said(await openMonitor(controller, store, "legacy"))).toBe("This run's box is gone.")
    expect(double.calls.filter((call) => call.path.startsWith("/api/workflow/")).length).toBe(callsBefore)
    // Chat stays usable beside the refusal.
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "still here" }).isPersisted.promise
    expect(store.session()).toMatchObject({ draft: "still here", phase: "idle" })
    store.dispatch({ type: "card.upsert", actor: "system", card: {
      ...legacy, id: "conflicting-trace", payload: { ...legacy.payload, workspaceId }
    } })
    expect(gatewayRunContextFor(store, "legacy")).toMatchObject({ error: expect.stringContaining("conflicting") })
    await controller.commands.run("runs.resume", "legacy")
    expect(double.calls.filter((call) => call.path.startsWith("/api/workflow/")).length).toBe(callsBefore)
  })

  for (const command of ["flow.run", "runs.open"] as const) {
    test(`${command} keeps its owning workspace across selection changes during provision and later resumption`, async () => {
      const store = await webStore()
      const double = relay({ runs: [{ runId: "run-1", flowId: "review-pr", status: "completed" }] })
      const fetch = double.services.fetchImpl!
      const controller = createAppController(store, silentAgent, {
        ...double.services,
        fetchImpl: async (input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
          if (url.endsWith("/api/workflow/provision")) {
            store.dispatch({ type: "repo.selected", actor: "user", id: REPO })
          }
          return fetch(input, init)
        }
      })
      await signIn(store)
      await selectWorkspace(store)
      const result = await controller.commands.run(command, command === "flow.run" ? "review-pr" : "run-1")
      expect(result.status).toBe("executed")
      await waitFor(() => runCardInScope(store, { repo: REPO, runId: "run-1", workspaceId }) !== undefined)
      expect(runCardInScope(store, { repo: REPO, runId: "run-1", workspaceId })).toMatchObject({ kind: "run-trace", payload: { workspaceId } })
      expect(store.session().activeRepoKey).toBe(REPO)
      for (const call of double.calls.filter((call) => call.path.startsWith("/api/workflow/"))) {
        expect(call.body).toMatchObject({ workspaceId })
      }
      await controller.commands.run("runs.resume", "run-1")
      const resumed = double.calls.find((call) => (call.body as { procedure?: string })?.procedure === "Resume")
      expect(resumed?.body).toMatchObject({ workspaceId })
      if (command === "flow.run") {
        const rerun = await controller.commands.run("runs.rerun", "run-1")
        expect(rerun.status).toBe("executed")
        await waitFor(() => runCardInScope(store, { repo: REPO, runId: "run-2", workspaceId }) !== undefined)
        expect(runCardInScope(store, { repo: REPO, runId: "run-2", workspaceId })).toMatchObject({ payload: { workspaceId } })
        const launches = double.calls.filter((call) => (call.body as { procedure?: string })?.procedure === "Run")
        expect(launches).toHaveLength(2)
        for (const launch of launches) expect(launch.body).toMatchObject({ workspaceId })
      }
    })
  }
  test("two gateway databases can both own run-1 without sharing cards, pumps, actions or reload state", async () => {
    const storage = memoryStorage()
    let store = await createAppStore({ kind: "localStorage", storage })
    const workspaceB = "ffffffff-ffff-ffff-ffff-ffffffffffff"
    const makeDouble = (seat: string) => relay({
      runs: [{ runId: "run-1", flowId: "review-pr", status: "completed" }],
      approvals: [approvalRow("run-1", "same-gate", `Approve ${seat}`)],
      transcriptLines: [{ runId: "run-1", sequence: 1, turn: 1, at: 100, kind: "message", text: seat }],
      events: [{ kind: "control.agent.turn-opened", payload: { seat, at: 100 }, sequence: 1, occurredAt: 100 }]
    })
    const a = makeDouble("workspace A")
    const b = makeDouble("workspace B")
    const services: AppServices = { ...a.services, workflowPollMs: 100_000, fetchImpl: async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
      return (body.workspaceId === workspaceB ? b : a).services.fetchImpl!(input, init)
    } }
    let controller = createAppController(store, silentAgent, services)
    // The slash grammar recognizes a trailing repository beside text only
    // when it is loaded. This makes the mismatch reach the gateway guard.
    await signIn(store, [REPO, "other/repo"])
    await selectWorkspace(store)
    expect((await controller.commands.run("flow.run", "review-pr")).status).toBe("executed")
    await selectWorkspace(store, workspaceB)
    expect((await controller.commands.run("flow.run", "review-pr")).status).toBe("executed")
    const scopeA = { repo: REPO, workspaceId, runId: "run-1" }
    const scopeB = { repo: REPO, workspaceId: workspaceB, runId: "run-1" }
    await waitFor(() => runCardInScope(store, scopeA) !== undefined && runCardInScope(store, scopeB) !== undefined)
    const cardA = runCardInScope(store, scopeA)!
    const cardB = runCardInScope(store, scopeB)!
    expect(cardA.id).not.toBe(cardB.id)
    await waitFor(() => runCardInScope(store, scopeA)?.payload.events?.length === 1 && runCardInScope(store, scopeB)?.payload.events?.length === 1, 10_000)
    expect(runCardInScope(store, scopeA)?.payload.events?.[0]?.payload).toMatchObject({ seat: "workspace A" })
    expect(runCardInScope(store, scopeB)?.payload.events?.[0]?.payload).toMatchObject({ seat: "workspace B" })
    expect(gatewayRunContextFor(store, "run-1")).toMatchObject({ error: expect.stringContaining("conflicting") })
    const callsBefore = a.calls.length + b.calls.length
    expect(said(await controller.commands.run("runs.resume", "run-1"))).toContain("conflicting")
    expect(said(await openMonitor(controller, store, `sourceCard=${cardA.id} wrong-run`))).toContain("does not record")
    expect(said(await openMonitor(controller, store, `sourceCard=${cardA.id} run-1 other/repo`))).toContain("another repository")
    expect(a.calls.length + b.calls.length).toBe(callsBefore)
    for (const [card, double, seat] of [[cardA, a, "workspace A"], [cardB, b, "workspace B"]] as const) {
      const source = `sourceCard=${card.id} run-1`
      expect((await controller.commands.run("runs.resume", source)).status).toBe("executed")
      expect((await controller.commands.run("runs.steer", `${source} keep sourceCard=literal`)).status).toBe("executed")
      expect(double.state.steered.at(-1)?.message.body).toBe("keep sourceCard=literal")
      expect((await controller.commands.run("runs.signal", `${source} go {"text":"a  b sourceCard=literal"}`)).status).toBe("executed")
      expect(double.state.signaled.at(-1)?.signal).toEqual({ name: "go", payload: { text: "a  b sourceCard=literal" } })
      expect((await controller.commands.run("runs.logs", source)).status).toBe("executed")
      await waitForFacet(store, card.id)
      expect(runCardInScope(store, card.payload)?.payload.transcriptRows?.[0]?.text).toBe(seat)
      const other = double === a ? b : a
      const otherReads = other.calls.length
      const snapshots = () => double.calls.filter(call => (call.body as { procedure?: string })?.procedure === "Projection.Snapshot").length
      const beforeRetry = snapshots()
      expect((await controller.commands.run("flow.run.retry", card.id)).status).toBe("executed")
      await waitFor(() => snapshots() >= beforeRetry + 2)
      expect(other.calls.length).toBe(otherReads)
      expect((await controller.commands.run("approvals.open", source)).status).toBe("executed")
      const approvalId = approvalCardIdFor(store, card === cardA ? scopeA : scopeB, "same-gate")
      expect((await controller.commands.run("approval.approve", approvalId)).status).toBe("executed")
      await waitFor(() => double.state.submitted.length === 2, 10_000) // Plan plus this gate.
      expect(double.state.resumed).toHaveLength(1)
    }
    expect(approvalCardIdFor(store, scopeA, "same-gate")).not.toBe(approvalCardIdFor(store, scopeB, "same-gate"))
    const missing = await controller.commands.runForAgent("runs.trace.view", `sourceCard=${cardA.id} run-1`)
    expect(missing).toMatchObject({ status: "form", fields: ["view"] })
    const form = store.collections.cards.get("form-runs.trace.view")
    expect(form?.kind === "flow-form" && form.payload.draft).toMatchObject({ sourceCard: cardA.id, runId: "run-1" })
    await controller.commands.run("form.set", "form-runs.trace.view view timeline")
    expect((await controller.commands.run("form.submit", "form-runs.trace.view")).status).toBe("executed")
    await controller.commands.run("runs.trace.filter", `sourceCard=${cardA.id} run-1 failed`)
    expect(runCardInScope(store, scopeB)?.payload.filter).toBeUndefined()
    await settle(10)
    await controller.dispose()
    store = await createAppStore({ kind: "localStorage", storage })
    controller = createAppController(store, silentAgent, services)
    await signIn(store)
    await selectWorkspace(store, workspaceB)
    expect(runCardInScope(store, scopeA)).toMatchObject({ id: cardA.id, payload: { filter: "failed", traceView: "timeline" } })
    expect(runCardInScope(store, scopeB)).toMatchObject({ id: cardB.id })
    await selectWorkspace(store)
    await listInventory(controller, store, "runs.list", REPO)
    await listInbox(controller, store, REPO)
    await selectWorkspace(store, workspaceB)
    await listInventory(controller, store, "runs.list", REPO)
    await listInbox(controller, store, REPO)
    const listA = `run-list-${REPO}-${workspaceId}`
    const listB = `run-list-${REPO}-${workspaceB}`
    const searchRows = controller.searchPalette("run: run-1").groups.flatMap((group) => group.items.map((row) => row.item))
    expect(searchRows).toHaveLength(2)
    expect(new Set(searchRows.map((item) => item.ref)).size).toBe(2)
    for (const item of searchRows) {
      const primary = item.actions.find((action) => action.role === "primary")!
      expect(primary.flow).toBe("runs.resume")
      expect(primary.args).toContain("sourceCard=")
      expect((await controller.commands.run(primary.flow, primary.args)).status).toBe("executed")
    }
    expect(a.state.resumed).toHaveLength(2)
    expect(b.state.resumed).toHaveLength(2)
    await controller.commands.run("search.runs", "run-1")
    const searchCard = store.collections.cards.get("search-search.runs")
    expect(searchCard?.kind === "search-results" && searchCard.payload.items).toHaveLength(2)
    const lastA = a.calls.length
    expect((await openMonitor(controller, store, `sourceCard=${listA} run-1`)).status).toBe("executed")
    expect((await openMonitor(controller, store, `sourceCard=${listB} run-1`)).status).toBe("executed")
    expect(runCardInScope(store, scopeA)?.id).toBe(cardA.id)
    expect(runCardInScope(store, scopeA)?.payload.filter).toBe("failed")
    await waitFor(() => runCardInScope(store, scopeA)?.payload.phase === "completed" && runCardInScope(store, scopeB)?.payload.phase === "completed", 10_000)
    expect(a.calls.slice(lastA).filter((call) => call.path.startsWith("/api/workflow/")).every((call) => (call.body as { workspaceId?: string }).workspaceId === workspaceId)).toBe(true)
    const submittedA = a.state.submitted.length
    const submittedB = b.state.submitted.length
    await controller.commands.run("approval.approve", `approvals-inbox-${REPO}-${workspaceId}:same-gate`)
    await controller.commands.run("approval.approve", `approvals-inbox-${REPO}-${workspaceB}:same-gate`)
    // A stale pending inventory after reload cannot reopen these decided gates.
    expect(a.state.submitted.length).toBe(submittedA)
    expect(b.state.submitted.length).toBe(submittedB)
    // Stop-all uses the source list's displayed set, not every workspace with the same repo.
    const list = store.collections.cards.get(listA)!
    if (list.kind !== "run-list") throw new Error("missing list")
    const recordedA = store.collections.runtimeRuns.get(runtimeRunKey(scopeA))!.summary!
    await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: { scope: scopeA, summary: { ...recordedA, status: "running", updatedAt: recordedA.updatedAt + 1 } } }).isPersisted.promise
    await controller.commands.run("flow.run.stop-all", `sourceCard=${listA} ${REPO}`)
    expect(a.state.cancelled).toHaveLength(1)
    expect(b.state.cancelled).toHaveLength(0)
    await controller.commands.run("flow.run.stop", cardB.id)
    await waitFor(() => b.state.cancelled.length === 1, 10_000)
    for (const [double, workspace] of [[a, workspaceId], [b, workspaceB]] as const) {
      for (const call of double.calls.filter((call) => call.path.startsWith("/api/workflow/"))) expect(call.body).toMatchObject({ workspaceId: workspace })
    }
  }, 120_000)

  test("historical raw card addresses survive while a list on another box never inherits the old card's box", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-1", flowId: "review-pr", status: "completed" }, { runId: "child-1", flowId: "review-pr", status: "completed" }] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    const old: Extract<Card, { kind: "run-trace" }> = {
      id: "flow-run-run-1", kind: "run-trace", title: "Old", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: REPO, workspaceId, runId: "run-1", workflow: "review-pr", phase: "completed", steps: [], result: null, lastSeq: 0,
        events: [
          { kind: "control.agent.cell-call-started", payload: { flowName: "agent/spawn", input: {} }, sequence: 1, occurredAt: 1 },
          { kind: "control.agent.cell-call-settled", payload: { flowName: "agent/spawn", outcome: "success", value: { child: "child-1" } }, sequence: 2, occurredAt: 2 },
          { kind: "control.engine.event", sequence: 3, occurredAt: 3, payload: {
            version: 1, executionId: "native-1", generation: 0, sequence: 1, eventId: "native-1/1",
            sourceId: "engine", sourceSequence: 1, emittedAtMs: 3, eventType: "flows.engine.run-decision",
            meta: { lineageId: "native-1" }, payload: { decision: "created", state: { version: 1, flowName: "coding/ImplementPlan", payload: {} } }
          } }
        ] }
    }
    await store.dispatch({ type: "card.upsert", actor: "system", card: old }).isPersisted.promise
    await listInventory(controller, store, "runs.list", REPO) // A newly recorded list on the repository's default box.
    const listId = `run-list-${REPO}-${TEST_BOX}`
    expect(store.collections.cards.get(listId)).toMatchObject({ payload: { gatewayBindingVersion: 1 } })
    expect(gatewayRunContextFor(store, "run-1")).toMatchObject({ error: expect.stringContaining("conflicting") })
    let before = double.calls.length
    expect((await openMonitor(controller, store, `sourceCard=${listId} run-1`)).status).toBe("executed")
    const listed = runCardInScope(store, { repo: REPO, workspaceId: TEST_BOX, runId: "run-1" })!
    expect(listed.id).not.toBe(old.id)
    expect(store.collections.cards.get(old.id)).toMatchObject({ payload: { workspaceId } })
    await waitFor(() => listed.id !== undefined && runCardInScope(store, { repo: REPO, workspaceId: TEST_BOX, runId: "run-1" })?.payload.phase === "completed", 10_000)
    await waitFor(() => double.calls.slice(before).some((call) => JSON.stringify(call.body).includes("\"run-events\"")))
    await settle()
    for (const call of double.calls.slice(before).filter((call) => call.path.startsWith("/api/workflow/"))) expect(call.body).toMatchObject({ workspaceId: TEST_BOX })
    const beforeNative = double.calls.length
    expect(said(await openMonitor(controller, store, `sourceCard=${old.id} native-1`))).toContain("does not record")
    expect(double.calls.length).toBe(beforeNative)
    // Only an actual recorded agent/spawn child can use its parent's source.
    before = double.calls.length
    expect((await openMonitor(controller, store, `sourceCard=${old.id} child-1`)).status).toBe("executed")
    expect(runCardInScope(store, { repo: REPO, workspaceId, runId: "child-1" })).toBeDefined()
    await waitFor(() => runCardInScope(store, { repo: REPO, workspaceId, runId: "child-1" })?.payload.phase === "completed", 10_000)
    for (const call of double.calls.slice(before).filter((call) => call.path.startsWith("/api/workflow/"))) expect(call.body).toMatchObject({ workspaceId })
    before = double.calls.length
    expect((await openMonitor(controller, store, `sourceCard=${old.id} run-1`)).status).toBe("executed")
    expect(runCardInScope(store, { repo: REPO, workspaceId, runId: "run-1" })?.id).toBe(old.id)
    await waitFor(() => runCardInScope(store, { repo: REPO, workspaceId, runId: "run-1" })?.payload.phase === "completed")
    await waitFor(() => double.calls.slice(before).some((call) => JSON.stringify(call.body).includes("\"run-events\"")))
    await settle()
    const wireCount = double.calls.length
    expect(said(await controller.commands.run("runs.resume", `sourceCard=${old.id} child-1`))).toContain("does not record")
    expect(double.calls.length).toBe(wireCount)
  }, 60_000)

})

test("a normalized approval waits for its own decision receipt; failed storage starts no submission", async () => {
  const backing = memoryStorage()
  let fail = false
  const storage = { ...backing, setItem: (key: string, value: string) => {
    if (fail) throw new Error("decision storage refused")
    backing.setItem(key, value)
  } }
  const store = await createAppStore({ kind: "localStorage", storage })
  const double = relay({ approvals: [approvalRow("run", "gate", "Deploy?")] })
  const controller = createAppController(store, silentAgent, double.services)
  await signIn(store)
  await controller.commands.run("approvals.open", "run")
  const card = [...store.collections.cards.values()].find(row => row.kind === "approval" && row.payload.runId === "run")!
  await store.settled?.()
  fail = true
  controller.decideApproval(card.id, "approved")
  await settle(10)
  await store.settled?.().catch(() => {})
  expect(double.state.submitted).toEqual([])
  expect(store.collections.cards.get(card.id)).toMatchObject({ status: "active" })
  expect([...store.collections.runtimeApprovals.values()].every(row => row.row.status === "pending" && row.pending !== true)).toBe(true)
  fail = false
  await controller.dispose()
})

test("a late run snapshot cannot repopulate normalized state after account erasure", async () => {
  const store = await webStore(), double = relay({ runs: [{ runId: "run", flowId: "test", status: "completed" }] })
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const requested = new Promise<void>(resolve => { started = resolve })
  const original = double.services.fetchImpl!
  const controller = createAppController(store, silentAgent, { ...double.services, fetchImpl: async (input, init) => {
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    if (body?.procedure === "Projection.Snapshot" && body.payload.selector._tag === "run-summary") { started(); await held }
    return original(input, init)
  } })
  await signIn(store)
  const opening = openMonitor(controller, store, `run ${REPO}`)
  await requested
  await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
  release()
  const result = await opening
  expect(result.status).not.toBe("executed")
  expect([...store.collections.runtimeRuns.values()]).toEqual([])
  expect([...store.collections.cards.values()].some(card => card.kind === "run-trace" && card.payload.runId === "run")).toBe(false)
  await controller.dispose()
})

test("a human answer draft is one event-derived value across inbox, card and reload; agent edits and re-asked questions cannot borrow it", async () => {
  const backing = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage: backing })
  const question = { ...approvalRow("run-answer", "question", "Who owns this?"), waitRunId: "child-answer", request: { question: "Who owns this?", kind: "ask", prompt: "Who owns this?" } }
  const double = relay({ approvals: [question] })
  const controller = createAppController(store, silentAgent, double.services)
  await signIn(store)
  await listInbox(controller, store)
  await controller.commands.run("approvals.open", "run-answer")
  const initial = inboxCard(store)!
  const target = approvalActionId(initial.id, question)
  const field = `answer:${initial.payload.approvals[0]!.answerDraft!.question}`
  const words = 'the "scheduler"\nkeeps the budget'
  const args = flowArgs("form.set", { cardId: target, field, value: words })
  expect((await controller.commands.runForAgent("form.set", args)).status).toBe("failed")
  expect([...store.collections.runtimeApprovals.values()][0]?.answerDraft).toBeUndefined()
  expect((await controller.commands.run("form.set", args)).status).toBe("executed")
  expect(inboxCard(store)?.payload.approvals[0]?.answerDraft?.text).toBe(words)
  const individual = [...store.collections.cards.values()].find(card => card.kind === "approval" && card.payload.runId === question.runId)
  expect(individual?.kind === "approval" && individual.payload.answerDraft?.text).toBe(words)
  await controller.dispose()
  await store.dispose?.()
  const reopened = await createAppStore({ kind: "localStorage", storage: backing })
  expect(inboxCard(reopened)?.payload.approvals[0]?.answerDraft?.text).toBe(words)
  expect((await reopened.verifyState()).valid).toBe(true)
  const next = createAppController(reopened, silentAgent, double.services)
  question.request.prompt = "Who owns the revised budget?"
  await listInbox(next, reopened)
  expect(inboxCard(reopened)?.payload.approvals[0]?.answerDraft?.text).toBe("")
  expect((await next.commands.run("form.set", args)).status).toBe("failed")
  next.answerApproval(target, words, field.slice("answer:".length))
  await settle(4)
  expect(double.state.submitted).toEqual([])
})

test("every human answer kind validates against its current question and commits input before submission", async () => {
  for (const example of [
    { kind: "ask", answer: "scheduler", invalid: false, text: "scheduler" },
    { kind: "confirm", answer: false, invalid: "false", text: "false" },
    { kind: "select", answer: "stable", invalid: "unknown", text: "stable" },
    { kind: "json", answer: { retry: 3 }, invalid: undefined, text: '{"retry":3}' }
  ] as const) {
    const store = await webStore()
    const question = { ...approvalRow("run-answer", "question", "Answer?"), waitRunId: "child-answer", request: { question: "Answer?", kind: example.kind, prompt: "Answer?", options: ["canary", "stable"] } }
    const double = relay({ approvals: [question] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    await listInbox(controller, store)
    const target = approvalActionId(inboxCard(store)!.id, question)
    if (example.invalid !== undefined) {
      controller.answerApproval(target, example.invalid)
      await settle(3)
      expect(double.state.submitted).toEqual([])
    }
    controller.answerApproval(target, example.answer)
    await waitFor(() => double.state.submitted.length === 1)
    expect(double.state.submitted[0]).toEqual({ approval: { ...question.payload, answer: example.answer }, decision: "approve" })
    const events = (await store.eventHistory()).events
    const accepted = events.find(event => event.type === "approval.answer.changed")
    expect(accepted).toBeDefined()
    expect(decodeEventValue(accepted!.input)).toMatchObject({ actor: "user", text: example.text })
  }
})

test("an answer whose input cannot persist submits nothing", async () => {
  const backing = memoryStorage()
  let fail = false
  const store = await createAppStore({ kind: "localStorage", storage: { ...backing, setItem: (key, value) => {
    if (fail) throw new Error("answer storage refused")
    backing.setItem(key, value)
  } } })
  const question = { ...approvalRow("run-answer", "question", "Who?"), waitRunId: "child-answer", request: { question: "Who?", kind: "ask", prompt: "Who?" } }
  const double = relay({ approvals: [question] })
  const controller = createAppController(store, silentAgent, double.services)
  await signIn(store)
  await listInbox(controller, store)
  const id = approvalActionId(inboxCard(store)!.id, question)
  await store.settled?.()
  fail = true
  controller.answerApproval(id, "private answer")
  await settle(10)
  await store.settled?.().catch(() => {})
  expect(double.state.submitted).toEqual([])
  expect([...store.collections.runtimeApprovals.values()][0]?.answerDraft).toBeUndefined()
  fail = false
  await controller.dispose()
})

describe("trace gestures retain their source view", () => {
  const workspaceId = "83e75ae5-0920-4000-8000-000000000001"
  const card = (id: string): Extract<Card, { kind: "run-trace" }> => ({
    id, kind: "run-trace", title: id, status: "acted", createdAt: 1, ordinal: 1,
    payload: { repo: REPO, workspaceId, runId: "run-reader", workflow: "coding", phase: "completed", steps: [], result: null, lastSeq: 2,
      input: { plan: CODING_PLAN }, filter: "all", traceView: "turns", selection: "frame-1", cursorSeq: 2, liveTail: false,
      graph: { follow: true, node: "gate", tab: "code" },
      events: [
        { kind: "control.agent.turn-opened", payload: { seat: "openai:gpt-5.6-sol", at: 100 }, sequence: 1, occurredAt: 100 },
        { kind: "control.agent.cell-call-started", payload: { flowName: "files.read", input: { path: "README.md" }, at: 250 }, sequence: 2, occurredAt: 250 }
      ]
    }
  })
  const cases = [
    ["runs.trace.filter", "failed", { filter: "failed" }],
    ["runs.trace.select", "call-1 2", { selection: "call-1", cursorSeq: 2, liveTail: false }],
    ["runs.trace.view", "timeline", { traceView: "timeline" }],
    ["runs.trace.live", "", { liveTail: true }],
    ["runs.graph.follow", "off", { graph: { follow: false, node: "gate", tab: "code" } }],
    ["runs.coding.select", "memory", { codingChangeId: "memory" }]
  ] as const
  const payload = (store: Awaited<ReturnType<typeof webStore>>, id: string) => {
    const found = store.collections.cards.get(id)
    return found?.kind === "run-trace" ? found.payload : undefined
  }
  const ready = async (storage = memoryStorage(), cards = [card("a"), card("b")]) => {
    const store = await createAppStore({ kind: "localStorage", storage })
    await signIn(store)
    for (const row of cards) await store.dispatch({ type: "card.upsert", actor: "system", card: row }).isPersisted.promise
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    return { store, controller, double, storage }
  }

  test.each(cases)("%s changes only its named view and restores that choice after reload", async (flow, args, expected) => {
    const fixture = await ready()
    const before = payload(fixture.store, "a")
    expect((await fixture.controller.commands.runForAgent(flow, `sourceCard=b run-reader ${args}`)).status).toBe("executed")
    expect(payload(fixture.store, "a")).toEqual(before)
    expect(payload(fixture.store, "b")).toMatchObject(expected)
    expect(fixture.double.calls).toHaveLength(0)
    expect((await fixture.store.eventHistory()).events.some(event => {
      if (event.type !== "card.updated" && event.type !== "card.upsert") return false
      const saved = decodeEventValue(event.input) as { actor?: string; id?: string; card?: { id?: string } }
      return saved.actor === "smithers" && (saved.id === "b" || saved.card?.id === "b")
    })).toBe(true)
    if (flow === "runs.trace.live") {
      expect(payload(fixture.store, "b")?.selection).toBeUndefined()
      expect(payload(fixture.store, "b")?.cursorSeq).toBeUndefined()
    }
    await fixture.controller.dispose()
    await fixture.store.dispose?.()
    const restored = await createAppStore({ kind: "localStorage", storage: fixture.storage })
    try {
      expect(payload(restored, "a")).toEqual(before)
      expect(payload(restored, "b")).toMatchObject(expected)
      if (flow === "runs.trace.live") {
        expect(payload(restored, "b")?.selection).toBeUndefined()
        expect(payload(restored, "b")?.cursorSeq).toBeUndefined()
      }
    } finally { await restored.dispose?.() }
  })

  test("selection validates the named view's own journal and coding plan", async () => {
    const first = card("a")
    const second = card("b")
    const fixture = await ready(memoryStorage(), [{ ...first, payload: { ...first.payload, input: {}, events: [] } }, second])
    expect((await fixture.controller.commands.run("runs.trace.select", "sourceCard=b run-reader call-1 2")).status).toBe("executed")
    expect((await fixture.controller.commands.run("runs.coding.select", "sourceCard=b run-reader memory")).status).toBe("executed")
    expect(said(await fixture.controller.commands.run("runs.trace.select", "sourceCard=a run-reader call-1 2"))).toContain("no recorded journal sequence")
    expect(said(await fixture.controller.commands.run("runs.coding.select", "sourceCard=a run-reader memory"))).toContain("no recorded planned Change")
  })

  test("missing and wrong-run sources refuse every gesture without falling back", async () => {
    const fixture = await ready()
    const before = [payload(fixture.store, "a"), payload(fixture.store, "b")]
    for (const [flow, args] of cases) {
      expect(said(await fixture.controller.commands.run(flow, `sourceCard=missing run-reader ${args}`))).toContain("does not record run")
      expect(said(await fixture.controller.commands.run(flow, `sourceCard=b another-run ${args}`))).toContain("does not record run")
    }
    expect([payload(fixture.store, "a"), payload(fixture.store, "b")]).toEqual(before)
  })

  test("unqualified references stay deterministic within one scope and refuse conflicting scopes", async () => {
    const fixture = await ready()
    expect((await fixture.controller.commands.run("runs.trace.filter", "run-reader failed")).status).toBe("executed")
    expect(payload(fixture.store, "a")?.filter).toBe("failed")
    expect(payload(fixture.store, "b")?.filter).toBe("all")
    const other = card("other")
    await fixture.store.dispatch({ type: "card.upsert", actor: "system", card: { ...other, payload: { ...other.payload, workspaceId: "83e75ae5-0920-4000-8000-000000000002" } } }).isPersisted.promise
    for (const [flow, args] of cases) expect(said(await fixture.controller.commands.run(flow, `run-reader ${args}`))).toContain("conflicting")
    expect((await fixture.controller.commands.run("runs.trace.filter", "sourceCard=b run-reader failed")).status).toBe("executed")
    expect(payload(fixture.store, "other")?.filter).toBe("all")
  })

  for (const [flow, args] of cases.slice(4)) {
    test(`${flow} waits for its card receipt while Chat remains usable`, async () => {
      const fixture = await ready()
      const dispatch = fixture.store.dispatch
      const saved = Promise.withResolvers<void>()
      let held = false
      let answered = false
      Object.assign(fixture.store, { dispatch: (transition: Parameters<typeof dispatch>[0]) => {
        const write = dispatch(transition)
        if (!held && transition.type === "card.upsert" && transition.card.kind === "run-trace") {
          held = true
          return { ...write, isPersisted: { promise: write.isPersisted.promise.then(() => saved.promise) } }
        }
        return write
      } })
      try {
        const result = fixture.controller.commands.run(flow, `sourceCard=b run-reader ${args}`).then(result => { answered = true; return result })
        await waitFor(() => held)
        await settle(15)
        expect(answered).toBe(false)
        await dispatch({ type: "composer.changed", actor: "user", draft: "Chat while the choice saves" }).isPersisted.promise
        saved.resolve()
        expect((await result).status).toBe("executed")
      } finally { saved.resolve(); Object.assign(fixture.store, { dispatch }) }
    })

    test(`${flow} reports a refused card save and can retry without changing another view`, async () => {
      const backing = memoryStorage()
      let armed = false
      let refused = 0
      const marker = JSON.stringify(flow === "runs.graph.follow" ? '"follow":false' : '"codingChangeId":"memory"').slice(1, -1)
      const storage = { ...backing, setItem: (key: string, value: string) => {
        if (armed && key.endsWith(".staged") && value.includes(marker)) {
          armed = false
          refused += 1
          throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError", code: 22 })
        }
        backing.setItem(key, value)
      } }
      const fixture = await ready(storage)
      const before = [payload(fixture.store, "a"), payload(fixture.store, "b")]
      armed = true
      const result = await fixture.controller.commands.run(flow, `sourceCard=b run-reader ${args}`)
      expect(refused).toBe(1)
      expect(result.status).toBe("failed")
      expect(said(result)).toMatch(/not.*saved/)
      expect([payload(fixture.store, "a"), payload(fixture.store, "b")]).toEqual(before)
      expect((await fixture.controller.commands.run(flow, `sourceCard=b run-reader ${args}`)).status).toBe("executed")
      expect(payload(fixture.store, "a")).toEqual(before[0])
      expect(payload(fixture.store, "b")).not.toEqual(before[1])
    })
  }
})

describe("durable run facet requests", () => {
  const card = (id: string): Extract<Card, { kind: "run-trace" }> => ({
    id, kind: "run-trace", title: id, status: "acted", createdAt: 1, ordinal: 1,
    payload: { repo: REPO, workspaceId: TEST_BOX, runId: "run-facet", workflow: "review", phase: "completed", steps: [], result: null,
      lastSeq: 0, facet: "steps", follow: false }
  })
  const current = (store: Awaited<ReturnType<typeof webStore>>, id = "b") => {
    const row = store.collections.cards.get(id)
    return row?.kind === "run-trace" ? row : undefined
  }
  const ready = async (gate?: Promise<void>, storage = memoryStorage()) => {
    const store = await createAppStore({ kind: "localStorage", storage })
    await signIn(store)
    for (const id of ["a", "b"]) await store.dispatch({ type: "card.upsert", actor: "system", card: card(id) }).isPersisted.promise
    const double = relay({ transcriptLines: [{ runId: "run-facet", sequence: 1, turn: 1, at: 1, kind: "assistant", text: "Facet source" }] })
    let reads = 0
    let finished = 0
    let refusal: string | undefined
    const services = { ...double.services, toastDebounceMs: 0, fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      const tag = body?.payload?.selector?._tag
      if (body?.procedure === "Projection.Snapshot" && (tag === "transcript" || tag === "run-events")) {
        reads += 1
        await gate
        const response = refusal === undefined ? await double.services.fetchImpl!(input, init)
          : json(200, { ok: false, error: { message: refusal } })
        finished += 1
        return response
      }
      return double.services.fetchImpl!(input, init)
    } }
    const controller = createAppController(store, silentAgent, services)
    await controller.commands.run("debug.verbose")
    return { store, controller, storage, services, refuse: (message?: string) => { refusal = message }, reads: () => reads, finished: () => finished }
  }

  test("Steps preserves its source view and waits for the write receipt", async () => {
    const fixture = await ready()
    for (const id of ["a", "b"]) {
      const before = current(fixture.store, id)!
      await fixture.store.dispatch({ type: "card.upsert", actor: "system", card: { ...before, payload: { ...before.payload, facet: "transcript" } } }).isPersisted.promise
    }
    const dispatch = fixture.store.dispatch
    const saved = Promise.withResolvers<void>()
    let held = false
    let answered = false
    Object.assign(fixture.store, { dispatch: (transition: Parameters<typeof dispatch>[0]) => {
      const write = dispatch(transition)
      if (transition.type === "card.upsert" && transition.card.id === "b") {
        held = true
        return { ...write, isPersisted: { promise: write.isPersisted.promise.then(() => saved.promise) } }
      }
      return write
    } })
    const result = fixture.controller.commands.run("runs.steps", "sourceCard=b run-facet").then(result => { answered = true; return result })
    try {
      await waitFor(() => held)
      await settle(15)
      expect(answered).toBe(false)
      saved.resolve()
      expect((await result).status).toBe("executed")
      expect(current(fixture.store)?.payload.facet).toBe("steps")
      expect(current(fixture.store, "a")?.payload.facet).toBe("transcript")
    } finally { saved.resolve(); Object.assign(fixture.store, { dispatch }); await result }
  })

  for (const [flow, facet] of [["runs.logs", "transcript"], ["runs.events", "events"]] as const) {
    test(`${flow} acknowledges its saved request before the read, shares duplicates, and keeps Chat usable`, async () => {
      const gate = Promise.withResolvers<void>()
      const fixture = await ready(gate.promise)
      let answered = false
      const result = fixture.controller.commands.run(flow, "sourceCard=b run-facet").then(result => { answered = true; return result })
      try {
        await waitFor(() => fixture.reads() === 1)
        await waitFor(() => answered)
        expect(said(await result)).toContain("requested")
        expect(current(fixture.store)?.payload.facetRequest?.state).toBe("pending")
        expect(current(fixture.store, "a")?.payload.facet).toBe("steps")
        await fixture.controller.commands.runForAgent(flow, "sourceCard=b run-facet")
        expect(fixture.reads()).toBe(1)
        await fixture.store.dispatch({ type: "composer.changed", actor: "user", draft: "Chat during a facet read" }).isPersisted.promise
        expect([...fixture.store.collections.toasts.values()].some(toast => toast.status === "running")).toBe(true)
        gate.resolve()
        await waitFor(() => current(fixture.store)?.payload.facetRequest?.state === "complete")
        expect(current(fixture.store)?.payload.facet).toBe(facet)
        expect(current(fixture.store, "a")?.payload.facet).toBe("steps")
      } finally { gate.resolve(); await result }
    })

    test(`${flow} cannot reopen a facet after Steps supersedes its pending read`, async () => {
      const gate = Promise.withResolvers<void>()
      const fixture = await ready(gate.promise)
      const result = fixture.controller.commands.run(flow, "sourceCard=b run-facet")
      try {
        await waitFor(() => fixture.reads() === 1)
        await fixture.controller.commands.run("runs.steps", "sourceCard=b run-facet")
        gate.resolve()
        await result
        await waitFor(() => fixture.finished() === 1)
        await settle(15)
        expect(current(fixture.store)?.payload.facet).toBe("steps")
        expect(current(fixture.store)?.payload.facetRequest).toBeUndefined()
        expect(current(fixture.store, "a")?.payload.facet).toBe("steps")
      } finally { gate.resolve(); await result }
    })

    test(`${flow} duplicate input waits for the admission receipt before any read`, async () => {
      const fixture = await ready()
      const dispatch = fixture.store.dispatch
      const saved = Promise.withResolvers<void>()
      let held = false
      let answered = 0
      Object.assign(fixture.store, { dispatch: (transition: Parameters<typeof dispatch>[0]) => {
        const write = dispatch(transition)
        if (!held && transition.type === "card.updated" && transition.id === "b") {
          held = true
          return { ...write, isPersisted: { promise: write.isPersisted.promise.then(() => saved.promise) } }
        }
        return write
      } })
      const first = fixture.controller.commands.run(flow, "sourceCard=b run-facet").then(result => { answered += 1; return result })
      try {
        await waitFor(() => held)
        const second = fixture.controller.commands.runForAgent(flow, "sourceCard=b run-facet").then(result => { answered += 1; return result })
        await settle(15)
        expect(answered).toBe(0)
        expect(fixture.reads()).toBe(0)
        saved.resolve()
        expect((await first).status).toBe("executed")
        expect((await second).status).toBe("executed")
        await waitForFacet(fixture.store, "b")
        expect(fixture.reads()).toBe(1)
      } finally { saved.resolve(); Object.assign(fixture.store, { dispatch }); await first }
    })

    test(`${flow} reconnects its saved request after reload without changing its identity`, async () => {
      const gate = Promise.withResolvers<void>()
      const fixture = await ready(gate.promise)
      let restored: Awaited<ReturnType<typeof webStore>> | undefined
      let reopened: AppController | undefined
      try {
        await fixture.controller.commands.run(flow, "sourceCard=b run-facet")
        await waitFor(() => fixture.reads() === 1)
        const id = current(fixture.store)?.payload.facetRequest?.id
        await fixture.controller.dispose()
        await fixture.store.dispose?.()
        restored = await createAppStore({ kind: "localStorage", storage: fixture.storage })
        reopened = createAppController(restored, silentAgent, fixture.services)
        await reopened.adoptSession({ state: "signed-in", login: "codeplanesmithers", allowlisted: true, admin: false })
        await waitFor(() => fixture.reads() === 2)
        expect(current(restored)?.payload.facetRequest?.id).toBe(id)
        gate.resolve()
        await waitForFacet(restored, "b")
        expect(current(restored)?.payload.facet).toBe(facet)
        expect(current(restored, "a")?.payload.facet).toBe("steps")
      } finally { gate.resolve(); await reopened?.dispose(); await restored?.dispose?.() }
    })

    test(`${flow} retains a fast refusal and retries from the existing facet button`, async () => {
      const fixture = await ready()
      fixture.refuse("Facet unavailable")
      await fixture.controller.commands.run(flow, "sourceCard=b run-facet")
      await waitFor(() => current(fixture.store)?.payload.facetRequest?.state === "failed")
      expect(current(fixture.store)?.payload.facetRequest?.error).toContain("Facet unavailable")
      await waitFor(() => [...fixture.store.collections.toasts.values()].some(toast => toast.status === "failed" && toast.key.startsWith("runs.facet.")))
      fixture.refuse()
      await fixture.controller.commands.run(flow, "sourceCard=b run-facet")
      await waitForFacet(fixture.store, "b")
      expect(current(fixture.store)?.payload.facetRequest?.error).toBeUndefined()
      expect(fixture.reads()).toBe(2)
    })

    for (const boundary of ["admission", "result"] as const) {
      test(`${flow} does not claim success when ${boundary} storage is refused`, async () => {
        const backing = memoryStorage()
        let armed = false
        let refused = 0
        const marker = JSON.stringify(`"state":"${boundary === "admission" ? "pending" : "complete"}"`).slice(1, -1)
        const storage = { ...backing, setItem: (key: string, value: string) => {
          if (armed && key.endsWith(".staged") && value.includes(marker)) {
            armed = false
            refused += 1
            throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError", code: 22 })
          }
          backing.setItem(key, value)
        } }
        const fixture = await ready(undefined, storage)
        armed = true
        const result = await fixture.controller.commands.run(flow, "sourceCard=b run-facet")
        if (boundary === "admission") {
          expect(result.status).toBe("failed")
          expect(fixture.reads()).toBe(0)
          expect(current(fixture.store)?.payload.facetRequest).toBeUndefined()
          expect(current(fixture.store)?.payload.facet).toBe("steps")
        } else {
          await waitFor(() => current(fixture.store)?.payload.facetRequest?.state === "failed")
          expect([...fixture.store.collections.toasts.values()].some(toast => toast.status === "ok" && toast.key.startsWith("runs.facet."))).toBe(false)
        }
        expect(refused).toBe(1)
        await fixture.controller.commands.run(flow, "sourceCard=b run-facet")
        await waitForFacet(fixture.store, "b")
      })
    }

    test(`${flow} keeps its toast running through the result receipt and shares duplicate input`, async () => {
      const gate = Promise.withResolvers<void>()
      const saved = Promise.withResolvers<void>()
      const fixture = await ready(gate.promise)
      const dispatch = fixture.store.dispatch
      let held = false
      Object.assign(fixture.store, { dispatch: (transition: Parameters<typeof dispatch>[0]) => {
        const write = dispatch(transition)
        if (transition.type === "card.upsert" && transition.card.kind === "run-trace" && transition.card.payload.facetRequest?.state === "complete") {
          held = true
          return { ...write, isPersisted: { promise: write.isPersisted.promise.then(() => saved.promise) } }
        }
        return write
      } })
      try {
        await fixture.controller.commands.run(flow, "sourceCard=b run-facet")
        await waitFor(() => [...fixture.store.collections.toasts.values()].some(toast => toast.status === "running"))
        gate.resolve()
        await waitFor(() => held)
        expect([...fixture.store.collections.toasts.values()].some(toast => toast.status === "running")).toBe(true)
        await fixture.controller.commands.runForAgent(flow, "sourceCard=b run-facet")
        expect(fixture.reads()).toBe(1)
        saved.resolve()
        await waitFor(() => [...fixture.store.collections.toasts.values()].some(toast => toast.status === "ok" && toast.key.startsWith("runs.facet.")))
      } finally { gate.resolve(); saved.resolve(); Object.assign(fixture.store, { dispatch }) }
    })

    for (const change of ["replacement", "account"] as const) {
      test(`${flow} discards a late response after source ${change}`, async () => {
        const gate = Promise.withResolvers<void>()
        const fixture = await ready(gate.promise)
        try {
          await fixture.controller.commands.run(flow, "sourceCard=b run-facet")
          await waitFor(() => fixture.reads() === 1)
          if (change === "account") await fixture.controller.adoptSession({ state: "signed-in", login: "another-owner", allowlisted: true, admin: false })
          const replacement = card("b")
          await fixture.store.dispatch({ type: "card.upsert", actor: "system", card: { ...replacement, payload: { ...replacement.payload, runId: "replacement" } } }).isPersisted.promise
          gate.resolve()
          await waitFor(() => fixture.finished() === 1)
          await settle(15)
          expect(current(fixture.store)?.payload.runId).toBe("replacement")
          expect(current(fixture.store)?.payload.facet).toBe("steps")
          expect(current(fixture.store)?.payload.facetRequest).toBeUndefined()
          expect(fixture.store.collections.runtimeRuns.has(runtimeRunKey({ repo: REPO, runId: "run-facet" }))).toBe(false)
        } finally { gate.resolve() }
      })
    }
  }
})


describe("durable run-list reads", () => {
  const ready = async (gate: Promise<void>, storage = memoryStorage(), holdAll = false) => {
    const store = await createAppStore({ kind: "localStorage", storage })
    await signIn(store)
    const double = relay({ runs: [
      { runId: "parked", flowId: "review-pr", status: "parked" },
      { runId: "done", flowId: "review-pr", status: "completed" }
    ] })
    let reads = 0
    let returned = 0
    const services = { ...double.services, fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (body?.payload?.selector?._tag === "workspace-runs") {
        reads += 1
        if (reads === 1 || holdAll) await gate
        const response = await double.services.fetchImpl!(input, init)
        returned += 1
        return response
      }
      return double.services.fetchImpl!(input, init)
    } }
    const controller = createAppController(store, silentAgent, services)
    return { store, controller, services, storage, reads: () => reads, returned: () => returned }
  }

  test("listing acknowledges before a held projection and leaves Chat usable", async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = await ready(gate.promise)
    let answered = false
    const result = fixture.controller.commands.run("runs.list").then(result => { answered = true; return result })
    try {
      await waitFor(() => fixture.reads() === 1)
      await waitFor(() => answered)
      expect(said(await result)).toBe("Runs requested.")
      await fixture.controller.commands.runForAgent("runs.list")
      expect(fixture.reads()).toBe(1)
      await fixture.store.dispatch({ type: "composer.changed", actor: "user", draft: "Chat while listing" }).isPersisted.promise
      await waitFor(() => [...fixture.store.collections.toasts.values()].some(toast => toast.status === "running"))
    } finally { gate.resolve(); await result }
  })

  test("an older filter cannot overwrite a newer result", async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = await ready(gate.promise)
    const first = fixture.controller.commands.run("runs.list", "parked")
    try {
      await waitFor(() => fixture.reads() === 1)
      await fixture.controller.commands.run("runs.list", "completed")
      await waitFor(() => fixture.returned() === 1)
      gate.resolve()
      await first
      await waitFor(() => fixture.returned() === 2)
      await settle(15)
      expect(runListCard(fixture.store)?.payload.status).toBe("completed")
      expect(runListCard(fixture.store)?.payload.runs.map(row => row.runId)).toEqual(["done"])
    } finally { gate.resolve(); await first }
  })

  test("a previous account's list cannot reappear after sign-in changes", async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = await ready(gate.promise)
    const first = fixture.controller.commands.run("runs.list")
    try {
      await waitFor(() => fixture.reads() === 1)
      await fixture.controller.adoptSession({ state: "signed-in", login: "another-owner", allowlisted: true, admin: false })
      gate.resolve()
      await first
      await waitFor(() => fixture.returned() === 1)
      await settle(15)
      expect(runListCard(fixture.store)).toBeUndefined()
    } finally { gate.resolve(); await first }
  })
  test("duplicate admission waits for the saved request before reading", async () => {
    const fixture = await ready(Promise.resolve())
    const saved = Promise.withResolvers<void>()
    const dispatch = fixture.store.dispatch
    let held = false
    let answers = 0
    Object.assign(fixture.store, { dispatch: (event: Parameters<typeof dispatch>[0]) => {
      const write = dispatch(event)
      if (!held && event.type === "card.upsert" && event.card.kind === "run-list") {
        held = true
        return { ...write, isPersisted: { promise: write.isPersisted.promise.then(() => saved.promise) } }
      }
      return write
    } })
    const first = fixture.controller.commands.run("runs.list").then(result => { answers += 1; return result })
    try {
      await waitFor(() => held)
      const second = fixture.controller.commands.runForAgent("runs.list").then(result => { answers += 1; return result })
      await settle(15)
      expect(answers).toBe(0)
      expect(fixture.reads()).toBe(0)
      saved.resolve()
      expect((await first).status).toBe("executed")
      expect((await second).status).toBe("executed")
      await waitFor(() => runListCard(fixture.store)?.payload.listRequest?.state === "complete")
      expect(fixture.reads()).toBe(1)
    } finally { saved.resolve(); Object.assign(fixture.store, { dispatch }); await first }
  })

  test("the named list owns its repository even when a different repository is selected", async () => {
    const fixture = await ready(Promise.resolve())
    await signIn(fixture.store, [REPO, "another/repo"])
    await fixture.store.dispatch({ type: "repo.selected", actor: "user", id: "another/repo" }).isPersisted.promise
    await fixture.store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: "alternate-list", kind: "run-list", title: "Runs", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: REPO, workspaceId: TEST_BOX, gatewayBindingVersion: 1, runs: [] }
    } }).isPersisted.promise
    await listInventory(fixture.controller, fixture.store, "runs.list", "parked sourceCard=alternate-list")
    expect(fixture.store.collections.cards.get("alternate-list")).toMatchObject({ payload: { repo: REPO, runs: [{ runId: "parked" }] } })
    expect(fixture.store.collections.cards.has("run-list-another/repo")).toBe(false)
  })

  test("reload reconnects the saved list without changing its request", async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = await ready(gate.promise, memoryStorage(), true)
    let reopened: AppController | undefined
    let restored: Awaited<ReturnType<typeof webStore>> | undefined
    try {
      await fixture.controller.commands.run("runs.list", "parked")
      await waitFor(() => fixture.reads() === 1)
      const id = runListCard(fixture.store)?.payload.listRequest?.id
      await fixture.controller.dispose()
      await fixture.store.dispose?.()
      restored = await createAppStore({ kind: "localStorage", storage: fixture.storage })
      reopened = createAppController(restored, silentAgent, fixture.services)
      await reopened.adoptSession({ state: "signed-in", login: "codeplanesmithers", allowlisted: true, admin: false })
      await waitFor(() => fixture.reads() === 2)
      expect(runListCard(restored)?.payload.listRequest?.id).toBe(id)
      gate.resolve()
      await waitFor(() => runListCard(restored!)?.payload.listRequest?.state === "complete")
      expect(runListCard(restored)?.payload.runs.map(row => row.runId)).toEqual(["parked"])
    } finally { gate.resolve(); await reopened?.dispose(); await restored?.dispose?.() }
  })

  for (const boundary of ["admission", "result"] as const) {
    test(`a refused ${boundary} write cannot claim a saved list and can retry`, async () => {
      const backing = memoryStorage()
      let armed = false
      let refused = 0
      const marker = JSON.stringify(`"state":"${boundary === "admission" ? "pending" : "complete"}"`).slice(1, -1)
      const storage = { ...backing, setItem: (key: string, value: string) => {
        if (armed && key.endsWith(".staged") && value.includes("listRequest") && value.includes(marker)) {
          armed = false; refused += 1
          throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError", code: 22 })
        }
        backing.setItem(key, value)
      } }
      const fixture = await ready(Promise.resolve(), storage)
      armed = true
      const result = await fixture.controller.commands.run("runs.list")
      if (boundary === "admission") {
        expect(result.status).toBe("failed")
        expect(runListCard(fixture.store)).toBeUndefined()
        expect(fixture.reads()).toBe(0)
      } else {
        await waitFor(() => runListCard(fixture.store)?.payload.listRequest?.state === "failed")
        expect([...fixture.store.collections.toasts.values()].some(toast => toast.key.startsWith("runs.list.") && toast.status === "ok")).toBe(false)
      }
      expect(refused).toBe(1)
      await listInventory(fixture.controller, fixture.store, "runs.list")
      expect(runListCard(fixture.store)?.payload.listRequest?.state).toBe("complete")
      expect(runListCard(fixture.store)?.payload.runs).toHaveLength(2)
    })
  }

  test("a replaced source rejects its old response", async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = await ready(gate.promise)
    try {
      await fixture.controller.commands.run("runs.list")
      await waitFor(() => fixture.reads() === 1)
      const card = runListCard(fixture.store)!
      await fixture.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { repo: "another/repo", runs: [] } } }).isPersisted.promise
      gate.resolve()
      await waitFor(() => fixture.returned() === 1)
      await settle(15)
      expect(runListCard(fixture.store)?.payload).toEqual({ repo: "another/repo", runs: [] })
      expect(fixture.store.collections.runtimeRuns.size).toBe(0)
    } finally { gate.resolve() }
  })

  test("completion waits for the list receipt and duplicate input shares that write", async () => {
    const gate = Promise.withResolvers<void>()
    const saved = Promise.withResolvers<void>()
    const fixture = await ready(gate.promise)
    const dispatch = fixture.store.dispatch
    let held = false
    Object.assign(fixture.store, { dispatch: (event: Parameters<typeof dispatch>[0]) => {
      const write = dispatch(event)
      if (event.type === "card.upsert" && event.card.kind === "run-list" && event.card.payload.listRequest?.state === "complete") {
        held = true
        return { ...write, isPersisted: { promise: write.isPersisted.promise.then(() => saved.promise) } }
      }
      return write
    } })
    try {
      await fixture.controller.commands.run("runs.list")
      await waitFor(() => [...fixture.store.collections.toasts.values()].some(toast => toast.key.startsWith("runs.list.") && toast.status === "running"))
      gate.resolve()
      await waitFor(() => held)
      await fixture.controller.commands.runForAgent("runs.list")
      expect(fixture.reads()).toBe(1)
      expect([...fixture.store.collections.toasts.values()].some(toast => toast.key.startsWith("runs.list.") && toast.status === "running")).toBe(true)
      saved.resolve()
      await waitFor(() => [...fixture.store.collections.toasts.values()].some(toast => toast.key.startsWith("runs.list.") && toast.status === "ok"))
    } finally { gate.resolve(); saved.resolve(); Object.assign(fixture.store, { dispatch }) }
  })

})


describe("durable run opens", () => {
  const ready = async (gate: Promise<void>, storage = memoryStorage(), toastDebounceMs = 0) => {
    const store = await createAppStore({ kind: "localStorage", storage })
    await signIn(store)
    const double = relay({ runs: [{ runId: "opened", flowId: "review-pr", status: "completed" }] })
    let reads = 0
    const services = { ...double.services, toastDebounceMs, fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (body?.payload?.selector?._tag === "run-summary") { reads += 1; await gate }
      return double.services.fetchImpl!(input, init)
    } }
    const controller = createAppController(store, silentAgent, services)
    return { store, controller, double, services, storage, reads: () => reads }
  }

  test("opening acknowledges while the summary is held and keeps Chat usable", async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = await ready(gate.promise)
    let answered = false
    const result = fixture.controller.commands.run("runs.open", "opened").then(result => { answered = true; return result })
    try {
      await waitFor(() => fixture.reads() === 1)
      await waitFor(() => answered)
      expect(said(await result)).toContain("requested")
      await fixture.store.dispatch({ type: "composer.changed", actor: "user", draft: "Chat while opening" }).isPersisted.promise
      await waitFor(() => [...fixture.store.collections.toasts.values()].some(toast => toast.status === "running"))
    } finally { gate.resolve(); await result }
  })

  test("reopening preserves the transcript snapshot and Follow choice", async () => {
    const fixture = await ready(Promise.resolve())
    await fixture.store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: "flow-run-opened", kind: "run-trace", title: "Run", status: "acted", createdAt: 1, ordinal: 1,
      payload: { repo: REPO, workspaceId: TEST_BOX, runId: "opened", workflow: "review-pr", phase: "completed", steps: [], result: null, lastSeq: 0,
        facet: "transcript", follow: false, transcriptAtRevision: 3, transcriptRows: [{ sequence: 1, kind: "assistant", text: "Saved transcript" }] }
    } }).isPersisted.promise
    await fixture.controller.commands.run("runs.open", "opened")
    await waitFor(() => fixture.reads() > 0)
    await settle(30)
    expect(fixture.store.collections.cards.get("flow-run-opened")).toMatchObject({ payload: {
      follow: false, transcriptAtRevision: 3, transcriptRows: [{ sequence: 1, kind: "assistant", text: "Saved transcript" }]
    } })
  })

  test("reload resumes the same admitted run open after identity confirmation", async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = await ready(gate.promise)
    let restored: Awaited<ReturnType<typeof webStore>> | undefined
    let reopened: AppController | undefined
    try {
      await fixture.controller.commands.run("runs.open", "opened")
      await waitFor(() => fixture.reads() === 1)
      const request = fixture.store.session().runOpenRequests![0]!
      await fixture.controller.dispose()
      await fixture.store.dispose?.()
      restored = await createAppStore({ kind: "localStorage", storage: fixture.storage })
      reopened = createAppController(restored, silentAgent, fixture.services)
      await reopened.adoptSession({ state: "signed-in", login: "codeplanesmithers", allowlisted: true, admin: false })
      await waitFor(() => fixture.reads() === 2)
      expect(restored.session().runOpenRequests![0]).toEqual(request)
      gate.resolve()
      await waitFor(() => restored!.session().runOpenRequests?.length === 0)
      expect(restored.collections.cards.get(request.cardId)).toMatchObject({ kind: "run-trace", payload: { runId: "opened" } })
    } finally { gate.resolve(); await reopened?.dispose(); await restored?.dispose?.() }
  })

  test("an old account's summary cannot create a monitor after sign-in changes", async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = await ready(gate.promise)
    try {
      await fixture.controller.commands.run("runs.open", "opened")
      await waitFor(() => fixture.reads() === 1)
      await fixture.controller.adoptSession({ state: "signed-in", login: "another-owner", allowlisted: true, admin: false })
      gate.resolve()
      await settle(30)
      expect([...fixture.store.collections.cards.values()].filter(card => card.kind === "run-trace")).toHaveLength(0)
      expect(fixture.store.session().runOpenRequests).toBeUndefined()
    } finally { gate.resolve() }
  })

  test("duplicate user and agent opens wait for admission, then share one summary", async () => {
    const gate = Promise.withResolvers<void>()
    const saved = Promise.withResolvers<void>()
    const fixture = await ready(gate.promise)
    const dispatch = fixture.store.dispatch
    let held = false
    let answers = 0
    Object.assign(fixture.store, { dispatch: (event: Parameters<typeof dispatch>[0]) => {
      const write = dispatch(event)
      if (event.type === "runs.open.requested") {
        held = true
        return { ...write, isPersisted: { promise: write.isPersisted.promise.then(() => saved.promise) } }
      }
      return write
    } })
    const first = fixture.controller.commands.run("runs.open", "opened").then(result => { answers += 1; return result })
    try {
      await waitFor(() => held)
      const second = fixture.controller.commands.runForAgent("runs.open", "opened").then(result => { answers += 1; return result })
      await settle(15)
      expect(answers).toBe(0)
      expect(fixture.reads()).toBe(0)
      saved.resolve()
      expect((await first).status).toBe("executed")
      expect((await second).status).toBe("executed")
      await waitFor(() => fixture.reads() === 1)
      expect(fixture.store.session().runOpenRequests).toHaveLength(1)
    } finally { saved.resolve(); gate.resolve(); Object.assign(fixture.store, { dispatch }); await first }
  })

  for (const boundary of ["monitor", "completion"] as const) {
    test(`the opening toast stays running through the ${boundary} receipt and deduplicates input`, async () => {
      const gate = Promise.withResolvers<void>()
      const saved = Promise.withResolvers<void>()
      const fixture = await ready(gate.promise)
      const dispatch = fixture.store.dispatch
      let held = false
      Object.assign(fixture.store, { dispatch: (event: Parameters<typeof dispatch>[0]) => {
        const write = dispatch(event)
        if (!held && (boundary === "monitor" ? event.type === "card.upsert" && event.card.kind === "run-trace" : event.type === "runs.open.settled" && event.error === undefined)) {
          held = true
          return { ...write, isPersisted: { promise: write.isPersisted.promise.then(() => saved.promise) } }
        }
        return write
      } })
      const toast = () => [...fixture.store.collections.toasts.values()].find(row => row.key.startsWith("runs.open."))
      try {
        await fixture.controller.commands.run("runs.open", "opened")
        await waitFor(() => toast()?.status === "running")
        gate.resolve()
        await waitFor(() => held)
        const reads = fixture.reads()
        await fixture.controller.commands.runForAgent("runs.open", "opened")
        expect(fixture.reads()).toBe(reads)
        expect(toast()?.status).toBe("running")
        saved.resolve()
        await waitFor(() => toast()?.status === "ok")
      } finally { saved.resolve(); gate.resolve(); Object.assign(fixture.store, { dispatch }) }
    })
  }

  test("a replaced monitor during its receipt cannot claim an opened run", async () => {
    const saved = Promise.withResolvers<void>()
    const fixture = await ready(Promise.resolve())
    const dispatch = fixture.store.dispatch
    let held = false
    Object.assign(fixture.store, { dispatch: (event: Parameters<typeof dispatch>[0]) => {
      const write = dispatch(event)
      if (!held && event.type === "card.upsert" && event.card.kind === "run-trace") {
        held = true
        return { ...write, isPersisted: { promise: write.isPersisted.promise.then(() => saved.promise) } }
      }
      return write
    } })
    try {
      await fixture.controller.commands.run("runs.open", "opened")
      await waitFor(() => held)
      const request = fixture.store.session().runOpenRequests![0]!
      await fixture.store.dispatch({ type: "card.upsert", actor: "system", card: {
        id: request.cardId, kind: "run-list", title: "Replacement", createdAt: 1, ordinal: 1, status: "active",
        payload: { repo: REPO, workspaceId: TEST_BOX, runs: [] }
      } }).isPersisted.promise
      saved.resolve()
      await waitFor(() => fixture.store.session().runOpenRequests?.[0]?.error !== undefined)
      expect(fixture.store.session().runOpenRequests![0]!.error).toContain("source run changed")
      expect(fixture.store.collections.cards.get(request.cardId)?.kind).toBe("run-list")
    } finally { saved.resolve(); Object.assign(fixture.store, { dispatch }) }
  })

  for (const boundary of ["admission", "monitor", "completion"] as const) {
    test(`a real refused ${boundary} write fails visibly and retries`, async () => {
      const backing = memoryStorage()
      let armed = false
      let refused = 0
      const marker = JSON.stringify(`"kind":"run-trace"`).slice(1, -1)
      const storage = { ...backing, setItem: (key: string, value: string) => {
        if (armed && key.endsWith(".staged") && (boundary === "admission" ? value.includes("runOpenRequests") : boundary === "completion" ? value.includes("runs.open.settled") : value.includes(marker))) {
          armed = false; refused += 1
          throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError", code: 22 })
        }
        backing.setItem(key, value)
      } }
      const fixture = await ready(Promise.resolve(), storage)
      armed = true
      const result = await fixture.controller.commands.run("runs.open", "opened")
      if (boundary === "admission") {
        expect(result.status).toBe("failed")
        expect(fixture.reads()).toBe(0)
        expect(fixture.store.session().runOpenRequests ?? []).toHaveLength(0)
      } else {
        await waitFor(() => fixture.store.session().runOpenRequests?.[0]?.error !== undefined)
        await waitFor(() => [...fixture.store.collections.toasts.values()].some(row => row.key.startsWith("runs.open.") && row.status === "failed"))
        expect([...fixture.store.collections.cards.values()].filter(card => card.kind === "run-trace")).toHaveLength(boundary === "completion" ? 1 : 0)
      }
      expect(refused).toBe(1)
      await openMonitor(fixture.controller, fixture.store, "opened")
      expect(fixture.store.session().runOpenRequests).toHaveLength(0)
      expect([...fixture.store.collections.cards.values()].filter(card => card.kind === "run-trace")).toHaveLength(1)
    })
  }

  test("a failed open's Retry retains its original gateway after workspace selection changes", async () => {
    const fixture = await ready(Promise.resolve())
    // First ask names a missing run; the refusal and request survive as the retry address.
    await openMonitor(fixture.controller, fixture.store, "missing")
    const request = fixture.store.session().runOpenRequests![0]!
    await waitFor(() => [...fixture.store.collections.toasts.values()].some(row => row.key.startsWith("runs.open.") && row.action !== undefined))
    const retry = [...fixture.store.collections.toasts.values()].find(row => row.key.startsWith("runs.open."))!.action!
    const workspaceId = "83e75ae5-0920-4000-8000-000000000001"
    await fixture.store.dispatch({ type: "workspace.updated", actor: "system", workspace: {
      id: workspaceId, repoId: REPO, name: "Coding", status: "running", targetBookmark: "main",
      provisioningStage: null, suspendedAt: null, createdAt: null, head: null
    } }).isPersisted.promise
    await fixture.store.dispatch({ type: "repo.selected", actor: "user", id: `${REPO}#workspace:${workspaceId}` }).isPersisted.promise
    expect(fixture.store.session().activeRepoKey).toBe(`${REPO}#workspace:${workspaceId}`)
    const before = fixture.double.calls.length
    expect((await fixture.controller.commands.run(retry.flow, retry.args)).status).toBe("executed")
    await waitFor(() => fixture.store.session().runOpenRequests?.[0]?.error !== undefined)
    expect(fixture.store.session().runOpenRequests![0]).toMatchObject({ cardId: request.cardId, repo: REPO })
    expect(fixture.store.session().runOpenRequests![0]!.workspaceId).toBe(TEST_BOX)
    const calls = fixture.double.calls.slice(before).filter(call => call.path.startsWith("/api/workflow/"))
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call.body).toMatchObject({ workspaceId: TEST_BOX })
    expect((await fixture.controller.commands.run("runs.open", flowArgs("runs.open", { runId: "opened", requestId: request.id }))).status).toBe("failed")
  })


  test("a fast summary with a slow completion receipt still shows the debounced running toast", async () => {
    const saved = Promise.withResolvers<void>()
    const fixture = await ready(Promise.resolve(), memoryStorage(), 100)
    const dispatch = fixture.store.dispatch
    let held = false
    Object.assign(fixture.store, { dispatch: (event: Parameters<typeof dispatch>[0]) => {
      const write = dispatch(event)
      if (event.type === "runs.open.settled" && event.error === undefined) {
        held = true
        return { ...write, isPersisted: { promise: write.isPersisted.promise.then(() => saved.promise) } }
      }
      return write
    } })
    const toast = () => [...fixture.store.collections.toasts.values()].find(row => row.key.startsWith("runs.open."))
    try {
      await fixture.controller.commands.run("runs.open", "opened")
      await waitFor(() => held)
      await waitFor(() => toast()?.status === "running")
      saved.resolve()
      await waitFor(() => toast()?.status === "ok")
    } finally { saved.resolve(); Object.assign(fixture.store, { dispatch }) }
  })

})

test("admin inbox reads another account in the background and answers its existing question", async () => {
  const store = await webStore()
  const double = relay()
  const held = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const foreignBox = "88888888-1111-4111-8111-111111111111"
  const question = {
    ...approvalRow("foreign-run", "register-repository/review#1", "Register other/repo?"),
    waitRunId: "foreign-wait",
    request: { name: "register-repository/review", kind: "select", prompt: "Register other/repo?", options: ["Approve", "Decline"] }
  }
  let rows = [question]
  const submitted: Array<Record<string, any>> = []
  const originalFetch = double.services.fetchImpl!
  const controller = createAppController(store, silentAgent, { ...double.services, fetchImpl: async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    if (body?.procedure === "Registration.Reviews") {
      started.resolve()
      await held.promise
      return json(200, { ok: true, payload: { inboxes: [{ repo: "other/repo", workspaceId: foreignBox, rows }], next: "" } })
    }
    if (body?.procedure === "Approval.Submit" && body.workspaceId === foreignBox) {
      submitted.push(body)
      rows = []
      return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "review", runId: "foreign-run" } } })
    }
    return originalFetch(input, init)
  } })
  await signIn(store)
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "codeplanesmithers", allowlisted: true, admin: true, scopesPlain: null }).isPersisted.promise
  try {
    expect(said(await controller.commands.run("approvals.list"))).toBe("Approvals requested.")
    await started.promise
    expect(inboxRequests(store)).toHaveLength(1)
    expect([...store.collections.cards.values()].some(card => card.kind === "approvals-inbox" && card.payload.repo === "other/repo")).toBe(false)
    held.resolve()
    await waitFor(() => inboxRequests(store).length === 0)
    const inbox = [...store.collections.cards.values()].find(card => card.kind === "approvals-inbox" && card.payload.repo === "other/repo")!
    expect(inbox.kind === "approvals-inbox" && inbox.payload.workspaceId).toBe(foreignBox)
    controller.answerApproval(approvalActionId(inbox.id, question), "Approve")
    await waitFor(() => submitted.length === 1)
    expect(submitted[0]).toMatchObject({ repo: "other/repo", workspaceId: foreignBox, payload: { ...question.payload, decision: "approve", answer: "Approve" } })
    await waitFor(() => [...store.collections.runtimeApprovals.values()].some(row => row.scope.workspaceId === foreignBox && row.row.status === "approved"))
    await listInbox(controller, store)
    const refreshed = store.collections.cards.get(inbox.id)
    expect(refreshed?.kind === "approvals-inbox" && refreshed.payload.approvals).toEqual([])
  } finally { held.resolve() }
})
