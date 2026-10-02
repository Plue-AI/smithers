/*
 * Wave 11 — "make me a workflow" becomes true, proven at the controller.
 *
 * Every test here drives the REAL controller against a relay double that
 * speaks the rc.0 gateway's own procedures behind the product Worker's
 * /api/workflow/{provision,rpc} seam: `List`, `Plan`, `Run`, `Cancel`,
 * `Approval.Submit`, and the `run-summary` and `approvals` projections.
 *
 * The bar: a workflow is created, presented, and run — from the conversation —
 * as an EMBEDDED run card that never silently stalls, whose approval only the
 * human can decide.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { repositoryFlowsOf } from "./seams/RepositoryFlowsSeam"
import type { Card } from "@smthrs/rpc/Cards"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { json, loadBox, memoryStorage, scriptedToolAgent, settle, signupProfileFetch, silentAgent, waitFor } from "./TestFixtures"
import { GATEWAY_REFUSED } from "./controller/GatewayFailureCopy"
import { SIGNUP_PROFILE_PATH } from "./Signup"

const createAppController = scopedControllers()

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const REPO = "codeplanesmithers/smithers-demo"

/**
 * What a command said back. A registered command that returns a string is an
 * honest refusal (`failed`); one that returns `{value}` executed and speaks.
 */
const said = (outcome: { status: string; value?: string; error?: string }): string =>
  outcome.status === "failed" ? (outcome.error ?? "") : (outcome.value ?? "")

/**
 * The relay double: one scriptable workspace behind the product Worker's
 * /api/workflow/* seam, answering the rc.0 gateway's own procedures.
 *
 * `advance()` is what a real run's progress looks like from the outside — the
 * summary's counters move — because the rc.0 read path serves a projection,
 * not an event log: the state IS the answer, so a poll that misses a beat
 * loses nothing.
 */
