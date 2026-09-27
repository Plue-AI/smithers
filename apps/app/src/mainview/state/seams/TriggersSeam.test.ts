import type { StorageApi } from "@tanstack/db"
import { describe, expect, setDefaultTimeout, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import type { AppController, AppServices } from "../AppController"
import { scopedControllers } from "../ControllerTestScope"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { workflowLaunchOf } from "../WorkflowLaunch"
import { waitFor } from "../TestFixtures"
import { Schema } from "effect"
import { initialSetup } from "@smthrs/rpc/RepositorySetup"
import { readFile } from "node:fs/promises"
import { flowArgs } from "../../flows/FlowArgs"
import { LIMIT_SHAPE, limitsRefusal, NO_RULES_SENTENCE, otherLimitSentence, overBoundFlowSentence, readTriggerFires, registerUnavailableSentence, unboundedFlowSentence } from "./TriggersSeam"
import type { TriggerWrite } from "./TriggersSeam"
import type { SeamContext } from "./SeamContext"

const createAppController = scopedControllers()
const controllerStores = new WeakMap<AppController, AppStore>()

// The first controller in a file pays the module warm-up; under machine load that alone passes 5 s.
setDefaultTimeout(30_000)

/*
 * The triggers seam through the real command path: controller.commands.run
 * drives triggers.list exactly as the Dispatcher chrome button, the Flows
 * pane door and the slash do. The declared rows come from the public mirror's
 * contents route for `.smithers/factory.json`; the live rows come from the
 * Worker's triggers route only for a signed-in session. The card states only
 * what each source answered.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}


const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

type Route = Response | ((request: Request) => Response | Promise<Response>)

const backend = (routes: Record<string, Route>, seen: Array<string> = []): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const path = absolute.pathname + absolute.search
    // The repository-flows seam reads the homepage beside the projection; not this seam's read.
    if (/^\/api\/repos\/[^/]+\/[^/]+\/home$/.test(absolute.pathname)) return new Response(JSON.stringify({ status: "error" }), { status: 404 })
    seen.push(path)
    for (const [route, answer] of Object.entries(routes)) {
      if (path === route || path.startsWith(`${route}?`)) {
        return typeof answer === "function" ? answer(new Request(absolute.toString(), init)) : answer.clone()
      }
    }
    return json(404, { status: "error", message: `no stub for ${path}` })
  }
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const signedIn = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

const signedOut = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-out",
    login: null,
    allowlisted: false,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

const reposChosen = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }]
  })
  await settled()
}

/** A controller watching exactly will/flows over the given backend, signed out unless asked. */
const ready = async (
  services: AppServices,
  options: { signedIn?: boolean; store?: AppStore } = {}
) => {
  const store = options.store ?? await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, services)
  controllerStores.set(controller, store)
  if (options.signedIn === true) await signedIn(store)
  else await signedOut(store)
  await reposChosen(store)
  return { store, controller }
}

const REPO = "/api/repos/will/flows"
const PROJECTION = `${REPO}/contents/.smithers/factory.json`
const LIVE = "/api/workflow/triggers"

/** The day-one table (design §7) as the mirror serves the committed projection: a base64 contents document. */
const projectionDocument = (projection: unknown): Response =>
  json(200, {
    path: ".smithers/factory.json",
    encoding: "base64",
    content: btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(projection))))
  })

const DAY_ONE = {
  summary: "How will/flows develops itself.",
  flows: [
    {
      id: "review",
      description: "Reviews the change.",
      summary: "Review the change.",
      featured: true,
      kind: "mdx",
      path: "flows/review/flow.mdx",
      capabilities: ["fs:read:**"],
      model: null,
      modelInvocable: true
    }
  ],
  github: { mirror: "push", issues: "two-way", changes: "land" },
  on: [
    { event: "issue.opened", flow: "issue", description: "Triage every new issue" },
    { event: "issue.labeled:smithers", flow: "implement" },
    { event: "change.landed", flow: ["wiki", "history.fold", "improve.mine"] },
    { event: "schedule:0 9 * * 1-5", flow: "review" }
  ]
}

const triggerCard = (store: AppStore) => {
  const card = store.collections.cards.get("trigger-list-will/flows")
  if (card === undefined || card.kind !== "trigger-list") throw new Error("expected the dispatcher card")
  return card
}

describe("triggers seam: the declaration, signed out", () => {
  test("the declared rows come from the projection on the public mirror, and the Worker's triggers route is never asked", async () => {
    const seen: Array<string> = []
    const { store, controller } = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE) }, seen))
    const outcome = await controller.commands.run("triggers.list")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = triggerCard(store)
    expect(card.title).toBe("Dispatcher · will/flows")
    expect(card.payload).toEqual({
      repo: "will/flows",
      declared: DAY_ONE.on,
      live: false,
      triggers: [],
      webhooks: []
    })
    // The projection is read once for the card (and once more by the repository-flows seam, which reads the same file for the slash leaves).
    expect(new Set(seen)).toEqual(new Set([PROJECTION]))
    expect(seen.some((path) => path.startsWith(LIVE))).toBe(false)
  })

  test("a mirror with no projection committed yet is 'No rules declared yet': an empty table, no live rows, no reason", async () => {
    const { store, controller } = await ready(backend({}))
    const outcome = await controller.commands.run("triggers.list")
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") expect(outcome.value).toBe(`${NO_RULES_SENTENCE} on will/flows.`)
    await settled()
    const card = triggerCard(store)
    expect(card.payload).toEqual({ repo: "will/flows", declared: [], live: false, triggers: [], webhooks: [] })
    expect(JSON.stringify(card.payload)).not.toContain("reason")
  })

  test("a projection the schema does not accept, or a mirror that does not answer, is an honest refusal, never an empty table", async () => {
    const malformed = await ready(backend({ [PROJECTION]: projectionDocument({ flows: ["issue"], on: [] }) }))
    const refused = await malformed.controller.commands.run("triggers.list")
    expect(refused.status).toBe("failed")
    if (refused.status === "failed") expect(refused.error).toBe("The rules of will/flows couldn't be read: .smithers/factory.json is not a factory projection.")
    expect(malformed.store.collections.cards.get("trigger-list-will/flows")).toBeUndefined()

    const down = await ready(backend({ [PROJECTION]: json(502, { message: "Repository data is temporarily unavailable." }) }))
    const unavailable = await down.controller.commands.run("triggers.list")
    expect(unavailable.status).toBe("failed")
    if (unavailable.status === "failed") expect(unavailable.error).toBe("The rules of will/flows couldn't be read: the mirror did not answer for .smithers/factory.json.")
  })

  test("the slash door and the agent door run the read signed out, and the register door defers behind sign-in", async () => {
    const { store, controller } = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE) }))
    expect((await controller.commands.runForAgent("triggers.list", "will/flows")).status).toBe("executed")
    expect(store.session().pendingCommand ?? null).toBeNull()
    /* The human's door parks the write behind sign-in: the outcome is auth.sign-in's, the parked flow is the register. */
    await controller.commands.run("triggers.register")
    expect(store.session().pendingCommand?.name).toBe("triggers.register")
    expect(store.session().pendingCommand?.requirement).toBe("signed-in")
    const agentRefused = await controller.commands.runForAgent("triggers.register", "will/flows")
    expect(agentRefused.status).toBe("failed")
    if (agentRefused.status === "failed") expect(agentRefused.error).toContain("Sign in with GitHub first")
  })
})

describe("triggers seam: the box, signed in", () => {
  test("a box that answered adds live rows beside the declared ones", async () => {
    const seen: Array<string> = []
    const { store, controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [LIVE]: json(200, {
          status: "ok",
          repo: "will/flows",
          live: true,
          triggers: [
            { id: "nightly", flowId: "review", cron: "0 9 * * 1-5", timezone: "UTC", enabled: true, lastFiredAt: 1_700_000_000_000, nextFireAt: 1_700_086_400_000, activeRunId: "run-8f21" },
            { id: "sweep", flowId: "issue", cron: "*/15 * * * *", enabled: false },
            { id: "broken" }
          ],
          webhooks: [{ name: "github-push", flowId: "review" }, { flowId: "nameless" }]
        })
      }, seen),
      { signedIn: true }
    )
    const outcome = await controller.commands.run("triggers.list")
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") {
      expect(outcome.value).toBe(
        "Dispatcher on will/flows: 4 rules declared in .smithers/FACTORY.ts: issue.opened runs issue; issue.labeled:smithers runs implement; change.landed runs wiki, history.fold, improve.mine; schedule:0 9 * * 1-5 runs review. the box is listening: nightly runs review, sweep runs issue, webhook github-push runs review."
      )
    }
    await settled()
    const card = triggerCard(store)
    expect(card.payload.declared).toEqual(DAY_ONE.on)
    expect(card.payload.live).toBe(true)
    expect(card.payload.triggers).toEqual([
      { id: "nightly", flowId: "review", cron: "0 9 * * 1-5", timezone: "UTC", enabled: true, lastFiredAt: 1_700_000_000_000, nextFireAt: 1_700_086_400_000, activeRunId: "run-8f21" },
      { id: "sweep", flowId: "issue", cron: "*/15 * * * *", enabled: false }
    ])
    expect(card.payload.webhooks).toEqual([{ name: "github-push", flowId: "review" }])
    /* Two live sources now: the box's own store and the repository's Smithers Cloud registrations, plus one ledger read per box row. */
    expect(seen.filter((path) => path !== PROJECTION).sort()).toEqual(
      [`${LIVE}?repo=will%2Fflows`, `/api/workflow/trigger-registrations?repo=will%2Fflows`, RPC, RPC].sort()
    )
    expect(seen).toContain(PROJECTION)
  })

  test("the box's policies, its whole list of upcoming fires, the claim it holds and the scheduler's heartbeat reach the card", async () => {
    const { store, controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [LIVE]: json(200, {
          status: "ok",
          repo: "will/flows",
          live: true,
          triggers: [{
            id: "nightly",
            flowId: "review",
            cron: "0 9 * * 1-5",
            timezone: "America/New_York",
            enabled: true,
            nextFireAt: 1_700_086_400_000,
            nextFiresAt: [1_700_086_400_000, 1_700_172_800_000, 1_700_259_200_000, 1_700_345_600_000, 1_700_432_000_000],
            overlap: "buffer-one",
            catchUp: "one",
            maxCatchUp: 3,
            pendingAt: 1_700_086_400_000,
            schedulerLastTickAt: 1_700_000_500_000,
            /* The route carries these two; the card has no field for either, so the seam drops them rather than smuggling them onto a row. */
            input: { label: "nightly" },
            revision: 7
          }],
          webhooks: []
        })
      }),
      { signedIn: true }
    )
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    expect(triggerCard(store).payload.triggers).toEqual([{
      id: "nightly",
      flowId: "review",
      cron: "0 9 * * 1-5",
      timezone: "America/New_York",
      enabled: true,
      nextFireAt: 1_700_086_400_000,
      nextFiresAt: [1_700_086_400_000, 1_700_172_800_000, 1_700_259_200_000, 1_700_345_600_000, 1_700_432_000_000],
      overlap: "buffer-one",
      catchUp: "one",
      maxCatchUp: 3,
      pendingAt: 1_700_086_400_000,
      schedulerLastTickAt: 1_700_000_500_000
    }])
  })

  /*
   * The policies, the whole list of upcoming fires, the claim and the
   * scheduler's heartbeat are the trigger panel's own fields.
   */
  const BOX_WITH_POLICIES = {
    status: "ok",
    repo: "will/flows",
    live: true,
    triggers: [{
      id: "nightly",
      flowId: "review",
      cron: "0 9 * * 1-5",
      timezone: "America/New_York",
      enabled: true,
      lastFiredAt: 1_700_000_000_000,
      nextFireAt: 1_700_086_400_000,
      activeRunId: "run-8f21",
      nextFiresAt: [1_700_086_400_000, 1_700_172_800_000],
      overlap: "buffer-one",
      catchUp: "one",
      maxCatchUp: 3,
      pendingAt: 1_700_086_400_000,
      schedulerLastTickAt: 1_700_000_500_000
    }],
    webhooks: []
  }

  test("a box answer carries every field the trigger panel reads", async () => {
    const { store, controller } = await ready(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [LIVE]: json(200, BOX_WITH_POLICIES), [RPC]: json(200, { ok: true, payload: { _tag: "fires", items: [] } }) }),
      { signedIn: true }
    )
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    expect(triggerCard(store).payload.triggers).toEqual([{
      id: "nightly",
      flowId: "review",
      cron: "0 9 * * 1-5",
      timezone: "America/New_York",
      enabled: true,
      lastFiredAt: 1_700_000_000_000,
      nextFireAt: 1_700_086_400_000,
      activeRunId: "run-8f21",
      nextFiresAt: [1_700_086_400_000, 1_700_172_800_000],
      overlap: "buffer-one",
      catchUp: "one",
      maxCatchUp: 3,
      pendingAt: 1_700_086_400_000,
      schedulerLastTickAt: 1_700_000_500_000,
      fires: []
    }])
  })

  test("a policy word the trigger store never writes never reaches a row, and the row still stands", async () => {
    const { store, controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [LIVE]: json(200, {
          status: "ok",
          repo: "will/flows",
          live: true,
          triggers: [{ id: "odd", flowId: "review", cron: "* * * * *", enabled: true, overlap: "queue", catchUp: 3, maxCatchUp: "many", nextFiresAt: [1, "soon", 2] }],
          webhooks: []
        })
      }),
      { signedIn: true }
    )
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    expect(triggerCard(store).payload.triggers).toEqual([{ id: "odd", flowId: "review", cron: "* * * * *", enabled: true, nextFiresAt: [1, 2] }])
  })

  test("signed in with no box answering, the card is the declaration alone with live false", async () => {
    const { store, controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [LIVE]: json(200, { status: "ok", repo: "will/flows", live: false, triggers: [], webhooks: [] })
      }),
      { signedIn: true }
    )
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    expect(triggerCard(store).payload).toEqual({ repo: "will/flows", declared: DAY_ONE.on, live: false, triggers: [], webhooks: [] })
    /* A route that stopped answering does not fail the card: the declaration still renders, with no live column. */
    const down = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE), [LIVE]: json(502, { message: "gateway down" }) }), { signedIn: true })
    expect((await down.controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    expect(triggerCard(down.store).payload.live).toBe(false)
  })

  /* Was: the door refused every registration with a sentence. THE FORM LAW replaces that with the form. */
  test("the register door runs signed in and asks for what it is missing", async () => {
    const { controller } = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE) }), { signedIn: true })
    const outcome = await controller.commands.run("triggers.register")
    expect(outcome.status).toBe("form")
    // One input (D-18): the flow; the name and the schedule default, and the rest is the advanced line's.
    if (outcome.status === "form") expect(outcome.fields).toEqual(["flow"])
  })

  test("re-listing re-surfaces the one card at the end of the transcript instead of adding a second", async () => {
    const { store, controller } = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE) }), { signedIn: true })
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    const first = triggerCard(store)
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    const second = triggerCard(store)
    expect([...store.collections.cards.values()].filter((card) => card.kind === "trigger-list")).toHaveLength(1)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.ordinal).toBeGreaterThan(first.ordinal)
  })
})

/*
 * The generic flow trigger: prepare a registration, preview the plan the
 * workspace made, approve it as the human, and register. The relay, the
 * Worker's three trigger routes and Smithers Cloud are all stubs here; no
 * test in this file may reach a network.
 */

const RPC = "/api/workflow/rpc"
const REGISTRATIONS = "/api/workflow/trigger-registrations"
const PAUSE = "/api/workflow/trigger-pause"
const APPROVAL = "/api/workflow/trigger-approval"

interface RelayCall {
  readonly procedure: string
  readonly payload: Record<string, unknown>
  /** Which box the Worker was asked to relay to: the repository's own, or one workspace's. */
  readonly workspaceId?: string
}

const PLAN_DIGEST = "d".repeat(64)
/* The card Control publishes: its envelope carries the budget nested, exactly as control/ControlSchema.ts Envelope declares it. */
const PLAN = {
  planId: "plan-1",
  digest: PLAN_DIGEST,
  flowId: "nightly-lint",
  executionDigest: "e".repeat(64),
  envelope: { capabilities: ["fs:read:**"], flows: ["nightly-lint"], budget: { tokens: 200_000, milliseconds: 1_800_000 } }
}

/* Exactly what the workspace publishes for a flow's input: registry Descriptor.inputDocument's own document. */
const LINT_SCHEMA = JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(Schema.Struct({ label: Schema.String })))) as unknown

const FLOW_ITEMS = [
  { flowId: "nightly-lint", description: "Lints the repository.", inputSchema: LINT_SCHEMA },
  { flowId: "repository/trigger", description: "Register one repository flow to run on a reviewed schedule." }
]

const okFrame = (payload: unknown) => ({ ok: true, payload })
const refusedFrame = (message: string, detail?: unknown) => ({ ok: false, error: { message, ...(detail === undefined ? {} : { detail }) } })

