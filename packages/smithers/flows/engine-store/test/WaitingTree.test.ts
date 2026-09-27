/**
 * Reading a whole run tree's open waits, not just the named run's own row.
 *
 * On Smithers Cloud, `run-3` of `coding/request` parked for good. The person
 * it was waiting on never saw the question, because `coding/request` itself
 * was parked on `event` while the `HumanTask` — `coding-clarification` — was
 * three executions further down, on `coding/PreparePlan`. Every reader in the
 * product asked `waiting(runId)` about the run an operator had named, got the
 * root's own `event` row back, and reported that nothing was waiting on a
 * person: the approvals inbox stayed empty and `Signal` answered
 * `/control/NoMatchingWait`.
 *
 * `waitingTree` is the read that answers the question actually being asked —
 * "does this run tree owe anybody an answer" — and `waiting_request` is what
 * makes the answer renderable rather than merely present.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as Migrations from "../src/Migrations.ts"

const TestFlow = Flow.make("WaitingTree/Test", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("unused")
})

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

/** The `coding-clarification` question, exactly as `HumanTask` declares it. */
const clarification = JSON.stringify({
  task: "human",
  name: "coding-clarification",
  kind: "ask",
  prompt: "Which service owns the retry budget?",
  attempt: 1,
  maxAttempts: 3
})

/**
 * Inserts one execution row directly, parked or not.
 *
 * Direct SQL rather than `park`: the shape under test is a run TREE, and
 * building one through the driver would take five nested flows to assert one
 * read. The columns written are the ones `park` writes.
 */
const insertRun = (options: {
  readonly runId: string
  readonly parent?: string | undefined
  readonly createdAtMs: number
  readonly status?: string | undefined
  readonly onParentExit?: "cancel" | "detach" | undefined
  readonly waiting?: { readonly reason: string; readonly token?: string; readonly request?: string } | undefined
}) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter.DurableWriter
    const stateJson = JSON.stringify({
      version: 1,
      flowName: TestFlow._tag,
      payload: {},
      ...(options.onParentExit === undefined ? {} : { onParentExit: options.onParentExit })
    })
    yield* writer.write(sql`
      INSERT INTO flows_runs (run_id, status, created_at_ms, waiting_reason, waiting_token, waiting_request, state_json)
      VALUES (
        ${options.runId},
        ${options.status ?? (options.waiting === undefined ? "pending" : "suspended")},
        ${options.createdAtMs},
        ${options.waiting?.reason ?? null},
        ${options.waiting?.token ?? null},
        ${options.waiting?.request ?? null},
        ${stateJson}
      )
    `)
    if (options.parent !== undefined) {
      yield* writer.write(
        sql`INSERT INTO flows_run_parents (child_id, parent_id, seq) VALUES (${options.runId}, ${options.parent}, ${options.createdAtMs})`
      )
    }
  })

const withState = <A>(body: (state: DurableEngineState.Service) => Effect.Effect<A, unknown, any>) =>
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    return yield* body(state)
  }).pipe(Effect.provide(services), Effect.orDie) as Effect.Effect<A>

