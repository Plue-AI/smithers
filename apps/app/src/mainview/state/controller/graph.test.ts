/*
 * The node drawer's reader state, through the real controller.
 *
 * Which node a graph card has open, and which of that node's tabs, are facts
 * on the card like every other reader gesture (L4's camera, the trace's
 * selection): four flows write them, a reload restores them, and an id no
 * graph carries is refused by name rather than opening an empty drawer.
 *
 * The plan node below is the control plane's own shape, so the relay answers
 * what a workspace answers; the run's journal is the recorded one, so every
 * node id a select names is one a real engine wrote.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { Card } from "@smthrs/rpc/Cards"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import { scopedControllers } from "../ControllerTestScope"
import { payloadFor } from "../../flows/SlashPayload"
import { flowArgs } from "../../flows/FlowArgs"
import { json, loadBox, memoryStorage, settle, silentAgent, TEST_BOX, waitFor } from "../TestFixtures"
import { digest } from "@smthrs/core/Digest"
import { triggerNodeId } from "../../cards/FlowGraphTriggerNode"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"
import { createGraphController } from "./graph"

const createAppController = scopedControllers()
const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const REPO = "codeplanesmithers/smithers-demo"
/** The revision the relay says it read the plan's declaration sites at (D-068). */
const REVISION = "b".repeat(40)
const FLOW = "gateway/GraphFixture"
const RUN = "run-1"
const PLAN_CARD = `flow-plan-${REPO}-${FLOW}--workspace-${digest(TEST_BOX).slice(0, 16)}`

const said = (outcome: { status: string; value?: string; error?: string }): string =>
  outcome.status === "failed" ? (outcome.error ?? "") : (outcome.value ?? "")

/** One node in the control plane's own shape (RunGraphView.test.ts). */
const planNode = (id: string, action: string, dependsOn: ReadonlyArray<string> = [], key = "0".repeat(64)) => ({
  id,
  kind: "step",
  key: `key1_${key}`,
  material: { version: "flows/key-material/v2", kind: "sealed", body: { action }, inputs: [], layers: [], capabilities: [] },
  effects: { reads: [], writes: [], boundaryMode: "hard" },
  dependsOn,
  conflicts: [],
  strategy: "serialize",
  runtime: "delay-rebase",
  priority: 0,
  generation: 0,
  status: "run"
})

const NODES = [planNode("gate", "graph/Gate"), planNode("steady", "graph/Steady", ["gate"], "1".repeat(64))]

/** The repository's schedule listing, which is where a trigger node on a plan comes from. */
const DISPATCHER: Card = {
  id: `trigger-list-${REPO}`,
  kind: "trigger-list",
  title: "Dispatcher",
  status: "acted",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repo: REPO,
    live: true,
    triggers: [{ id: "nightly", flowId: FLOW, cron: "0 9 * * 1-5", timezone: "UTC", enabled: true }]
  }
}

/** The recorded run the graph fold is proved against (cards/fixtures/GraphRunJournal.json). */
const RECORDED: {
  readonly rows: ReadonlyArray<Record<string, unknown>>
} = JSON.parse(readFileSync(new URL("../../cards/fixtures/GraphRunJournal.json", import.meta.url), "utf8"))

/** A relay double answering the procedures a plan, a launch and a re-open ride. */
const relay = (options: {
  readonly events?: ReadonlyArray<unknown>
  readonly nodes?: ReadonlyArray<unknown>
  /** What a SECOND Plan answers, when the re-plan is meant to draw another graph. */
  readonly replan?: ReadonlyArray<unknown>
  /** Where the workspace says each node was declared (D-054). */
  readonly sites?: ReadonlyArray<{ readonly id: string; readonly declaredAt?: { readonly path: string; readonly line: number } }>
  /**
   * The revision the workspace read those sites at (D-068).
   *
   * `null` is a host that named none, which is what a plan from an
   * unversioned tree looks like; the default is the revision below.
   */
  readonly sourceRevision?: string | null
  /** The bytes the repository answers for the declared file, when a case reads one. */
  readonly source?: string
  /**
   * The bytes the repository answers for that file AT A REVISION, when they
   * differ from the working tree's above (D-068).
   *
   * A read with no `ref` is a read of whatever is on disk now; a read with
   * one is a read of bytes that cannot change. A case that sets both is a
   * working tree that has moved off the revision the plan was built at.
   */
  readonly revisionSource?: string
  readonly readGate?: Promise<void>
  readonly sourceResponse?: (url: URL) => Promise<Response>
} = {}) => {
  const reads: Array<string> = []
  let plans = 0
  const rows = (projection: string, values: ReadonlyArray<unknown>): Response =>
    json(200, { ok: true, payload: { cursor: { projection, runId: null, value: 0 }, rows: values } })
  const procedure = (name: string, payload: Record<string, unknown>): Response => {
    switch (name) {
      case "List":
        return json(200, { ok: true, payload: { _tag: "flows", items: [{ flowId: FLOW, description: "" }] } })
      case "Plan":
        plans += 1
        return json(200, {
          ok: true,
          payload: {
            planId: "plan-1",
            flowId: FLOW,
            digest: "d".repeat(64),
            inputSummary: "{}",
            envelope: { capabilities: [], flows: [], budget: {} },
            deployClass: false,
            nodes: (plans > 1 ? options.replan : undefined) ?? options.nodes ?? NODES,
            graph: {
              edges: [{ from: "gate", to: "steady", reason: "value" }],
              ...(options.sites === undefined ? {} : { nodes: options.sites }),
              ...(options.sourceRevision === null ? {} : { sourceRevision: options.sourceRevision ?? REVISION })
            },
            approval: {
              target: { _tag: "Plan", planId: "plan-1", digest: "d".repeat(64), envelope: { capabilities: [], flows: [], budget: {} } },
              scope: "run",
              idempotencyKey: "approve:plan-1"
            }
          }
        })
      case "Run":
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: RUN } })
      case "Approval.Submit":
        return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } })
      case "Projection.Snapshot": {
        const selector = (payload.selector ?? {}) as { _tag?: string }
        if (selector._tag === "run-summary") {
          return rows("run-summary", [{
            runId: RUN,
            flowId: FLOW,
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
        if (selector._tag === "run-events") return rows("run-events", options.events ?? [])
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
      if (absolute.pathname.includes("/contents/")) {
        reads.push(`${absolute.pathname}${absolute.search}`)
        if (options.sourceResponse) return options.sourceResponse(absolute)
        await options.readGate
        const asked = absolute.searchParams.get("ref")
        const served = asked === null ? options.source : options.revisionSource ?? options.source
        return served === undefined
          ? json(404, { status: "error", message: "not found" })
          : json(200, { type: "file", encoding: "utf-8", content: served })
      }
      if (absolute.pathname === "/api/workflow/provision") return json(200, { status: "ready", repo: body?.repo, gatewayId: "gw-1" })
      if (absolute.pathname === "/api/workflow/rpc") {
        return procedure(String(body.procedure), (body.payload ?? {}) as Record<string, unknown>)
      }
      return json(404, { status: "error", message: `no stub for ${absolute.pathname}` })
    }
  }
  return { services, reads }
}

const signIn = async (store: Awaited<ReturnType<typeof webStore>>) => {
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
    repositories: [{ id: REPO, org: REPO.split("/")[0] ?? "", ownerKind: "user", name: REPO.split("/")[1] ?? "", head: null }]
  })
  await loadBox(store, REPO)
  await settle(2)
}