/** The workspace Smithers Cloud gave this repository's reviewed jobs: the box whose gateway runs the coding host. */
const JOB_WORKSPACE = "b9275008-1c3e-4f2a-9a7d-0c2f5a6b1d84"

/*
 * The repository's own gateway, which is the box a relay body that names no
 * workspace reaches: plue matches such a call to the `workspace_id IS NULL`
 * row alone (db/queries/repo_gateways.sql), and that row runs the product
 * host — the librarian flow, no registrar, and no run of one.
 */
const productHost: Record<string, (payload: Record<string, unknown>) => unknown> = {
  List: () => okFrame({ _tag: "flows", items: [{ flowId: "librarian/history" }] }),
  Plan: (payload) => refusedFrame(`No flow "${String(payload.flowId)}" is registered on this workspace.`, [
    { _tag: "Fail", error: { _tag: "/control/FlowNotFound", code: "flow_not_found", flowId: payload.flowId } }
  ]),
  "Projection.Snapshot": () => okFrame({ rows: [] })
}

/** The relay stub: every call recorded, answered by the box its own frame named. */
const relayRoute = (
  calls: Array<RelayCall>,
  answers: Record<string, (payload: Record<string, unknown>) => unknown>
): Route =>
async (request) => {
  const frame = await request.json() as { procedure: string; payload: Record<string, unknown>; workspaceId?: string }
  calls.push({ procedure: frame.procedure, payload: frame.payload, ...(frame.workspaceId === undefined ? {} : { workspaceId: frame.workspaceId }) })
  const answer = (frame.workspaceId === JOB_WORKSPACE ? answers : productHost)[frame.procedure]
  /* A stub may answer late, or never: a launch a reload interrupts is a call the workspace never answers. */
  return json(200, answer === undefined ? { ok: false, error: { message: `no stub for ${frame.procedure}` } } : await answer(frame.payload))
}

/** The registrar run the workspace started; the registration's outcome is this run's outcome. */
const REGISTRAR_RUN = "run-1"

/** How the registrar run stands, as the workspace's own run-summary projection answers for it. */
interface HostRun {
  status: "running" | "completed" | "failed" | "cancelled"
  /** A completed run's own output line. A failed run's verdict is derived from its journal cause, as the gateway derives it. */
  verdict: string
  /**
   * What the agent journals on `control.run.failed`: `<code>: <sentence>` on
   * the first line (internal/FailureSummary.ts), then the rendered cause.
   */
  cause?: string
}

/**
 * The gateway's own one-line verdict for a failed run, as
 * `packages/smithers/gateway` Diagnosis.verdict writes it: the cause's first
 * line behind `failed — `, clipped to 100 code points. The registrar's code
 * rides in front of the sentence, and a long sentence loses its ending.
 */
const hostVerdict = (cause: string): string => {
  const line = cause.split(/[\r\n]/)[0] ?? ""
  const points = [...line]
  return `failed — ${points.length <= 100 ? line : `${points.slice(0, 99).join("")}…`}`
}

/** The one journal event a failed registrar run leaves behind. */
const FAILED_SEQUENCE = 1

const runSummarySnapshot = (run: HostRun, tag: string): unknown => {
  /* A settled run is newer lifecycle evidence than the running one it replaces. */
  const at = run.status === "running" ? 2 : 3
  const verdict = run.status === "failed" ? hostVerdict(run.cause ?? "") : run.verdict
  if (tag === "run-events") {
    return {
      cursor: { selector: { _tag: tag, runId: REGISTRAR_RUN }, projection: tag, runId: REGISTRAR_RUN, value: FAILED_SEQUENCE, offset: 0 },
      rows: run.cause === undefined ? [] : [{
        sequence: FAILED_SEQUENCE, kind: "control.run.failed", runId: REGISTRAR_RUN, occurredAt: at, payload: { cause: run.cause }
      }]
    }
  }
  return {
    cursor: { selector: { _tag: tag, runId: REGISTRAR_RUN }, projection: tag, runId: REGISTRAR_RUN, value: at, offset: 0 },
    rows: tag !== "run-summary" ? [] : [{
      runId: REGISTRAR_RUN, flowId: "repository/trigger", status: run.status, createdAt: 1, updatedAt: at,
      turns: 0, calls: 0, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0,
      verdict, diagnosis: verdict
    }]
  }
}

/** The workspace that holds one markdown flow, plans it deterministically, and reports its own runs. */
const workspaceAnswers = (
  overrides: Record<string, (payload: Record<string, unknown>) => unknown> = {},
  run: HostRun = { status: "running", verdict: "" }
) => ({
  List: () => okFrame({ _tag: "flows", items: FLOW_ITEMS }),
  Plan: (payload: Record<string, unknown>) =>
    payload.flowId === "nightly-lint"
      ? okFrame(PLAN)
      : okFrame({ ...PLAN, planId: (payload.input as { operation?: string })?.operation === "fire"
        ? `plan-fire-${(payload.input as { requestId: string }).requestId}` : "plan-registrar", digest: "f".repeat(64), flowId: String(payload.flowId) }),
  "Approval.Submit": () => okFrame({ decision: { _tag: "Accepted" } }),
  Run: () => okFrame({ runId: REGISTRAR_RUN }),
  "Projection.Snapshot": (payload: Record<string, unknown>) =>
    okFrame(runSummarySnapshot(run, (payload.selector as { _tag?: string } | undefined)?._tag ?? "run-summary")),
  ...overrides
})

/** The watch this app already runs for a launched flow run: a fast pump, no toast debounce. */
const watched = (services: AppServices): AppServices => ({
  ...services, workflowPollMs: 1, toastDebounceMs: 0, toastAutoDismissMs: 10_000
})

const registrationToast = (store: AppStore, slug = "nightly") =>
  [...store.collections.toasts.values()].find(toast => toast.key.startsWith(`trigger.register.will/flows.${slug}.`))

/** One preparation by its schedule name, before or after the dispatcher card exists. */
const preparationOf = (store: AppStore, slug: string) =>
  [...store.collections.cards.values()].flatMap(card => card.kind === "trigger-list" ? card.payload.preparations ?? [] : []).find(row => row.draft.slug === slug)

const registrationRun = (store: AppStore, requestId: string) => {
  const card = [...store.collections.cards.values()].find(card => workflowLaunchOf(card)?.triggerRegistration?.requestId === requestId)
  return card?.kind === "run-trace" ? card : undefined
}

const preparedId = (store: AppStore): string =>
  String((JSON.parse(lastAction(store)?.args ?? "{}") as Record<string, unknown>).requestId)

const lastAction = (store: AppStore) =>
  [...store.collections.messages.values()].sort((left, right) => right.ordinal - left.ordinal).find((message) => message.action !== undefined)?.action

const REQUEST = { operation: "register" as const, repo: "will/flows", flow: "nightly-lint", slug: "nightly", schedule: "0 9 * * 1-5", input: '{"label":"nightly"}' }

/** One reviewed job already set up on `repo`, as its own card records the workspace it ran on. */
const jobSetUp = async (store: AppStore, repo = "will/flows", workspaceId = JOB_WORKSPACE): Promise<void> => {
  await store.dispatch({
    type: "card.upsert",
    actor: "system",
    card: {
      id: `setup-${repo}-issues`, kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: 1,
      payload: { ...initialSetup(repo, "issues", "will"), workspaceId }
    }
  }).isPersisted.promise
}

/** A signed-in controller on a repository whose reviewed jobs already run on JOB_WORKSPACE. */
const readyToRegister = async (services: AppServices, store?: AppStore) => {
  const scope = await ready(services, { signedIn: true, ...(store === undefined ? {} : { store }) })
  await jobSetUp(scope.store)
  return scope
}

/** Existing receipt assertions wait for background preparation; the held-network tests exercise acknowledgment directly. */
const registrationResult = async (controller: AppController, request: TriggerWrite) => {
  const answer = await controller.registerTrigger(request)
  if (request.operation !== "register" || typeof answer !== "object") return answer
  const store = controllerStores.get(controller)!
  const latest = () => [...store.collections.cards.values()].flatMap(card => card.kind === "trigger-list" ? card.payload.preparations ?? [] : [])
    .find(row => row.draft.slug === request.slug)
  await waitFor(() => ["prepared", "failed"].includes(latest()?.phase ?? ""))
  return latest()?.phase === "failed" ? latest()?.error : answer
}

const REGISTRATION_STAGES = ["discovery", "review", "review-approval", "receipt", "registrar-plan", "registrar-approval", "run"] as const
type RegistrationStage = typeof REGISTRATION_STAGES[number]
const registrationBackend = (calls: RelayCall[], run: HostRun, observe: (stage: RegistrationStage) => Promise<void>) => {
  const answers: Record<string, (payload: Record<string, unknown>) => unknown> = workspaceAnswers({}, run)
  return watched(backend({
    [PROJECTION]: projectionDocument(DAY_ONE),
    [APPROVAL]: async () => { await observe("receipt"); return json(200, { status: "ok", approvedAt: "2026-09-26T08:00:00Z", approvedBy: 1 }) },
    [REGISTRATIONS]: json(200, { status: "ok", rows: [] }),
    [RPC]: relayRoute(calls, Object.fromEntries(Object.entries(answers).map(([procedure, answer]) => [procedure, async (payload: Record<string, unknown>) => {
      const stage = procedure === "List" ? "discovery" : procedure === "Plan" ? payload.flowId === "nightly-lint" ? "review" : "registrar-plan"
        : procedure === "Approval.Submit" ? (payload.target as { planId: string }).planId === "plan-1" ? "review-approval" : "registrar-approval"
        : procedure === "Run" ? "run" : undefined
      if (stage) await observe(stage)
      return answer(payload)
    }])))
  }))
}