describe("waitingTree", () => {
  it.effect("reports a human wait parked three executions below the run an operator named", () =>
    withState((state) =>
      Effect.gen(function*() {
        // The shape run-3 actually had: the root waiting on an `event` while
        // the question a person owed an answer to sat on a great-grandchild.
        yield* insertRun({ runId: "run-3", createdAtMs: 1, waiting: { reason: "event", token: "root-token" } })
        yield* insertRun({ runId: "request", parent: "run-3", createdAtMs: 2 })
        yield* insertRun({ runId: "prepare-with-wiki", parent: "request", createdAtMs: 3 })
        yield* insertRun({
          runId: "prepare-plan",
          parent: "prepare-with-wiki",
          createdAtMs: 4,
          waiting: { reason: "approval", token: "plan-token", request: clarification }
        })

        // What every reader used to see, and why the inbox was empty.
        const own = yield* state.waiting("run-3")
        expect(Option.isSome(own) ? own.value.reason : undefined).toBe("event")

        const tree = yield* state.waitingTree("run-3")
        expect(tree.map((row) => [row.runId, row.reason])).toEqual([
          ["run-3", "event"],
          ["prepare-plan", "approval"]
        ])
        // Renderable, not merely present: the prompt and the kind of answer
        // travel with the park, so an inbox can put a box on the screen.
        expect(tree[1]!.request).toEqual({
          task: "human",
          name: "coding-clarification",
          kind: "ask",
          prompt: "Which service owns the retry budget?",
          attempt: 1,
          maxAttempts: 3
        })
        expect(tree[0]!.request).toBeUndefined()
      })
    ))

  it.effect("omits executions that are not waiting and those that have settled", () =>
    withState((state) =>
      Effect.gen(function*() {
        yield* insertRun({ runId: "root", createdAtMs: 1 })
        yield* insertRun({ runId: "busy", parent: "root", createdAtMs: 2 })
        yield* insertRun({
          runId: "finished",
          parent: "root",
          createdAtMs: 3,
          status: "completed",
          waiting: { reason: "approval", token: "stale" }
        })
        yield* insertRun({
          runId: "open",
          parent: "root",
          createdAtMs: 4,
          waiting: { reason: "approval", token: "open-token" }
        })

        expect((yield* state.waitingTree("root")).map((row) => row.runId)).toEqual(["open"])
        // A run nothing knows about is an empty tree, not a failure.
        expect(yield* state.waitingTree("absent")).toEqual([])
      })
    ))

  it.effect("stops at a detached child, whose question its parent is not waiting on", () =>
    withState((state) =>
      Effect.gen(function*() {
        // `.child()` records `cancel`: the parent is waiting for the value, so
        // its question is the parent's too. A fire-and-forget spawn records
        // `detach` and outlives the run that started it, so reporting its
        // question upward would say a run that can proceed cannot.
        yield* insertRun({ runId: "root", createdAtMs: 1 })
        yield* insertRun({
          runId: "attached",
          parent: "root",
          createdAtMs: 2,
          waiting: { reason: "approval", token: "attached-token" }
        })
        yield* insertRun({ runId: "detached", parent: "root", createdAtMs: 3, onParentExit: "detach" })
        yield* insertRun({
          runId: "under-detached",
          parent: "detached",
          createdAtMs: 4,
          waiting: { reason: "approval", token: "hidden-token" }
        })

        expect((yield* state.waitingTree("root")).map((row) => row.runId)).toEqual(["attached"])
        // The detached run still owns its own subtree's question.
        expect((yield* state.waitingTree("detached")).map((row) => row.runId)).toEqual(["under-detached"])
      })
    ))

  it.effect("keeps a sibling tree's waits out of the answer", () =>
    withState((state) =>
      Effect.gen(function*() {
        yield* insertRun({ runId: "mine", createdAtMs: 1 })
        yield* insertRun({ runId: "theirs", createdAtMs: 2 })
        yield* insertRun({
          runId: "their-child",
          parent: "theirs",
          createdAtMs: 3,
          waiting: { reason: "approval", token: "theirs-token" }
        })

        expect(yield* state.waitingTree("mine")).toEqual([])
        expect((yield* state.waitingTree("theirs")).map((row) => row.runId)).toEqual(["their-child"])
      })
    ))

  it.effect("reads a park whose declared question is not JSON as a park that declared none", () =>
    withState((state) =>
      Effect.gen(function*() {
        yield* insertRun({ runId: "torn", createdAtMs: 1, waiting: { reason: "approval", token: "torn-token" } })
        // Written past the column's own `json_valid` check, which is the only
        // way this value can exist: a park that cannot be rendered is still a
        // park a sweeper has to see.
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter.DurableWriter
        yield* writer.write(TestDatabase.checks(sql, false))
        yield* writer.write(sql`UPDATE flows_runs SET waiting_request = 'not json' WHERE run_id = 'torn'`)
        yield* writer.write(TestDatabase.checks(sql, true))

        const tree = yield* state.waitingTree("torn")
        expect(tree.map((row) => row.runId)).toEqual(["torn"])
        expect(tree[0]!.request).toBeUndefined()
      })
    ))

  it.effect("clears the declared question when the run wakes", () =>
    withState((state) =>
      Effect.gen(function*() {
        yield* insertRun({
          runId: "answered",
          createdAtMs: 1,
          waiting: { reason: "approval", token: "answered-token", request: clarification }
        })
        expect(yield* state.wake("answered")).toMatchObject({ _tag: "Woken" })
        expect(yield* state.waitingTree("answered")).toEqual([])
      })
    ))
})

describe("waitingTree, in memory", () => {
  const memory = (
    runs?: (runId: string) => Option.Option<DurableEngineState.MemoryRunView>
  ) => DurableEngineState.makeMemory(runs === undefined ? {} : { runs })
  const owner = { hostId: "waiting-tree", pid: 1, nonce: "n" }

  it.effect("walks the same edges the durable recursion walks", () =>
    Effect.gen(function*() {
      const state = memory()
      yield* state.recordRunParent("child", "root")
      yield* state.recordRunParent("grandchild", "child")
      yield* state.park("grandchild", { reason: "approval", token: "t", request: clarification }, owner)

      const tree = yield* state.waitingTree("root")
      expect(tree.map((row) => row.runId)).toEqual(["grandchild"])
      expect(tree[0]!.request).toMatchObject({ kind: "ask", name: "coding-clarification" })
      expect(yield* state.waitingTree("child")).toHaveLength(1)
      expect(yield* state.waitingTree("grandchild")).toHaveLength(1)
      expect(yield* state.waitingTree("elsewhere")).toEqual([])
    }))

  it.effect("stops at a detached child, as the durable walk does", () =>
    Effect.gen(function*() {
      // Owned by the parking owner: `park` is owner-fenced, as in SQL.
      const view: DurableEngineState.MemoryRunView = { status: "running", owner }
      const state = memory((runId) =>
        Option.some(runId === "detached" ? { ...view, onParentExit: "detach" as const } : view)
      )
      yield* state.recordRunParent("attached", "root")
      yield* state.recordRunParent("detached", "root")
      yield* state.recordRunParent("under-detached", "detached")
      yield* state.park("attached", { reason: "approval", token: "attached-token" }, owner)
      yield* state.park("under-detached", { reason: "approval", token: "hidden-token" }, owner)

      expect((yield* state.waitingTree("root")).map((row) => row.runId)).toEqual(["attached"])
      expect((yield* state.waitingTree("detached")).map((row) => row.runId)).toEqual(["under-detached"])
    }))
})
