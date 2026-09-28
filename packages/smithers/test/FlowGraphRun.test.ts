/**
 * What a live plan graph can honestly be built from, proven on a real stack.
 *
 * The flow builder wants six facts: a plan whose nodes have stable ids, node
 * lifecycle that reaches a client, an approval gate on the card, an attempt
 * count for a retried step, a cache verdict on a second run, and a way to join
 * a node's output back to the plan node that produced it. Every assertion below
 * is over `BridgedEngineRun.ts`: a real control plane, a real engine, two
 * SQLite files, and the `EngineJournalSupervisor` bridge a deployed host wires.
 *
 * All six hold. The node lifecycle arrives under the plan's own ids, with the
 * driven graph, its labelled edges and each node's declaration site beside it,
 * and a second run is served the cacheable node from the step cache as soon as
 * the host declares a cache environment; with no environment declared nothing
 * here can address an earlier run's row, so no node is ever `clean`. A node's
 * settlement names the step key digests it dispatched under, which is what
 * joins the attempt records — keyed by digest, carrying no node id — back to
 * the node that drove them, and it carries the engine's own attempt count, so
 * the retried step settles at two. Every assertion is what this stack does, so
 * the UI lanes build only on what passes here.
 */
import { Control } from "@smthrs/control/Control"
import type { ApprovalPayload, ControlEvent, PlanCard, RunSummary } from "@smthrs/control/ControlSchema"
import type * as GatewayProjection from "@smthrs/gateway/GatewayProjection"
import { Projections } from "@smthrs/gateway/Projections"
import * as PlanDiff from "@smthrs/plan/PlanDiff"
import { Effect, type Scope } from "effect"
import { describe, expect, it } from "vitest"
import {
  bridgeSettledKind,
  Engine,
  fixtureSchedule,
  flowId,
  gatePrompt,
  planOf,
  relayPrincipal,
  runOn,
  stack,
  stackWith
} from "./BridgedEngineRun.ts"

const approvalOf = (card: PlanCard): ApprovalPayload => ({
  target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
  scope: card.approval.scope,
  idempotencyKey: `approve:${card.planId}`
})

/** Plans, approves and launches the fixture, returning the card and the run id. */
const launch = (label: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const card = yield* control.plan({ flowId, input: { label } })
    // As the relay submits it. A browser holds no gateway credential, so every
    // decision a card makes arrives stamped with the gateway's bearer
    // identity, and an authority that knows only the local operator refuses it.
    yield* control.approve({ ...approvalOf(card), principal: relayPrincipal })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${card.planId}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
    return { card, runId: receipt.runId }
  })

/**
 * The run once its gate is parked: the engine has admitted the wrapper, the
 * gate's execution holds an open human wait, and the control plane has
 * observed it. Polling the status row alone would race the observation.
 */
const parked = (label: string) =>
  Effect.gen(function*() {
    const engine = yield* Engine
    const launched = yield* launch(label)
    const wait = yield* engine.parkedBelow(launched.runId)
    return { ...launched, wait }
  })

/** Answers the gate the way the card does, then waits for the run to settle. */
const answerAndSettle = (runId: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const engine = yield* Engine
    yield* control.signal({
      runId,
      signal: { name: "graph-gate", payload: "merged" },
      idempotencyKey: `gate:${runId}`
    })
    return yield* engine.settled(runId)
  })

/**
 * The run's control events once the bridge has drained the engine's journal.
 *
 * The control plane settles a run from its own observation of the engine, and
 * the copy runs on a separate fiber afterwards. A read taken on the status
 * would race the records it is about to assert over, so this waits for the
 * bridge's own settled marker instead.
 */
const drained = (
  runId: string,
  attempts = 2_000
): Effect.Effect<ReadonlyArray<ControlEvent>, never, Projections> =>
  Effect.gen(function*() {
    const projections = yield* Projections
    const events = (yield* Effect.orDie(projections.snapshot({ _tag: "run-events", runId }))).rows
    if (events.some((event) => event.kind === bridgeSettledKind)) return events
    if (attempts <= 0) return yield* Effect.die(`the bridge never drained ${runId}`)
    yield* Effect.sleep("5 millis")
    return yield* drained(runId, attempts - 1)
  })