describe("triggers seam: registering a repository flow on a schedule", () => {
  test.each(["List", "Run"])("approval saves one launch request before unresolved %s and keeps Chat usable", async stage => {
    const held = Promise.withResolvers<void>()
    const calls: Array<RelayCall> = []
    const answers = workspaceAnswers()
    let holding = false
    const { store, controller } = await readyToRegister({ ...watched(backend({
      [APPROVAL]: json(200, { status: "ok", approvedAt: "2026-09-26T08:00:00Z", approvedBy: 1 }),
      [RPC]: relayRoute(calls, { ...answers, [stage]: async () => {
        if (holding) await held.promise
        return answers[stage]!()
      } })
    })), toastDebounceMs: 300 })
    await registrationResult(controller, REQUEST)
    const args = lastAction(store)!.args!
    holding = true
    try {
      await controller.commands.run("triggers.approve", args)
      const launches = () => [...store.collections.cards.values()].filter(card => card.kind === "run-trace" && card.payload.workflow === "repository/trigger")
      expect(launches()).toHaveLength(1)
      await controller.commands.run("triggers.approve", args)
      expect(launches()).toHaveLength(1)
      await store.dispatch({ type: "composer.changed", actor: "user", draft: "Chat during registration" }).isPersisted.promise
      await waitFor(() => registrationToast(store)?.status === "running")
      expect(calls.filter(call => call.procedure === "Run")).toHaveLength(stage === "Run" ? 1 : 0)
    } finally { held.resolve(); await controller.dispose() }
  })

  test.each([...REGISTRATION_STAGES])("reload during registration %s reconnects the same approval and wire keys", async stage => {
    const storage = memoryStorage()
    const held = Promise.withResolvers<void>()
    const calls: RelayCall[] = []
    const run: HostRun = { status: "running", verdict: "" }
    let armed = false, entered = false
    const first = await readyToRegister(registrationBackend(calls, run, async at => {
      if (armed && at === stage) { entered = true; await held.promise }
    }), await createAppStore({ kind: "localStorage", storage }))
    await registrationResult(first.controller, REQUEST)
    const args = lastAction(first.store)!.args!
    const requestId = JSON.parse(args).requestId as string
    armed = true
    await first.controller.commands.run("triggers.approve", args)
    await waitFor(() => entered)
    const original = workflowLaunchOf(registrationRun(first.store, requestId))!
    await first.controller.dispose()
    await first.store.dispose?.()
    const next = await ready(registrationBackend(calls, run, async () => {}), {
      signedIn: true, store: await createAppStore({ kind: "localStorage", storage })
    })
    try {
      await waitFor(() => registrationRun(next.store, requestId)?.payload.phase === "running")
      const recovered = workflowLaunchOf(registrationRun(next.store, requestId))!
      expect(recovered.id).toBe(original.id)
      expect(recovered.triggerRegistration).toEqual(original.triggerRegistration)
      expect(recovered.workspaceId).toBe(JOB_WORKSPACE)
      await next.controller.commands.run("triggers.approve", args)
      held.resolve()
      await settled()
      expect(calls.filter(call => call.procedure === "Run")).toHaveLength(stage === "run" ? 2 : 1)
      expect(new Set(calls.filter(call => call.procedure === "Run").map(call => call.payload.idempotencyKey)))
        .toEqual(new Set([`trigger:${requestId}:register-run`]))
      expect(new Set(calls.filter(call => call.procedure === "Plan" && call.payload.flowId === "repository/trigger").map(call => call.payload.idempotencyKey)))
        .toEqual(new Set([`trigger:${requestId}:register-plan`]))
      expect(new Set(calls.map(call => call.workspaceId))).toEqual(new Set([JOB_WORKSPACE]))
      expect([...next.store.collections.cards.values()].filter(card => workflowLaunchOf(card)?.triggerRegistration?.requestId === requestId)).toHaveLength(1)
    } finally { held.resolve(); await next.controller.dispose() }
  })

  test.each([...REGISTRATION_STAGES])("sign-out during registration %s fences the remaining calls and late receipt", async stage => {
    const held = Promise.withResolvers<void>()
    const calls: RelayCall[] = []
    let armed = false, entered = false
    const stages: RegistrationStage[] = []
    const { store, controller } = await readyToRegister(registrationBackend(calls, { status: "running", verdict: "" }, async at => {
      stages.push(at)
      if (armed && at === stage) { entered = true; await held.promise }
    }))
    await registrationResult(controller, REQUEST)
    const args = lastAction(store)!.args!
    armed = true
    await controller.commands.run("triggers.approve", args)
    await waitFor(() => entered)
    await signedOut(store)
    const count = stages.length
    held.resolve()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(stages).toHaveLength(count)
    expect([...store.collections.cards.values()].some(card => workflowLaunchOf(card)?.triggerRegistration !== undefined)).toBe(false)
    expect([...store.collections.toasts.values()].some(toast => toast.title === "nightly registered")).toBe(false)
    await controller.dispose()
  })

  test("every registration call stays on the approved workspace after another is selected", async () => {
    const held = Promise.withResolvers<void>()
    const calls: RelayCall[] = []
    let armed = false, entered = false
    const { store, controller } = await readyToRegister(registrationBackend(calls, { status: "running", verdict: "" }, async stage => {
      if (armed && stage === "review") { entered = true; await held.promise }
    }))
    await registrationResult(controller, REQUEST)
    const args = lastAction(store)!.args!
    const requestId = JSON.parse(args).requestId as string
    armed = true
    await controller.commands.run("triggers.approve", args)
    await waitFor(() => entered)
    await jobSetUp(store, "will/flows", "e5973059-58bc-41ca-aa78-a57c3fc4b032")
    held.resolve()
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "running")
    expect(new Set(calls.map(call => call.workspaceId))).toEqual(new Set([JOB_WORKSPACE]))
    expect(registrationRun(store, requestId)?.payload.workspaceId).toBe(JOB_WORKSPACE)
    await controller.dispose()
  })

  test.each(["input", "tokens", "planDigest"])("an altered approved %s is refused before saving or launching", async field => {
    const calls: RelayCall[] = []
    const { store, controller } = await readyToRegister(registrationBackend(calls, { status: "running", verdict: "" }, async () => {}))
    await registrationResult(controller, REQUEST)
    const args = JSON.parse(lastAction(store)!.args!)
    const count = calls.length
    const result = await controller.registerTrigger({ ...args, operation: "approve", [field]: field === "tokens" ? 1000 : field === "input" ? '{"changed":true}' : "changed" })
    expect(result).toBe("The registration changed since you reviewed it. Prepare it again.")
    expect(calls).toHaveLength(count)
    expect(registrationRun(store, args.requestId)).toBeUndefined()
    await controller.dispose()
  })

  /*
   * The Run it every night app (PRODUCT.md D-18): one press. A request naming
   * only the flow runs nightly under the flow's own name, and the owner's
   * press is their approval of the plan — applied through the Approve
   * button's own path once the plan is prepared, so the registration runs
   * with no preview prompt and one toast follows it to the real receipt.
   */
  test("Schedule with only a flow: nightly, the owner's approval applied on preparation, no Approve prompt, and the registration's toast settles with the run", async () => {
    const calls: RelayCall[] = []
    const { store, controller } = await readyToRegister(registrationBackend(calls, { status: "completed", verdict: "Registered" }, async () => {}))
    const quick = { operation: "register" as const, repo: "will/flows", flow: "nightly-lint", input: '{"label":"nightly"}' }
    const answer = await controller.registerTrigger(quick)
    expect(answer).toEqual({ value: "Preparation requested for nightly-lint on will/flows." })
    const prepared = () => preparationOf(store, "nightly-lint")
    await waitFor(() => registrationRun(store, prepared()?.id ?? "")?.payload.phase === "completed")
    expect(prepared()).toMatchObject({ phase: "prepared", approve: "owner", draft: { flow: "nightly-lint", slug: "nightly-lint", schedule: "0 2 * * *", input: '{"label":"nightly"}' } })
    // No prompt: the press was the approval; the plan the owner approved is the one the registrar receives.
    expect([...store.collections.messages.values()].some(message => message.action?.flow === "triggers.approve")).toBe(false)
    expect(calls.filter(call => call.procedure === "Approval.Submit").map(call => (call.payload.target as { planId: string }).planId)).toContain("plan-1")
    expect(calls.filter(call => call.procedure === "Run")).toHaveLength(1)
    const launch = workflowLaunchOf(registrationRun(store, prepared()!.id))!
    expect(launch.triggerRegistration).toMatchObject({ slug: "nightly-lint", flow: "nightly-lint", schedule: "0 2 * * *", planId: "plan-1" })
    await waitFor(() => registrationToast(store, "nightly-lint")?.status === "ok")
    expect(registrationToast(store, "nightly-lint")?.title).toBe("nightly-lint registered")
    // Pressing again joins the registration already made: one preparation, one run.
    await controller.registerTrigger(quick)
    await settled()
    expect(triggerCard(store).payload.preparations?.filter(row => row.draft.slug === "nightly-lint")).toHaveLength(1)
    expect(calls.filter(call => call.procedure === "Run")).toHaveLength(1)
    await controller.dispose()
  })

  test("a schedule the line names keeps the advanced path: prepare, preview, and the human's Approve", async () => {
    const calls: RelayCall[] = []
    const { store, controller } = await readyToRegister(registrationBackend(calls, { status: "running", verdict: "" }, async () => {}))
    await controller.registerTrigger({ ...REQUEST, slug: undefined })
    const prepared = () => preparationOf(store, "nightly-lint")
    await waitFor(() => ["prepared", "failed"].includes(prepared()?.phase ?? ""))
    expect(prepared()).toMatchObject({ phase: "prepared", draft: { schedule: "0 9 * * 1-5" } })
    expect(prepared()?.approve).toBeUndefined()
    expect(lastAction(store)?.flow).toBe("triggers.approve")
    expect(calls.some(call => call.procedure === "Approval.Submit" || call.procedure === "Run")).toBe(false)
    await controller.dispose()
  })

  test("the agent's one-flow request keeps the preview and the human's Approve: approvals belong to the human", async () => {
    const calls: RelayCall[] = []
    const { store, controller } = await readyToRegister(registrationBackend(calls, { status: "running", verdict: "" }, async () => {}))
    const outcome = await controller.submitCommand({ name: "triggers.register", payload: { flow: "nightly-lint", input: '{"label":"nightly"}' }, actor: "agent" })
    expect(outcome.status).toBe("executed")
    const prepared = () => preparationOf(store, "nightly-lint")
    await waitFor(() => ["prepared", "failed"].includes(prepared()?.phase ?? ""))
    expect(prepared()).toMatchObject({ phase: "prepared", draft: { schedule: "0 2 * * *" } })
    expect(prepared()?.approve).toBeUndefined()
    expect(lastAction(store)?.flow).toBe("triggers.approve")
    expect(calls.some(call => call.procedure === "Approval.Submit" || call.procedure === "Run")).toBe(false)
    await controller.dispose()
  })

  test("a completed registration's approval never launches it twice", async () => {
    const calls: RelayCall[] = []
    const { store, controller } = await readyToRegister(registrationBackend(calls, { status: "completed", verdict: "Registered" }, async () => {}))
    await registrationResult(controller, REQUEST)
    const args = lastAction(store)!.args!
    const requestId = JSON.parse(args).requestId as string
    await controller.commands.run("triggers.approve", args)
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "completed")
    const id = registrationRun(store, requestId)!.id
    await controller.commands.run("triggers.approve", args)
    await settled()
    expect(registrationRun(store, requestId)!.id).toBe(id)
    expect(calls.filter(call => call.procedure === "Run")).toHaveLength(1)
    await controller.dispose()
  })

  test("approval whose request cannot be saved makes no remote calls", async () => {
    const original = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let reject = true
    const store: AppStore = { ...original, dispatch: transition => {
      if (reject && transition.type === "card.upsert" && workflowLaunchOf(transition.card)?.triggerRegistration) {
        return { isPersisted: { promise: Promise.reject(new Error("disk full")) } } as ReturnType<AppStore["dispatch"]>
      }
      return original.dispatch(transition)
    } }
    const calls: RelayCall[] = []
    const { controller } = await readyToRegister(registrationBackend(calls, { status: "running", verdict: "" }, async () => {}), store)
    await registrationResult(controller, REQUEST)
    const args = lastAction(store)!.args!
    const count = calls.length
    expect((await controller.commands.run("triggers.approve", args)).status).toBe("failed")
    expect(calls).toHaveLength(count)
    reject = false
    await controller.commands.run("triggers.approve", args)
    await waitFor(() => calls.some(call => call.procedure === "Run"))
    await controller.dispose()
  })

  test.each(["List", "Plan"])("preparation acknowledges while %s is unresolved and shares one toast", async heldProcedure => {
    const held = Promise.withResolvers<void>()
    const calls: Array<RelayCall> = []
    const answers = workspaceAnswers()
    const { store, controller } = await readyToRegister({ ...watched(backend({ [RPC]: relayRoute(calls, {
      ...answers, [heldProcedure]: async payload => { await held.promise; return answers[heldProcedure]!(payload) }
    }) })), toastDebounceMs: 300 })
    try {
      const command = controller.registerTrigger(REQUEST)
      expect(await Promise.race([command, new Promise(resolve => setTimeout(() => resolve("blocked"), 100))])).toEqual({ value: "Preparation requested for nightly on will/flows." })
      await controller.registerTrigger(REQUEST)
      await waitFor(() => calls.some(call => call.procedure === heldProcedure))
      await store.dispatch({ type: "composer.changed", actor: "user", draft: "Keep chatting" }).isPersisted.promise
      await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.title === "Preparing nightly" && toast.status === "running"))
      expect(calls.filter(call => call.procedure === heldProcedure)).toHaveLength(1)
      expect(lastAction(store)?.flow).not.toBe("triggers.approve")
      held.resolve()
      await waitFor(() => lastAction(store)?.flow === "triggers.approve")
      await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.title === "Prepared nightly" && toast.status === "ok"))
      expect(calls.some(call => call.procedure === "Approval.Submit" || call.procedure === "Run")).toBe(false)
    } finally { held.resolve(); await controller.dispose() }
  })

  test.each(["List", "Plan", "publish"])("reload recovers %s with the same reviewed request and one approval prompt", async stage => {
    const storage = memoryStorage()
    const held = Promise.withResolvers<void>()
    const calls: Array<RelayCall> = []
    const answers = workspaceAnswers()
    let publishing = false
    const original = await createAppStore({ kind: "localStorage", storage })
    const store: AppStore = { ...original, dispatch: transition => {
      if (stage === "publish" && transition.type === "message.appended" && transition.action?.flow === "triggers.approve") {
        publishing = true
        return { isPersisted: { promise: held.promise } } as unknown as ReturnType<AppStore["dispatch"]>
      }
      return original.dispatch(transition)
    } }
    const first = await readyToRegister(watched(backend({ [RPC]: relayRoute(calls, {
      ...answers,
      ...(stage === "publish" ? {} : { [stage]: async payload => { await held.promise; return answers[stage]!(payload) } })
    }) })), store)
    await first.controller.registerTrigger(REQUEST)
    await waitFor(() => stage === "publish" ? publishing : calls.some(call => call.procedure === stage))
    const request = triggerCard(store).payload.preparations![0]!
    await first.controller.dispose()
    await store.dispose?.()
    const next = await ready(watched(backend({ [RPC]: relayRoute(calls, answers) })), {
      signedIn: true, store: await createAppStore({ kind: "localStorage", storage })
    })
    try {
      await waitFor(() => triggerCard(next.store).payload.preparations?.[0]?.phase === "prepared")
      const prompts = [...next.store.collections.messages.values()].filter(message => message.action?.flow === "triggers.approve")
      expect(prompts).toHaveLength(1)
      expect(JSON.parse(prompts[0]!.action!.args!).requestId).toBe(request.id)
      const plans = calls.filter(call => call.procedure === "Plan")
      expect(plans).toHaveLength(stage === "Plan" ? 2 : 1)
      expect(new Set(plans.map(call => call.payload.idempotencyKey)).size).toBe(1)
      expect(new Set(calls.map(call => call.workspaceId))).toEqual(new Set([JOB_WORKSPACE]))
      expect(calls.some(call => call.procedure === "Run")).toBe(false)
    } finally { held.resolve(); await next.controller.dispose() }
  })

  test("a late plan cannot offer approval after sign-out", async () => {
    const held = Promise.withResolvers<void>()
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(watched(backend({ [RPC]: relayRoute(calls, workspaceAnswers({
      Plan: async () => { await held.promise; return okFrame(PLAN) }
    })) })))
    await controller.registerTrigger(REQUEST)
    await waitFor(() => calls.some(call => call.procedure === "Plan"))
    await signedOut(store)
    held.resolve()
    await settled()
    expect(lastAction(store)?.flow).not.toBe("triggers.approve")
    expect([...store.collections.toasts.values()].some(toast => toast.title === "Prepared nightly")).toBe(false)
    await controller.dispose()
  })

  test("a workspace change refuses the old preview and retry binds the new workspace", async () => {
    const held = Promise.withResolvers<void>()
    const calls: Array<RelayCall> = []
    let delay = true
    const answers = workspaceAnswers()
    const { store, controller } = await readyToRegister(watched(backend({ [RPC]: relayRoute(calls, {
      ...answers, List: async () => { if (delay) await held.promise; return answers.List!() }
    }) })))
    await controller.registerTrigger(REQUEST)
    await waitFor(() => calls.length === 1)
    await jobSetUp(store, "will/flows", "e5973059-58bc-41ca-aa78-a57c3fc4b032")
    delay = false
    held.resolve()
    await waitFor(() => triggerCard(store).payload.preparations?.[0]?.phase === "failed")
    expect(calls.some(call => call.procedure === "Plan")).toBe(false)
    expect(await registrationResult(controller, REQUEST)).toBe(registerUnavailableSentence("will/flows"))
    expect(calls.at(-1)?.workspaceId).toBe("e5973059-58bc-41ca-aa78-a57c3fc4b032")
    expect(lastAction(store)?.flow).not.toBe("triggers.approve")
    await controller.dispose()
  })

  test("replacing a prepared draft retires the previous approval button", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(watched(backend({ [RPC]: relayRoute(calls, workspaceAnswers()) })))
    await registrationResult(controller, REQUEST)
    const old = JSON.parse(lastAction(store)!.args!)
    await registrationResult(controller, { ...REQUEST, input: '{"label":"corrected"}' })
    const count = calls.length
    expect(await controller.registerTrigger({ ...old, operation: "approve" })).toBe("Prepare this schedule again; this preview was replaced.")
    expect(calls).toHaveLength(count)
    await controller.dispose()
  })

  test("correcting a pending draft retires its late plan", async () => {
    const held = Promise.withResolvers<void>()
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(watched(backend({ [RPC]: relayRoute(calls, workspaceAnswers({
      Plan: async payload => { if ((payload.input as { label?: string }).label === "nightly") await held.promise; return okFrame(PLAN) }
    })) })))
    await controller.registerTrigger(REQUEST)
    await waitFor(() => calls.some(call => call.procedure === "Plan"))
    await registrationResult(controller, { ...REQUEST, input: '{"label":"corrected"}' })
    held.resolve()
    await settled()
    const prompts = [...store.collections.messages.values()].filter(message => message.action?.flow === "triggers.approve")
    expect(prompts).toHaveLength(1)
    expect(JSON.parse(prompts[0]!.action!.args!).input).toBe('{"label":"corrected"}')
    await controller.dispose()
  })

  test("Retry admitted while the failure is settling still prepares the request", async () => {
    let plans = 0
    const { store, controller } = await readyToRegister(watched(backend({ [RPC]: relayRoute([], workspaceAnswers({
      Plan: () => ++plans === 1 ? refusedFrame("Try again") : okFrame(PLAN)
    })) })))
    let retried = false
    const subscription = store.collections.cards.subscribeChanges(() => {
      const card = store.collections.cards.get("trigger-list-will/flows")
      if (!retried && card?.kind === "trigger-list" && card.payload.preparations?.[0]?.phase === "failed") {
        retried = true
        queueMicrotask(() => { void controller.registerTrigger(REQUEST) })
      }
    })
    try {
      await controller.registerTrigger(REQUEST)
      await waitFor(() => triggerCard(store).payload.preparations?.[0]?.phase === "prepared")
      expect(plans).toBe(2)
      expect(lastAction(store)?.flow).toBe("triggers.approve")
    } finally { subscription.unsubscribe(); await controller.dispose() }
  })

  test.each(["requested", "planning", "ready", "publish", "prepared"])("failed %s storage never claims a durable preview and can retry", async phase => {
    const original = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let rejected = false
    const calls: Array<RelayCall> = []
    const store: AppStore = { ...original, dispatch: transition => {
      const target = phase === "publish" ? transition.type === "message.appended" && transition.action?.flow === "triggers.approve"
        : transition.type === "card.upsert" && transition.card.kind === "trigger-list" && transition.card.payload.preparations?.some(request => request.phase === phase)
      if (!rejected && target) {
        rejected = true
        return { isPersisted: { promise: Promise.reject(new Error("disk full")) } } as ReturnType<AppStore["dispatch"]>
      }
      return original.dispatch(transition)
    } }
    const { controller } = await readyToRegister(watched(backend({ [RPC]: relayRoute(calls, workspaceAnswers()) })), store)
    const answer = await controller.registerTrigger(REQUEST)
    if (phase === "requested") expect(answer).toBe("Could not save the preparation. Retry.")
    else await waitFor(() => triggerCard(store).payload.preparations?.[0]?.phase === "failed")
    if (["requested", "planning"].includes(phase)) expect(calls.some(call => call.procedure === "Plan")).toBe(false)
    if (phase !== "prepared") expect(lastAction(store)?.flow).not.toBe("triggers.approve")
    await registrationResult(controller, REQUEST)
    expect([...store.collections.messages.values()].filter(message => message.action?.flow === "triggers.approve")).toHaveLength(1)
    if (["publish", "prepared"].includes(phase)) expect(calls.filter(call => call.procedure === "Plan")).toHaveLength(1)
    await controller.dispose()
  })

  test("a bad name or a schedule that is not five UTC cron fields is refused before anything is asked of the workspace", async () => {
    const seen: Array<string> = []
    const { controller } = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE) }, seen), { signedIn: true })
    expect(await registrationResult(controller, { ...REQUEST, slug: "Nightly" })).toContain("schedule name")
    expect(await registrationResult(controller, { ...REQUEST, schedule: "0 9 * *" })).toBe("schedule must have five cron fields in UTC")
    expect(await registrationResult(controller, { ...REQUEST, input: "{not json" })).toContain("valid JSON")
    expect(seen.filter((path) => path.startsWith(RPC))).toEqual([])
  })

  test("input the flow's own schema refuses never reaches a plan, and an unknown flow lists what the workspace has", async () => {
    const calls: Array<RelayCall> = []
    const { controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) })
    )
    const refused = await registrationResult(controller, { ...REQUEST, input: "{}" })
    expect(typeof refused).toBe("string")
    expect(String(refused)).toContain("label")
    expect(calls.map((call) => call.procedure)).toEqual(["List"])

    const unknown = await registrationResult(controller, { ...REQUEST, flow: "weekly-sweep" })
    expect(String(unknown)).toContain("nightly-lint")
    expect(calls.map((call) => call.procedure)).toEqual(["List", "List"])
  })

  /*
   * The canary's own register form, verbatim: `checks/fast` prepared with
   * Input `{}` (.artifacts/mvp-canary-walk-20260917/W1-e-triggers-register.json
   * `L98-previewTranscript`) put `Missing key at ["args"]` in the transcript
   * and on the card — the decoder's own pointer, not a sentence. The refusal
   * is written from the flow's published document: which input it needs and
   * what to put there.
   */
  test("input the flow refuses is answered with the input it needs, never the decoder's pointer", async () => {
    const calls: Array<RelayCall> = []
    const document = JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(Schema.Struct({ args: Schema.String })))) as unknown
    const { controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, {
        ...workspaceAnswers(),
        List: () => okFrame({ _tag: "flows", items: [{ flowId: "checks/fast", description: "Fast checks.", inputSchema: document }, FLOW_ITEMS[1]] })
      }) })
    )
    const refused = await registrationResult(controller, { ...REQUEST, flow: "checks/fast", input: "{}" })
    expect(refused).toBe('Input for "checks/fast" needs args: {"args": "…"}.')
    const wrongType = await registrationResult(controller, { ...REQUEST, flow: "checks/fast", input: '{"args":7}' })
    expect(wrongType).toBe('Input for "checks/fast" takes {"args": "…"}.')
    for (const sentence of [refused, wrongType]) {
      expect(String(sentence)).not.toContain("Missing key")
      expect(String(sentence)).not.toContain('["')
    }
    expect(calls.map((call) => call.procedure)).toEqual(["List", "List"])
  })

  /*
   * A flow whose published document declares no properties — `checks/fast`'s
   * sibling taking one string — used to be refused with `Input for "<flow>"
   * isn't what it takes.`, which tells the person nothing they can act on. It
   * now says what the flow takes, in the same words every other refusal here
   * uses.
   */
  test("a flow that declares no properties says what it takes instead of that the input is wrong", async () => {
    const calls: Array<RelayCall> = []
    const document = JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(Schema.String))) as unknown
    const { controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, {
        ...workspaceAnswers(),
        List: () => okFrame({ _tag: "flows", items: [{ flowId: "checks/none", description: "No input.", inputSchema: document }, FLOW_ITEMS[1]] })
      }) })
    )
    const refused = await registrationResult(controller, { ...REQUEST, flow: "checks/none", input: '{"args":"lint"}' })
    expect(refused).toBe('Input for "checks/none" takes "…".')
    expect(String(refused)).not.toContain("isn't what it takes")
  })

  test("a prepared registration previews the plan and offers the human's approve button; nothing is approved yet", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) })
    )
    const prepared = await registrationResult(controller, REQUEST)
    expect(typeof prepared).toBe("object")
    expect(calls.map((call) => call.procedure)).toEqual(["List", "Plan"])
    const action = lastAction(store)
    expect(action?.flow).toBe("triggers.approve")
    const args = JSON.parse(action?.args ?? "{}") as Record<string, unknown>
    const requestId = String(args.requestId)
    expect(requestId).not.toBe("undefined")
    expect(args).toEqual({
      requestId, repo: "will/flows", flow: "nightly-lint", slug: "nightly", schedule: "0 9 * * 1-5",
      input: '{"label":"nightly"}', planId: "plan-1", planDigest: PLAN_DIGEST
    })
    /* The plan is keyed by this request, not by the schedule's name (L36 §3 step 4). */
    expect(calls[1]?.payload).toEqual({
      flowId: "nightly-lint",
      input: { label: "nightly" },
      idempotencyKey: `trigger:${requestId}:plan`
    })
    const preview = [...store.collections.messages.values()].sort((left, right) => right.ordinal - left.ordinal)[0]?.text ?? ""
    expect(preview).toContain("nightly-lint")
    expect(preview).toContain("0 9 * * 1-5")
    expect(preview).toContain("fs:read:**")
    expect(preview).toContain(PLAN.executionDigest.slice(0, 12))
    /* The standing budget a person grants by approving is on the card they approve. */
    expect(preview).toContain("200000 tokens")
    expect(preview).toContain("30 min")
  })

  /*
   * D3-N3 of walk run 3: the form field held `0 9 * * 1-5` and the preview the
   * person approved read `checks/fast · 0 9 1-5 UTC`, because the transcript
   * renders a message as markdown (TranscriptMessage.tsx) and `* *` is
   * emphasis. The capability line rendered as a bare `*` for the same reason.
   */
  test("the preview states the schedule and the capabilities verbatim, so markdown cannot eat a wildcard", async () => {
    const { store, controller } = await readyToRegister(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute([], workspaceAnswers({
          Plan: (payload) =>
            payload.flowId === "nightly-lint"
              ? okFrame({ ...PLAN, envelope: { ...PLAN.envelope, capabilities: ["*"] } })
              : okFrame({ ...PLAN, planId: "plan-registrar", digest: "f".repeat(64), flowId: String(payload.flowId) })
        }))
      })
    )
    expect(typeof await registrationResult(controller, REQUEST)).toBe("object")
    const preview = [...store.collections.messages.values()].sort((left, right) => right.ordinal - left.ordinal)[0]?.text ?? ""
    expect(preview).toContain("`0 9 * * 1-5`")
    expect(preview).toContain("`*`")
  })

  /*
   * D3-N2 of walk run 3, the release blocker: `Plan checks/fast` answers
   * `"budget": {}` (D3-13-plan-envelope.json) because the flow declares no
   * ceiling, the registration carried that envelope, and the approval was
   * refused upstream — `upstream_refused — automatic work needs the reviewed
   * envelope and finite token/time limits`. A registration never reaches an
   * approval without finite limits again: it is refused here, in the app, in a
   * sentence that says what to do.
   */
  test("a flow that declares no ceiling is refused before any approval, unless the registration names the limits", async () => {
    const calls: Array<RelayCall> = []
    const unbounded = workspaceAnswers({
      Plan: (payload) =>
        payload.flowId === "nightly-lint"
          ? okFrame({ ...PLAN, envelope: { ...PLAN.envelope, budget: {} } })
          : okFrame({ ...PLAN, planId: "plan-registrar", digest: "f".repeat(64), flowId: String(payload.flowId) })
    })
    const { store, controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, unbounded) })
    )
    expect(await registrationResult(controller, REQUEST)).toBe(unboundedFlowSentence("nightly-lint"))
    expect(lastAction(store)).toBeUndefined()
    expect(calls.map((call) => call.procedure)).toEqual(["List", "Plan"])

    /* The same flow, with the limits the person gave: prepared, and the preview states them. */
    expect(typeof await registrationResult(controller, { ...REQUEST, tokens: "150000", minutes: "20" })).toBe("object")
    const preview = [...store.collections.messages.values()].sort((left, right) => right.ordinal - left.ordinal)[0]?.text ?? ""
    expect(preview).toContain("150000 tokens · 20 min")
    expect(JSON.parse(lastAction(store)?.args ?? "{}")).toMatchObject({ tokens: 150_000, minutes: 20 })
  })

  /*
   * R98 F1: `Descriptor.BudgetCeiling` bounds nothing from above, so a flow
   * may DECLARE more than six hours or a million tokens. Only the person's own numbers
   * were held to the deployment's ceiling, so such a declaration was previewed,
   * approved, and refused upstream — the same production toast, for the same
   * reason, on a path the walk never reached because `checks/fast` declares
   * nothing at all.
   */
  test("a flow that declares a ceiling past the deployment's own is refused before the preview, in a sentence naming the range", async () => {
    const declaring = (budget: Record<string, number>) =>
      workspaceAnswers({
        Plan: (payload) =>
          payload.flowId === "nightly-lint"
            ? okFrame({ ...PLAN, envelope: { ...PLAN.envelope, budget } })
            : okFrame({ ...PLAN, planId: "plan-registrar", digest: "f".repeat(64), flowId: String(payload.flowId) })
      })
    for (const budget of [{ tokens: 200_000, milliseconds: 21_600_001 }, { tokens: 5_000_000, milliseconds: 600_000 }]) {
      const calls: Array<RelayCall> = []
      const { store, controller } = await readyToRegister(
        backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, declaring(budget)) })
      )
      expect(await registrationResult(controller, REQUEST)).toBe(overBoundFlowSentence("nightly-lint"))
      expect(lastAction(store)).toBeUndefined()
      expect(calls.map((call) => call.procedure)).toEqual(["List", "Plan"])

      /* The same flow, bounded by the limits the person gave: prepared, and the preview states theirs. */
      expect(typeof await registrationResult(controller, { ...REQUEST, tokens: "150000", minutes: "20" })).toBe("object")
      const preview = [...store.collections.messages.values()].sort((left, right) => right.ordinal - left.ordinal)[0]?.text ?? ""
      expect(preview).toContain("150000 tokens · 20 min")
    }
  })

  test("a declared six-hour limit reaches the preview at the deployment ceiling", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers({
        Plan: (payload) => payload.flowId === "nightly-lint"
          ? okFrame({ ...PLAN, envelope: { ...PLAN.envelope, budget: { tokens: 200_000, milliseconds: 21_600_000 } } })
          : okFrame({ ...PLAN, planId: "plan-registrar", digest: "f".repeat(64), flowId: String(payload.flowId) })
      })) })
    )
    expect(typeof await registrationResult(controller, REQUEST)).toBe("object")
    const preview = [...store.collections.messages.values()].sort((left, right) => right.ordinal - left.ordinal)[0]?.text ?? ""
    expect(preview).toContain("200000 tokens · 360 min")
    expect(lastAction(store)?.flow).toBe("triggers.approve")
    expect(calls.map(call => call.procedure)).toEqual(["List", "Plan"])
  })

  test("limits that are not whole positive numbers are refused before the workspace is asked anything", async () => {
    const calls: Array<RelayCall> = []
    const { controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) })
    )
    expect(await registrationResult(controller, { ...REQUEST, tokens: "lots", minutes: "20" })).toBe(LIMIT_SHAPE)
    expect(await registrationResult(controller, { ...REQUEST, tokens: "150000", minutes: "0" })).toBe(LIMIT_SHAPE)
    /* Smithers Cloud refuses a registration past six hours; a person's own number never earns an upstream refusal. */
    expect(await registrationResult(controller, { ...REQUEST, tokens: "150000", minutes: "500" })).toBe(LIMIT_SHAPE)
    /* R98 F2: past the registrar's token ceiling the host refused on the registration run, after a Plue approval row existed. */
    expect(await registrationResult(controller, { ...REQUEST, tokens: "500000", minutes: "20" })).toBe(LIMIT_SHAPE)
    expect(calls).toEqual([])
  })

  /*
   * R102 B2 and R102b B1b, held against ONE fixture because they are one
   * conversation. Half a pair is not a bad number: the number is inside the
   * range the sentence names and the other limit is simply not typed yet. The
   * rule says so in its own words at submit, and says NOTHING at the door,
   * whose whole purpose is to collect the half that is missing.
   *
   * What it says is only what is MISSING. The pair rule runs before
   * `limitsFor`, so its sentence is the FIRST one a person reads — and for a
   * flow that declares no limits of its own, `Name both limits, or neither`
   * offered them "neither" and `limitsFor` then refused them for taking it.
   * That flow is `checks/fast`, the one walk W1 registered, so the flow here
   * is `checks/fast` and its plan carries the empty budget the walk saw
   * (D3-13-plan-envelope.json). The three calls stay in one test so the two
   * sentences can never drift apart again.
   */
  test("a flow that declares no limits is told what is missing, never offered a choice the next rule refuses", async () => {
    const calls: Array<RelayCall> = []
    const unbounded = workspaceAnswers({
      List: () => okFrame({ _tag: "flows", items: [{ flowId: "checks/fast", description: "Runs the fast checks." }, FLOW_ITEMS[1]] }),
      Plan: (payload) =>
        payload.flowId === "checks/fast"
          ? okFrame({ ...PLAN, flowId: "checks/fast", envelope: { ...PLAN.envelope, flows: ["checks/fast"], budget: {} } })
          : okFrame({ ...PLAN, planId: "plan-registrar", digest: "f".repeat(64), flowId: String(payload.flowId) })
    })
    const { controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, unbounded) })
    )
    const walked = { ...REQUEST, flow: "checks/fast", input: "" }

    /* Half a pair, refused with zero network calls, naming the half that is missing and the range it takes. */
    expect(await registrationResult(controller, { ...walked, tokens: "150000" })).toBe("Name the other limit: --minutes 1..360.")
    expect(await registrationResult(controller, { ...walked, minutes: "20" })).toBe("Name the other limit: --tokens 1..200000.")
    expect(calls).toEqual([])

    /* Neither named, same flow: the only sentence that may speak of "none" is the one that knows the flow. */
    expect(await registrationResult(controller, walked)).toBe(unboundedFlowSentence("checks/fast"))
    expect(calls.map((call) => call.procedure)).toEqual(["List", "Plan"])

    /* No sentence on this card offers an option another rule refuses. */
    for (const sentence of [otherLimitSentence("tokens"), otherLimitSentence("minutes"), unboundedFlowSentence("checks/fast")]) {
      expect(sentence).not.toContain("or neither")
    }
    expect(otherLimitSentence("tokens")).toBe("Name the other limit: --tokens 1..200000.")
    expect(otherLimitSentence("minutes")).toBe("Name the other limit: --minutes 1..360.")

    /* The door's own rule: a number out of range still earns the range; a half-named pair earns silence. */
    expect(limitsRefusal({ tokens: "150000" })).toBeUndefined()
    expect(limitsRefusal({ minutes: "20" })).toBeUndefined()
    expect(limitsRefusal({ tokens: "500000" })).toBe(LIMIT_SHAPE)
    expect(limitsRefusal({ minutes: "500" })).toBe(LIMIT_SHAPE)
    expect(limitsRefusal({ tokens: "lots" })).toBe(LIMIT_SHAPE)
    expect(limitsRefusal({})).toBeUndefined()
  })

  /*
   * R98 F2: `Set token and time limits: "checks/fast" declares none.` asked a
   * person for two numbers without saying which ones are acceptable, and the
   * number they could not guess — the registrar's token ceiling — was enforced
   * late, by the host, after an approval row had been written.
   */
  test("every limits refusal names the range the register door takes", () => {
    expect(unboundedFlowSentence("checks/fast")).toBe(
      `Set token and time limits: "checks/fast" declares none. --tokens 1..200000, --minutes 1..360.`
    )
    expect(overBoundFlowSentence("checks/fast")).toBe(
      `Set token and time limits: "checks/fast" declares more than --tokens 1..200000, --minutes 1..360.`
    )
    expect(LIMIT_SHAPE).toBe("Token and time limits are whole numbers: --tokens 1..200000, --minutes 1..360.")
  })

  /*
   * The app holds no second copy of host policy: the ceiling it names is the
   * registrar's own (`flows/repository/inspection.ts`, enforced by `Prepare`
   * and by repository setup), read here so the two cannot drift apart while
   * both still pass their own tests.
   */
  test("the range the app names is the registrar's own ceiling", async () => {
    const source = await readFile(new URL("../../../../../../flows/repository/inspection.ts", import.meta.url), "utf8")
    const ceiling = (name: string): number =>
      Number((new RegExp(`export const ${name} = ([0-9_]+)`).exec(source)?.[1] ?? "").replaceAll("_", ""))
    expect(LIMIT_SHAPE).toContain(`--tokens 1..${ceiling("deploymentTokens")}`)
    expect(LIMIT_SHAPE).toContain(`--minutes 1..${ceiling("deploymentMinutes")}`)
  })

  /*
   * The registrar is a built-in of the workspace coding host (flows/coding
   * host.ts, flows/repository/registry.ts). A relay call that names no
   * workspace reaches the repository's own gateway instead, which runs the
   * product host and holds the librarian flow and no registrar at all —
   * the canary's `No flow "repository/trigger" is registered on this
   * workspace.` on every repository.
   */
  test("every relayed call names the workspace the repository's reviewed jobs run on", async () => {
    const calls: Array<RelayCall> = []
    const { controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) })
    )
    expect(typeof await registrationResult(controller, REQUEST)).toBe("object")
    expect(calls.map((call) => call.procedure)).toEqual(["List", "Plan"])
    expect(calls.map((call) => call.workspaceId)).toEqual([JOB_WORKSPACE, JOB_WORKSPACE])
  })

  /* A reviewed job on another repository is not this repository's box, so the call reaches the product host. */
  test("a repository with no reviewed job set up has no recorded workspace to name, and its own gateway holds no registrar", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await ready(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) }),
      { signedIn: true }
    )
    await jobSetUp(store, "will/other")
    expect(await registrationResult(controller, REQUEST)).toBe(registerUnavailableSentence("will/flows"))
    expect(calls.map((call) => call.workspaceId)).toEqual([undefined])
  })

  test("correcting the input prepares a new plan instead of pinning the first one to the name forever", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) })
    )
    await registrationResult(controller, { ...REQUEST, input: '{"label":"nightlyy"}' })
    const first = String((JSON.parse(lastAction(store)?.args ?? "{}") as Record<string, unknown>).requestId)
    await registrationResult(controller, REQUEST)
    const second = String((JSON.parse(lastAction(store)?.args ?? "{}") as Record<string, unknown>).requestId)
    expect(second).not.toBe(first)
    expect(calls.filter((call) => call.procedure === "Plan").map((call) => call.payload.idempotencyKey))
      .toEqual([`trigger:${first}:plan`, `trigger:${second}:plan`])
  })

  /*
   * A workspace that idle-suspended is resuming, and the relay answers that
   * state as HTTP 200 with its own sentence (apps/server workflows.ts
   * gatewayCallResponse: provisioning, no-capacity, quota-exceeded,
   * no-cloud-identity, no-cloud-repo). Since the register door always
   * addresses the repository-jobs box, this is the ordinary first press after
   * the box has been idle.
   */
  test("a box that is still resuming answers with its own sentence, not with a refusal it never made", async () => {
    const resuming = "The workspace is resuming; ask again in a moment."
    const { controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: json(200, { status: "provisioning", message: resuming }) })
    )
    expect(await registrationResult(controller, REQUEST)).toBe(resuming)
  })

  test("a workspace that cannot register schedules says so before it plans anything", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute(calls, workspaceAnswers({ List: () => okFrame({ _tag: "flows", items: [FLOW_ITEMS[0]] }) }))
      })
    )
    expect(await registrationResult(controller, REQUEST)).toBe(registerUnavailableSentence("will/flows"))
    expect(calls.map((call) => call.procedure)).toEqual(["List"])
    expect(lastAction(store)).toBeUndefined()
  })

  test("the agent may prepare a registration and may never approve one", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) })
    )
    await registrationResult(controller, REQUEST)
    const args = lastAction(store)?.args ?? "{}"
    const refused = await controller.commands.runForAgent("triggers.approve", args)
    expect(refused.status).toBe("failed")
    if (refused.status === "failed") expect(refused.error).toContain("approvals belong to the human")
    expect(calls.map((call) => call.procedure)).toEqual(["List", "Plan"])
  })

  test("the human's approval submits the plan once, records the receipt once, and starts one registration run", async () => {
    const calls: Array<RelayCall> = []
    const receipts: Array<unknown> = []
    const { store, controller } = await readyToRegister(
      watched(backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute(calls, workspaceAnswers()),
        [APPROVAL]: async (request) => {
          receipts.push(await request.json())
          return json(200, { status: "ok", approvedAt: "2026-09-17T06:00:00Z", approvedBy: 1 })
        }
      }))
    )
    await registrationResult(controller, REQUEST)
    const args = lastAction(store)?.args ?? "{}"
    const requestId = String((JSON.parse(args) as Record<string, unknown>).requestId)
    const approved = await controller.commands.run("triggers.approve", args)
    expect(approved.status).toBe("executed")
    /* The approval answers at once and the registration runs behind it (AGENTS.md, instant chat). */
    await waitFor(() => calls.filter((call) => call.procedure === "Run").length === 1)
    /*
     * Plue's RecordApproval refuses an approval whose flow_id does not match
     * the registered flow, and `validateRepositoryJob` refuses an envelope
     * with no finite token/time limits. The receipt carries the envelope the
     * registration will carry: the plan's, bounded by the reviewed limits.
     */
    expect(receipts).toEqual([{
      repo: "will/flows", slug: "nightly", flowId: "nightly-lint", planId: "plan-1", planDigest: PLAN_DIGEST,
      envelope: { ...PLAN.envelope, budget: { tokens: 200_000, milliseconds: 1_800_000 } }
    }])
    expect(calls.map((call) => call.procedure).filter((name) => name !== "Projection.Snapshot")).toEqual([
      "List", "Plan", "List", "Plan", "Approval.Submit", "Plan", "Approval.Submit", "Run"
    ])
    /* The target's plan is approved by its own digest; the registrar's plan carries the approved pair. */
    expect(calls[4]?.payload).toMatchObject({ target: { _tag: "Plan", planId: "plan-1", digest: PLAN_DIGEST }, decision: "approve" })
    expect(calls[5]?.payload).toMatchObject({
      flowId: "repository/trigger",
      idempotencyKey: `trigger:${requestId}:register-plan`,
      input: {
        requestId, operation: "register", repo: "will/flows", slug: "nightly", flow: "nightly-lint",
        schedule: "0 9 * * 1-5", input: { label: "nightly" }, budget: { tokens: 200_000, milliseconds: 1_800_000 },
        approvedPlanId: "plan-1", approvedPlanDigest: PLAN_DIGEST
      }
    })
    expect(calls[7]?.payload).toMatchObject({ _tag: "Plan", idempotencyKey: `trigger:${requestId}:register-run` })

    /* Was: a second press repeated the whole attempt. It now reconnects to the run this attempt already started. */
    const again = await controller.commands.run("triggers.approve", args)
    expect(again.status).toBe("executed")
    expect(receipts).toHaveLength(1)
    expect(calls.filter((call) => call.payload.idempotencyKey === `trigger:${requestId}:register-run`)).toHaveLength(1)
  })

  /*
   * Was: each refusal was the approve command's own failure. The approval now
   * answers at once and the registration runs behind it, so a refusal on the
   * way to the run reaches the human on the notice that named the work.
   */
  test("the host's own refusal and Smithers Cloud's own refusal each reach the human as themselves", async () => {
    const moduleRefusal = '"nightly-lint" is a flow.ts. Schedules run flow.mdx.'
    const hosted = await readyToRegister(
      watched(backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute([], workspaceAnswers({
          Plan: (payload) => payload.flowId === "repository/trigger" ? refusedFrame(moduleRefusal) : okFrame(PLAN)
        })),
        [APPROVAL]: json(200, { status: "ok", approvedAt: "2026-09-17T06:00:00Z", approvedBy: 1 })
      }))
    )
    await registrationResult(hosted.controller, REQUEST)
    const hostArgs = lastAction(hosted.store)?.args ?? "{}"
    const hostId = preparedId(hosted.store)
    expect((await hosted.controller.commands.run("triggers.approve", hostArgs)).status).toBe("executed")
    await waitFor(() => registrationRun(hosted.store, hostId)?.payload.phase === "failed")
    expect(registrationRun(hosted.store, hostId)?.payload.error).toBe(moduleRefusal)

    const cloudRefusal = "register only the plan a person approved; approve the preview, then apply"
    const clouded = await readyToRegister(
      watched(backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute([], workspaceAnswers()),
        [APPROVAL]: json(409, { status: "error", code: "trigger_approval_missing", message: cloudRefusal })
      }))
    )
    await registrationResult(clouded.controller, REQUEST)
    const cloudArgs = lastAction(clouded.store)?.args ?? "{}"
    const cloudId = preparedId(clouded.store)
    expect((await clouded.controller.commands.run("triggers.approve", cloudArgs)).status).toBe("executed")
    await waitFor(() => registrationRun(clouded.store, cloudId)?.payload.phase === "failed")
    expect(registrationRun(clouded.store, cloudId)?.payload.error).toContain("trigger_approval_missing")
    expect(registrationRun(clouded.store, cloudId)?.payload.error).toContain(cloudRefusal)
  })

  /*
   * The other half of D3-N2: the preview is not the only door into the
   * approval. A carried payload that names no limits — one prepared before
   * this app asked for them — must stop at the app, before the plan is
   * approved and before Smithers Cloud is asked to record a receipt for an
   * envelope it will refuse.
   */
  test("an approval that names no finite limits never reaches the approval or Smithers Cloud", async () => {
    const calls: Array<RelayCall> = []
    const receipts: Array<unknown> = []
    const { store, controller } = await readyToRegister(
      watched(backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute(calls, workspaceAnswers({
          Plan: (payload) =>
            payload.flowId === "nightly-lint"
              ? okFrame({ ...PLAN, envelope: { ...PLAN.envelope, budget: {} } })
              : okFrame({ ...PLAN, planId: "plan-registrar", digest: "f".repeat(64), flowId: String(payload.flowId) })
        })),
        [APPROVAL]: async (request) => {
          receipts.push(await request.json())
          return json(200, { status: "ok", approvedAt: "2026-09-17T06:00:00Z", approvedBy: 1 })
        }
      }))
    )
    const requestId = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e"
    const carried = JSON.stringify({
      requestId, repo: "will/flows", flow: "nightly-lint", slug: "nightly", schedule: "0 9 * * 1-5",
      input: '{"label":"nightly"}', planId: "plan-1", planDigest: PLAN_DIGEST
    })
    expect((await controller.commands.run("triggers.approve", carried)).status).toBe("executed")
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "failed")
    expect(registrationRun(store, requestId)?.payload.error).toBe(unboundedFlowSentence("nightly-lint"))
    expect(receipts).toEqual([])
    expect(calls.map((call) => call.procedure)).toEqual(["List", "Plan"])
  })

  /* The same door, the same bound: a flow's own limit just over six hours is refused here too, so no approval row is written for it. */
  test("an approval whose flow declares more than the ceiling never reaches the approval or Smithers Cloud", async () => {
    const calls: Array<RelayCall> = []
    const receipts: Array<unknown> = []
    const { store, controller } = await readyToRegister(
      watched(backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute(calls, workspaceAnswers({
          Plan: (payload) =>
            payload.flowId === "nightly-lint"
              ? okFrame({ ...PLAN, envelope: { ...PLAN.envelope, budget: { tokens: 200_000, milliseconds: 21_600_001 } } })
              : okFrame({ ...PLAN, planId: "plan-registrar", digest: "f".repeat(64), flowId: String(payload.flowId) })
        })),
        [APPROVAL]: async (request) => {
          receipts.push(await request.json())
          return json(200, { status: "ok", approvedAt: "2026-09-17T06:00:00Z", approvedBy: 1 })
        }
      }))
    )
    const requestId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
    const carried = JSON.stringify({
      requestId, repo: "will/flows", flow: "nightly-lint", slug: "nightly", schedule: "0 9 * * 1-5",
      input: '{"label":"nightly"}', planId: "plan-1", planDigest: PLAN_DIGEST
    })
    expect((await controller.commands.run("triggers.approve", carried)).status).toBe("executed")
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "failed")
    expect(registrationRun(store, requestId)?.payload.error).toBe(overBoundFlowSentence("nightly-lint"))
    expect(receipts).toEqual([])
    expect(calls.map((call) => call.procedure)).toEqual(["List", "Plan"])
  })

  test("a plan that no longer reproduces refuses rather than registering something else", async () => {
    const calls: Array<RelayCall> = []
    let changed = false
    const { store, controller } = await readyToRegister(
      watched(backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute(calls, workspaceAnswers({ Plan: () => okFrame({ ...PLAN, digest: changed ? "a".repeat(64) : PLAN_DIGEST }) }))
      }))
    )
    await registrationResult(controller, REQUEST)
    const args = JSON.parse(lastAction(store)?.args ?? "{}") as Record<string, unknown>
    const requestId = preparedId(store)
    changed = true
    await controller.commands.run("triggers.approve", JSON.stringify(args))
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "failed")
    expect(registrationRun(store, requestId)?.payload.error).toContain("changed")
    expect(calls.filter((call) => call.procedure === "Run")).toEqual([])
  })
})