const relay = (options: {
  readonly flows?: ReadonlyArray<{ flowId: string; description?: string }>
  readonly provision?: () => unknown
  readonly readsFail?: () => boolean
  readonly events?: () => ReadonlyArray<Record<string, unknown>>
  readonly eventReadsFail?: () => boolean
  /** Exercise the current cursor contract instead of the legacy cursorless fallback. */
  readonly typedCursors?: boolean
  /** Make provisioning slow enough to cross the toast debounce (the 300ms law). */
  readonly provisionDelayMs?: number
} = {}) => {
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const approvals: Array<Record<string, unknown>> = []
  const state = {
    runStatus: "running" as string,
    waitingReason: undefined as string | undefined,
    verdict: "completed — I built `summarize-open-issues`, which writes one digest of your open issues.",
    turns: 0,
    calls: 0,
    callsFailed: 0,
    launched: [] as Array<{ workflow: string; input: unknown }>
  }
  const flows = options.flows ?? [
    { flowId: "create-flow", description: "Build a new Smithers workflow from a plain-English ask." },
    { flowId: "review-pr" }
  ]
  /** What the plan card of the launch in flight said. */
  let planned: { flowId: string; input: unknown } | undefined

  const summaryRow = (): Record<string, unknown> => ({
    runId: "run-w11",
    flowId: state.launched.at(-1)?.workflow ?? "review-pr",
    status: state.runStatus,
    createdAt: 1,
    updatedAt: 2 + state.turns + state.calls,
    ...(state.waitingReason === undefined ? {} : { waitingReason: state.waitingReason }),
    turns: state.turns,
    calls: state.calls,
    callsFailed: state.callsFailed,
    editsAttempted: 0,
    editsSucceeded: 0,
    inputTokens: 0,
    outputTokens: 0,
    verdict: state.verdict,
    diagnosis: `Verdict   ${state.verdict}`
  })

  const snapshot = (rows: ReadonlyArray<unknown>, projection: string): Response =>
    json(200, { ok: true, payload: { cursor: { projection, runId: "run-w11", value: 1,
      ...(options.typedCursors ? { selector: { _tag: projection, runId: "run-w11" }, offset: 0 } : {}) }, rows } })

  const procedure = (name: string, payload: Record<string, unknown>): Response => {
    switch (name) {
      case "List":
        return json(200, {
          ok: true,
          payload: {
            _tag: "flows",
            items: flows.map((flow) => ({ flowId: flow.flowId, description: flow.description ?? "" }))
          }
        })
      case "Plan": {
        // The real gateway resolves its registry on a miss, then refuses
        // honestly — the only truthful "no such flow".
        const flowId = String(payload.flowId)
        if (!flows.some((entry) => entry.flowId === flowId)) {
          // In the wire's own shape: ControlError.FlowNotFound carries no message, so the relay
          // writes the sentence and the encoded reasons array names the code the client reads.
          return json(200, {
            ok: false,
            error: {
              message: `No flow "${flowId}" is registered on this workspace.`,
              detail: [{ _tag: "Fail", error: { _tag: "/control/FlowNotFound", code: "flow_not_found", flowId } }]
            }
          })
        }
        planned = { flowId, input: payload.input }
        return json(200, {
          ok: true,
          payload: {
            planId: `plan-${flowId}`,
            flowId,
            digest: "digest-1",
            envelope: { capabilities: [], flows: [], budget: {} },
            inputSummary: "",
            deployClass: false,
            nodes: []
          }
        })
      }
      case "Run": {
        state.launched.push({ workflow: planned?.flowId ?? "?", input: planned?.input })
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: "run-w11" } })
      }
      case "Cancel":
        state.runStatus = "cancelled"
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "c", runId: "run-w11" } })
      case "Approval.Submit":
        return json(200, {
          ok: true,
          payload: { decision: { _tag: "Accepted", receiptId: "a" }, resume: { _tag: "Accepted", receiptId: "b" } }
        })
      case "Projection.Snapshot": {
        if (options.readsFail?.() === true) {
          return json(200, { ok: false, error: { message: "the workspace gateway is unreachable" } })
        }
        const selector = (payload.selector ?? {}) as { _tag?: string }
        if (selector._tag === "approvals") return snapshot(approvals, "approvals")
        if (selector._tag === "run-events") {
          if (options.eventReadsFail?.() === true) return json(200, { ok: false, error: { message: "engine evidence unavailable" } })
          const after = options.typedCursors ? payload.after as { value: number; offset: number } | undefined : undefined
          const offsets = new Map<number, number>()
          const events = (options.events?.() ?? []).filter(event => {
            const seq = Number(event.sequence), offset = (offsets.get(seq) ?? -1) + 1
            offsets.set(seq, offset)
            return after === undefined || seq > after.value || seq === after.value && offset > after.offset
          })
          return snapshot(events, "run-events")
        }
        return snapshot([summaryRow()], "run-summary")
      }
      default:
        return json(200, { ok: false, error: { message: `no ${name}` } })
    }
  }

  // The sign-in's signup-profile read answers as the backend does for a new account; every other request is recorded.
  const profile = signupProfileFetch(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    // The repository-flows seam reads .smithers/factory.json in the background whenever the target repository changes (the slash leaves); it is not this test's request.
    if (absolute.pathname.endsWith("/contents/.smithers/factory.json")) return json(404, { status: "error", message: "no projection" })
    // The same seam reads the repository homepage beside it.
    if (/^\/api\/repos\/[^/]+\/[^/]+\/home$/.test(absolute.pathname)) return json(404, { status: "error", message: "no homepage" })
    calls.push({ path: absolute.pathname + absolute.search, method: init?.method ?? "GET", body })
    if (absolute.pathname === "/api/workflow/provision") {
      if (options.provisionDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.provisionDelayMs))
      }
      return json(200, options.provision?.() ?? { status: "ready", repo: REPO, gatewayId: "gw-1" })
    }
    if (absolute.pathname === "/api/workflow/rpc") {
      return procedure(String(body.procedure), (body.payload ?? {}) as Record<string, unknown>)
    }
    return json(404, { status: "error", message: `no stub for ${absolute.pathname}` })
  })
  const services: AppServices = {
    workflowPollMs: 1,
    toastDebounceMs: 0,
    toastAutoDismissMs: 10_000,
    fetchImpl: profile.fetchImpl
  }

  const gate = (requestId: string): Record<string, unknown> => ({
    runId: "run-w11",
    requestId,
    title: "Open a pull request with the new workflow",
    request: {},
    payload: {
      target: {
        _tag: "Node",
        runId: "run-w11",
        requestId,
        digest: `digest-${requestId}`,
        envelope: { capabilities: [], flows: [], budget: {} }
      },
      scope: "run",
      idempotencyKey: `approve:${requestId}`
    },
    requestedAt: 1,
    status: "pending"
  })

  return {
    services,
    calls,
    profileReads: profile.reads,
    state,
    /** The run did some work: the summary's counters move. */
    advance: (turns: number, callCount: number, failed = 0) => {
      state.turns += turns
      state.calls += callCount
      state.callsFailed += failed
    },
    park: (requestId: string) => {
      state.runStatus = "waiting-approval"
      state.waitingReason = "approval"
      approvals.push(gate(requestId))
    },
    /*
     * A park the run reports as `parked` rather than `waiting-approval`. Both
     * are real rc.0 statuses and both mean a human has to decide, so a card
     * that only recognized one would leave the other with no way to unblock.
     */
    parkAsParked: (requestId: string) => {
      state.runStatus = "parked"
      state.waitingReason = "approval"
      approvals.push(gate(requestId))
    },
    finish: () => {
      state.runStatus = "completed"
      state.waitingReason = undefined
      approvals.length = 0
    },
    fail: (verdict = "failed — OPENROUTER_API_KEY is not set") => {
      state.runStatus = "failed"
      state.waitingReason = undefined
      state.verdict = verdict
    }
  }
}