const runCard = (store: Awaited<ReturnType<typeof webStore>>): Extract<Card, { kind: "run-trace" }> | undefined => {
  // A launch persists its request card first and rewrites it with the run id
  // the control plane answers with, so the card is keyed by the request, never
  // by the run. The run id on the payload is what identifies it.
  const card = [...store.collections.cards.values()].find((card) => card.kind === "run-trace" && card.payload.runId === RUN)
  return card?.kind === "run-trace" ? card : undefined
}

const planCard = (store: Awaited<ReturnType<typeof webStore>>): Extract<Card, { kind: "flow-plan" }> | undefined => {
  const card = store.collections.cards.get(PLAN_CARD)
  return card?.kind === "flow-plan" ? card : undefined
}

const launched = async (options: Parameters<typeof relay>[0] = {}) => {
  const store = await webStore()
  const served = relay(options)
  const controller = createAppController(store, silentAgent, served.services)
  await signIn(store)
  await controller.commands.run("flow.run", FLOW)
  // The command returns on the persisted request; the run card carries a run id
  // only once the launch itself answers.
  await waitFor(() => runCard(store)?.payload.phase === "running")
  return { store, controller, reads: served.reads }
}

const planned = async (options: Parameters<typeof relay>[0] = {}) => {
  const store = await webStore()
  const served = relay(options)
  const controller = createAppController(store, silentAgent, served.services)
  await signIn(store)
  await controller.commands.run("flow.plan", FLOW)
  await settle(2)
  return { store, controller, reads: served.reads }
}