/*
 * The registration is slow work: the approve door answers at once, the shared
 * toast runs through the launch AND the registrar run, and the run the app
 * already knows how to watch carries the outcome (AGENTS.md, instant chat).
 */
describe("triggers seam: watching the registration run", () => {
  const ROUTES = (
    calls: Array<RelayCall>,
    run: HostRun,
    extra: Record<string, Route> = {},
    answers: Record<string, (payload: Record<string, unknown>) => unknown> = {}
  ) => watched(backend({
    [PROJECTION]: projectionDocument(DAY_ONE),
    [RPC]: relayRoute(calls, workspaceAnswers(answers, run)),
    [APPROVAL]: json(200, { status: "ok", approvedAt: "2026-09-17T06:00:00Z", approvedBy: 1 }),
    ...extra
  }))

  /** The registrar's own refusal, as the host writes it: one coded error, one sentence for the person. */
  const MODEL_REFUSAL = 'Add a model to "nightly-lint" to schedule it.'
  const DECLARED_INPUT =
    '"declared-input" declares an input schema the engine ignores (discovery warning unsupported_input_schema). Remove it: a trigger delivers your registered input to the flow as JSON, unvalidated.'
  /* The registrar's other code: the one it maps an unexpected failure to (flows/repository/triggers.ts:226). */
  const CRASH = "The schedule registration did not complete; inspect the retained run"
  const journalCause = (sentence: string, code = "invalid_receipt"): string =>
    `${code}: ${sentence}\n    at repository/trigger (flows/repository/triggers.ts:20)`

  const approved = async (store: AppStore, controller: Awaited<ReturnType<typeof ready>>["controller"]) => {
    await registrationResult(controller, REQUEST)
    const args = lastAction(store)?.args ?? "{}"
    const outcome = await controller.commands.run("triggers.approve", args)
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") expect(outcome.value).toBe("Registration requested for nightly on will/flows.")
    return String((JSON.parse(args) as Record<string, unknown>).requestId)
  }

  /*
   * The falsifier for every fake in this file: the run-summary shape below is
   * what the real gateway projects for a real registrar refusal, measured on
   * host 54db60f5 through GatewayProjection.runSummary. If the fake ever
   * drifts to a bare sentence, this fails.
   */
  test("the fake's verdict is what the real gateway projects: the code in front and 100 code points of it", () => {
    expect(hostVerdict(journalCause('Add a model to "nightly-check" to schedule it.')))
      .toBe('failed — invalid_receipt: Add a model to "nightly-check" to schedule it.')
    expect(hostVerdict(journalCause(DECLARED_INPUT)))
      .toBe('failed — invalid_receipt: "declared-input" declares an input schema the engine ignores (discovery warning un…')
  })

  /*
   * The registrar runs on the workspace gateway, so the watch has to read it
   * there. A card that records no box binds the pump to the repository's own
   * gateway (controller/workflow-pump.ts `const binding = { workspaceId }`),
   * which holds no run of this registration: the card would sit reconnecting
   * for ten minutes, then go quiet, and the person would be told the
   * registration is no longer being watched — while the schedule was
   * registered.
   */
  test("the run card records the box the registration was started on, and the watch reads that box", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    const { store, controller } = await readyToRegister(ROUTES(calls, run))
    const requestId = await approved(store, controller)
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "running")
    expect(registrationRun(store, requestId)?.payload.workspaceId).toBe(JOB_WORKSPACE)
    await waitFor(() => registrationToast(store)?.status === "running")
    await new Promise(resolve => setTimeout(resolve, 30))
    expect([...store.collections.toasts.values()].filter(t => t.status === "running")).toEqual([
      expect.objectContaining({ sourceCard: registrationRun(store, requestId)?.id })
    ])
    run.status = "completed"
    run.verdict = "Registered nightly on will/flows."
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "completed")
    /* The registration settles from the run the workspace holds, so the notice resolves as this schedule's. */
    await waitFor(() => registrationToast(store)?.status === "ok")
    expect([...new Set(calls.filter((call) => call.procedure === "Projection.Snapshot").map((call) => call.workspaceId))])
      .toEqual([JOB_WORKSPACE])
  })

  test("a run that settles failed shows the host's own sentence as this run's typed failure", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    const { store, controller } = await readyToRegister(ROUTES(calls, run))
    const requestId = await approved(store, controller)
    await waitFor(() => registrationToast(store)?.status === "running")
    run.cause = journalCause(MODEL_REFUSAL)
    run.status = "failed"
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "failed")
    expect(registrationRun(store, requestId)?.payload.error).toBe('failed — invalid_receipt: Add a model to "nightly-lint" to schedule it.')
    await waitFor(() => registrationToast(store)?.status === "failed")
    /* The host's own sentence, with no `failed — invalid_receipt:` in front of it. */
    expect(registrationToast(store)?.detail).toBe(MODEL_REFUSAL)
  })

  test("a refusal longer than the gateway's one line still reaches the person whole", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    const { store, controller } = await readyToRegister(ROUTES(calls, run))
    await approved(store, controller)
    await waitFor(() => registrationToast(store)?.status === "running")
    run.cause = journalCause(DECLARED_INPUT)
    run.status = "failed"
    await waitFor(() => registrationToast(store)?.status === "failed")
    expect(registrationToast(store)?.detail).toBe(DECLARED_INPUT)
  })

  test("the registrar's other code reaches the person as its sentence too, not as its code", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    const { store, controller } = await readyToRegister(ROUTES(calls, run))
    await approved(store, controller)
    await waitFor(() => registrationToast(store)?.status === "running")
    run.cause = journalCause(CRASH, "execution")
    run.status = "failed"
    await waitFor(() => registrationToast(store)?.status === "failed")
    expect(registrationToast(store)?.detail).toBe(CRASH)
  })

  test("a run that settles completed shows the registration the schedule now holds", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    const { store, controller } = await readyToRegister(
      ROUTES(calls, run, {
        [REGISTRATIONS]: json(200, {
          status: "ok", repo: "will/flows",
          rows: [{
            slug: "nightly", flowId: "nightly-lint", schedule: "0 9 * * 1-5", enabled: true, revision: 1,
            digest: "c".repeat(64), sourceRevision: "b".repeat(40), nextFireAt: "2026-09-18T09:00:00Z",
            registrationId: "registration-nightly"
          }]
        })
      })
    )
    const requestId = await approved(store, controller)
    await waitFor(() => registrationToast(store)?.status === "running")
    run.status = "completed"
    run.verdict = "Registered nightly on will/flows."
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "completed")
    await waitFor(() => registrationToast(store)?.status === "ok")
    await waitFor(() => triggerCard(store).payload.triggers.length === 1)
    /* The row carries the registration's own name too: it is what the Run now door fires. */
    expect(triggerCard(store).payload.triggers).toEqual([{
      id: "registration-nightly", slug: "nightly", flowId: "nightly-lint", cron: "0 9 * * 1-5", timezone: "UTC",
      enabled: true, nextFireAt: Date.parse("2026-09-18T09:00:00Z")
    }])
  })

  test("completed registration settles while its listing refresh is held", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    const refresh = Promise.withResolvers<Response>()
    const { store, controller } = await readyToRegister(ROUTES(calls, run, { [REGISTRATIONS]: () => refresh.promise }))
    try {
      const requestId = await approved(store, controller)
      await waitFor(() => registrationRun(store, requestId)?.payload.phase === "running")
      await waitFor(() => registrationToast(store)?.status === "running")
      run.status = "completed"
      await waitFor(() => registrationRun(store, requestId)?.payload.phase === "completed")
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(registrationToast(store)?.status).toBe("ok")
      expect([...store.collections.toasts.values()].filter(toast => toast.status === "running")).toEqual([])
    } finally { refresh.resolve(json(200, { status: "ok", rows: [] })) }
  })

  test("a failed listing refresh stays visible without reversing registration completion", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    let unavailable = false
    const { store, controller } = await readyToRegister(ROUTES(calls, run, {
      [PROJECTION]: () => unavailable ? json(503, { status: "error" }) : projectionDocument(DAY_ONE)
    }))
    const requestId = await approved(store, controller)
    await waitFor(() => registrationToast(store)?.status === "running")
    unavailable = true
    run.status = "completed"
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "completed")
    await waitFor(() => registrationToast(store)?.status === "ok")
    await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.key === "trigger.refresh.will/flows" && toast.status === "failed"))
    expect(registrationToast(store)?.status).toBe("ok")
    expect(store.collections.toasts.get("toast-trigger.refresh.will/flows")?.detail).toContain("The rules of will/flows couldn't be read")
  })

  test("a cancelled registration settles neutrally without refreshing the listing", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    let refreshes = 0
    const { store, controller } = await readyToRegister(ROUTES(calls, run, {
      [REGISTRATIONS]: () => { refreshes++; return json(200, { status: "ok", rows: [] }) }
    }))
    await approved(store, controller)
    await waitFor(() => registrationToast(store)?.status === "running")
    run.status = "cancelled"
    run.verdict = "Cancelled"
    await waitFor(() => registrationToast(store)?.status === "cancelled")
    expect(refreshes).toBe(0)
  })

  test("a run that never settles keeps the notice running, the card running, and chat usable", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(ROUTES(calls, { status: "running", verdict: "" }))
    const requestId = await approved(store, controller)
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "running")
    /* Chat and every unrelated door stay usable while the registration runs. */
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    expect(registrationToast(store)?.status).toBe("running")
    expect(registrationRun(store, requestId)?.payload.phase).toBe("running")
  })

  test("reload reconnects to the running registration instead of starting a second one", async () => {
    const calls: Array<RelayCall> = []
    const storage = memoryStorage()
    const run: HostRun = { status: "running", verdict: "" }
    const first = await readyToRegister(ROUTES(calls, run), await createAppStore({ kind: "localStorage", storage }))
    const requestId = await approved(first.store, first.controller)
    await waitFor(() => registrationRun(first.store, requestId)?.payload.phase === "running")
    await first.controller.dispose()

    run.status = "completed"
    run.verdict = "Registered nightly on will/flows."
    /* The reloaded page sets nothing up: the run card it read back names the box its watch has to read. */
    const resumed = await ready(ROUTES(calls, run), {
      signedIn: true, store: await createAppStore({ kind: "localStorage", storage })
    })
    resumed.controller.resumeWorkflowRuns()
    await waitFor(() => registrationRun(resumed.store, requestId)?.payload.phase === "completed")
    expect(calls.filter((call) => call.procedure === "Run")).toHaveLength(1)
    expect(registrationRun(resumed.store, requestId)?.payload.workspaceId).toBe(JOB_WORKSPACE)
  })

  test("a second press inside the launch window joins the attempt already running", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    let start = () => {}
    const held = new Promise<void>((resolve) => { start = resolve })
    const { store, controller } = await readyToRegister(
      ROUTES(calls, run, {}, { Run: async () => { await held; return okFrame({ runId: REGISTRAR_RUN }) } })
    )
    await registrationResult(controller, REQUEST)
    const args = lastAction(store)?.args ?? "{}"
    expect((await controller.commands.run("triggers.approve", args)).status).toBe("executed")
    await waitFor(() => calls.some((call) => call.procedure === "Run"))
    /* The button has no pressed state, and the launch window is six relayed round trips. */
    expect((await controller.commands.run("triggers.approve", args)).status).toBe("executed")
    start()
    run.status = "completed"
    run.verdict = "Registered nightly on will/flows."
    await waitFor(() => registrationToast(store)?.status === "ok")
    expect(calls.filter((call) => call.procedure === "Run")).toHaveLength(1)
  })

  test("a reload inside the launch window strands nothing, and the approve button still registers", async () => {
    const calls: Array<RelayCall> = []
    const storage = memoryStorage()
    const run: HostRun = { status: "running", verdict: "" }
    /* A launch the reload interrupts: this `Run` is never answered, as a closed tab's never is. */
    const unanswered = new Promise<never>(() => {})
    const first = await readyToRegister(
      ROUTES(calls, run, {}, { Run: () => unanswered }),
      await createAppStore({ kind: "localStorage", storage })
    )
    await registrationResult(first.controller, REQUEST)
    const args = lastAction(first.store)?.args ?? "{}"
    const requestId = String((JSON.parse(args) as Record<string, unknown>).requestId)
    expect((await first.controller.commands.run("triggers.approve", args)).status).toBe("executed")
    await waitFor(() => calls.some((call) => call.procedure === "Run"))
    await first.controller.dispose()

    const resumed = await ready(ROUTES(calls, run), {
      signedIn: true, store: await createAppStore({ kind: "localStorage", storage })
    })
    resumed.controller.resumeWorkflowRuns()
    /* Reload resumes the saved request; repeated approval joins that same launch. */
    expect(workflowLaunchOf(registrationRun(resumed.store, requestId))?.triggerRegistration?.requestId).toBe(requestId)
    /* The press the reloaded page offers is the same prepared registration, so a person presses what they see. */
    const reloaded = lastAction(resumed.store)?.args
    expect(reloaded).toBe(args)
    expect((await resumed.controller.commands.run("triggers.approve", reloaded ?? "{}")).status).toBe("executed")
    run.status = "completed"
    run.verdict = "Registered nightly on will/flows."
    await waitFor(() => registrationRun(resumed.store, requestId)?.payload.phase === "completed")
    /* The retry carries the attempt's own key, so the workspace can refuse a second run of the same registration. */
    expect(calls.filter((call) => call.procedure === "Run").map((call) => call.payload.idempotencyKey))
      .toEqual([`trigger:${requestId}:register-run`, `trigger:${requestId}:register-run`])
  })
})