const signIn = async (store: Awaited<ReturnType<typeof webStore>>, loaded: string[] | null = [REPO]) => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "codeplanesmithers",
    admin: false,
    scopesPlain: null
  })
  if (loaded !== null) {
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
    for (const [index, fullName] of loaded.entries()) await loadBox(store, fullName, `0b0c0d0e-0000-4000-8000-00000000000${index + 1}`)
  }
  await settle(2)
}

/** The box signIn loads for the n-th loaded repository (1-based). */
const boxOf = (n = 1) => `0b0c0d0e-0000-4000-8000-00000000000${n}`
const listId = (repo: string, n = 1) => `workflow-list@${encodeURIComponent(repo)}@${encodeURIComponent(boxOf(n))}`
const W11_APPROVAL = `approval@${[REPO, boxOf(), "run-w11"].map(encodeURIComponent).join("@")}@open-pr`

const runCard = (store: Awaited<ReturnType<typeof webStore>>): Extract<Card, { kind: "run-trace" }> | undefined => {
  const card = [...store.collections.cards.values()].find(card => card.kind === "run-trace" && card.payload.runId === "run-w11")
  return card?.kind === "run-trace" ? card : undefined
}

/** The durable card `flow.create` mints: where a background refusal is stated and retried. */
const authoringCard = (store: Awaited<ReturnType<typeof webStore>>): Extract<Card, { kind: "run-trace" }> | undefined => {
  const card = [...store.collections.cards.values()].find(card => card.kind === "run-trace" && card.payload.authoring !== undefined)
  return card?.kind === "run-trace" ? card : undefined
}

/** A scripted tool-loop agent (the ToolLoop.test.ts pattern). */
describe("wave 11 — the full journey: make me a workflow", () => {
  test("description → provision → run card → approval → completed card leading with the result", async () => {
    const store = await webStore()
    // A slow provision so the toast genuinely crosses the debounce (the 300ms
    // law): work that settles faster than that must never flash anything.
    const double = relay({ provisionDelayMs: 8 })
    const controller = createAppController(store, silentAgent, {
      ...double.services,
      toastDebounceMs: 1
    })
    await signIn(store)

    double.advance(1, 1)
    const outcome = await controller.commands.run(
      "flow.create",
      "a workflow that summarizes my open issues"
    )
    expect(outcome.status).toBe("executed")
    /* The door SAVES the request and answers; provision and launch ride the background. */
    expect(said(outcome)).toBe(`flow-requested repo=${REPO}`)
    await waitFor(() => double.state.launched.length > 0)

    // The gateway was provisioned BEFORE anything was launched, and the
    // launch is the stock create-flow with the description as its input.
    const order = double.calls.filter(call => call.path.startsWith("/api/workflow/")).map((call) => call.path)
    expect(double.profileReads).toEqual([SIGNUP_PROFILE_PATH])
    expect(order[0]).toBe("/api/workflow/provision")
    expect(double.state.launched).toEqual([
      { workflow: "create-flow", input: { args: "a workflow that summarizes my open issues" } }
    ])
    // The provision toast reported and then SETTLED into its result — the
    // wave-9 law: a toast past the debounce never keeps its running sentence.
    const toast = [...store.collections.toasts.values()].find((entry) => entry.key.startsWith("flow.provision"))
    expect(toast?.status).toBe("ok")
    expect(toast?.title).toBe("Box ready")

    // THE EMBED LAW: a card in the transcript, and the surface never moved.
    const card = runCard(store)
    expect(card).toBeDefined()
    expect(card?.payload.repo).toBe(REPO)
    expect(card?.payload.workflow).toBe("create-flow")
    expect(store.collections.sessions.get("main")?.surface).toBe("chat")

    // Progress arrives in WORDS, never as a raw payload.
    await waitFor(() => runCard(store)?.payload.steps.join(" ").includes("1 turn · 1 call") === true)
    expect(runCard(store)?.payload.steps.join(" ")).toContain("1 turn · 1 call")
    expect(runCard(store)?.payload.steps.join(" ")).not.toContain("{")
    expect(runCard(store)?.payload.phase).toBe("running")

    // The run parks on an outbound act — the approval tier, not an auto-yes.
    double.park("open-pr")
    await waitFor(() => runCard(store)?.payload.phase === "waiting-approval")
    expect(runCard(store)?.payload.phase).toBe("waiting-approval")
    const approval = store.collections.cards.get(W11_APPROVAL)
    expect(approval?.kind).toBe("approval")
    expect(approval?.kind === "approval" && approval.payload.repo).toBe(REPO)
    expect(approval?.title).toContain("pull request")

    // The human decides. The decision goes back as the exact envelope the
    // gateway published, through THIS user's gateway.
    await controller.commands.run("approval.approve", W11_APPROVAL)
    await settle(6)
    // The plan approval the launch itself takes is an `Approval.Submit` too;
    // the human's decision is the one on the run's own gate.
    const decision = double.calls.find((call) => {
      const body = call.body as { procedure?: string; payload?: { target?: { _tag?: string } } } | undefined
      return body?.procedure === "Approval.Submit" && body.payload?.target?._tag === "Node"
    })
    expect(decision?.body).toMatchObject({
      repo: REPO,
      procedure: "Approval.Submit",
      payload: { decision: "approve", target: { _tag: "Node", runId: "run-w11", requestId: "open-pr" } }
    })

    // ONE call: the gateway records the decision and resumes the run itself,
    // so the client never issues a second manual resume.
    expect(
      double.calls.filter((call) => (call.body as { procedure?: string } | undefined)?.procedure === "Resume")
    ).toHaveLength(0)

    double.finish()
    await waitFor(() => runCard(store)?.payload.phase === "completed")

    const done = runCard(store)
    expect(done?.payload.phase).toBe("completed")
    expect(done?.status).toBe("acted")
    // The result LEADS — stated in words, in the chat and on the card.
    expect(done?.payload.result).toContain("summarize-open-issues")
    expect([...store.collections.messages.values()].some((message) => message.text.includes("summarize-open-issues")))
      .toBe(
        true
      )
  })

  test("the agent invoking flow.create from the conversation renders the card, never a surface", async () => {
    const store = await webStore()
    const double = relay()
    const { agent, requests } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({
            action: "execute",
            name: "flow.create",
            args: "a workflow that summarizes my open issues"
          })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: "Started it — the card tracks it live." },
        { type: "done" as const, reason: "stop" as const }
      ]
    ])
    const controller = createAppController(store, agent, double.services)
    await signIn(store)

    controller.send("can you make me a smithers workflow that summarizes my open issues?")
    await settle(30)

    expect(double.state.launched[0]?.workflow).toBe("create-flow")
    expect(runCard(store)).toBeDefined()
    expect(store.collections.sessions.get("main")?.surface).toBe("chat")
    // The tool result the model saw states the REQUEST, so it cannot claim
    // something the seam did not do.
    const secondTurn = requests[1]
    expect(JSON.stringify(secondTurn?.messages)).toContain(`flow-requested repo=${REPO}`)
    // The transcript act line is compact — no raw tool payload.
    expect([...store.collections.messages.values()].map((message) => message.text).join("\n")).not.toContain(
      "{\"state\""
    )
  })
})