/** One bridged engine record, unwrapped from its `control.engine.event` envelope. */
interface Bridged {
  readonly executionId: string
  readonly eventType: string
  readonly payload: Readonly<Record<string, unknown>>
}

const bridgedOf = (events: ReadonlyArray<ControlEvent>): ReadonlyArray<Bridged> =>
  events.filter((event) => event.kind === "control.engine.event")
    .map((event) => event.payload as unknown as Bridged)

/**
 * The execution that drove the fixture's own graph.
 *
 * One control run is four engine executions: the `agent/run` wrapper, the
 * fixture, and the two boundaries the gate is nested behind. Each one records
 * its own plan and its own node lifecycle, and only one of them drove the
 * eleven nodes the card was drawn from, so a suite that folded them together
 * would assert over a graph no card shows.
 */
const graphExecution = (bridged: ReadonlyArray<Bridged>): string => {
  const recorded = bridged.find((record) =>
    record.eventType === "flows.engine.plan-recorded" && record.payload.flow === flowId
  )
  if (recorded === undefined) throw new Error(`no execution recorded a plan for ${flowId}`)
  return recorded.executionId
}

const summaryOf = (runId: string): Effect.Effect<RunSummary | undefined, never, Control> =>
  Effect.gen(function*() {
    const control = yield* Control
    const listed = yield* Effect.orDie(control.list({ _tag: "runs", filters: { runId } }))
    return listed._tag === "runs" ? listed.items[0] : undefined
  })

/** One scenario over its own stack: two fresh databases, torn down with the scope. */
const scenario = <E>(
  title: string,
  body: () => Effect.Effect<void, E, Control | Projections | Engine | Scope.Scope>,
  host: typeof stack = stack
) => it(title, { timeout: 120_000 }, () => runOn(host, body()))

/**
 * The environment a host would declare about itself, complete by contract.
 *
 * `Action.CacheEnvironment` is complete-or-absent on purpose: a partial one
 * would assert this composition grants nothing, which is false for any host
 * holding a capability envelope. The fixture's actions touch no file and hold
 * no capability, so the empty set is the true one here.
 */
const fixtureEnvironment = { layers: ["gateway/graph-fixture/v1"], capabilities: {} } as const

/** The step key digests one node-settled record claims, and the node that claims them. */
const digestsOf = (record: Bridged): ReadonlyArray<string> =>
  (record.payload.stepKeyDigests ?? []) as ReadonlyArray<string>

/** The node-settled outcome the engine recorded for each fixture action. */
const settledByAction = (runId: string) =>
  Effect.map(drained(runId), (events) =>
    Object.fromEntries(
      bridgedOf(events)
        .filter((record) => record.eventType === "flows.engine.node-settled" && record.payload.action !== undefined)
        .map((record) => [String(record.payload.action), String(record.payload.outcome)])
    ))