describe("triggers seam: listing and pausing a schedule", () => {
  const ROWS = {
    status: "ok",
    repo: "will/flows",
    rows: [{
      slug: "nightly", flowId: "nightly-lint", schedule: "0 9 * * 1-5", enabled: true, revision: 1,
      digest: "c".repeat(64), sourceRevision: "b".repeat(40), nextFireAt: "2026-09-18T09:00:00Z",
      registrationId: "registration-nightly"
    }]
  }

  test("the dispatcher lists the registered schedule beside the box's own rows", async () => {
    const { store, controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [LIVE]: json(200, { status: "ok", repo: "will/flows", live: true, triggers: [{ id: "sweep", flowId: "issue", cron: "*/15 * * * *", enabled: false }], webhooks: [] }),
        [REGISTRATIONS]: json(200, ROWS)
      }),
      { signedIn: true }
    )
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    const card = triggerCard(store)
    expect(card.payload.live).toBe(true)
    expect(card.payload.triggers).toEqual([
      { id: "sweep", flowId: "issue", cron: "*/15 * * * *", enabled: false },
      {
        id: "registration-nightly", slug: "nightly", flowId: "nightly-lint", cron: "0 9 * * 1-5", timezone: "UTC",
        enabled: true, nextFireAt: Date.parse("2026-09-18T09:00:00Z")
      }
    ])
  })

  test("a repository with no registrations and no box is not listening", async () => {
    /* Smithers Cloud answers 200 [] for every repository, which is the shape every signed-in user meets on day one. */
    const { store, controller } = await ready(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [REGISTRATIONS]: json(200, { status: "ok", repo: "will/flows", rows: [] }) }),
      { signedIn: true }
    )
    const outcome = await controller.commands.run("triggers.list")
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") expect(outcome.value).not.toContain("listening")
    await settled()
    expect(triggerCard(store).payload).toEqual({ repo: "will/flows", declared: DAY_ONE.on, live: false, triggers: [], webhooks: [] })
  })

  test("a registrations route that did not answer leaves the declaration and the box alone", async () => {
    const { store, controller } = await ready(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [REGISTRATIONS]: json(502, { message: "gateway down" }) }),
      { signedIn: true }
    )
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    expect(triggerCard(store).payload).toEqual({ repo: "will/flows", declared: DAY_ONE.on, live: false, triggers: [], webhooks: [] })
  })

  test("pause stops the schedule through the Worker and re-reads the listing; a refusal stays the refusing party's", async () => {
    const seen: Array<string> = []
    const paused: Array<unknown> = []
    const { controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [REGISTRATIONS]: json(200, { ...ROWS, rows: [{ ...ROWS.rows[0], enabled: false }] }),
        [PAUSE]: async (request) => {
          paused.push(await request.json())
          return json(200, { status: "ok", paused: 1 })
        }
      }, seen),
      { signedIn: true }
    )
    const outcome = await controller.registerTrigger({ operation: "pause", repo: "will/flows", slug: "nightly" })
    expect(typeof outcome).toBe("object")
    await waitFor(() => seen.some(path => path.startsWith(REGISTRATIONS)))
    expect(paused).toEqual([{ repo: "will/flows", slug: "nightly" }])
    expect(seen.filter((path) => path.startsWith(REGISTRATIONS))).toHaveLength(1)

    const refused = await ready(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [PAUSE]: json(404, { status: "error", code: "upstream_refused", message: "unknown repository job" }) }),
      { signedIn: true }
    )
    const answer = await refused.controller.registerTrigger({ operation: "pause", repo: "will/flows", slug: "nightly" })
    expect(answer).toEqual({ value: "Pause requested for nightly on will/flows." })
    await waitFor(() => triggerCard(refused.store).payload.pauseRequests?.[0]?.phase === "failed")
    expect(triggerCard(refused.store).payload.pauseRequests?.[0]?.error).toContain("unknown repository job")
  })

  test("a pause that stopped nothing says so instead of saying paused", async () => {
    const seen: Array<string> = []
    const { store, controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [PAUSE]: json(200, { status: "ok", paused: 0 })
      }, seen),
      { signedIn: true }
    )
    const outcome = await controller.registerTrigger({ operation: "pause", repo: "will/flows", slug: "no-such-schedule" })
    expect(outcome).toEqual({ value: "Pause requested for no-such-schedule on will/flows." })
    await waitFor(() => triggerCard(store).payload.pauseRequests?.[0]?.phase === "failed")
    expect(triggerCard(store).payload.pauseRequests?.[0]?.error).toBe('No schedule "no-such-schedule" is registered on will/flows.')
    expect(seen.filter((path) => path.startsWith(REGISTRATIONS))).toEqual([])
  })

  /*
   * Canary D-3: the sentence above was returned and never read. A returned
   * string surfaces only as the command-failure toast, which states itself
   * and dismisses after four seconds, so a person who pressed a consequential
   * door and looked away saw nothing at all. The transcript is the durable
   * half of the answer, so the door writes it there itself.
   */
  test("a pause that stopped nothing states it in the transcript, not only on a toast", async () => {
    const { store, controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [PAUSE]: json(200, { status: "ok", paused: 0 })
      }),
      { signedIn: true }
    )
    await controller.registerTrigger({ operation: "pause", repo: "will/flows", slug: "canary-never-registered" })
    await settled()
    expect([...store.collections.messages.values()].map((message) => message.text))
      .toContain('No schedule "canary-never-registered" is registered on will/flows.')
  })

  /*
   * Canary W1 item 3a, receipt `W1-13-triggers-pause-submitted.png` and
   * `W1-e-triggers-register.json` `L92-tokensCards`: the pause form card read
   *
   *   Pause a schedule / Repo / Slug / Cancel / Submit
   *   No schedule "canary-w1-not-registered" is registered on codeplanesmithers/canary-sandbox.
   *
   * with the same sentence standing in the transcript above it. The transcript
   * line is the durable half the door writes on purpose; the card underneath
   * was the form repeating it back.
   */
  test("a refusal the door already said in the transcript is not repeated on its form card", async () => {
    const { store, controller } = await ready(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [PAUSE]: json(200, { status: "ok", paused: 0 }) }),
      { signedIn: true }
    )
    const sentence = 'No schedule "canary-w1-not-registered" is registered on will/flows.'
    expect((await controller.commands.run("triggers.pause")).status).toBe("form")
    const cardId = "form-triggers.pause"
    await controller.runCommand("form.set", flowArgs("form.set", { cardId, field: "repo", value: "will/flows" }))
    await controller.runCommand("form.set", flowArgs("form.set", { cardId, field: "slug", value: "canary-w1-not-registered" }))
    await controller.runCommand("form.submit", cardId)
    await settled()
    const card = store.collections.cards.get(cardId)
    const said = [...store.collections.messages.values()].filter((message) => message.text === sentence)
    expect(said.map((message) => message.text)).toEqual([sentence])
    /* The door's own mark, which is what the form card yields to. */
    expect(said.map((message) => message.spoken)).toEqual([true])
    expect(card?.kind === "flow-form" ? card.payload.error : "no card").toBeUndefined()
  })

  test("Pause acknowledges a persisted request, deduplicates, and settles before its listing refresh", async () => {
    const pause = Promise.withResolvers<Response>()
    const listing = Promise.withResolvers<Response>()
    let writes = 0
    let reads = 0
    const { store, controller } = await ready({ ...watched(backend({
      [PROJECTION]: projectionDocument(DAY_ONE),
      [REGISTRATIONS]: () => { reads += 1; return reads === 1 ? json(200, ROWS) : listing.promise },
      [PAUSE]: () => { writes += 1; return pause.promise }
    })), toastDebounceMs: 300 }, { signedIn: true })
    try {
      await controller.listTriggers("will/flows")
      const command = controller.commands.run("triggers.pause", flowArgs("triggers.pause", { slug: "nightly", repo: "will/flows" }))
      expect((await Promise.race([command, new Promise(resolve => setTimeout(() => resolve("blocked"), 100))]))).toMatchObject({ status: "executed" })
      await waitFor(() => writes === 1)
      expect(triggerCard(store).payload.pauseRequests?.[0]?.phase).toBe("sending")
      await controller.commands.run("triggers.pause", flowArgs("triggers.pause", { slug: "nightly", repo: "will/flows" }))
      expect(writes).toBe(1)
      await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.title === "Pausing nightly"))
      const toast = [...store.collections.toasts.values()].find(toast => toast.title === "Pausing nightly")!
      expect(toast.status).toBe("running")
      pause.resolve(json(200, { status: "ok", paused: 1 }))
      await waitFor(() => store.collections.toasts.get(toast.id)?.status === "ok")
      expect(triggerCard(store).payload.triggers.find(row => row.slug === "nightly")?.enabled).toBe(false)
      expect(reads).toBe(2)
    } finally {
      pause.resolve(json(200, { status: "ok", paused: 1 }))
      listing.resolve(json(200, { ...ROWS, rows: ROWS.rows.map(row => ({ ...row, enabled: false })) }))
      await controller.dispose()
    }
  })

  test.each([false, true])("reload observes interrupted Pause without replaying it (enabled=%s)", async enabled => {
    const storage = memoryStorage()
    const held = Promise.withResolvers<Response>()
    let writes = 0
    const first = await ready(watched(backend({ [PAUSE]: () => { writes += 1; return held.promise } })), {
      signedIn: true, store: await createAppStore({ kind: "localStorage", storage })
    })
    await first.controller.registerTrigger({ operation: "pause", repo: "will/flows", slug: "nightly" })
    await waitFor(() => writes === 1)
    const id = triggerCard(first.store).payload.pauseRequests![0]!.id
    await first.controller.dispose()
    await first.store.dispose?.()
    const resumed = await ready(watched(backend({
      [PROJECTION]: projectionDocument(DAY_ONE),
      [REGISTRATIONS]: json(200, { ...ROWS, rows: ROWS.rows.map(row => ({ ...row, enabled })) }),
      [PAUSE]: () => { writes += 1; return json(200, { status: "ok", paused: 1 }) }
    })), { signedIn: true, store: await createAppStore({ kind: "localStorage", storage }) })
    try {
      await waitFor(() => triggerCard(resumed.store).payload.pauseRequests?.[0]?.phase === (enabled ? "failed" : "completed"))
      expect(triggerCard(resumed.store).payload.pauseRequests?.[0]?.id).toBe(id)
      expect(writes).toBe(1)
      if (enabled) {
        await resumed.controller.registerTrigger({ operation: "pause", repo: "will/flows", slug: "nightly" })
        await waitFor(() => writes === 2)
        await waitFor(() => triggerCard(resumed.store).payload.pauseRequests?.[0]?.phase === "completed")
      }
    } finally { held.resolve(json(200, { status: "ok", paused: 1 })); await resumed.controller.dispose() }
  })

  test.each([undefined, -1, 0.5])("Pause requires an actual receipt (count=%s)", async paused => {
    const { store, controller } = await ready(watched(backend({ [PAUSE]: json(200, { status: "ok", paused }) })), { signedIn: true })
    await controller.registerTrigger({ operation: "pause", repo: "will/flows", slug: "nightly" })
    await waitFor(() => triggerCard(store).payload.pauseRequests?.[0]?.phase === "failed")
    expect(triggerCard(store).payload.pauseRequests?.[0]?.error).toBe("Smithers Cloud did not confirm Pause.")
    await controller.dispose()
  })

  test("a late Pause receipt cannot restore an account's card after sign-out", async () => {
    const held = Promise.withResolvers<Response>()
    let sent = false
    const { store, controller } = await ready(watched(backend({ [PAUSE]: () => { sent = true; return held.promise } })), { signedIn: true })
    await controller.registerTrigger({ operation: "pause", repo: "will/flows", slug: "nightly" })
    await waitFor(() => sent)
    await signedOut(store)
    held.resolve(json(200, { status: "ok", paused: 1 }))
    await settled()
    expect([...store.collections.cards.values()].some(card => card.kind === "trigger-list" && card.payload.pauseRequests?.some(row => row.phase === "completed"))).toBe(false)
    expect([...store.collections.toasts.values()].some(toast => toast.title === "Paused nightly")).toBe(false)
    await controller.dispose()
  })

  test("Pause still records its HTTP receipt after the workspace signs out", async () => {
    const held = Promise.withResolvers<Response>()
    let sent = false
    const { store, controller } = await ready(watched(backend({ [PAUSE]: () => { sent = true; return held.promise } })), { signedIn: true })
    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null }).isPersisted.promise
    await controller.registerTrigger({ operation: "pause", repo: "will/flows", slug: "nightly" })
    await waitFor(() => sent)
    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-out", username: null, expiresAt: null, scopes: null }).isPersisted.promise
    held.resolve(json(200, { status: "ok", paused: 1 }))
    await waitFor(() => triggerCard(store).payload.pauseRequests?.[0]?.phase === "completed")
    await controller.dispose()
  })

  test.each(["requested", "sending", "completed"])("a failed %s commit cannot claim a saved Pause", async phase => {
    const original = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let rejected = false
    let writes = 0
    const store: AppStore = { ...original, dispatch: transition => {
      if (!rejected && transition.type === "card.upsert" && transition.card.kind === "trigger-list"
        && transition.card.payload.pauseRequests?.some(request => request.phase === phase)) {
        rejected = true
        return { isPersisted: { promise: Promise.reject(new Error("disk full")) } } as ReturnType<AppStore["dispatch"]>
      }
      return original.dispatch(transition)
    } }
    const { controller } = await ready(watched(backend({ [PAUSE]: () => { writes += 1; return json(200, { status: "ok", paused: 1 }) } })), { signedIn: true, store })
    const answer = await controller.registerTrigger({ operation: "pause", repo: "will/flows", slug: "nightly" })
    if (phase === "requested") expect(answer).toBe("Could not save Pause. Retry.")
    else await waitFor(() => triggerCard(store).payload.pauseRequests?.[0]?.phase === "failed")
    expect(writes).toBe(phase === "completed" ? 1 : 0)
    await waitFor(() => [...store.collections.messages.values()].some(message => message.text === "Could not save Pause. Retry."))
    await controller.dispose()
  })

  test("a listing started before Pause cannot restore its enabled row", async () => {
    const stale = Promise.withResolvers<Response>()
    const refresh = Promise.withResolvers<Response>()
    let reads = 0
    const { store, controller } = await ready(watched(backend({
      [PROJECTION]: projectionDocument(DAY_ONE),
      [REGISTRATIONS]: () => { reads += 1; return reads === 1 ? json(200, ROWS) : reads === 2 ? stale.promise : refresh.promise },
      [PAUSE]: json(200, { status: "ok", paused: 1 })
    })), { signedIn: true })
    try {
      await controller.listTriggers("will/flows")
      const oldRead = controller.listTriggers("will/flows")
      await waitFor(() => reads === 2)
      await controller.registerTrigger({ operation: "pause", repo: "will/flows", slug: "nightly" })
      await waitFor(() => triggerCard(store).payload.pauseRequests?.[0]?.phase === "completed")
      stale.resolve(json(200, ROWS))
      await oldRead
      expect(triggerCard(store).payload.triggers.find(row => row.slug === "nightly")?.enabled).toBe(false)
    } finally {
      stale.resolve(json(200, ROWS))
      refresh.resolve(json(200, { ...ROWS, rows: ROWS.rows.map(row => ({ ...row, enabled: false })) }))
      await controller.dispose()
    }
  })

  test("the pause door is the agent's to ask for and the human's to confirm", async () => {
    const { store, controller } = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE) }), { signedIn: true })
    const asked = await controller.commands.runForAgent("triggers.pause", JSON.stringify({ repo: "will/flows", slug: "nightly" }))
    expect(asked.status).toBe("executed")
    expect(lastAction(store)?.flow).toBe("triggers.pause")
  })
})

