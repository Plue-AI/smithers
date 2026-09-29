import { Authorize } from "@smthrs/chain"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import type { StorageApi } from "@tanstack/db"
import { describe,expect,test } from "bun:test"
import { Effect } from "effect"

import type { AgentPort } from "../../runtime/AgentPort"
import type { AppServices } from "../AppController"
import type { Card } from "../AppState"
import type { AppStore } from "../AppStore"
import { createAppStore } from "../AppStore"
import { scopedControllers } from "../ControllerTestScope"
import { PROTOTYPE_FLOW_ID,PROTOTYPE_RUN_KIND } from "./onboarding"
import { loadBox, TEST_BOX } from "../TestFixtures"

const createAppController = scopedControllers()

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}


const REPO = "smithersai/smithers"
const SUMMARY = "Smithers is a durable framework that lets agents plan, run, and review changes to a code repository through flows."

const WEB: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false }),
  authFlow: "redirect",
  sandbox: null
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const settled = async (ticks = 4): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** A route stub: the response for one path, given the request's init (the relay stubs read the body). */
type Route = (init?: RequestInit) => Response

const fixture = async (routes: Record<string, Route>, selected = true, box = true) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<string> = []
  const turns: Array<string> = []
  const agent: AgentPort = {
    available: true,
    startTurn: async (request) => {
      const last = request.messages.at(-1)
      turns.push(last !== undefined && "content" in last ? last.content : "")
      return { status: "started" }
    },
    cancelTurn: async () => {},
    subscribe: () => () => {}
  }
  const services: AppServices = {
    bootstrap: WEB,
    workflowPollMs: 5,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url, "https://app.test").pathname
      // The repository-flows seam reads .smithers/factory.json in the background whenever the target repository changes (the slash leaves); it is not one of the flow's own reads, so it stays out of the log.
      if (!path.endsWith("/contents/.smithers/factory.json")) requests.push(path)
      return (routes[path] ?? (() => json(404, { status: "error", message: `no stub for ${path}` })))(init)
    }
  }
  const controller = createAppController(store, agent, services)
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: REPO, org: "smithersai", ownerKind: "user", name: "smithers", head: null, catalog: true, summary: SUMMARY }]
  })
  if (selected) store.dispatch({ type: "repo.selected", actor: "user", id: REPO })
  if (box) await loadBox(store, REPO)
  return { store, controller, requests, turns }
}

const lastMessage = (store: AppStore) =>
  [...store.collections.messages.values()].sort((left, right) => left.ordinal - right.ordinal).at(-1)

const identity = (store: AppStore, state: "signed-out" | "signed-in"): void => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state,
    login: state === "signed-in" ? "will" : null,
    allowlisted: state === "signed-in",
    admin: false,
    scopesPlain: null
  })
}

/*
 * The relay, as the prototype launch rides it: provision answers ready, and
 * the gateway procedures answer in the wire's shapes. Every procedure the
 * launch called is recorded so the test reads the launch off the wire, not
 * off the card alone.
 */
/**
 * The relay's frame for a gateway `Plan` the control plane refused with
 * ControlError.FlowNotFound: the Worker's sentence leads, and the whole
 * encoded cause rides as the detail. Effect's RPC protocol encodes a failure
 * cause as an array of reasons, `[{ _tag: "Fail", error }]`, and the error is
 * the TaggedError's encoded form (verified: `new FlowNotFound({ flowId })`
 * has an empty `message`, so only its tag and code identify it).
 */
const flowNotFoundFrame = (flowId: string) => ({
  ok: false,
  error: {
    message: "/control/FlowNotFound",
    detail: [{ _tag: "Fail", error: { _tag: "/control/FlowNotFound", code: "flow_not_found", flowId } }]
  }
})

const relayStubs = (options: { readonly refuseRun?: string; readonly flows?: ReadonlyArray<string>; readonly refusePlan?: string } = {}) => {
  const procedures: Array<{ readonly procedure: string; readonly payload: Record<string, unknown> }> = []
  const rpc: Route = (init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { procedure?: string; payload?: Record<string, unknown> }
    const procedure = body.procedure ?? ""
    const payload = body.payload ?? {}
    procedures.push({ procedure, payload })
    switch (procedure) {
      case "List":
        return options.flows === undefined
          ? json(200, { ok: false, error: { message: "no List" } })
          : json(200, { ok: true, payload: { _tag: "flows", items: options.flows.map((flowId) => ({ flowId, description: "" })) } })
      case "Plan":
        if (options.refusePlan !== undefined) return json(200, flowNotFoundFrame(options.refusePlan))
        return json(200, {
          ok: true,
          payload: { planId: "plan-1", flowId: payload.flowId, digest: "digest-1", envelope: { capabilities: [], flows: [], budget: {} }, nodes: [] }
        })
      case "Approval.Submit":
        return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } })
      case "Run":
        return options.refuseRun === undefined
          ? json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: "run-1" } })
          : json(200, {
            ok: false,
            error: { message: options.refuseRun, detail: [{ _tag: "Fail", error: { _tag: "/control/Unavailable", code: "unavailable" } }] }
          })
      case "Projection.Snapshot":
        return json(200, {
          ok: true,
          payload: {
            cursor: { projection: "run-summary", runId: "run-1", value: 0 },
            rows: [{
              runId: "run-1",
              flowId: "prototype",
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
              diagnosis: ""
            }]
          }
        })
      default:
        return json(200, { ok: false, error: { message: `no ${procedure}` } })
    }
  }
  return {
    procedures,
    routes: {
      "/api/workflow/provision": () => json(200, { status: "ready", repo: REPO, gatewayId: "gw-1" }),
      "/api/workflow/rpc": rpc
    }
  }
}