describe("wave 11 — the loaded repositories are the universe", () => {
  test("no repository loaded gets the honest name-one line instead of a guess", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store, null)

    const outcome = await controller.commands.run("flow.create", "summarize my issues")
    expect(said(outcome)).toContain("No repository is loaded yet")
    expect(double.calls.some((call) => call.path === "/api/workflow/provision")).toBe(false)
  })

  test("signed out, nothing reaches the seam — the answer names the one step", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)

    for (const command of ["flow.create", "flow.list", "flow.run"]) {
      const outcome = await controller.commands.run(command, command === "flow.list" ? undefined : "x")
      expect(said(outcome)).toContain("Sign in")
    }
    expect(double.calls).toHaveLength(0)
  })
})

describe("wave 11 — the run card never silently stalls", () => {
  test("a terminal control verdict keeps observing until the native projection settles, without repeating the verdict", async () => {
    const store = await webStore()
    const events: Array<Record<string, unknown>> = [{
      sequence: 1, occurredAt: 1, kind: "control.engine.projection-started",
      payload: { version: 1, executionId: "run-w11", generation: 0 }
    }]
    const double = relay({ events: () => events, typedCursors: true })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    double.finish()
    await controller.commands.run("flow.run", "review-pr")
    await waitFor(() => runCard(store)?.payload.phase === "completed")
    expect(runCard(store)?.payload.phase).toBe("completed")
    const reads = () => double.calls.filter((call) =>
      (call.body as { payload?: { selector?: { _tag?: string } } })?.payload?.selector?._tag === "run-events"
    ).length
    const whilePending = reads()
    await waitFor(() => reads() > whilePending)
    expect(reads()).toBeGreaterThan(whilePending)
    events.push({ sequence: 2, occurredAt: 2, kind: "control.engine.projection-settled", payload: { version: 1, executionId: "run-w11", generation: 0 } })
    await waitFor(() => runCard(store)?.payload.events?.at(-1)?.kind === "control.engine.projection-settled")
    expect(runCard(store)?.payload.events?.at(-1)?.kind).toBe("control.engine.projection-settled")
    expect(runCard(store)?.payload.events?.map(event => event.sequence)).toEqual([1, 2])
    const suffixReads = double.calls.flatMap(call => {
      const body = call.body as { payload?: { selector?: { _tag?: string }; after?: unknown } }
      return body?.payload?.selector?._tag === "run-events" && body.payload.after !== undefined ? [body.payload.after] : []
    })
    expect(suffixReads.length).toBeGreaterThan(1)
    expect(suffixReads).toEqual(suffixReads.map(() => ({ selector: { _tag: "run-events", runId: "run-w11" },
      projection: "run-events", runId: "run-w11", value: 1, offset: 0 })))
    const finishedReads = reads()
    await settle(15)
    expect(reads()).toBe(finishedReads)
    expect([...store.collections.messages.values()].filter((message) => message.text === double.state.verdict)).toHaveLength(1)
  })

  test("an empty pending native suffix reaches the quiet bound without changing a completed verdict", async () => {
    const store = await webStore()
    const double = relay({ typedCursors: true, events: () => [{ sequence: 1, occurredAt: 1,
      kind: "control.engine.projection-started", payload: { version: 1, executionId: "run-w11", generation: 0 } }] })
    const controller = createAppController(store, silentAgent, { ...double.services, workflowQuietMs: 40 })
    await signIn(store)
    double.finish()
    await controller.commands.run("flow.run", "review-pr")
    await waitFor(() => runCard(store)?.payload.observationError?.includes("has not finished synchronizing") === true)
    expect(runCard(store)?.payload.phase).toBe("completed")
    expect(runCard(store)?.payload.result).toBe(double.state.verdict)
    expect(runCard(store)?.payload.observationError).toContain("has not finished synchronizing")
    expect(runCard(store)?.payload.events).toHaveLength(1)
    const reads = double.calls.length
    await settle(15)
    expect(double.calls.length).toBe(reads)
  })

  test("reload resumes incomplete terminal observations and a read refusal preserves the real terminal phase", async () => {
    const storage = memoryStorage()
    let store = await createAppStore({ kind: "localStorage", storage })
    let unavailable = false
    const events = [{ sequence: 1, occurredAt: 1, kind: "control.engine.projection-started", payload: { version: 1, executionId: "run-w11", generation: 0 } }]
    const double = relay({ events: () => events, eventReadsFail: () => unavailable, typedCursors: true })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    double.state.turns = 2
    double.state.calls = 3
    double.state.runStatus = "failed"
    double.state.verdict = "Typecheck rejected the implementation."
    await controller.commands.run("flow.run", "review-pr")
    await waitFor(() => runCard(store)?.payload.phase === "failed")
    expect(runCard(store)?.payload.phase).toBe("failed")
    const stepsBeforeReload = runCard(store)?.payload.steps
    await controller.dispose()
    unavailable = true
    store = await createAppStore({ kind: "localStorage", storage })
    const resumed = createAppController(store, silentAgent, double.services)
    // Session reconciliation invokes this after the account is authenticated.
    resumed.resumeWorkflowRuns()
    const readRefused = `The run has settled, but its recorded engine evidence could not be read: ${GATEWAY_REFUSED}`
    await waitFor(() => runCard(store)?.payload.observationError === readRefused)
    expect(runCard(store)?.payload.phase).toBe("failed")
    expect(runCard(store)?.payload.error).toBe(double.state.verdict)
    expect(runCard(store)?.payload.steps).toEqual(stepsBeforeReload)
    expect(runCard(store)?.payload.observationError).toBe(readRefused)
    expect(runCard(store)?.payload.observationError).not.toContain("engine evidence unavailable")
    const reads = double.calls.length
    await settle(15)
    expect(double.calls.length).toBe(reads)
    unavailable = false
    events.push({ sequence: 2, occurredAt: 2, kind: "control.engine.projection-settled", payload: { version: 1, executionId: "run-w11", generation: 0 } })
    await resumed.commands.run("flow.run.retry", runCard(store)!.id)
    expect(runCard(store)?.payload.error).toBe(double.state.verdict)
    await waitFor(() => runCard(store)?.payload.observationError === undefined)
    expect(runCard(store)?.payload.error).toBe(double.state.verdict)
    expect(runCard(store)?.payload.observationError).toBeUndefined()
  })

  test("reload does not repeat the same counters for a still-running run", async () => {
    const storage = memoryStorage()
    let store = await createAppStore({ kind: "localStorage", storage })
    const double = relay()
    double.advance(2, 3)
    let controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    await controller.commands.run("flow.run", "review-pr")
    await waitFor(() => runCard(store)?.payload.steps.includes("2 turns · 3 calls") === true)
    const before = runCard(store)?.payload.steps
    expect(before).toContain("2 turns · 3 calls")
    await controller.dispose()
    store = await createAppStore({ kind: "localStorage", storage })
    controller = createAppController(store, silentAgent, double.services)
    controller.resumeWorkflowRuns()
    await waitFor(() => runCard(store)?.payload.phase === "running")
    expect(runCard(store)?.payload.phase).toBe("running")
    expect(runCard(store)?.payload.steps).toEqual(before)
  })

  test("stream loss flips the card to the honest reconnecting state, then it catches up", async () => {
    const store = await webStore()
    let broken = false
    const double = relay({ readsFail: () => broken })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    double.advance(1, 1)
    await controller.commands.run("flow.run", "review-pr")
    await waitFor(() => runCard(store)?.payload.phase === "running")
    expect(runCard(store)?.payload.phase).toBe("running")

    // The 600s relay cap makes this ROUTINE, not exceptional.
    broken = true
    await waitFor(() => runCard(store)?.payload.phase === "reconnecting")
    expect(runCard(store)?.payload.phase).toBe("reconnecting")

    broken = false
    double.advance(1, 2)
    await waitFor(() => runCard(store)?.payload.phase === "running")
    expect(runCard(store)?.payload.phase).toBe("running")
    expect(runCard(store)?.payload.steps.join(" ")).toContain("2 turns · 3 calls")
  })

  test("a re-read never re-narrates what the card already said", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    double.advance(1, 1)
    await controller.commands.run("flow.run", "review-pr")
    await settle(25)

    /*
     * The rc.0 read path serves a projection, not an event log: every poll
     * carries the whole current answer, so there is no cursor to resume from
     * and no replay to de-duplicate. The card narrates a line only when the
     * answer actually changed.
     */
    const steps = runCard(store)?.payload.steps ?? []
    expect(steps.filter((step) => step === "1 turn · 1 call")).toHaveLength(1)
    expect(double.calls.filter((call) => call.path === "/api/workflow/rpc").length).toBeGreaterThan(1)
  })

  test("a failed run states it and stops — no card left spinning", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    await controller.commands.run("flow.run", "review-pr")
    double.fail()
    await waitFor(() => runCard(store)?.payload.phase === "failed")
    expect(runCard(store)?.payload.phase).toBe("failed")
    expect(runCard(store)?.status).toBe("error")
    expect([...store.collections.messages.values()].some((message) => message.text.includes("failed"))).toBe(true)
  })

  test("a failed run uses shared failure copy and retains the engine diagnosis on its card", async () => {
    /*
     * The old wire made the client infer failure from an event because
     * `getRun.status` lagged behind it. The rc.0 run summary carries the
     * status AND the diagnosis the engine computed from the run's own
     * events, so the card states the reason rather than guessing at one.
     */
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    await controller.commands.run("flow.run", "review-pr")
    double.fail(
      "failed — Smithers generated an OpenRouter default agent, but OPENROUTER_API_KEY is not set."
    )
    await waitFor(() => runCard(store)?.payload.phase === "failed")

    const card = runCard(store)
    expect(card?.payload.phase).toBe("failed")
    expect(card?.payload.error).toContain("OPENROUTER_API_KEY is not set")
    // Uncoded infrastructure failures use shared human copy; the exact engine
    // reason remains available in the card instead of becoming user blame.
    const messages = [...store.collections.messages.values()].map(message => message.text)
    expect(messages).toContain("The run failed: Something on Smithers' side failed. Not your fault, and nothing your request could have changed.")
    expect(messages.some(message => message.includes("OPENROUTER_API_KEY"))).toBe(false)
  })

  test("a run parked on approval gets its card whichever parked status it reports", async () => {
    /*
     * `parked` and `waiting-approval` are both rc.0 statuses and both mean a
     * human has to decide. A card that recognized only one would leave the
     * other reading Running with no way to unblock it — the run would then
     * wait on a decision it never asked for.
     */
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    await controller.commands.run("flow.run", "review-pr")
    double.parkAsParked("open-pr")
    await settle(30)

    expect(double.state.runStatus).toBe("parked")
    // The card asked for the gate anyway, and reads honestly.
    const approval = store.collections.cards.get(W11_APPROVAL)
    expect(approval?.kind).toBe("approval")
    expect(approval?.kind === "approval" && approval.payload.repo).toBe(REPO)
    expect(runCard(store)?.payload.phase).toBe("waiting-approval")

    // And it round-trips through this user's gateway like any other.
    await controller.commands.run("approval.approve", W11_APPROVAL)
    await settle(6)
    const submitted = double.calls.find((call) => {
      const body = call.body as { procedure?: string; payload?: { target?: { _tag?: string } } } | undefined
      return body?.procedure === "Approval.Submit" && body.payload?.target?._tag === "Node"
    })
    expect(submitted?.body).toMatchObject({
      repo: REPO,
      payload: { decision: "approve", target: { requestId: "open-pr" } }
    })
  })

  test("a run that has done nothing yet narrates nothing", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    await controller.commands.run("flow.run", "review-pr")
    await settle(20)

    // No turns and no calls is not progress, and saying so would be noise
    // where a human is watching for movement.
    const steps = runCard(store)?.payload.steps ?? []
    expect(steps.filter((step) => step.includes("turn"))).toHaveLength(0)
    expect(runCard(store)?.payload.phase).toBe("running")
  })

  test("no_capacity is a passing truth — stated honestly, nothing launched, nothing retry-looped", async () => {
    const store = await webStore()
    const double = relay({
      provisionDelayMs: 8,
      provision: () => ({
        status: "no-capacity",
        message: "Smithers Cloud has no free workspace capacity right now — nothing was queued; try again in a bit."
      })
    })
    const controller = createAppController(store, silentAgent, {
      ...double.services,
      toastDebounceMs: 1
    })
    await signIn(store)

    expect(said(await controller.commands.run("flow.create", "summarize my issues"))).toBe(`flow-requested repo=${REPO}`)
    /* The refusal is the durable card's, where the retry door stands beside it. */
    await waitFor(() => authoringCard(store)?.payload.authoring?.launchError !== undefined)
    expect(authoringCard(store)?.payload.authoring?.launchError).toContain("no free workspace capacity")
    expect(double.state.launched).toHaveLength(0)
    expect(double.calls.filter((call) => call.path === "/api/workflow/provision")).toHaveLength(1)
    // The failure toast keeps the attempt and states why.
    expect([...store.collections.toasts.values()].some((toast) => toast.status === "failed")).toBe(true)
  })
})