describe("the run graph's node drawer", () => {
  test("selecting a node the plan carries persists before it answers", async () => {
    const { store, controller } = await launched()
    const answer = controller.commands.run("runs.graph.select", `${RUN} gate`)
    expect(said(await answer)).toBe(`graph-select run=${RUN} node=gate`)
    expect(runCard(store)?.payload.graph).toEqual({ node: "gate" })
    /* The act is the actor's, recorded as a transition, never component state. */
    expect([...store.collections.transitions.values()].some((record) => {
      if (record.type !== "card.upsert") return false
      const payload = JSON.parse(record.payload)
      return payload.card?.id === runCard(store)?.id && payload.card?.payload?.graph?.node === "gate"
    })).toBe(true)
  })

  test.each(["root.flow.all.hello world", "root.flow.all.branch/step"])("selects the exact engine ID %s through both structured doors", async (nodeId) => {
    const nodes = [planNode(nodeId, "graph/Step")]
    const run = await launched({ nodes })
    expect((await run.controller.commands.run("runs.graph.select", flowArgs("runs.graph.select", { runId: RUN, nodeId }))).status).toBe("executed")
    expect(runCard(run.store)?.payload.graph?.node).toBe(nodeId)
    const plan = await planned({ nodes })
    expect(planCard(plan.store)?.status).toBe("active")
    expect(planCard(plan.store)?.payload.status).toBe("done")
    expect((await plan.controller.commands.run("flow.plan.select", flowArgs("flow.plan.select", { cardId: PLAN_CARD, nodeId }))).status).toBe("executed")
    expect(planCard(plan.store)?.payload.view?.node).toBe(nodeId)
  })

  test("an id no graph carries is refused by name and opens nothing", async () => {
    const { store, controller } = await launched()
    expect(said(await controller.commands.run("runs.graph.select", `${RUN} invented`))).toBe(`Run ${RUN} has no graph node invented.`)
    expect(runCard(store)?.payload.graph).toBeUndefined()
  })

  /*
   * A run this client did not launch has no plan on its card at all, so every
   * node it can draw comes from the journal the pump read. The recording is a
   * real `gateway/GraphFixture` run, so the id below is one an engine wrote.
   */
  test("a node only the JOURNAL carries selects", async () => {
    const { store, controller } = await launched({ nodes: [], events: RECORDED.rows })
    await settle(8)
    expect(runCard(store)?.payload.plan).toBeUndefined()
    expect(said(await controller.commands.run("runs.graph.select", `${RUN} root.flow.then.map.all.steady`)))
      .toBe(`graph-select run=${RUN} node=root.flow.then.map.all.steady`)
    expect(runCard(store)?.payload.graph?.node).toBe("root.flow.then.map.all.steady")
  })

  test("clearing the selection removes the node and its tab durably, and keeps the camera", async () => {
    const { store, controller } = await launched()
    await controller.commands.run("runs.graph.follow", `${RUN} on`)
    await controller.commands.run("runs.graph.select", `${RUN} gate`)
    await controller.commands.run("runs.graph.tab", `${RUN} code`)
    expect(said(await controller.commands.run("runs.graph.select", RUN))).toBe(`graph-select run=${RUN} node=none`)
    expect(runCard(store)?.payload.graph).toEqual({ follow: true })
    expect(Object.keys(runCard(store)?.payload.graph ?? {})).not.toContain("node")
    expect(Object.keys(runCard(store)?.payload.graph ?? {})).not.toContain("tab")
  })

  /*
   * A word no tab answers to never reaches the handler: the composer boundary
   * refuses it by name, and THE FORM LAW turns that refusal into the flow's
   * own form rather than a usage sentence.
   */
  test("the tab enum refuses a word no tab answers to", async () => {
    const { store, controller } = await launched()
    expect(payloadFor("runs.graph.tab", `${RUN} frames`))
      .toEqual({ error: "runs.graph.tab needs one of in, declaration, code, output, events, attempts" })
    expect((await controller.commands.run("runs.graph.tab", `${RUN} frames`)).status).toBe("form")
    expect(runCard(store)?.payload.graph).toBeUndefined()
    await controller.commands.run("runs.graph.select", `${RUN} gate`)
    expect(said(await controller.commands.run("runs.graph.tab", `${RUN} events`))).toBe(`graph-tab run=${RUN} tab=events`)
    expect(runCard(store)?.payload.graph).toEqual({ node: "gate", tab: "events" })
  })

  test("a tab with no node open is refused, because there is nothing to show it on", async () => {
    const { store, controller } = await launched()
    expect(said(await controller.commands.run("runs.graph.tab", `${RUN} code`)))
      .toBe(`Select a node on run ${RUN} before choosing one of its tabs.`)
    expect(runCard(store)?.payload.graph).toBeUndefined()
  })

  test("selecting another node keeps the tab the reader chose", async () => {
    const { store, controller } = await launched()
    await controller.commands.run("runs.graph.select", `${RUN} gate`)
    await controller.commands.run("runs.graph.tab", `${RUN} events`)
    await controller.commands.run("runs.graph.select", `${RUN} steady`)
    expect(runCard(store)?.payload.graph).toEqual({ node: "steady", tab: "events" })
  })

  test("the camera and the open node are different gestures, and neither clears the other", async () => {
    const { store, controller } = await launched()
    await controller.commands.run("runs.graph.select", `${RUN} gate`)
    await controller.commands.run("runs.graph.tab", `${RUN} events`)
    await controller.commands.run("runs.graph.follow", `${RUN} on`)
    expect(runCard(store)?.payload.graph).toEqual({ node: "gate", tab: "events", follow: true })
    await controller.commands.run("runs.graph.follow", `${RUN} off`)
    expect(runCard(store)?.payload.graph).toEqual({ node: "gate", tab: "events", follow: false })
  })

  test("both gestures need the run's card first", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, relay().services)
    await signIn(store)
    expect(said(await controller.commands.run("runs.graph.select", "run-9 gate"))).toContain("runs.open run-9")
    expect(said(await controller.commands.run("runs.graph.tab", "run-9 code"))).toContain("runs.open run-9")
  })

  test("the selection and the tab survive a re-open", async () => {
    const { store, controller } = await launched()
    await controller.commands.run("runs.graph.select", `${RUN} gate`)
    await controller.commands.run("runs.graph.tab", `${RUN} declaration`)
    await controller.commands.run("runs.open", RUN)
    await waitFor(() => (store.session().runOpenRequests ?? []).length === 0)
    expect(runCard(store)?.payload.graph).toEqual({ node: "gate", tab: "declaration" })
  })
})