const runCards = (store: AppStore): Array<Extract<Card, { kind: "run-trace" }>> =>
  [...store.collections.cards.values()].flatMap((card) => (card.kind === "run-trace" ? [card] : []))

describe("feature.prototype", () => {
  test("signed in, the human's request starts a run of kind prototype on the workspace's prototype flow, tracked by the run card", async () => {
    const relay = relayStubs()
    const { store, controller, turns } = await fixture(relay.routes)
    identity(store, "signed-in")
    await settled()
    // Missing input renders the form, never a usage sentence (THE FORM LAW).
    const form = await controller.commands.run("feature.prototype")
    expect(form.status).toBe("form")
    if (form.status === "form") expect(form.fields).toEqual(["request"])

    const outcome = await controller.commands.run("feature.prototype", "a dark mode toggle")
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") {
      expect(outcome.value).toContain("run-started workflow=prototype run=run-1")
      expect(outcome.value).toContain("kind=prototype")
    }
    // The flow list is asked first (it cannot answer here, so the launch is tried); then the launch is flow.run's
    // own: Plan, approve the plan, Run, on the prototype flow with the request as its goal.
    expect(relay.procedures.map((call) => call.procedure).slice(0, 4)).toEqual(["List", "Plan", "Approval.Submit", "Run"])
    expect(relay.procedures[1]?.payload).toMatchObject({ flowId: "prototype", input: { goal: "a dark mode toggle" } })
    const [card] = runCards(store)
    expect(card?.id).toBe(`flow-run@${encodeURIComponent(REPO)}@${TEST_BOX}@run-1`)
    expect(card?.payload).toMatchObject({
      repo: REPO,
      runId: "run-1",
      workflow: "prototype",
      kind: "prototype",
      input: { goal: "a dark mode toggle" },
      // Spec 06 §5: a new run-trace card starts on live tail; the pump tails the journal from the first cycle.
      liveTail: true
    })
    expect(card?.kind).toBe("run-trace")
    expect(card?.title).toBe("prototype · a dark mode toggle")
    // No chat turn is spent on a sketch: the run is the answer.
    expect(turns).toHaveLength(0)
    expect([...store.collections.messages.values()].filter((message) => message.role === "user")).toHaveLength(0)
  })

  /*
   * RULINGS 42 (Will, 2026-09-08): Implement runs on the smart seat, first try
   * included, and cost control is never a cheaper implementer. The launch path
   * `feature.prototype` shares with an implement launch names the flow and the
   * kind and nothing about a model, so no caller can quietly downgrade a run's
   * seat from here; the workspace flow's own declaration stays the only seat
   * authority. A lane that adds `seat`, `tier`, `model`, or `role` to this
   * payload fails here and has to answer for it.
   */
  test("the launch asks for no seat, tier, model, or role: the workspace flow's declaration is the only seat authority", async () => {
    const relay = relayStubs({ flows: ["prototype"] })
    const { store, controller } = await fixture(relay.routes)
    identity(store, "signed-in")
    await settled()

    expect((await controller.commands.run("feature.prototype", "a dark mode toggle")).status).toBe("executed")

    const launchKeys = relay.procedures
      .filter((call) => call.procedure === "Plan" || call.procedure === "Run")
      .flatMap((call) => Object.keys(call.payload))
    expect(launchKeys).not.toContain("seat")
    expect(launchKeys).not.toContain("tier")
    expect(launchKeys).not.toContain("model")
    expect(launchKeys).not.toContain("role")
    // The Plan still names the flow and its goal, so the pin is on the seat, not on an empty payload.
    expect(relay.procedures.find((call) => call.procedure === "Plan")?.payload)
      .toMatchObject({ flowId: PROTOTYPE_FLOW_ID, input: { goal: "a dark mode toggle" } })
    expect(runCards(store)[0]?.payload).toMatchObject({ kind: PROTOTYPE_RUN_KIND })
  })

  test("signed out, the human's request parks on the sign-in step and resumes as a launch once signed in", async () => {
    const relay = relayStubs()
    const { store, controller } = await fixture(relay.routes)
    identity(store, "signed-out")
    await settled()
    const outcome = await controller.commands.run("feature.prototype", "a dark mode toggle")
    expect(outcome.status).toBe("executed")
    await settled()
    expect(lastMessage(store)?.action).toEqual({ flow: "auth.sign-in", label: "Sign in with GitHub" })
    expect(store.session().pendingCommand).toMatchObject({ name: "feature.prototype", args: "a dark mode toggle", requirement: "signed-in" })
    // Nothing was provisioned or launched for a signed-out visitor.
    expect(relay.procedures).toEqual([])
    expect(runCards(store)).toEqual([])

    identity(store, "signed-in")
    controller.resumeDeferredCommand()
    await settled(8)
    expect(store.session().pendingCommand ?? null).toBeNull()
    expect(relay.procedures.map((call) => call.procedure)).toContain("Run")
    expect(runCards(store)[0]?.payload).toMatchObject({ kind: "prototype", workflow: "prototype" })
  })

  test("the authorized model's signed-out invocation renders the sign-in step and fails honestly without launching", async () => {
    const relay = relayStubs()
    const { store, controller } = await fixture(relay.routes)
    identity(store, "signed-out")
    await settled()
    // Reach the onboarding handler as an authorized agent invocation: the host
    // injects the authority, the flow declaration claims nothing.
    const authorize = Authorize.make({ authorize: () => Effect.void })
    const outcome = await controller.commands.runForAgent("feature.prototype", "a dark mode toggle", {
      authorize, slot: { chain: "", link: 1, ordinal: 0 }, refused: () => {}
    })
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("Sign in with GitHub first")
    expect(lastMessage(store)?.action?.flow).toBe("auth.sign-in")
    expect(relay.procedures).toEqual([])
  })

  test("a workspace whose flow list lacks prototype is refused before anything is planned, naming the flow", async () => {
    const relay = relayStubs({ flows: ["review-pr", "implement"] })
    const { store, controller } = await fixture(relay.routes)
    identity(store, "signed-in")
    await settled()
    const outcome = await controller.commands.run("feature.prototype", "a dark mode toggle")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe(`${REPO} has no prototype flow on its workspace yet, so there is nothing to run the prototype with.`)
    // The list answered, so nothing was planned, approved or run.
    expect(relay.procedures.map((call) => call.procedure)).toEqual(["List"])
    expect(runCards(store)).toEqual([])
  })

  test("a Plan the control plane refuses with FlowNotFound is read off the wire's shape, never off its prose", async () => {
    // The list cannot answer (the gateway's registry is lazy), so the launch is tried and refused at Plan.
    const relay = relayStubs({ refusePlan: "prototype" })
    const { store, controller } = await fixture(relay.routes)
    identity(store, "signed-in")
    await settled()
    const outcome = await controller.commands.run("feature.prototype", "a dark mode toggle")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe(`${REPO} has no prototype flow on its workspace yet, so there is nothing to run the prototype with.`)
    expect(relay.procedures.map((call) => call.procedure)).toEqual(["List", "Plan"])
    expect(runCards(store)).toEqual([])
  })

  /* The lesson never strands: with no box it answers with the box to open, calls nothing, and chat still answers. */
  test("a repository with no box is refused visibly before any call, and chat stays usable", async () => {
    const relay = relayStubs({ flows: ["prototype"] })
    const { store, controller, requests, turns } = await fixture(relay.routes, true, false)
    identity(store, "signed-in")
    await settled()
    const outcome = await controller.commands.run("feature.prototype", "a dark mode toggle")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe(`Open a box of ${REPO} first: /box.open ${REPO}`)
    expect(relay.procedures).toEqual([])
    expect(requests.some((path) => path.startsWith("/api/workflow/"))).toBe(false)
    expect(runCards(store)).toEqual([])
    controller.send("what now?")
    await settled()
    expect(turns).toHaveLength(1)
    // Opening the box is the retry: the same request now launches.
    await loadBox(store, REPO)
    expect((await controller.commands.run("feature.prototype", "a dark mode toggle")).status).toBe("executed")
    expect(relay.procedures.map((call) => call.procedure)).toContain("Run")
  })

  test("any other launch refusal is surfaced as its control code's sentence, never the control plane's words", async () => {
    const relay = relayStubs({ flows: ["prototype"], refuseRun: "run driver pool exhausted (0/32 slots)" })
    const { store, controller } = await fixture(relay.routes)
    identity(store, "signed-in")
    await settled()
    const outcome = await controller.commands.run("feature.prototype", "a dark mode toggle")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("The workspace isn't answering right now. Not your fault; try again in a moment.")
      expect(outcome.error).not.toContain("run driver pool exhausted")
    }
    expect(relay.procedures.map((call) => call.procedure)).toEqual(["List", "Plan", "Approval.Submit", "Run"])
    expect(runCards(store)).toEqual([])
  })
})

test("welcome sentence helpers are deleted", async () => {
  const source = await Bun.file(new URL("./onboarding.ts", import.meta.url)).text()
  expect(source).not.toMatch(/welcomeSentence|summaryPredicate/)
})