describe("wave 11 — workflows are presented", () => {
  test("flow.list renders the workspace's workflows as an embedded card", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    const outcome = await controller.commands.run("flow.list")
    expect(outcome.status).toBe("executed")
    expect(said(outcome)).toBe("Flows requested.")
    await waitFor(() => store.collections.cards.get(listId(REPO))?.loading === false)
    const card = store.collections.cards.get(listId(REPO))
    expect(card?.kind).toBe("workflow-list")
    expect(card?.kind === "workflow-list" && card.payload.workflows.map((entry) => entry.key)).toEqual([
      "create-flow",
      "review-pr"
    ])
    // A workflow with no description says nothing rather than inventing one.
    expect(card?.kind === "workflow-list" && card.payload.workflows[1]?.description).toBeNull()
    expect(store.collections.sessions.get("main")?.surface).toBe("chat")
  })

  test("flow.list uses the selected repository and accepts an explicit override", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    try {
      await signIn(store, [REPO, "another/project"])
      store.dispatch({ type: "repo.selected", actor: "user", id: "another/project" })
      expect((await controller.commands.run("flow.list")).status).toBe("executed")
      await waitFor(() => double.calls.some(call => call.path === "/api/workflow/provision"))
      expect(double.calls.find((call) => call.path === "/api/workflow/provision")?.body).toEqual({ repo: "another/project", workspaceId: boxOf(2) })
      expect(store.collections.cards.has(listId("another/project", 2))).toBe(true)
      expect((await controller.commands.run("flow.list", REPO)).status).toBe("executed")
      expect(store.collections.cards.has(listId(REPO))).toBe(true)
    } finally { controller.dispose() }
  })

  test("flow.run refuses a name the workspace does not have, and names what it does have", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    const outcome = await controller.commands.run("flow.run", "nope")
    expect(said(outcome)).toContain("run-requested")
    await waitFor(() => [...store.collections.cards.values()].some(card => card.kind === "run-trace" && card.payload.workflow === "nope" && card.status === "error"))
    const failed = [...store.collections.cards.values()].find(card => card.kind === "run-trace" && card.payload.workflow === "nope")!
    expect(failed.kind === "run-trace" && failed.payload.error).toContain("There's no flow called nope")
    expect(failed.kind === "run-trace" && failed.payload.error).toContain("create-flow")
    expect(double.state.launched).toHaveLength(0)
  })

  test("a workspace without create-flow is refused by the LAUNCH, and told what to do", async () => {
    // A listing is never the evidence: only the launch resolves the registry.
    // What the launch's miss is turned into is L106's rule — the workspace
    // cannot author a flow, so say that and what closes it, not the id.
    const store = await webStore()
    const double = relay({ flows: [{ flowId: "review-pr" }] })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    expect(said(await controller.commands.run("flow.create", "summarize my issues"))).toBe(`flow-requested repo=${REPO}`)
    await waitFor(() => authoringCard(store)?.payload.authoring?.launchError !== undefined)
    const refusal = authoringCard(store)?.payload.authoring?.launchError ?? ""
    expect(refusal).not.toContain("is registered on this workspace")
    expect(refusal).toContain("flow-authoring flow")
    expect(double.state.launched).toHaveLength(0)
    // It tried the launch — it did not refuse on a stale list.
    expect(double.calls.some((call) => (call.body as { procedure?: string } | undefined)?.procedure === "Plan")).toBe(
      true
    )
  })

  test("a listing that disagrees with the registry never blocks a flow the workspace really has", async () => {
    // Regression for the live-caught defect: the pre-flight list gate refused
    // a flow on a workspace that ran it seconds later. The launch resolves the
    // registry; a listing is a second answer that can only ever agree with it.
    const store = await webStore()
    const double = relay({ flows: [{ flowId: "create-flow" }] })
    const controller = createAppController(store, silentAgent, {
      ...double.services,
      fetchImpl: async (input, init) => {
        const absolute = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
          "https://app.test"
        )
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        // A COLD registry: the flow listing shows only the repo's own flows.
        if (absolute.pathname === "/api/workflow/rpc" && body?.procedure === "List") {
          return json(200, {
            ok: true,
            payload: { _tag: "flows", items: [{ flowId: "chat" }, { flowId: "oneshot" }, { flowId: "workspace" }] }
          })
        }
        return double.services.fetchImpl?.(input, init) ?? json(404, {})
      }
    })
    await signIn(store)

    expect(said(await controller.commands.run("flow.create", "summarize my issues"))).toBe(`flow-requested repo=${REPO}`)
    await waitFor(() => double.state.launched.length > 0)
    expect(double.state.launched[0]?.workflow).toBe("create-flow")
  })

  test("a launch answers with a MINIMAL machine acknowledgment — the claim surface is not the model's", async () => {
    /*
     * Wave 11 tried to talk the model out of lying, in the tool result and
     * in the system prompt, and the deployed model said "has been created"
     * anyway. Wave 12 §1 stops arguing: the result states the fact, and the
     * rendered claim is the client's (Wave12.test.ts pins the rendering).
     */
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    const created = said(await controller.commands.run("flow.create", "summarize my open issues"))
    expect(created).toBe(`flow-requested repo=${REPO}`)

    const ran = said(await controller.commands.run("flow.run", "review-pr"))
    expect(ran).toMatch(/^run-requested workflow=review-pr request=\S+ repo=/)
  })

  test("the three commands are agent-reachable (trigger both) — this is the whole of the new surface", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)

    const listed = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "list" })
    })
    for (const name of ["flow.create", "flow.list", "flow.run"]) {
      expect(listed).toContain(name)
    }
    /*
     * NO INVENTION: the three conversational commands stay the whole of the
     * agent-facing flow.* surface. Wave 12 added three HIDDEN card bindings
     * (the which-repo answer and a quiet run's stop/retry); lane runs added
     * the hidden stop-all — affordances the briefs name, invisible to the
     * slash menu and the tool catalog alike. The runs.* lifecycle commands
     * are their own namespace, pinned in the registry test. `flow.plan` is the
     * fourth conversational one (D-080: the flow builder is the app), and it
     * brought two hidden graph gestures with it.
     */
    expect(controller.commands.all().filter((command) => command.name.startsWith("flow."))).toHaveLength(10)
    expect(
      controller.commands
        .all()
        .filter((command) => command.name.startsWith("flow.") && command.hidden !== true)
        .map((command) => command.name)
    ).toEqual(["flow.create", "flow.list", "flow.run", "flow.plan"])
  })
})