describe("a live plan graph over a bridged real engine", () => {
  scenario(
    "plans a non-empty graph whose node ids are stable across two plans of the same input",
    () =>
      Effect.gen(function*() {
        const control = yield* Control
        const first = yield* control.plan({ flowId, input: { label: "stable" } })
        const second = yield* control.plan({ flowId, input: { label: "stable" } })

        expect(first.nodes.length).toBeGreaterThan(0)
        expect(first.nodes.map((node) => node.id)).toEqual(second.nodes.map((node) => node.id))
        // Ids are lookup addresses, keys are content. A graph a card can draw
        // twice needs both to hold, or the second draw is a different graph.
        expect(first.nodes.map((node) => node.key)).toEqual(second.nodes.map((node) => node.key))
        expect(new Set(first.nodes.map((node) => node.id)).size).toBe(first.nodes.length)
        // Edges are what makes it a graph rather than a list.
        expect(first.nodes.some((node) => node.dependsOn.length > 0)).toBe(true)
      })
  )

  scenario("takes a plan approval from the identity the relay authenticates as", () =>
    Effect.gen(function*() {
      const control = yield* Control
      const card = yield* control.plan({ flowId, input: { label: "authority" } })

      // `NativeGateway.layerAuth` stamps every credentialled call with this
      // identity, and a host delegates its operator's decisions to it. Without
      // that delegation the stack plans, lists and runs over the relay and
      // refuses the one call that launches anything.
      const receipt = yield* control.approve({ ...approvalOf(card), principal: relayPrincipal })
      expect(receipt._tag).toBe("Accepted")
    }))

  scenario("serves the nested gate through the run-scoped approvals projection", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const { runId } = yield* parked("gate")

      const rows = (yield* projections.snapshot({ _tag: "approvals", runId }))
        .rows as ReadonlyArray<GatewayProjection.ApprovalRow>
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ requestId: "graph-gate#1", title: gatePrompt, status: "pending" })
      // The wait is held by an execution the control plane's database has
      // never heard of, which is what the bridge and the observation port are
      // for.
      expect(rows[0]?.waitRunId).not.toBe(rows[0]?.runId)
    }))

  scenario(
    "bridges the engine's own records into the run's events, which no unbridged stack does",
    () =>
      Effect.gen(function*() {
        const engine = yield* Engine
        const { runId } = yield* parked("bridge")
        expect(yield* answerAndSettle(runId)).toBe("completed")

        const engineKinds = yield* engine.kinds(runId)
        expect(engineKinds).toContain("flows.engine.run-decision")

        const events = yield* drained(runId)
        expect(events.map((event) => event.kind)).toContain("control.engine.event")
        const bridged = events.filter((event) => event.kind === "control.engine.event")
          .map((event) => (event.payload as { readonly eventType?: string }).eventType)
        expect(bridged).toContain("flows.engine.run-decision")
      })
  )

  scenario(
    "runs the retried step twice and the recovered step once, and merges the fan-out",
    () =>
      Effect.gen(function*() {
        const engine = yield* Engine
        const { runId } = yield* parked("retry")
        expect(yield* answerAndSettle(runId)).toBe("completed")

        // The injected counter decides the first failure, so this is the
        // composition's own retry and not a flake.
        expect(engine.dispatches.counts.get("flaky")).toBe(2)
        expect(engine.dispatches.counts.get("doomed")).toBe(1)
        expect(engine.dispatches.counts.get("steady")).toBe(1)
        expect(engine.dispatches.counts.get("cacheable")).toBe(1)

        const summary = yield* summaryOf(runId)
        expect(summary?.status).toBe("completed")
      })
  )

  scenario("carries the retried step's two attempts to the client, keyed by step digest", () =>
    Effect.gen(function*() {
      const { runId } = yield* parked("attempts")
      expect(yield* answerAndSettle(runId)).toBe("completed")

      const started = bridgedOf(yield* drained(runId))
        .filter((record) => record.eventType === "flows.engine.attempt-started")
      const byStep = new Map<string, Array<number>>()
      for (const record of started) {
        const step = String(record.payload.stepKeyDigest)
        byStep.set(step, [...byStep.get(step) ?? [], Number(record.payload.attempt)])
      }
      const retried = [...byStep.entries()].filter(([, attempts]) => attempts.length > 1)
      // Exactly one step in this graph is retried, and its second attempt is
      // numbered. This is the number a drawer would render as "attempt 2".
      expect(retried).toHaveLength(1)
      expect(retried[0]?.[1]).toEqual([1, 2])

      const finished = bridgedOf(yield* drained(runId))
        .filter((record) =>
          record.eventType === "flows.engine.attempt-finished" &&
          record.payload.stepKeyDigest === retried[0]?.[0]
        )
        .map((record) => [record.payload.attempt, record.payload.state])
      expect(finished).toEqual([[1, "failed"], [2, "succeeded"]])
    }))

  scenario(
    "records a cache row on both runs under two addresses, so neither run can serve the other",
    () =>
      Effect.gen(function*() {
        const engine = yield* Engine
        const first = yield* parked("cache")
        expect(yield* answerAndSettle(first.runId)).toBe("completed")
        const afterFirst = new Map(engine.dispatches.counts)

        const second = yield* parked("cache")
        expect(yield* answerAndSettle(second.runId)).toBe("completed")

        // The control plane issued the same graph twice: the same input keys the
        // same nodes, which is what a cache-hit prediction would be read off.
        expect(second.card.nodes.map((node) => node.key)).toEqual(first.card.nodes.map((node) => node.key))

        // The engine disagrees, and this is the record that says why. The
        // cacheable step is cache-eligible by the engine's own rule, so each run
        // consults the store and journals the row it recorded. The two rows carry
        // different addresses: a composition that installs no complete
        // `Action.CacheEnvironment` folds the execution id into the dispatch key
        // (`@smthrs/engine` `FlowEngine/ActionKey.actionKey`), and this stack
        // installs none, as every host in this repo composes it. A second run
        // therefore cannot address the first run's row, whatever the plan says.
        // The scenario below runs the same fixture over the same stack with an
        // environment declared, and the cacheable node settles `clean` there.
        const recordedKeys = (runId: string) =>
          Effect.map(drained(runId), (events) =>
            bridgedOf(events)
              .filter((record) =>
                record.eventType === "flows.engine.cache-provenance" && record.payload.action === "recorded"
              )
              .map((record) => String(record.payload.keyDigest)))
        const firstKeys = yield* recordedKeys(first.runId)
        const secondKeys = yield* recordedKeys(second.runId)
        expect(firstKeys).toHaveLength(1)
        expect(secondKeys).toHaveLength(1)
        expect(secondKeys[0]).not.toBe(firstKeys[0])

        // So every step ran again, and the predicted cache-hit count is zero
        // however the prediction is computed. L7's count needs a cache the engine
        // can actually address across runs, not a plan-key comparison.
        for (const step of ["steady", "doomed", "cacheable"]) {
          expect(engine.dispatches.counts.get(step)).toBe((afterFirst.get(step) ?? 0) + 1)
        }
        // `flaky` re-dispatches once too, not twice: the injected counter is
        // shared across both runs, so the second run's first attempt is dispatch
        // three and succeeds. L4 and L5 must not expect "attempt 2" on a rerun of
        // this fixture.
        expect(engine.dispatches.counts.get("flaky")).toBe((afterFirst.get("flaky") ?? 0) + 1)
      })
  )

  scenario(
    "serves the cacheable node from the step cache on a second run once the host declares an environment",
    () =>
      Effect.gen(function*() {
        const engine = yield* Engine
        const first = yield* parked("declared")
        expect(yield* answerAndSettle(first.runId)).toBe("completed")
        expect(yield* settledByAction(first.runId)).toMatchObject({
          "gateway/graph/Cacheable": "built",
          "gateway/graph/Steady": "built"
        })
        const afterFirst = new Map(engine.dispatches.counts)

        const second = yield* parked("declared")
        expect(yield* answerAndSettle(second.runId)).toBe("completed")

        // The claim the product is built on, on a real bridged stack: the
        // second run addressed the FIRST run's row, replayed it, and the
        // interpreter reported a node that dispatched nothing of its own.
        expect(yield* settledByAction(second.runId)).toMatchObject({
          "gateway/graph/Cacheable": "clean",
          "gateway/graph/Steady": "built"
        })
        // And the body is what proves it, not the label: the implementation
        // was never entered a second time.
        expect(engine.dispatches.counts.get("cacheable")).toBe(afterFirst.get("cacheable"))
        // Nothing else is served. `steady` and `doomed` declare no
        // idempotency key, so their keys stay invocation-scoped whatever the
        // environment says, and they run again.
        for (const step of ["steady", "doomed"]) {
          expect(engine.dispatches.counts.get(step)).toBe((afterFirst.get(step) ?? 0) + 1)
        }

        // Both runs addressed ONE row, which is the difference from the
        // stack above: there the two addresses differed and neither run could
        // read the other's.
        const recordedKeys = (runId: string) =>
          Effect.map(drained(runId), (events) =>
            bridgedOf(events)
              .filter((record) =>
                record.eventType === "flows.engine.cache-provenance" && record.payload.action === "recorded"
              )
              .map((record) => String(record.payload.keyDigest)))
        expect(yield* recordedKeys(first.runId)).toHaveLength(1)
        expect(yield* recordedKeys(second.runId)).toHaveLength(0)
      }),
    stackWith({ cacheEnvironment: fixtureEnvironment })
  )

  scenario(
    "joins every attempt record to the plan node that dispatched it, and still serves no node output",
    () =>
      Effect.gen(function*() {
        const { card, runId } = yield* parked("join")
        expect(yield* answerAndSettle(runId)).toBe("completed")

        const bridged = bridgedOf(yield* drained(runId))
        expect(bridged.length).toBeGreaterThan(0)

        // The node records join: every id they name is the plan's own.
        const named = new Set(
          bridged
            .filter((record) =>
              record.eventType === "flows.engine.node-scheduled" ||
              record.eventType === "flows.engine.node-settled"
            )
            .map((record) => String(record.payload.nodeId))
        )
        for (const id of card.nodes.map((node) => node.id)) expect(named.has(id)).toBe(true)

        // THE JOIN. An attempt record still carries a step key digest and no
        // node id — it is written under the dispatch, which knows no graph —
        // but a node's settlement now names the digests it dispatched under,
        // so every attempt belongs to exactly one node of one execution and
        // "attempt 2 of this node" is derivable from the pair.
        const attempts = bridged.filter((record) => record.eventType === "flows.engine.attempt-started")
        expect(attempts.length).toBeGreaterThan(0)
        for (const record of attempts) {
          expect(record.payload.stepKeyDigest).toEqual(expect.any(String))
          expect(record.payload.nodeId).toBeUndefined()
        }
        const settled = bridged.filter((record) => record.eventType === "flows.engine.node-settled")
        const claimed = new Map<string, string>()
        let claims = 0
        for (const record of settled) {
          for (const digest of digestsOf(record)) {
            claims++
            claimed.set(`${record.executionId}/${digest}`, String(record.payload.nodeId))
          }
        }
        expect(claimed.size).toBeGreaterThan(0)
        // EXACTLY one node. A second claim on the same key would overwrite the
        // first and leave the map looking well formed, so the claims MADE and
        // the keys HELD are what have to agree.
        expect(claimed.size).toBe(claims)
        for (const record of attempts) {
          expect(claimed.get(`${record.executionId}/${String(record.payload.stepKeyDigest)}`))
            .toEqual(expect.any(String))
        }
        // A node that dispatched nothing claims no digest, so a map or a join
        // node is never handed another node's attempts.
        const dispatching = new Set(
          bridged
            .filter((record) =>
              record.eventType === "flows.engine.node-scheduled" && record.payload.kind === "ActionCall"
            )
            .map((record) => `${record.executionId}/${String(record.payload.nodeId)}`)
        )
        for (const record of settled) {
          expect(digestsOf(record).length > 0)
            .toBe(dispatching.has(`${record.executionId}/${String(record.payload.nodeId)}`))
        }

        // And the node-output projection is still empty: it keys rows off the
        // `control.agent.cell-call-*` records only an agent run writes, and
        // that projection reads no node record. The Output tab reads the
        // settlement's own bounded result instead, asserted below.
        const projections = yield* Projections
        const rows = (yield* projections.snapshot({
          _tag: "node-output",
          runId,
          nodeId: card.nodes[0]?.id ?? "root"
        })).rows
        expect(rows).toEqual([])
      })
  )

  scenario(
    "reports the same plan for the same input, so PlanDiff calls every node unchanged",
    () =>
      Effect.gen(function*() {
        const before = yield* Effect.orDie(planOf({ label: "rekey" }, "flow-graph-rekey"))
        const after = yield* Effect.orDie(planOf({ label: "rekey" }, "flow-graph-rekey"))
        const edited = yield* Effect.orDie(planOf({ label: "edited" }, "flow-graph-rekey"))

        expect(PlanDiff.diff(before, after)).toEqual({
          added: [],
          removed: [],
          rekeyed: [],
          unchanged: before.nodes.map((node) => node.id)
        })
        // An edited input re-keys rather than adding or removing: the graph's
        // shape is the flow's, and the input only changes what the nodes carry.
        const changed = PlanDiff.diff(before, edited)
        expect(changed.added).toEqual([])
        expect(changed.removed).toEqual([])
        expect(changed.rekeyed.length).toBeGreaterThan(0)
      })
  )

  scenario(
    "carries node-scheduled and node-settled envelopes for the plan's own node ids",
    () =>
      Effect.gen(function*() {
        const { card, runId } = yield* parked("lifecycle")
        expect(yield* answerAndSettle(runId)).toBe("completed")

        const bridged = bridgedOf(yield* drained(runId))
        const execution = graphExecution(bridged)
        // One ordered stream, so "before" is a fact about the history rather
        // than about two arrays that were filtered apart.
        const lifecycle = bridged
          .filter((record) =>
            record.executionId === execution &&
            (record.eventType === "flows.engine.node-scheduled" ||
              record.eventType === "flows.engine.node-settled")
          )
          .map((record) => ({ eventType: record.eventType, nodeId: String(record.payload.nodeId) }))
        const idsOf = (eventType: string) =>
          lifecycle.filter((record) => record.eventType === eventType).map((record) => record.nodeId)

        // The same ids in both directions and in the card: a drawer that keyed
        // its nodes off the plan can move every one of them from the run.
        const planned = card.nodes.map((node) => node.id)
        expect(idsOf("flows.engine.node-scheduled").sort()).toEqual([...planned].sort())
        expect(idsOf("flows.engine.node-settled").sort()).toEqual([...planned].sort())
        // Scheduled before settled for every node, which is what a status that
        // advances rather than jumps needs.
        for (const id of planned) {
          const scheduledAt = lifecycle.findIndex((record) =>
            record.nodeId === id && record.eventType === "flows.engine.node-scheduled"
          )
          const settledAt = lifecycle.findIndex((record) =>
            record.nodeId === id && record.eventType === "flows.engine.node-settled"
          )
          expect(scheduledAt).toBeGreaterThanOrEqual(0)
          expect(scheduledAt).toBeLessThan(settledAt)
        }
      })
  )

  scenario(
    "records the driven graph beside the run, with the plan's ids and labelled edges",
    () =>
      Effect.gen(function*() {
        const { card, runId } = yield* parked("graph")
        expect(yield* answerAndSettle(runId)).toBe("completed")

        const bridged = bridgedOf(yield* drained(runId))
        const recorded = bridged.filter((record) =>
          record.eventType === "flows.engine.plan-recorded" && record.payload.flow === flowId
        )
        expect(recorded).toHaveLength(1)
        const graph = recorded[0]?.payload.graph as {
          readonly nodes: ReadonlyArray<Record<string, unknown>>
          readonly edges?: ReadonlyArray<{ readonly from: string; readonly to: string; readonly reason: string }>
        }
        expect(graph.nodes.map((node) => node["id"])).toEqual(card.nodes.map((node) => node.id))
        // `nodes` on the record stays the COUNT it has always been; the list
        // rides beside it.
        expect(recorded[0]?.payload.nodes).toBe(card.nodes.length)

        // Edges are the interpreter's own, and it knows the reason it drew
        // each one. A plan knows only `dependsOn`, so this is the one writer
        // that can label them.
        const edges = graph.edges ?? []
        expect(edges.length).toBeGreaterThan(0)
        expect(new Set(edges.map((edge) => edge.reason))).toEqual(new Set(["value", "continuation", "failure"]))
        for (const edge of edges) {
          expect(card.nodes.map((node) => node.id)).toContain(edge.from)
          expect(card.nodes.map((node) => node.id)).toContain(edge.to)
        }

        // Provenance, and repo-relative by contract: a journal is read on
        // machines that did not write it, so an absolute path is at best noise
        // and at worst an operator's home directory in a run's history.
        //
        // The path is the REPOSITORY's, not the caller's. `declarationRoot`
        // defaults to the process working directory, and this stack is run
        // from three of them — `packages/smithers` under vitest, `apps/app`
        // under the flow-graph host, the repository root under a bare node —
        // so a stack that took the default would record a different path each
        // time, and from `apps/app` no path at all, because the fixture is not
        // under it. A reader who cannot spell the path cannot open the file.
        const declared = graph.nodes
          .map((node) => node["declaredAt"] as { readonly path: string; readonly line: number } | undefined)
          .filter((site) => site !== undefined)
        expect(declared.length).toBeGreaterThan(0)
        for (const site of declared) {
          expect(site.path).toBe("packages/smithers/test/BridgedEngineRun.ts")
          expect(site.line).toBeGreaterThan(0)
        }
      })
  )

  scenario(
    "settles the retried node at its real attempt count, and never clean",
    () =>
      Effect.gen(function*() {
        const { card, runId } = yield* parked("outcome")
        expect(yield* answerAndSettle(runId)).toBe("completed")

        const bridged = bridgedOf(yield* drained(runId))
        const execution = graphExecution(bridged)
        const settled = bridged.filter((record) =>
          record.executionId === execution && record.eventType === "flows.engine.node-settled"
        )
        // One settlement per plan node, scoped to the execution that drove
        // this graph: a node id addresses a node WITHIN one graph, and this
        // run drives four executions that each name a node `root`.
        expect(settled.length).toBe(card.nodes.length)

        // `attempts` is the ENGINE's count of the node's dispatches, not the
        // walk's count of the node: the interpreter settles each node once,
        // and a retry happens underneath it inside one dispatch, so the count
        // has to come up from the dispatch. The retried node ran twice and
        // says two; every other node ran once and says one.
        const retried = settled.find((record) => record.payload.action === "gateway/graph/Flaky")
        expect(retried?.payload.attempts).toBe(2)
        expect(
          new Set(
            settled
              .filter((record) => record.payload.action !== "gateway/graph/Flaky")
              .map((record) => record.payload.attempts)
          )
        ).toEqual(new Set([1]))
        // And the attempt records under the retried node's own digest are the
        // two the count names, in order.
        const retriedDigest = digestsOf(retried!)[0]
        expect(retriedDigest).toEqual(expect.any(String))
        expect(
          bridged
            .filter((record) =>
              record.eventType === "flows.engine.attempt-started" &&
              record.payload.stepKeyDigest === retriedDigest
            )
            .map((record) => record.payload.attempt)
        ).toEqual([1, 2])

        // What each node settled with, bounded and redacted by the journal's
        // own write path. A built node carries its value; the node the catch
        // arm recovered carries the typed failure it raised.
        const steady = settled.find((record) => record.payload.action === "gateway/graph/Steady")
        expect((steady?.payload.result as { readonly preview: string }).preview).toContain("steady:outcome")
        const doomedResult = settled.find((record) => record.payload.action === "gateway/graph/Doomed")
        expect((doomedResult?.payload.result as { readonly preview: string }).preview)
          .toContain("doomed:outcome")

        // The outcomes are the walk's own: `built` ran, `failed` raised. No
        // node is `clean`, because `clean` means every dispatch was served
        // from durable records and this composition declares no cache
        // environment, so it can address no earlier run's row (D-044). A card
        // must not render a cache verdict from a host that declared none; the
        // scenario above shows what a host that declares one gets.
        expect(new Set(settled.map((record) => record.payload.outcome))).toEqual(new Set(["built", "failed"]))
        expect(settled.some((record) => record.payload.outcome === "clean")).toBe(false)
        // Exactly one node raised, and the catch arm carried the run past it.
        expect(settled.filter((record) => record.payload.outcome === "failed")).toHaveLength(1)
        const doomed = settled.find((record) => record.payload.action === "gateway/graph/Doomed")
        expect(doomed?.payload.outcome).toBe("failed")
        // And the arm that recovered it still settled, so a failed node is not
        // a failed run.
        expect(settled.find((record) => record.payload.nodeId === "root")?.payload.outcome).toBe("built")
      })
  )

  /*
   * The dispatcher half. A schedule is not a plan node (D-031): it is a row in
   * a trigger store, and `Control.list { _tag: "triggers" }` is the only way
   * a client reads one. A composition with no trigger store REFUSES that
   * listing rather than answering an empty page, so a host that wants a
   * dispatcher has to hold one.
   */
  scenario(
    "lists the schedule its trigger store holds, with the occurrences its cron computes",
    () =>
      Effect.gen(function*() {
        const control = yield* Control
        const listed = yield* Effect.orDie(control.list({ _tag: "triggers" }))
        expect(listed._tag).toBe("triggers")
        const rows = listed._tag === "triggers" ? listed.items : []
        expect(rows.map((row) => row.triggerId)).toEqual([fixtureSchedule.id])
        const row = rows[0]!
        expect(row.flowId).toBe(flowId)
        expect(row.cron).toBe(fixtureSchedule.cron)
        expect(row.enabled).toBe(true)
        // The five upcoming occurrences the reader computes from the cron
        // itself, in time order and all in the future. Nothing here is a
        // stored field: an occurrence is what the schedule WILL do.
        expect(row.nextOccurrencesMs).toHaveLength(5)
        expect([...row.nextOccurrencesMs!]).toEqual([...row.nextOccurrencesMs!].sort((a, b) => a - b))
        expect(row.nextOccurrencesMs![0]!).toBeGreaterThan(Date.now())
        // No scheduler ticks on this host, so the row says nothing about one:
        // an armed schedule nobody polls is not a schedule about to fire.
        expect(row.schedulerLastTickMs).toBeUndefined()
        expect(row.activeRunId).toBeUndefined()
        expect(row.pendingAtMs).toBeUndefined()
      })
  )
})
