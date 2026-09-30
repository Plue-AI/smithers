/**
 * The workspace approvals inbox over a nested human wait, on a control plane
 * that shares the engine's database and so lists every execution of the tree.
 *
 * `@smthrs/control` rolls a nested wait onto the execution holding it AND onto
 * every ancestor, and the SQL listing returns them newest first: the leaf, the
 * execution between, then the root. The inbox is a list of questions, so it
 * must list this one once, owned by the root, whichever read produced it. A
 * subscription's first delta once listed it three times while a fresh snapshot
 * listed it once, owned by the leaf (#2658).
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Control } from "@smthrs/control/Control"
import * as ControlLive from "@smthrs/control/ControlLive"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as OwnerIdentity from "@smthrs/engine-store/OwnerIdentity"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Action, Flow, HumanTask, Interpreter } from "@smthrs/flow"
import type * as GatewayProjection from "@smthrs/gateway/GatewayProjection"
import * as Projections from "@smthrs/gateway/Projections"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Jj } from "@smthrs/kernel"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"

const prompt = "Which service?"

const Leaf = Flow.make("inbox/Leaf", {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => HumanTask.action.call({ name: "review-question", kind: "ask", prompt, maxAttempts: 3 })
})

const Middle = Flow.make("inbox/Middle", {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => Leaf.child({})
})

const Root = Flow.make("inbox/Root", {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => Middle.child({})
})

const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "nested-inbox" as never, changeId: "nested-inbox" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** One database, so the control plane lists every execution the engine spawned. */
const database = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  AttemptStore.layer,
  CacheStore.layer,
  DurableEngineState.layer
).pipe(
  Layer.provideMerge(Layer.effectDiscard(EngineMigrations.run)),
  Layer.provideMerge(Layer.merge(TestDatabase.layer, NodeCrypto.layer))
)

const engine = Layer.mergeAll(
  HumanTask.layer,
  Interpreter.layer(Root),
  Interpreter.layer(Middle),
  Interpreter.layer(Leaf)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(
    EngineStore.layer({
      owner: { hostId: "nested-inbox" },
      journalSource: "nested-inbox",
      isAlive: () => Effect.succeed(false)
    })
  ),
  Layer.provideMerge(Layer.mergeAll(StepBoundary.layerTest(), stubJj, OwnerIdentity.layer))
)

const plane = Layer.provideMerge(
  ControlLive.layer,
  Layer.mergeAll(
    SqlControlRuntime.layer({}).pipe(Layer.orDie),
    NotificationQueue.layer,
    Registry.layerNoop()
  )
)

const stack = Layer.merge(plane, engine).pipe(Layer.provideMerge(database))

/** Polls until an execution below the root holds the human wait. */
const parkedBelow = (rootId: string) =>
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    let holder: DurableEngineState.WaitingRow | undefined
    yield* TestDatabase.until(
      state.waitingTree(rootId).pipe(Effect.map((rows) => {
        holder = rows.find((row) => row.reason === "approval" && row.runId !== rootId)
        return holder !== undefined
      }))
    )
    return holder!
  })

type Row = GatewayProjection.ApprovalRow

describe("the workspace approvals inbox over a nested human wait", () => {
  it("lists the question once, owned by the root, in the snapshot, the next delta and a fresh snapshot", async () => {
    const observed = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const control = yield* Control
          const journal = yield* Journal.Journal
          yield* Root.execute({}, { executionId: "review-root", discard: true })
          const holder = yield* parkedBelow("review-root")
          const projections = yield* Projections.make(control, { heartbeatMillis: 60_000 })
          const listed = yield* control.list({ _tag: "runs", filters: { status: "waiting-approval" } })
          const before = (yield* projections.snapshot({ _tag: "approvals" })).rows as ReadonlyArray<Row>

          const snapshotEnded = yield* Deferred.make<void>()
          const following = yield* Effect.forkChild(
            projections.subscribe({ _tag: "approvals" }).pipe(
              Stream.tap((frame) =>
                frame._tag === "snapshot-end" ? Deferred.succeed(snapshotEnded, undefined) : Effect.void
              ),
              Stream.filter((frame) => frame._tag === "row" || frame._tag === "delta"),
              Stream.takeUntil((frame) => frame._tag === "delta"),
              Stream.runCollect
            )
          )
          yield* Deferred.await(snapshotEnded)
          yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: JournalEvent.RunId.make("review-root"),
              sourceId: JournalEvent.SourceId.make("review-trigger"),
              eventType: "control.agent.turn-opened",
              payload: { seat: "review", at: 42 }
            })
          )
          const frames = yield* Fiber.join(following).pipe(Effect.timeout("10 seconds"))
          const after = (yield* projections.snapshot({ _tag: "approvals" })).rows as ReadonlyArray<Row>
          return {
            holder,
            listed: listed._tag === "runs" ? listed.items.map((item) => item.runId) : [],
            before,
            subscribed: frames.flatMap((frame) => frame._tag === "row" ? [frame.row as Row] : []),
            delta: (frames.find((frame) => frame._tag === "delta")?.delta ?? []) as ReadonlyArray<Row>,
            after
          }
        }),
        stack
      ).pipe(Effect.scoped, Effect.orDie)
    )

    // The control plane really lists the whole tree: the question reaches the
    // inbox through three runs, in whatever order the listing chose.
    expect(observed.listed).toHaveLength(3)
    expect(observed.listed).toContain("review-root")
    expect(observed.holder.runId).not.toBe("review-root")

    const question = {
      runId: "review-root",
      waitRunId: observed.holder.runId,
      requestId: "review-question#1",
      title: prompt,
      status: "pending"
    }
    for (const rows of [observed.before, observed.subscribed, observed.delta, observed.after]) {
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject(question)
    }
    expect(observed.delta).toEqual(observed.after)
  })
})
