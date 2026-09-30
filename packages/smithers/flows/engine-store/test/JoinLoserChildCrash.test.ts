/**
 * A join journals its decision and then, in the same uninterruptible step,
 * cancels the child executions its losing members opened. A process that dies
 * between the two used to orphan those children: the resumed walk replays the
 * journaled winners, never demands the loser, and so never asked the runtime
 * to cancel it, leaving a durable engine free to resume the orphan (#2892).
 *
 * The first process here runs over a real SQLite engine store and dies while
 * the race is still open, with the losing child running. The join record is
 * then committed exactly as the dying process wrote it — decision and opened
 * children, with no cancellation after it — because an in-process fiber
 * interrupt cannot stop inside the join's uninterruptible step. The second
 * process reopens the same database and resumes the parent; the losing child
 * must be asked to stop before the parent's next step runs, rather than only
 * when the parent ends.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime, Graph, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Deferred, Effect, Exit, Fiber, Layer, Schema, type Scope } from "effect"
import type * as Crypto from "effect/Crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

/** Wins the race; in the first process it never gets the chance. */
const Win = Action.make("join-loser-crash/win", { payload: {}, success: Schema.Number })
/** The parent's step after the join. */
const After = Action.make("join-loser-crash/after", { payload: {}, success: Schema.String })
/** The losing child: it opens, then runs until something stops it. */
const Loser = Flow.make("join-loser-crash/loser", { payload: {}, success: Schema.Number, body: opaqueHandlerBody })
const Parent = Flow.make("join-loser-crash/parent", {
  payload: {},
  success: Schema.String,
  body: () =>
    Node.race({ loser: Loser.child({}), win: Win.call({}) }).pipe(
      Node.andThen(After.call({}))
    )
})

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "join-loser-crash", changeId: "join-loser-crash" }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** One process over the shared database file. */
const process_ = <A, E>(
  database: string,
  phase: string,
  body: (
    engine: FlowRuntime.FlowRuntime["Service"]
  ) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof TestStores.layerAt>> | Scope.Scope | Crypto.Crypto>
) =>
  withCrypto(
    Effect.scoped(Effect.gen(function*() {
      const engine = yield* EngineStore.make({
        owner: { hostId: `join-loser-crash-${phase}` },
        journalSource: "join-loser-crash",
        isAlive: () => Effect.succeed(false)
      })
      return yield* body(engine as FlowRuntime.FlowRuntime["Service"])
    })).pipe(
      Effect.provide(jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layerAt(database))
    )
  )

describe("a join that crashed between its journal and its cancellations (#2892)", () => {
  it.live("cancels the losing child execution when the parent resumes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "smithers-join-loser-crash-"))),
      (directory) =>
        Effect.gen(function*() {
          const database = join(directory, "engine.db")
          const graph = Graph.nodes(Graph.build(Parent, {}))
          const race = graph.find((node) => node.ast._tag === "Race")!
          const boundary = graph.find((node) => node.ast._tag === "FlowCall" && node.ast.mode === "boundary")!
          let loserId: string | undefined

          const crashed = yield* process_(database, "first", (engine) =>
            Effect.gen(function*() {
              const opened = yield* Deferred.make<void>()
              yield* engine.register(Loser, () =>
                Effect.gen(function*() {
                  loserId = (yield* FlowRuntime.FlowInstance).executionId
                  yield* Deferred.succeed(opened, undefined)
                  return yield* Effect.never
                }))
              const layer = Layer.mergeAll(
                Win.toLayer(() => Effect.never),
                After.toLayer(() => Effect.die("the first process never reaches the step after the join")),
                Interpreter.layer(Parent)
              ).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
              )
              const running = yield* Effect.forkChild(
                Parent.execute({}, { executionId: "join-parent" }).pipe(Effect.provide(layer))
              )
              yield* Deferred.await(opened)
              yield* Fiber.interrupt(running)
              // What the dying process committed: the decision, naming the
              // child the loser opened, and nothing after it.
              const journal = DurableDeferred.make(`join/${race.id}`, { success: Schema.Unknown })
              yield* engine.deferredDone(journal, {
                flowName: Parent._tag,
                executionId: "join-parent",
                deferredName: journal.name,
                exit: Exit.succeed({ members: ["win"], children: [{ node: boundary.id, executionId: loserId! }] })
              })
              const runs = yield* RunStore.RunStore
              return yield* runs.get(loserId!)
            }))
          expect(loserId).toBeDefined()
          // The crash left the loser un-cancelled: no request was recorded.
          expect(crashed.cancelRequestedAtMs).toBeNull()

          const resumed = yield* process_(database, "second", (engine) =>
            Effect.gen(function*() {
              const runs = yield* RunStore.RunStore
              let observed: RunStore.RunRow | undefined
              yield* engine.register(Loser, () => Effect.die("a journaled loser must not run again"))
              const layer = Layer.mergeAll(
                Win.toLayer(() => Effect.succeed(9)),
                After.toLayer(() =>
                  runs.get(loserId!).pipe(
                    Effect.orDie,
                    Effect.map((row) => {
                      observed = row
                      return "after"
                    })
                  )
                ),
                Interpreter.layer(Parent)
              ).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
              )
              const exit = yield* Parent.execute({}, { executionId: "join-parent" }).pipe(
                Effect.provide(layer),
                Effect.exit
              )
              return { exit, observed }
            }))
          expect(resumed.exit).toEqual(Exit.succeed("after"))
          // Asked to stop from the join record, before the parent moved on.
          expect(resumed.observed?.cancelRequestedAtMs).not.toBeNull()
        }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
    ))
})