// Offline relay substitutes the remote gateway only; catalog, command parsing,
// controller, provision/Plan/Run protocol and persisted run card are real.
test.each([
  { label: "bare", args: undefined, input: {} },
  { label: "with JSON", args: '{"verify":false,"narrate":false}', input: { verify: false, narrate: false } }
])("/review $label from the actual repository projection launches the ordinary gateway flow", async ({ args, input }) => {
  const projection = JSON.parse(readFileSync(new URL("../../../../../.smithers/factory.json", import.meta.url), "utf8")) as {
    flows: Parameters<typeof repositoryFlowsOf>[0]
  }
  const flows = projection.flows
  const store = await webStore()
  const double = relay({ flows: flows.map(row => ({ flowId: row.id, description: row.description })) })
  const controller = createAppController(store, silentAgent, double.services)
  await signIn(store)
  await settle()
  await store.dispatch({ type: "repository-flows.loaded", actor: "system", repo: REPO, flows: repositoryFlowsOf(flows) }).isPersisted.promise
  await settle()
  double.finish()
  const outcome = await controller.commands.run("review", args)
  expect(outcome.status).toBe("executed")
  await waitFor(() => runCard(store)?.payload.phase === "completed")
  expect(double.state.launched).toEqual([{ workflow: "review", input }])
  expect(double.calls.filter(call => call.path === "/api/workflow/rpc").map(call => (call.body as { procedure: string }).procedure)).toContain("Plan")
  expect(double.calls.filter(call => call.path === "/api/workflow/rpc").map(call => (call.body as { procedure: string }).procedure)).toContain("Run")
  expect(runCard(store)?.payload.workflow).toBe("review")
  expect(double.calls.some(call => call.path.includes("/review/"))).toBe(false)
})