/*
 * "Run now": the manual dispatch of a schedule that is already registered.
 * The host has carried the operation since d492503f4403 — `repository/trigger`
 * with `operation: "fire"` reads the registration's own revision and digest
 * and asks Smithers Cloud to enqueue one dispatch of it — while the app had no
 * door to reach it: the canary walk's `/triggers.fire` and `/triggers.run`
 * both answered "There is no /triggers.run flow." (D-REPORT part 1, "Run now,
 * twice", receipt D-14-doors.json).
 */
describe("triggers seam: running a registered schedule now", () => {
  const REGISTERED = {
    status: "ok",
    repo: "will/flows",
    rows: [{
      slug: "nightly", flowId: "nightly-lint", schedule: "0 9 * * 1-5", enabled: true, revision: 1,
      digest: "c".repeat(64), sourceRevision: "b".repeat(40), nextFireAt: "2026-09-18T09:00:00Z",
      registrationId: "registration-nightly"
    }]
  }

  const ROUTES = (calls: Array<RelayCall>, run: HostRun = { status: "running", verdict: "" }, rows: unknown = REGISTERED) =>
    watched(backend({
      [PROJECTION]: projectionDocument(DAY_ONE),
      [REGISTRATIONS]: json(200, rows),
      [RPC]: relayRoute(calls, workspaceAnswers({}, run))
    }))

  const dispatchCards = (store: AppStore) =>
    [...store.collections.cards.values()].filter((card) => workflowLaunchOf(card)?.triggerDispatch !== undefined)
      .flatMap((card) => card.kind === "run-trace" ? [card] : [])

  test("the door dispatches the registered schedule through the registrar's fire operation, and the run card carries it", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    const { store, controller } = await readyToRegister(ROUTES(calls, run))
    const outcome = await controller.commands.run("triggers.run", "nightly will/flows")
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") expect(outcome.value).toBe("Requested nightly on will/flows.")
    await waitFor(() => calls.some((call) => call.procedure === "Run"))
    const planned = calls.find((call) => call.procedure === "Plan")
    expect(planned?.payload).toMatchObject({
      flowId: "repository/trigger",
      input: { operation: "fire", repo: "will/flows", slug: "nightly", flow: "nightly-lint", schedule: "0 9 * * 1-5" }
    })
    /* The registrar runs on the box the repository's reviewed jobs run on, as every other relayed call does. */
    expect([...new Set(calls.map((call) => call.workspaceId))]).toEqual([JOB_WORKSPACE])
    await waitFor(() => dispatchCards(store)[0]?.payload.phase === "running")
    const card = dispatchCards(store)[0]
    expect(card?.payload.runId).toBe(REGISTRAR_RUN)
    expect(card?.title).toBe("Run nightly · will/flows")
    await new Promise(resolve => setTimeout(resolve, 30))
    const running = [...store.collections.toasts.values()].filter(t => t.status === "running")
    expect(running).toEqual([expect.objectContaining({ sourceCard: card?.id })])
    run.status = "completed"
    run.verdict = "Dispatched nightly on will/flows."
    await waitFor(() => store.collections.toasts.get(running[0]!.id)?.status === "ok")
  })

  test("Run now acknowledges before lookup and keeps one toast through execution", async () => {
    const calls: Array<RelayCall> = []
    const lookup = Promise.withResolvers<Response>()
    const run: HostRun = { status: "running", verdict: "" }
    const { store, controller } = await readyToRegister({ ...watched(backend({
      [PROJECTION]: projectionDocument(DAY_ONE),
      [REGISTRATIONS]: () => lookup.promise,
      [RPC]: relayRoute(calls, workspaceAnswers({}, run))
    })), toastDebounceMs: 300 })
    let answered = false
    const request = controller.commands.run("triggers.run", "nightly will/flows").then(outcome => { answered = true; return outcome })
    try {
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(answered).toBe(true)
      expect((await request).status).toBe("executed")
      expect(calls).toEqual([])
      expect(store.collections.toasts.size).toBe(0)
      expect(dispatchCards(store)[0]?.payload.phase).toBe("launching")
      await store.dispatch({ type: "composer.changed", actor: "user", draft: "still chatting" }).isPersisted.promise
      expect(store.session().draft).toBe("still chatting")
      await waitFor(() => store.collections.toasts.size === 1)
      const toast = [...store.collections.toasts.values()][0]!
      expect(toast.sourceCard).toBe(dispatchCards(store)[0]?.id)
      expect(toast.status).toBe("running")
      lookup.resolve(json(200, REGISTERED))
      await waitFor(() => dispatchCards(store)[0]?.payload.runId === REGISTRAR_RUN)
      expect(store.collections.toasts.size).toBe(1)
      expect(store.collections.toasts.get(toast.id)?.status).toBe("running")
      run.status = "completed"
      await waitFor(() => store.collections.toasts.get(toast.id)?.status === "ok")
    } finally { lookup.resolve(json(200, REGISTERED)); await request }
  })

  test("Resume acknowledges held lookup, deduplicates through preparation, and settles with execution", async () => {
    const calls: Array<RelayCall> = []
    const lookup = Promise.withResolvers<Response>()
    const paused = { ...REGISTERED, rows: REGISTERED.rows.map(row => ({ ...row, enabled: false })) }
    const run: HostRun = { status: "running", verdict: "" }
    const { store, controller } = await readyToRegister({ ...watched(backend({
      [PROJECTION]: projectionDocument(DAY_ONE),
      [REGISTRATIONS]: () => lookup.promise.then(response => response.clone()),
      [RPC]: relayRoute(calls, workspaceAnswers({}, run))
    })), toastDebounceMs: 300 })
    try {
      const outcome = await Promise.race([
        controller.commands.run("triggers.resume", "nightly will/flows"),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Resume waited for lookup")), 100))
      ])
      expect(outcome.status).toBe("executed")
      await controller.commands.run("triggers.resume", "nightly will/flows")
      expect(calls).toEqual([])
      expect(dispatchCards(store)).toHaveLength(1)
      await store.dispatch({ type: "composer.changed", actor: "user", draft: "still chatting" }).isPersisted.promise
      expect(store.session().draft).toBe("still chatting")
      await waitFor(() => store.collections.toasts.size === 1)
      const toast = [...store.collections.toasts.values()][0]!
      expect(toast.status).toBe("running")
      lookup.resolve(json(200, paused))
      await waitFor(() => dispatchCards(store)[0]?.payload.phase === "running")
      await controller.commands.run("triggers.resume", "nightly will/flows")
      expect(dispatchCards(store)).toHaveLength(1)
      expect(calls.filter(call => call.procedure === "Run")).toHaveLength(1)
      expect(calls.find(call => call.procedure === "Plan")?.payload).toMatchObject({
        flowId: "repository/trigger", input: { operation: "resume", slug: "nightly", flow: "nightly-lint", schedule: "0 9 * * 1-5" }
      })
      expect(dispatchCards(store)[0]?.title).toBe("Resume nightly · will/flows")
      expect(store.collections.toasts.get(toast.id)?.status).toBe("running")
      run.status = "completed"
      await waitFor(() => store.collections.toasts.get(toast.id)?.status === "ok")
    } finally { lookup.resolve(json(200, paused)) }
  })

  test("a stale Run now request refuses the paused lookup and retries after resume", async () => {
    const calls: Array<RelayCall> = []
    const lookup = Promise.withResolvers<Response>()
    let enabled = false
    const { store, controller } = await readyToRegister(watched(backend({
      [PROJECTION]: projectionDocument(DAY_ONE),
      [REGISTRATIONS]: () => enabled ? json(200, REGISTERED) : lookup.promise,
      [RPC]: relayRoute(calls, workspaceAnswers())
    })))
    let answered = false
    const command = controller.commands.run("triggers.run", "nightly will/flows").then(outcome => { answered = true; return outcome })
    try {
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(answered).toBe(true)
      expect((await command).status).toBe("executed")
      expect(calls).toEqual([])
      await store.dispatch({ type: "composer.changed", actor: "user", draft: "still chatting" }).isPersisted.promise
      expect(store.session().draft).toBe("still chatting")
      lookup.resolve(json(200, { ...REGISTERED, rows: REGISTERED.rows.map(row => ({ ...row, enabled: false })) }))
      await waitFor(() => dispatchCards(store)[0]?.payload.phase === "failed")
      const card = dispatchCards(store)[0]!
      const original = workflowLaunchOf(card)!
      expect(original.error?.code).toBe("trigger_paused")
      expect(card.payload.error).toBe('Resume "nightly" before running it.')
      expect(calls).toEqual([])
      await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.sourceCard === card.id && toast.status === "failed"))
      enabled = true
      await controller.commands.run("flow.run.retry", card.id)
      await waitFor(() => dispatchCards(store)[0]?.payload.runId === REGISTRAR_RUN)
      expect(workflowLaunchOf(dispatchCards(store)[0])?.id).toBe(original.id)
      expect(calls.filter(call => call.procedure === "Run")).toHaveLength(1)
      expect(calls.find(call => call.procedure === "Plan")?.payload.input).toMatchObject({ requestId: original.input.requestId })
    } finally { lookup.resolve(json(200, REGISTERED)); await command }
  })

  test("Resume refuses a schedule that was already enabled before lookup completed", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(ROUTES(calls))
    await controller.commands.run("triggers.resume", "nightly will/flows")
    await waitFor(() => dispatchCards(store)[0]?.payload.phase === "failed")
    expect(calls.some(call => call.procedure === "Run")).toBe(false)
    expect(workflowLaunchOf(dispatchCards(store)[0])?.error?.message).toMatch(/already enabled/)
  })

  for (const command of ["triggers.run", "triggers.resume"] as const) for (const interrupted of ["lookup", "launch"] as const) test(`${command}: reload during ${interrupted} reconnects the same dispatch request`, async () => {
    const registered = { ...REGISTERED, rows: REGISTERED.rows.map(row => ({ ...row, enabled: command !== "triggers.resume" })) }
    const storage = memoryStorage()
    const calls: Array<RelayCall> = []
    const held = Promise.withResolvers<void>()
    let reading = false
    const first = await readyToRegister(watched(backend({
      [PROJECTION]: projectionDocument(DAY_ONE),
      [REGISTRATIONS]: async () => { reading = true; if (interrupted === "lookup") await held.promise; return json(200, registered) },
      [RPC]: relayRoute(calls, workspaceAnswers({ Run: async () => { await held.promise; return okFrame({ runId: REGISTRAR_RUN }) } }))
    })), await createAppStore({ kind: "localStorage", storage }))
    await first.controller.commands.run(command, "nightly will/flows")
    await waitFor(() => interrupted === "lookup" ? reading : calls.some(call => call.procedure === "Run"))
    const original = workflowLaunchOf(dispatchCards(first.store)[0])!
    await first.controller.dispose()
    await first.store.dispose?.()
    const nextRows = interrupted === "launch" ? { ...registered, rows: registered.rows.map(row => ({ ...row, flowId: "changed-after-launch" })) } : registered
    const resumed = await ready(ROUTES(calls, { status: "running", verdict: "" }, nextRows), {
      signedIn: true, store: await createAppStore({ kind: "localStorage", storage })
    })
    try {
      await waitFor(() => dispatchCards(resumed.store)[0]?.payload.runId === REGISTRAR_RUN)
      const request = workflowLaunchOf(dispatchCards(resumed.store)[0])!
      expect(request.id).toBe(original.id)
      expect(request.input.requestId).toBe(original.input.requestId)
      expect(request.input.flow).toBe("nightly-lint")
      expect(dispatchCards(resumed.store)).toHaveLength(1)
      const plans = calls.filter(call => call.procedure === "Plan")
      expect(plans).toHaveLength(interrupted === "launch" ? 2 : 1)
      expect(new Set(plans.map(call => call.payload.idempotencyKey)).size).toBe(1)
      expect(new Set(calls.filter(call => call.procedure === "Run").map(call => call.payload.idempotencyKey)).size).toBe(1)
      if (interrupted === "launch") expect(plans[0]?.payload.input).toEqual(plans[1]?.payload.input)
      held.resolve()
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(calls.filter(call => call.procedure === "Run")).toHaveLength(interrupted === "launch" ? 2 : 1)
    } finally { held.resolve() }
  })

  test("a failed lookup is visible and Retry retains the dispatch identity", async () => {
    const calls: Array<RelayCall> = []
    let available = false
    const { store, controller } = await readyToRegister(watched(backend({
      [PROJECTION]: projectionDocument(DAY_ONE),
      [REGISTRATIONS]: () => available ? json(200, REGISTERED) : json(503, { status: "error" }),
      [RPC]: relayRoute(calls, workspaceAnswers())
    })))
    await controller.commands.run("triggers.run", "nightly will/flows")
    await waitFor(() => dispatchCards(store)[0]?.payload.phase === "failed")
    const card = dispatchCards(store)[0]!
    const original = workflowLaunchOf(card)!
    expect(original.error?.code).toBe("trigger_lookup_unavailable")
    expect(card.payload.error).toBe("The schedules could not be read. Retry the request.")
    expect(calls).toEqual([])
    available = true
    expect((await controller.commands.run("flow.run.retry", card.id)).status).toBe("executed")
    await waitFor(() => dispatchCards(store)[0]?.payload.runId === REGISTRAR_RUN)
    expect(workflowLaunchOf(dispatchCards(store)[0])?.id).toBe(original.id)
    expect(calls.find(call => call.procedure === "Plan")?.payload.input).toMatchObject({ requestId: original.input.requestId })
    expect(dispatchCards(store)).toHaveLength(1)
  })

  test("retrying a refused launch keeps its pinned registration and launch key", async () => {
    const calls: Array<RelayCall> = []
    let refused = true, lookups = 0
    const { store, controller } = await readyToRegister(watched(backend({
      [PROJECTION]: projectionDocument(DAY_ONE),
      [REGISTRATIONS]: () => { lookups++; return json(200, refused ? REGISTERED : { ...REGISTERED, rows: [] }) },
      [RPC]: relayRoute(calls, workspaceAnswers({ Plan: () => refused ? refusedFrame("Workspace unavailable") : okFrame(PLAN) }))
    })))
    await controller.commands.run("triggers.run", "nightly will/flows")
    await waitFor(() => dispatchCards(store)[0]?.payload.phase === "failed")
    const card = dispatchCards(store)[0]!
    expect(card.payload.error).toBe("Workspace unavailable")
    refused = false
    await controller.commands.run("flow.run.retry", card.id)
    await waitFor(() => dispatchCards(store)[0]?.payload.runId === REGISTRAR_RUN)
    const plans = calls.filter(call => call.procedure === "Plan")
    expect(plans).toHaveLength(2)
    expect(plans[0]?.payload).toEqual(plans[1]?.payload)
    expect(lookups).toBe(1)
    expect(calls.filter(call => call.procedure === "Run")).toHaveLength(1)
    await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.sourceCard === card.id && toast.status === "running"))
    expect([...store.collections.toasts.values()].filter(toast => toast.sourceCard === card.id)).toHaveLength(1)
  })

  test("a late lookup cannot launch a dispatch after sign-out", async () => {
    const calls: Array<RelayCall> = []
    const lookup = Promise.withResolvers<Response>()
    let reading = false
    const { store, controller } = await readyToRegister(watched(backend({
      [PROJECTION]: projectionDocument(DAY_ONE),
      [REGISTRATIONS]: () => { reading = true; return lookup.promise },
      [RPC]: relayRoute(calls, workspaceAnswers())
    })))
    await controller.commands.run("triggers.run", "nightly will/flows")
    await waitFor(() => reading)
    await signedOut(store)
    lookup.resolve(json(200, REGISTERED))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toEqual([])
    expect(dispatchCards(store)).toEqual([])
  })

  test("completed dispatch settles even when its listing refresh never answers", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    const refresh = Promise.withResolvers<Response>()
    let reads = 0
    const { store, controller } = await readyToRegister(watched(backend({
      [PROJECTION]: projectionDocument(DAY_ONE),
      [REGISTRATIONS]: () => ++reads === 1 ? json(200, REGISTERED) : refresh.promise,
      [RPC]: relayRoute(calls, workspaceAnswers({}, run))
    })))
    try {
      await controller.commands.run("triggers.run", "nightly will/flows")
      await waitFor(() => dispatchCards(store)[0]?.payload.phase === "running")
      await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.sourceCard === dispatchCards(store)[0]?.id))
      const toast = [...store.collections.toasts.values()].find(toast => toast.sourceCard === dispatchCards(store)[0]?.id)!
      run.status = "completed"
      await waitFor(() => dispatchCards(store)[0]?.payload.phase === "completed")
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(store.collections.toasts.get(toast.id)?.status).toBe("ok")
    } finally { refresh.resolve(json(200, REGISTERED)) }
  })

  test("two presses dispatch twice", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(ROUTES(calls))
    expect((await controller.commands.run("triggers.run", "nightly will/flows")).status).toBe("executed")
    await waitFor(() => calls.filter((call) => call.procedure === "Run").length === 1)
    expect((await controller.commands.run("triggers.run", "nightly will/flows")).status).toBe("executed")
    await waitFor(() => calls.filter((call) => call.procedure === "Run").length === 2)
    const keys = calls.filter((call) => call.procedure === "Run").map((call) => String(call.payload.idempotencyKey))
    expect(new Set(keys).size).toBe(2)
    await waitFor(() => dispatchCards(store).length === 2)
    await new Promise(resolve => setTimeout(resolve, 30))
    const running = [...store.collections.toasts.values()].filter(t => t.status === "running")
    expect(running).toHaveLength(2)
    expect(new Set(running.map(t => t.sourceCard))).toEqual(new Set(dispatchCards(store).map(c => c.id)))
  })

  test("a cancelled dispatch resolves its only toast neutrally", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    const { store, controller } = await readyToRegister(ROUTES(calls, run))
    await controller.commands.run("triggers.run", "nightly will/flows")
    await waitFor(() => dispatchCards(store)[0]?.payload.phase === "running")
    await new Promise(resolve => setTimeout(resolve, 30))
    const toast = [...store.collections.toasts.values()].find(t => t.sourceCard === dispatchCards(store)[0]?.id)!
    expect(toast).toBeDefined()
    run.status = "cancelled"
    run.verdict = "Cancelled"
    await waitFor(() => store.collections.toasts.get(toast.id)?.status !== "running")
    expect([...store.collections.toasts.values()].filter(t => t.sourceCard === toast.sourceCard))
      .toEqual([expect.objectContaining({ status: "cancelled" })])
    expect([...store.collections.toasts.values()].filter(t => t.status === "failed")).toEqual([])
  })

  test("a name no schedule holds is retained as a background failure before any workspace request", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(ROUTES(calls, { status: "running", verdict: "" }, { status: "ok", repo: "will/flows", rows: [] }))
    const outcome = await controller.commands.run("triggers.run", "nightly will/flows")
    expect(outcome.status).toBe("executed")
    await waitFor(() => dispatchCards(store)[0]?.payload.phase === "failed")
    expect(dispatchCards(store)[0]?.payload.error).toBe('No schedule "nightly" is registered on will/flows.')
    expect(calls).toEqual([])
  })

  /* The box the relay reaches decides whether a registrar answers at all (defect D-1); its refusal is its own sentence. */
  test("a box that holds no registrar refuses the dispatch in its own words, on this press's card", async () => {
    const refusal = 'No flow "repository/trigger" is registered on this workspace.'
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(watched(backend({
      [PROJECTION]: projectionDocument(DAY_ONE),
      [REGISTRATIONS]: json(200, REGISTERED),
      [RPC]: relayRoute(calls, workspaceAnswers({ Plan: () => refusedFrame(refusal) }))
    })))
    expect((await controller.commands.run("triggers.run", "nightly will/flows")).status).toBe("executed")
    await waitFor(() => dispatchCards(store)[0]?.payload.phase === "failed")
    expect(dispatchCards(store)[0]?.payload.error).toBe(refusal)
    expect(calls.map((call) => call.procedure)).toEqual(["Plan"])
  })

  for (const command of ["triggers.run", "triggers.resume"] as const) test(`${command}: agent requests confirmation and missing input opens a form`, async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(ROUTES(calls))
    const asked = await controller.commands.runForAgent(command, "nightly will/flows")
    expect(asked.status).toBe("executed")
    expect(lastAction(store)?.flow).toBe(command)
    expect(calls).toEqual([])
    const form = await controller.commands.run(command)
    expect(form.status).toBe("form")
    if (form.status === "form") expect(form.fields).toEqual(["slug"])
  })
})