describe("the plan card's node drawer", () => {
  test("selecting one of the plan's own nodes persists on the card that drew it", async () => {
    const { store, controller } = await planned()
    expect(said(await controller.commands.run("flow.plan.select", `${PLAN_CARD} steady`)))
      .toBe(`plan-select card=${PLAN_CARD} node=steady`)
    expect(planCard(store)?.payload.view).toEqual({ node: "steady" })
  })

  /*
   * D-054: the Code tab is a viewer, so opening it reads the declared file.
   * The read is background work (AGENTS.md §1): the tab is on the card
   * before the repository has answered, and the bytes arrive under the
   * shared toast.
   */
  test("a slow Code read uses a storage-safe toast identity and acknowledges before the read", async () => {
    const gate = Promise.withResolvers<void>()
    const { store, controller } = await planned({
      sites: [{ id: "gate", declaredAt: { path: "flows/a b/flow.ts", line: 1 } }],
      source: "const gate = 1", readGate: gate.promise
    })
    try {
      await controller.commands.run("flow.plan.select", `${PLAN_CARD} gate`)
      await controller.commands.run("flow.plan.tab", `${PLAN_CARD} code`)
      await settle(10)
      const toast = [...store.collections.toasts.values()].find(row => row.status === "running")
      expect(toast).toBeDefined()
      expect(toast!.id).not.toMatch(/[\u0000-\u001f]/)
      expect([...store.collections.cards.values()].some(row => row.kind === "file")).toBe(false)
    } finally { gate.resolve(); await settle(10) }
  })

  test("opening the Code tab reads the declared file in the background", async () => {
    const site = { path: "flows/review/flow.ts", line: 12 }
    const { store, controller, reads } = await planned({
      sites: [{ id: "gate", declaredAt: site }],
      source: "const gate = 1\n"
    })
    await controller.commands.run("flow.plan.select", `${PLAN_CARD} gate`)

    expect(said(await controller.commands.run("flow.plan.tab", `${PLAN_CARD} code`)))
      .toBe(`plan-tab card=${PLAN_CARD} tab=code`)
    /* The tab is a fact on the card; the bytes are background work behind it. */
    expect(planCard(store)?.payload.view).toEqual({ node: "gate", tab: "code" })

    await settle(10)
    expect(reads.filter((path) => path.includes("flow.ts")).length).toBe(1)
    const file = [...store.collections.cards.values()].find((card) => card.kind === "file")
    expect(file?.kind === "file" ? file.payload.path : undefined).toBe(site.path)
    expect(file?.kind === "file" ? file.payload.line : undefined).toBe(12)

    /* Nothing was refused, so the card states no refusal. */
    expect(planCard(store)?.payload.view?.codeError).toBeUndefined()

    /* The file is in hand and on screen, so opening the tab again reads nothing. */
    await controller.commands.run("flow.plan.tab", `${PLAN_CARD} code`)
    await settle(10)
    expect(reads.filter((path) => path.includes("flow.ts")).length).toBe(1)
  })

  /*
   * Two nodes of ONE file. The bytes are the same bytes and the card that
   * holds them is the same card; what differs is the line the reader asked
   * for. The door moves the anchor onto the held card and puts it at the
   * tail, because a door that does nothing is not an act (AGENTS.md agent
   * parity), and it spends no second request for bytes already in hand.
   */
  test("the Code tab of a second node in the same file moves the held card's anchor", async () => {
    const path = "flows/review/flow.ts"
    const { store, controller, reads } = await planned({
      sites: [{ id: "gate", declaredAt: { path, line: 12 } }, { id: "steady", declaredAt: { path, line: 40 } }],
      source: "const gate = 1\n"
    })
    const fileCard = () => {
      const card = [...store.collections.cards.values()].find((row) => row.kind === "file")
      return card?.kind === "file" ? card : undefined
    }

    await controller.commands.run("flow.plan.select", `${PLAN_CARD} gate`)
    await controller.commands.run("flow.plan.tab", `${PLAN_CARD} code`)
    await settle(10)
    expect(fileCard()?.payload.line).toBe(12)
    const held = fileCard()!
    const trailing = store.nextOrdinal()

    await controller.commands.run("flow.plan.select", `${PLAN_CARD} steady`)
    await settle(10)

    /* The same card, moved: one card on screen, anchored where the reader is. */
    expect([...store.collections.cards.values()].filter((row) => row.kind === "file").length).toBe(1)
    expect(fileCard()?.id).toBe(held.id)
    expect(fileCard()?.payload.line).toBe(40)
    /* And it is at the tail, so the door put it where the reader is looking. */
    expect(fileCard()!.ordinal).toBeGreaterThanOrEqual(trailing)
    /* The bytes were in hand, so nothing was read a second time. */
    expect(reads.filter((read) => read.includes("flow.ts")).length).toBe(1)
  })

  /*
   * A read that fails leaves the refusal standing in the shared toast, in the
   * seam's own words, and leaves no card claiming it worked. The tab's
   * `Open file` door is the retry, and it works because nothing was cached
   * over the failure.
   */
  test("a refused read is stated and stays retryable", async () => {
    const site = { path: "flows/review/flow.ts", line: 12 }
    const { store, controller, reads } = await planned({ sites: [{ id: "gate", declaredAt: site }] })
    await controller.commands.run("flow.plan.select", `${PLAN_CARD} gate`)
    await controller.commands.run("flow.plan.tab", `${PLAN_CARD} code`)
    await settle(10)

    /* The refusal is on the card the drawer draws, in the seam's own words. */
    expect(planCard(store)?.payload.view?.codeError?.path).toBe(site.path)
    expect(planCard(store)?.payload.view?.codeError?.message.length).toBeGreaterThan(0)
    expect([...store.collections.cards.values()].some((card) => card.kind === "file")).toBe(false)

    /* Asking again really asks again: nothing was cached over the refusal. */
    await controller.commands.run("flow.plan.tab", `${PLAN_CARD} code`)
    await settle(10)
    expect(reads.filter((path) => path.includes("flow.ts")).length).toBe(2)
    expect(planCard(store)?.payload.view?.codeError?.path).toBe(site.path)
  })

  test("a node the plan named no declaration site for reads nothing at all", async () => {
    const { controller, reads } = await planned({ source: "const gate = 1\n" })
    await controller.commands.run("flow.plan.select", `${PLAN_CARD} gate`)
    await controller.commands.run("flow.plan.tab", `${PLAN_CARD} code`)
    await settle(10)
    expect(reads).toEqual([])
  })

  /*
   * D-068. The Code tab shows the source the plan was built from, which is
   * not the same thing as the file at that path: the working tree moves. The
   * read is made AT the revision the plan recorded, so a tree that has since
   * changed does not change what this plan's reader is shown.
   */
  test("reads the declared file at the revision the plan recorded, not the working tree", async () => {
    const site = { path: "flows/review/flow.ts", line: 12 }
    const { store, controller, reads } = await planned({
      sites: [{ id: "gate", declaredAt: site }],
      source: "const gate = 2\n",
      revisionSource: "const gate = 1\n"
    })
    await controller.commands.run("flow.plan.select", `${PLAN_CARD} gate`)
    await controller.commands.run("flow.plan.tab", `${PLAN_CARD} code`)
    await settle(10)

    /* The request carried the revision, so the bytes are the revision's. */
    expect(reads).toEqual([`/api/repos/codeplanesmithers/smithers-demo/contents/${site.path}?ref=${REVISION}`])
    const file = [...store.collections.cards.values()].find((card) => card.kind === "file")
    expect(file?.kind === "file" ? file.payload.content : undefined).toBe("const gate = 1\n")
    /* And the card says which revision it holds, so nothing else can stand in for it. */
    expect(file?.kind === "file" ? file.payload.ref : undefined).toBe(REVISION)
    /*
     * The head the session last saw is NOT what this card was read at, so it
     * does not claim one: `readAt` is the position a plain read is taken at.
     */
    expect(file?.kind === "file" ? file.payload.readAt : undefined).toBeUndefined()
  })

  /*
   * And the working tree moving under the plan changes nothing a reader sees:
   * the file the tab renders is the one card keyed by that revision, and the
   * tab does not read again for a file it already holds at it.
   */
  test("an edited working tree does not change what an old plan's Code tab shows", async () => {
    const site = { path: "flows/review/flow.ts", line: 12 }
    const served = { working: "const gate = 1\n" }
    const store = await webStore()
    const base = relay({ sites: [{ id: "gate", declaredAt: site }], revisionSource: "const gate = 1\n" })
    const services: AppServices = {
      ...base.services,
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const absolute = new URL(url, "https://app.test")
        /* The working tree, which this case edits between reads. */
        if (absolute.pathname.includes("/contents/") && absolute.searchParams.get("ref") === null) {
          base.reads.push(`${absolute.pathname}${absolute.search}`)
          return json(200, { type: "file", encoding: "utf-8", content: served.working })
        }
        return base.services.fetchImpl!(input, init)
      }
    }
    const controller = createAppController(store, silentAgent, services)
    await signIn(store)
    await controller.commands.run("flow.plan", FLOW)
    await settle(2)
    await controller.commands.run("flow.plan.select", `${PLAN_CARD} gate`)
    await controller.commands.run("flow.plan.tab", `${PLAN_CARD} code`)
    await settle(10)

    const shown = () => {
      const file = [...store.collections.cards.values()].find((card) => card.kind === "file")
      return file?.kind === "file" ? file.payload.content : undefined
    }
    expect(shown()).toBe("const gate = 1\n")

    /* Somebody edits the file. The plan, and the revision it names, are unchanged. */
    served.working = "const gate = 999\n"
    await controller.commands.run("flow.plan.tab", `${PLAN_CARD} declaration`)
    await controller.commands.run("flow.plan.tab", `${PLAN_CARD} code`)
    await settle(10)

    expect(shown()).toBe("const gate = 1\n")
    /* Every read this tab made asked for the revision; none asked the tree. */
    expect(base.reads.filter((path) => path.includes("flow.ts")))
      .toEqual([`/api/repos/codeplanesmithers/smithers-demo/contents/${site.path}?ref=${REVISION}`])
  })

  /*
   * A host that could not name the revision it walked reports the site and no
   * revision, and then there is nothing to read that could be called the code
   * this plan was built from: nothing is read, and the drawer draws no tab.
   */
  test("a plan that names no revision reads nothing and holds no file", async () => {
    const site = { path: "flows/review/flow.ts", line: 12 }
    const { store, controller, reads } = await planned({
      sites: [{ id: "gate", declaredAt: site }],
      source: "const gate = 1\n",
      sourceRevision: null
    })
    await controller.commands.run("flow.plan.select", `${PLAN_CARD} gate`)
    expect(said(await controller.commands.run("flow.plan.tab", `${PLAN_CARD} code`)))
      .toBe(`plan-tab card=${PLAN_CARD} tab=code`)
    await settle(10)

    expect(reads).toEqual([])
    expect([...store.collections.cards.values()].some((card) => card.kind === "file")).toBe(false)
    expect(planCard(store)?.payload.view?.codeError).toBeUndefined()
  })

  test("an id the plan does not carry is refused by name", async () => {
    const { store, controller } = await planned()
    expect(said(await controller.commands.run("flow.plan.select", `${PLAN_CARD} invented`)))
      .toBe(`That plan has no node invented.`)
    expect(planCard(store)?.payload.view).toBeUndefined()
  })

  test("a card that is not a plan is refused by name", async () => {
    const { controller } = await planned()
    expect(said(await controller.commands.run("flow.plan.select", "card-that-is-not-here steady")))
      .toBe("Open the plan first: the graph lives on its card.")
  })

  test("clearing removes the view field durably", async () => {
    const { store, controller } = await planned()
    await controller.commands.run("flow.plan.select", `${PLAN_CARD} steady`)
    await controller.commands.run("flow.plan.tab", `${PLAN_CARD} declaration`)
    expect(said(await controller.commands.run("flow.plan.select", PLAN_CARD))).toBe(`plan-select card=${PLAN_CARD} node=none`)
    expect(planCard(store)?.payload.view).toBeUndefined()
    expect(Object.keys(planCard(store)?.payload ?? {})).not.toContain("view")
  })

  test("the plan card's tab enum refuses a word no tab answers to", async () => {
    const { store, controller } = await planned()
    await controller.commands.run("flow.plan.select", `${PLAN_CARD} steady`)
    expect(payloadFor("flow.plan.tab", `${PLAN_CARD} frames`))
      .toEqual({ error: "flow.plan.tab needs one of in, declaration, code, output, events, attempts" })
    expect((await controller.commands.run("flow.plan.tab", `${PLAN_CARD} frames`)).status).toBe("form")
    expect(planCard(store)?.payload.view?.tab).toBeUndefined()
  })

  test("a re-plan keeps the node the reader had open", async () => {
    const { store, controller } = await planned()
    await controller.commands.run("flow.plan.select", `${PLAN_CARD} gate`)
    await controller.commands.run("flow.plan", FLOW)
    await settle(2)
    expect(planCard(store)?.payload.view).toEqual({ node: "gate" })
  })

  /* A drawer pointed at a node the new plan does not carry would be open over nothing. */
  test("a re-plan that no longer carries the open node closes the drawer", async () => {
    const { store, controller } = await planned({ replan: [planNode("steady", "graph/Steady")] })
    await controller.commands.run("flow.plan.select", `${PLAN_CARD} gate`)
    await controller.commands.run("flow.plan", FLOW)
    await settle(2)
    expect(planCard(store)?.payload.nodes?.map((node) => node.id)).toEqual(["steady"])
    expect(planCard(store)?.payload.view).toBeUndefined()
  })

  /*
   * A schedule is drawn beside the plan and is selectable like any other node
   * (planNodeIds), so it is not in `nodes` and a re-plan never removes it.
   */
  test("a re-plan keeps a schedule the reader had open", async () => {
    const { store, controller } = await planned()
    store.dispatch({ type: "card.upsert", actor: "system", card: DISPATCHER })
    await settle(1)
    expect(said(await controller.commands.run("flow.plan.select", `${PLAN_CARD} ${triggerNodeId("nightly")}`)))
      .toBe(`plan-select card=${PLAN_CARD} node=${triggerNodeId("nightly")}`)
    await controller.commands.run("flow.plan", FLOW)
    await settle(2)
    expect(planCard(store)?.payload.view).toEqual({ node: triggerNodeId("nightly") })
  })
})