/*
 * A trigger's fire ledger, through the same `/api/workflow/rpc` relay every
 * other call in this seam uses. `List` is already relayed, so the read adds
 * no seam and no route.
 *
 * The call names no workspace on purpose. The rows it is a ledger for come
 * from the Worker's triggers route, which asks the repository's own gateway
 * (apps/server workflows.ts `handleWorkflowTriggers` passes no workspaceId),
 * so the fires of those trigger ids live in that box's store. A call that
 * named the reviewed jobs' workspace would read a different store and answer
 * for a different ledger.
 */
describe("triggers seam: a trigger's fire ledger", () => {
  const LEDGER = {
    _tag: "fires",
    items: [
      { triggerId: "nightly", occurrenceAtMs: 1_700_000_000_000, outcome: null },
      { triggerId: "nightly", occurrenceAtMs: 1_699_996_400_000, outcome: "launched", runId: "run-9", waiting: "approval" },
      { triggerId: "nightly", occurrenceAtMs: 1_699_992_800_000, outcome: "failed", error: "the flow refused the input" }
    ]
  }

  /** A seam context over one stubbed relay, on a repository whose reviewed jobs already name a workspace. */
  const ledger = async (calls: Array<RelayCall>, answer: (payload: Record<string, unknown>) => unknown) => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await signedIn(store)
    await jobSetUp(store)
    const ctx: SeamContext = {
      store,
      dispatch: store.dispatch,
      baseUrl: "",
      actor: () => "user",
      nextOrdinal: store.nextOrdinal,
      http: async (input, init) => {
        const url = new URL(input, "https://app.test")
        if (url.pathname !== RPC) return json(404, { status: "error", message: `no stub for ${url.pathname}` })
        const frame = JSON.parse(String(init?.body ?? "{}")) as { procedure: string; payload: Record<string, unknown>; workspaceId?: string }
        calls.push({ procedure: frame.procedure, payload: frame.payload, ...(frame.workspaceId === undefined ? {} : { workspaceId: frame.workspaceId }) })
        return json(200, answer(frame.payload))
      }
    }
    return ctx
  }

  test("a relayed page becomes the trigger's ledger, read from the box its rows came from", async () => {
    const calls: Array<RelayCall> = []
    const ctx = await ledger(calls, () => okFrame(LEDGER))
    expect(await readTriggerFires(ctx, "will/flows", "nightly")).toEqual({
      ok: true,
      fires: [
        { occurrenceAt: 1_700_000_000_000, outcome: null },
        { occurrenceAt: 1_699_996_400_000, outcome: "launched", runId: "run-9", waiting: "approval" },
        { occurrenceAt: 1_699_992_800_000, outcome: "failed", error: "the flow refused the input" }
      ]
    })
    expect(calls).toEqual([{ procedure: "List", payload: { _tag: "fires", filters: { triggerId: "nightly" }, limit: 20 } }])
  })

  test("a relay failure is the refusing party's own sentence and no rows", async () => {
    const calls: Array<RelayCall> = []
    const ctx = await ledger(calls, () => refusedFrame("this host serves no trigger store"))
    expect(await readTriggerFires(ctx, "will/flows", "nightly")).toEqual({ ok: false, message: "this host serves no trigger store" })
  })

  test("a page of another tag, or a shapeless answer, is a visible error rather than an empty ledger", async () => {
    const shapeless = await ledger([], () => okFrame({ _tag: "triggers", items: [] }))
    const wrongTag = await readTriggerFires(shapeless, "will/flows", "nightly")
    expect(wrongTag.ok).toBe(false)
    if (!wrongTag.ok) expect(wrongTag.message).toBe("The workspace answered in a shape I didn't understand.")
    const nonsense = await ledger([], () => okFrame({ _tag: "fires", items: "none" }))
    expect((await readTriggerFires(nonsense, "will/flows", "nightly")).ok).toBe(false)
  })

  test("the seam invents no row: a fire with no occurrence, an outcome the ledger never records, and another trigger's fire are all left out", async () => {
    const ctx = await ledger([], () => okFrame({
      _tag: "fires",
      items: [
        { triggerId: "nightly", occurrenceAtMs: 1_700_000_000_000, outcome: "completed", runId: "run-9" },
        { triggerId: "nightly", outcome: "completed" },
        { triggerId: "nightly", occurrenceAtMs: 1, outcome: "fired" },
        { triggerId: "nightly", occurrenceAtMs: 2 },
        { triggerId: "sweep", occurrenceAtMs: 3, outcome: "completed" },
        "not a fire"
      ]
    }))
    expect(await readTriggerFires(ctx, "will/flows", "nightly")).toEqual({
      ok: true,
      fires: [{ occurrenceAt: 1_700_000_000_000, outcome: "completed", runId: "run-9" }]
    })
  })

  /*
   * The ledger reaches the card through the one act that builds it, the list.
   * There is no second act and no effect: whoever presses Dispatcher, or
   * types the slash, gets the box's rows with their history already on them.
   */
  const TWO_BOX_ROWS = json(200, {
    status: "ok",
    repo: "will/flows",
    live: true,
    triggers: [
      { id: "nightly", flowId: "review", cron: "0 9 * * 1-5", timezone: "UTC", enabled: true },
      { id: "sweep", flowId: "issue", cron: "*/15 * * * *", enabled: false }
    ],
    webhooks: []
  })

  const ONE_PLUE_ROW = json(200, {
    status: "ok",
    repo: "will/flows",
    rows: [{ registrationId: "reg-1", slug: "nightly", flowId: "review", schedule: "0 9 * * 1-5", enabled: true, nextFireAt: "2026-09-21T16:00:00.000Z" }]
  })

  /** The relay as the list path meets it: every call recorded, each answered for the trigger it named. */
  const firesRoute = (calls: Array<RelayCall>, answer: (triggerId: string) => unknown): Route =>
  async (request) => {
    const frame = await request.json() as { procedure: string; payload: { filters?: { triggerId?: string } } & Record<string, unknown>; workspaceId?: string }
    calls.push({ procedure: frame.procedure, payload: frame.payload, ...(frame.workspaceId === undefined ? {} : { workspaceId: frame.workspaceId }) })
    return json(200, answer(frame.payload.filters?.triggerId ?? ""))
  }

  const listedRows = async (rpc: Route, seen: Array<string> = []) => {
    const { store, controller } = await ready(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [LIVE]: TWO_BOX_ROWS, [REGISTRATIONS]: ONE_PLUE_ROW, [RPC]: rpc }, seen),
      { signedIn: true }
    )
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    return triggerCard(store).payload.triggers
  }

  test("the list puts each box row's own ledger on that row, and asks the repository's own gateway for it", async () => {
    const calls: Array<RelayCall> = []
    const rows = await listedRows(
      firesRoute(calls, (triggerId) => okFrame({ _tag: "fires", items: [{ triggerId, occurrenceAtMs: 1_700_000_000_000, outcome: "completed", runId: `run-${triggerId}` }] }))
    )
    expect(rows[0]?.fires).toEqual([{ occurrenceAt: 1_700_000_000_000, outcome: "completed", runId: "run-nightly" }])
    expect(rows[1]?.fires).toEqual([{ occurrenceAt: 1_700_000_000_000, outcome: "completed", runId: "run-sweep" }])
    /* One `List` per box row, none naming a workspace, and none for the Plue registration: its registry serves no fires page. */
    expect(calls).toEqual([
      { procedure: "List", payload: { _tag: "fires", filters: { triggerId: "nightly" }, limit: 20 } },
      { procedure: "List", payload: { _tag: "fires", filters: { triggerId: "sweep" }, limit: 20 } }
    ])
  })

  test("a Plue registration is never asked for a ledger, and carries none", async () => {
    const calls: Array<RelayCall> = []
    const rows = await listedRows(firesRoute(calls, () => okFrame({ _tag: "fires", items: [] })))
    const plue = rows.find((row) => row.slug === "nightly")
    expect(plue?.id).toBe("reg-1")
    expect(plue?.fires).toBeUndefined()
    expect(calls.map((call) => call.payload.filters)).toEqual([{ triggerId: "nightly" }, { triggerId: "sweep" }])
  })

  test("a box that refused the ledger leaves the row without one, because unread history is not an empty history", async () => {
    const rows = await listedRows(firesRoute([], () => refusedFrame("this host serves no trigger store")))
    expect(rows[0]?.id).toBe("nightly")
    expect(rows[0]?.fires).toBeUndefined()
    expect(rows[1]?.fires).toBeUndefined()
    expect(JSON.stringify(rows)).not.toContain("fires")
  })

  test("a box that read a ledger with nothing in it says so: an empty ledger is an answer", async () => {
    const rows = await listedRows(firesRoute([], () => okFrame({ _tag: "fires", items: [] })))
    expect(rows[0]?.fires).toEqual([])
  })
})