test("a thrown declaration read stays visible even inside the toast debounce", async () => {
  const { store } = await planned({ sites: [{ id: "gate", declaredAt: { path: "flows/review/flow.ts", line: 1 } }] })
  const context = createControllerContext(store, silentAgent, { toastDebounceMs: 300 })
  Object.assign(context, createFailureController(context))
  const graph = createGraphController(context, async () => { throw new Error("read interrupted") })
  try {
    await graph.selectPlanNode(PLAN_CARD, "gate")
    graph.planNodeTab(PLAN_CARD, "code")
    await waitFor(() => planCard(store)?.payload.view?.codeError !== undefined)
    expect(planCard(store)?.payload.view?.codeError?.message).toBe("The declaration could not be loaded. Try again.")
    expect(context.failures.recent().some(failure => failure.seam === "toast.work")).toBe(true)
  } finally { await context.dispose() }
})

for (const kind of ["plan", "run"] as const) {
  const setup = async (options: Parameters<typeof relay>[0]) => {
    const fixture = await (kind === "plan" ? planned(options) : launched(options))
    const { store, controller } = fixture
    return { ...fixture,
      select: (node?: string) => kind === "plan" ? controller.selectPlanNode(PLAN_CARD, node) : controller.selectGraphNode(RUN, node),
      code: () => kind === "plan" ? controller.planNodeTab(PLAN_CARD, "code") : controller.graphNodeTab(RUN, "code"),
      view: () => kind === "plan" ? planCard(store)?.payload.view : runCard(store)?.payload.graph,
    }
  }
  const sites = [
    { id: "gate", declaredAt: { path: "flows/first/flow.ts", line: 1 } },
    { id: "steady", declaredAt: { path: "flows/second/flow.ts", line: 2 } },
  ]

  test(`${kind}: selecting another node while Code is open reads its declaration and clears the previous refusal`, async () => {
    const fixture = await setup({ sites, sourceResponse: async url => url.pathname.includes("/first/")
      ? json(404, { message: "first missing" }) : json(200, { type: "file", encoding: "utf-8", content: "second source" }) })
    await fixture.select("gate")
    fixture.code()
    await waitFor(() => fixture.view()?.codeError !== undefined)
    await fixture.select("steady")
    expect(fixture.view()?.codeError).toBeUndefined()
    await settle(10)
    expect(fixture.reads.some(path => path.includes("/second/"))).toBe(true)
    expect([...fixture.store.collections.cards.values()].some(card => card.kind === "file" && card.payload.content === "second source")).toBe(true)
    expect(fixture.view()?.node).toBe("steady")
    expect(fixture.view()?.tab).toBe("code")
  })

  test(`${kind}: duplicate Code activation shares a pending read and leaves Chat usable`, async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = await setup({ sites, readGate: gate.promise })
    try {
      await fixture.select("gate")
      fixture.code()
      fixture.code()
      await waitFor(() => fixture.reads.length > 0)
      await fixture.store.dispatch({ type: "composer.changed", actor: "user", draft: "Chat during a declaration read" }).isPersisted.promise
      expect(fixture.reads).toHaveLength(1)
      gate.resolve()
      await waitFor(() => fixture.view()?.codeError !== undefined)
      fixture.code()
      await waitFor(() => fixture.reads.length === 2)
    } finally { gate.resolve() }
  })

  test(`${kind}: closing a drawer prevents a late declaration refusal from reopening its state`, async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = await setup({ sites, readGate: gate.promise })
    try {
      await fixture.select("gate")
      fixture.code()
      await waitFor(() => fixture.reads.length === 1)
      await fixture.select()
      gate.resolve()
      await settle(15)
      expect(fixture.view()?.node).toBeUndefined()
      expect(fixture.view()?.codeError).toBeUndefined()
    } finally { gate.resolve() }
  })

  test(`${kind}: an old account's read cannot clear the replacement drawer's refusal`, async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = await setup({ sites, readGate: gate.promise })
    try {
      await fixture.select("gate")
      fixture.code()
      await waitFor(() => fixture.reads.length === 1)
      const previous = kind === "plan" ? planCard(fixture.store)! : runCard(fixture.store)!
      await fixture.controller.adoptSession({ state: "signed-in", login: "another-owner", allowlisted: true, admin: false })
      const view = { node: "gate", tab: "code" as const, codeError: { path: sites[0]!.declaredAt.path, message: "Current account refusal" } }
      const replacement = previous.kind === "flow-plan" ? { ...previous, payload: { ...previous.payload, view } }
        : { ...previous, payload: { ...previous.payload, graph: view } }
      await fixture.store.dispatch({ type: "card.upsert", actor: "system", card: replacement }).isPersisted.promise
      gate.resolve()
      await settle(15)
      expect(fixture.view()?.codeError?.message).toBe("Current account refusal")
    } finally { gate.resolve() }
  })

  test(`${kind}: a response from the prior source revision cannot change the current drawer`, async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = await setup({ sites, readGate: gate.promise })
    try {
      await fixture.select("gate")
      fixture.code()
      await waitFor(() => fixture.reads.length === 1)
      const previous = kind === "plan" ? planCard(fixture.store)! : runCard(fixture.store)!
      const codeError = { path: sites[0]!.declaredAt.path, message: "Current revision refusal" }
      const card = previous.kind === "flow-plan"
        ? { ...previous, payload: { ...previous.payload, view: { ...previous.payload.view, codeError }, graph: { ...previous.payload.graph!, sourceRevision: "c".repeat(40) } } }
        : { ...previous, payload: { ...previous.payload, graph: { ...previous.payload.graph, codeError }, plan: { ...previous.payload.plan!, graph: { ...previous.payload.plan!.graph!, sourceRevision: "c".repeat(40) } } } }
      await fixture.store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
      gate.resolve()
      await settle(15)
      expect(fixture.view()?.codeError?.message).toBe("Current revision refusal")
    } finally { gate.resolve() }
  })

  test(`${kind}: a slower selection commit cannot retire the newer node's read`, async () => {
    const saved = Promise.withResolvers<void>()
    const answered = Promise.withResolvers<void>()
    const fixture = await setup({ sites, readGate: answered.promise })
    await fixture.select("steady")
    fixture.code()
    await waitFor(() => fixture.reads.length === 1)
    const dispatch = fixture.store.dispatch
    Object.assign(fixture.store, { dispatch: (transition: Parameters<typeof dispatch>[0]) => {
      const write = dispatch(transition)
      if (transition.type === "card.upsert" &&
        ((transition.card.kind === "flow-plan" && transition.card.payload.view?.node === "gate") ||
          (transition.card.kind === "run-trace" && transition.card.payload.graph?.node === "gate"))) {
        return { ...write, isPersisted: { promise: write.isPersisted.promise.then(() => saved.promise) } }
      }
      return write
    } })
    try {
      const older = fixture.select("gate")
      await fixture.select("steady")
      saved.resolve()
      await older
      answered.resolve()
      await waitFor(() => fixture.view()?.codeError !== undefined)
      expect(fixture.view()?.codeError?.path).toBe(sites[1]!.declaredAt.path)
      expect(fixture.reads).toHaveLength(1)
    } finally { saved.resolve(); answered.resolve(); Object.assign(fixture.store, { dispatch }) }
  })

  test(`${kind}: a delayed old declaration cannot replace the current Code refusal`, async () => {
    const first = Promise.withResolvers<void>()
    const fixture = await setup({ sites, sourceResponse: async url => {
      if (url.pathname.includes("/first/")) await first.promise
      return json(404, { message: url.pathname.includes("/first/") ? "first missing" : "second missing" })
    } })
    try {
      await fixture.select("gate")
      fixture.code()
      await waitFor(() => fixture.reads.length === 1)
      await fixture.select("steady")
      fixture.code()
      await waitFor(() => fixture.view()?.codeError?.path === sites[1]!.declaredAt.path)
      first.resolve()
      await settle(15)
      expect(fixture.view()?.codeError?.path).toBe(sites[1]!.declaredAt.path)
    } finally { first.resolve() }
  })
}


describe("run graph commands retain the recorded gateway scope", () => {
  const workspaceA = "11111111-1111-1111-1111-111111111111"
  const workspaceB = "22222222-2222-2222-2222-222222222222"
  const trace = (id: string, repo = REPO, workspaceId?: string): Extract<Card, { kind: "run-trace" }> => ({
    id, kind: "run-trace", title: id, status: "acted", createdAt: 1, ordinal: 1,
    payload: { repo, workspaceId, runId: RUN, workflow: FLOW, phase: "completed", steps: [], result: null, lastSeq: 0,
      graph: { node: "gate", tab: "declaration" },
      plan: { planId: "plan-1", digest: "d".repeat(64), nodes: [
        { id: "gate", kind: "step", key: "key1_" + "0".repeat(64), dependsOn: [], tier: "sealed", status: "run" },
        { id: "steady", kind: "step", key: "key1_" + "1".repeat(64), dependsOn: ["gate"], tier: "sealed", status: "run" },
      ], graph: { edges: [], sourceRevision: REVISION, nodes: [{ id: "gate", declaredAt: { path: "flows/review/flow.ts", line: 1 } }] } }
    }
  })
  const ready = async (cards: Card[]) => {
    const store = await webStore()
    await signIn(store)
    for (const card of cards) await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    const served = relay({ source: "export const source = true" })
    const controller = createAppController(store, silentAgent, served.services)
    return { store, controller, reads: served.reads }
  }
  const view = (store: Awaited<ReturnType<typeof webStore>>, id: string) => {
    const card = store.collections.cards.get(id)
    return card?.kind === "run-trace" ? card.payload.graph : undefined
  }

  test.each([
    ["different workspaces", trace("a", REPO, workspaceA), trace("b", REPO, workspaceB)],
    ["different repositories", trace("a", REPO, workspaceA), trace("b", "another/repository", workspaceA)],
    ["legacy and bound gateways", trace("a"), trace("b", REPO, workspaceA)],
  ] as const)("unqualified selection and tabs refuse %s without modifying either graph", async (_name, first, second) => {
    const { store, controller, reads } = await ready([first, second])
    expect(said(await controller.commands.run("runs.graph.select", `${RUN} steady`))).toContain("conflicting")
    expect(said(await controller.commands.run("runs.graph.tab", `${RUN} code`))).toContain("conflicting")
    await settle(10)
    expect(view(store, first.id)).toEqual(first.payload.graph)
    expect(view(store, second.id)).toEqual(second.payload.graph)
    expect(reads).toHaveLength(0)
  })

  test("a conflicting listing also refuses rather than overriding its recorded gateway", async () => {
    const first = trace("a", REPO, workspaceA)
    const listing: Card = { id: "other-list", kind: "run-list", title: "Other runs", status: "acted", createdAt: 1, ordinal: 2,
      payload: { repo: REPO, workspaceId: workspaceB, gatewayBindingVersion: 1,
        runs: [{ runId: RUN, flowId: FLOW, status: "completed", createdAt: 1, turns: 0, calls: 0 }] } }
    const { store, controller } = await ready([first, listing])
    expect(said(await controller.commands.run("runs.graph.select", `${RUN} steady`))).toContain("conflicting")
    expect(view(store, first.id)).toEqual(first.payload.graph)
  })

  test("explicit source cards select exactly their run despite another matching ID", async () => {
    const first = trace("a", REPO, workspaceA)
    const second = trace("b", REPO, workspaceB)
    const { store, controller } = await ready([first, second])
    expect(said(await controller.commands.run("runs.graph.select", `sourceCard=b ${RUN} steady`))).toContain("graph-select")
    expect(said(await controller.commands.run("runs.graph.tab", `sourceCard=b ${RUN} events`))).toContain("graph-tab")
    expect(view(store, first.id)).toEqual(first.payload.graph)
    expect(view(store, second.id)).toEqual({ node: "steady", tab: "events" })
    expect(said(await controller.commands.run("runs.graph.select", `sourceCard=missing ${RUN} gate`))).toContain("Open the run first")
    expect(said(await controller.commands.run("runs.graph.select", `sourceCard=b another-run gate`))).toContain("Open the run first")
    expect(view(store, second.id)).toEqual({ node: "steady", tab: "events" })
  })

  test("duplicate views of one recorded run retain deterministic selection", async () => {
    const first = trace("a", REPO, workspaceA)
    const second = trace("b", REPO, workspaceA)
    const { store, controller } = await ready([second, first])
    expect(said(await controller.commands.run("runs.graph.select", `${RUN} steady`))).toContain("graph-select")
    expect(view(store, first.id)?.node).toBe("steady")
    expect(view(store, second.id)).toEqual(second.payload.graph)
  })
})

for (const kind of ["plan", "run"] as const) {
  const ready = async (readGate?: Promise<void>) => {
    const options = { sites: [{ id: "gate", declaredAt: { path: "flows/review/flow.ts", line: 1 } }], source: "export const gate = true", readGate }
    const seed = await (kind === "plan" ? planned(options) : launched(options))
    const original = kind === "plan" ? planCard(seed.store)! : runCard(seed.store)!
    const view = { node: "gate", tab: "declaration" as const }
    const card = original.kind === "flow-plan" ? { ...original, payload: { ...original.payload, view } }
      : { ...original, payload: { ...original.payload, graph: view } }
    const backing = memoryStorage()
    let refuse = false
    let refused = 0
    const marker = JSON.stringify('"tab":"code"').slice(1, -1)
    const storage = { ...backing, setItem: (key: string, value: string) => {
      if (refuse && key.endsWith(".staged") && value.includes(marker)) {
        refuse = false
        refused += 1
        throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError", code: 22 })
      }
      backing.setItem(key, value)
    } }
    const store = await createAppStore({ kind: "localStorage", storage })
    await signIn(store)
    await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    const served = relay(options)
    const controller = createAppController(store, silentAgent, served.services)
    const flow = kind === "plan" ? "flow.plan.tab" : "runs.graph.tab"
    const tab = (value = "code") => controller.commands.run(flow, kind === "plan" ? `${card.id} ${value}` : `sourceCard=${card.id} ${RUN} ${value}`)
    const shown = (from = store) => {
      const current = from.collections.cards.get(card.id)
      return current?.kind === "flow-plan" ? current.payload.view : current?.kind === "run-trace" ? current.payload.graph : undefined
    }
    const hold = () => {
      const gate = Promise.withResolvers<void>()
      const dispatch = store.dispatch
      let held = false
      Object.assign(store, { dispatch: (transition: Parameters<typeof dispatch>[0]) => {
        const transaction = dispatch(transition)
        if (!held && transition.type === "card.updated" && transition.id === card.id) {
          held = true
          return { ...transaction, isPersisted: { promise: transaction.isPersisted.promise.then(() => gate.promise) } }
        }
        return transaction
      } })
      return { release: gate.resolve, held: () => held, restore: () => Object.assign(store, { dispatch }) }
    }
    return { store, controller, storage, card, services: served.services, reads: served.reads, tab, shown, hold, refuse: () => { refuse = true }, refused: () => refused }
  }

  test(`${kind}: tab acknowledgment and declaration read wait for storage, not the source response`, async () => {
    const source = Promise.withResolvers<void>()
    const fixture = await ready(source.promise)
    const held = fixture.hold()
    let answered = false
    try {
      const result = fixture.tab().then(result => { answered = true; return result })
      await waitFor(held.held)
      await settle(15)
      expect(answered).toBe(false)
      expect(fixture.reads).toHaveLength(0)
      await fixture.store.dispatch({ type: "composer.changed", actor: "user", draft: "Chat while the tab saves" }).isPersisted.promise
      held.release()
      expect(said(await result)).toContain("tab=")
      await waitFor(() => fixture.reads.length === 1)
      expect(answered).toBe(true)
      expect(fixture.shown()?.tab).toBe("code")
    } finally { held.release(); held.restore(); source.resolve() }
  })

  test(`${kind}: refused tab storage fails visibly, reads nothing, and preserves the previous tab on reload`, async () => {
    const fixture = await ready()
    fixture.refuse()
    const result = await fixture.tab()
    await settle(15)
    expect(fixture.refused()).toBe(1)
    expect(result.status).toBe("failed")
    expect(said(result)).toMatch(/not.*saved/)
    expect(fixture.reads).toHaveLength(0)
    expect(fixture.shown()?.tab).toBe("declaration")
    await fixture.controller.dispose()
    await fixture.store.dispose?.()
    const restored = await createAppStore({ kind: "localStorage", storage: fixture.storage })
    const retry = createAppController(restored, silentAgent, fixture.services)
    try {
      expect(fixture.shown(restored)?.tab).toBe("declaration")
      const result = await retry.commands.run(kind === "plan" ? "flow.plan.tab" : "runs.graph.tab",
        kind === "plan" ? `${fixture.card.id} code` : `sourceCard=${fixture.card.id} ${RUN} code`)
      expect(said(result)).toContain("tab=code")
      await waitFor(() => fixture.reads.length === 1)
    } finally { await retry.dispose(); await restored.dispose?.() }
  })

  test(`${kind}: a successful tab choice is restored after immediate reload`, async () => {
    const fixture = await ready()
    expect(said(await fixture.tab("events"))).toContain("tab=events")
    await fixture.controller.dispose()
    await fixture.store.dispose?.()
    const restored = await createAppStore({ kind: "localStorage", storage: fixture.storage })
    try { expect(fixture.shown(restored)?.tab).toBe("events") } finally { await restored.dispose?.() }
  })

  test(`${kind}: an account change during the tab receipt cannot launch an old declaration read`, async () => {
    const fixture = await ready()
    const held = fixture.hold()
    try {
      const result = fixture.tab()
      await waitFor(held.held)
      await fixture.controller.adoptSession({ state: "signed-in", login: "another-owner", allowlisted: true, admin: false })
      const card = fixture.card.kind === "flow-plan"
        ? { ...fixture.card, payload: { ...fixture.card.payload, view: { node: "gate", tab: "code" as const } } }
        : { ...fixture.card, payload: { ...fixture.card.payload, graph: { node: "gate", tab: "code" as const } } }
      await fixture.store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
      held.release()
      await result
      await settle(15)
      expect(fixture.reads).toHaveLength(0)
    } finally { held.release(); held.restore() }
  })
}
