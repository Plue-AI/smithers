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
import { FlowEngine } from "@smthrs/engine"
import { DurableDeferred, Flow, FlowRuntime, WaitFor } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("WaitingTree/Test", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("unused")
})

const ParentFlow = Flow.make("WaitingTree/Parent", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("unused")
})

const SharedChildFlow = Flow.make("WaitingTree/SharedChild", {
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

type Services = Layer.Success<typeof services>

const withState = <A>(body: (state: DurableEngineState.Service) => Effect.Effect<A, unknown, Services>) =>
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    return yield* body(state)
  }).pipe(Effect.provide(services), Effect.orDie)

const insertParent = (childId: string, parentId: string, seq: number) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter.DurableWriter
    yield* writer.write(
      sql`INSERT INTO flows_run_parents (child_id, parent_id, seq) VALUES (${childId}, ${parentId}, ${seq})`
    )
  })

describe("waitingTree", () => {
  it.effect("seeks each tree edge without scanning unrelated runs", () =>
    withCrypto(Effect.scoped(
      Effect.gen(function*() {
        // Keep this fixture SQLite-specific: its EXPLAIN QUERY PLAN details are
        // the deterministic cost evidence, independent of elapsed time.
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* insertRun({ runId: "plan-root", createdAtMs: 1 })
        yield* insertRun({
          runId: "plan-child",
          parent: "plan-root",
          createdAtMs: 2,
          waiting: { reason: "approval", token: "plan-token", request: clarification }
        })
        for (let index = 0; index < 500; index++) {
          yield* insertRun({ runId: `unrelated-${index}`, createdAtMs: index + 3 })
          yield* insertRun({
            runId: `unrelated-child-${index}`,
            parent: `unrelated-${index}`,
            createdAtMs: index + 503
          })
        }
        let statement: string | undefined
        let parameters: ReadonlyArray<unknown> | undefined
        const traced = new Proxy(sql, {
          apply(target, thisArg, args) {
            const query = Reflect.apply(target, thisArg, args)
            const [compiled, values] = query.compile()
            if (compiled.includes("WITH RECURSIVE") && compiled.includes("waiting_reason")) {
              statement = compiled
              parameters = values
            }
            return query
          }
        })
        const state = yield* DurableEngineState.make.pipe(Effect.provideService(SqlClient.SqlClient, traced))
        expect((yield* state.waitingTree("plan-root")).map((row) => row.runId)).toEqual(["plan-child"])
        expect(statement).toBeDefined()
        const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${statement!}`, parameters)
        const details = plan.map((row) => row.detail)
        // The recursive step must probe the indexes of both durable edge kinds.
        expect(
          details.some((detail) =>
            /SEARCH (?:TABLE )?flows_run_parents\b USING COVERING INDEX \S+ \(parent_id=\?\)/.test(detail)
          ),
          details.join("\n")
        )
          .toBe(true)
        expect(
          details.some((detail) => /SEARCH (?:TABLE )?flows_runs\b.*\(parent_run_id=\?\)/.test(detail)),
          details.join("\n")
        )
          .toBe(true)
        expect(details.some((detail) => /SCAN (?:TABLE )?flows_run_parents\b/.test(detail))).toBe(false)
        expect(details.some((detail) => /SCAN (?:TABLE )?flows_runs\b/.test(detail))).toBe(false)
      }).pipe(Effect.provide(
        Layer.mergeAll(
          SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
          RunStore.layer,
          DurableEngineState.layer
        ).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.sqliteLayer)))
      ))
    )))

  it.effect("a shared attached child's approval is visible from its second parent", () =>
    withCrypto(Effect.scoped(
      Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const store = yield* RunStore.RunStore
        const runtime = yield* FlowRuntime.FlowRuntime
        const driver = yield* RunDriver.make({
          owner: { hostId: "waiting-tree", pid: 1, nonce: "shared-child" },
          journalSource: "waiting-tree-shared-child",
          isAlive: () => Effect.succeed(false),
          engine: Effect.succeed(runtime)
        })
        const token = DurableDeferred.tokenFromExecutionId(WaitFor.deferred("approval"), {
          flow: SharedChildFlow,
          executionId: "shared-child"
        })
        yield* driver.register(SharedChildFlow, () =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            instance.waiting = { reason: "approval", token, request: clarification }
            return yield* Flow.suspend(instance)
          }))
        yield* driver.register(ParentFlow, () =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            expect(instance.flow._tag).toBe(ParentFlow._tag)
            expect((yield* store.get(instance.executionId)).status).toBe("running")
            const child = yield* driver.execute(SharedChildFlow, {
              executionId: "shared-child",
              payload: {},
              discard: false,
              parent: instance
            })
            expect(child).toBeInstanceOf(Flow.Suspended)
            expect((yield* store.get("shared-child")).status).toBe("suspended")
            instance.waiting = { reason: "event", token: `${instance.executionId}-event` }
            return yield* Flow.suspend(instance)
          }))

        for (const parentId of ["first-parent", "second-parent"]) {
          expect(
            yield* driver.execute(ParentFlow, {
              executionId: parentId,
              payload: {},
              discard: false
            })
          ).toBeInstanceOf(Flow.Suspended)
          expect((yield* store.get(parentId)).status).toBe("suspended")
        }

        expect((yield* store.get("shared-child")).status).toBe("suspended")
        expect((yield* state.runParents("shared-child")).map((edge) => edge.parentId))
          .toEqual(["first-parent", "second-parent"])
        for (const parentId of ["first-parent", "second-parent"]) {
          const tree = yield* state.waitingTree(parentId)
          expect(tree.map((row) => [row.runId, row.reason])).toEqual([
            [parentId, "event"],
            ["shared-child", "approval"]
          ])
          expect(tree[1]!.token).toBe(token)
          expect(tree[1]!.request).toEqual(JSON.parse(clarification))
        }
      }).pipe(Effect.provide(services), Effect.provide(FlowEngine.layerMemory))
    )))

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
        yield* insertRun({ runId: "other-root", createdAtMs: 3 })
        yield* insertRun({ runId: "detached", parent: "root", createdAtMs: 4, onParentExit: "detach" })
        yield* insertParent("detached", "other-root", 5)
        yield* insertRun({
          runId: "under-detached",
          parent: "detached",
          createdAtMs: 6,
          waiting: { reason: "approval", token: "hidden-token" }
        })

        expect((yield* state.waitingTree("root")).map((row) => row.runId)).toEqual(["attached"])
        expect(yield* state.waitingTree("other-root")).toEqual([])
        // The detached run still owns its own subtree's question.
        expect((yield* state.waitingTree("detached")).map((row) => row.runId)).toEqual(["under-detached"])
        // A caller asking what a resume would restart walks the detached subtree too (#3328).
        expect((yield* state.waitingTree("root", { detached: "include" })).map((row) => row.runId))
          .toEqual(["attached", "under-detached"])
      })
    ))

  it.effect("deduplicates a shared wait reached through unequal-depth diamond paths", () =>
    withState((state) =>
      Effect.gen(function*() {
        yield* insertRun({ runId: "root", createdAtMs: 1 })
        yield* insertRun({ runId: "short", parent: "root", createdAtMs: 2 })
        yield* insertRun({ runId: "long", parent: "root", createdAtMs: 3 })
        yield* insertRun({ runId: "middle", parent: "long", createdAtMs: 4 })
        yield* insertRun({
          runId: "deep",
          parent: "middle",
          createdAtMs: 5,
          waiting: { reason: "event", token: "deep-token" }
        })
        yield* insertRun({
          runId: "shared",
          parent: "short",
          createdAtMs: 6,
          waiting: { reason: "approval", token: "shared-token", request: clarification }
        })
        yield* insertParent("shared", "middle", 7)

        const tree = yield* state.waitingTree("root")
        // The newer, shallower shared wait must precede the older, deeper wait.
        expect(tree.map((row) => [row.runId, row.reason])).toEqual([
          ["shared", "approval"],
          ["deep", "event"]
        ])
        expect(tree[0]!.request).toEqual(JSON.parse(clarification))
        expect((yield* state.waitingTree("middle")).map((row) => row.runId)).toEqual(["deep", "shared"])
      })
    ))

  it.effect("includes a wait at depth 64 and excludes one at depth 65", () =>
    withState((state) =>
      Effect.gen(function*() {
        yield* insertRun({ runId: "depth-0", createdAtMs: 0 })
        for (let depth = 1; depth <= 65; depth++) {
          yield* insertRun({
            runId: `depth-${depth}`,
            parent: `depth-${depth - 1}`,
            createdAtMs: depth,
            ...(depth >= 64 ? { waiting: { reason: "approval", token: `depth-${depth}-token` } } : {})
          })
        }

        expect((yield* state.waitingTree("depth-0")).map((row) => row.runId)).toEqual(["depth-64"])
        expect((yield* state.waitingTree("depth-1")).map((row) => row.runId))
          .toEqual(["depth-64", "depth-65"])
      })
    ))

  it.effect("walks trampoline rounds and their attached children without a spawn edge for the round", () =>
    withState((state) =>
      Effect.gen(function*() {
        yield* insertRun({ runId: "lineage", createdAtMs: 1, waiting: { reason: "event", token: "lineage-token" } })
        yield* insertRun({ runId: "round-2", createdAtMs: 2 })
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter.DurableWriter
        yield* writer.write(sql`UPDATE flows_runs SET parent_run_id = 'lineage' WHERE run_id = 'round-2'`)
        yield* insertRun({
          runId: "round-child",
          parent: "round-2",
          createdAtMs: 3,
          waiting: { reason: "approval", token: "round-token", request: clarification }
        })

        expect(yield* state.runParents("round-2")).toEqual([])
        expect((yield* state.waitingTree("lineage")).map((row) => [row.runId, row.reason])).toEqual([
          ["lineage", "event"],
          ["round-child", "approval"]
        ])
      })
    ))

  it.effect("keeps a detached spawn outside its parent but finds its later round's approval", () =>
    withState((state) =>
      Effect.gen(function*() {
        yield* insertRun({ runId: "outside", createdAtMs: 1 })
        yield* insertRun({
          runId: "round-1",
          parent: "outside",
          createdAtMs: 2,
          status: "completed",
          onParentExit: "detach"
        })
        yield* insertRun({
          runId: "round-2",
          createdAtMs: 3,
          onParentExit: "detach",
          waiting: { reason: "approval", token: "round-2-token", request: clarification }
        })
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter.DurableWriter
        yield* writer.write(sql`UPDATE flows_runs SET parent_run_id = 'round-1' WHERE run_id = 'round-2'`)

        expect(yield* state.runParents("round-2")).toEqual([])
        expect(yield* state.waitingTree("outside")).toEqual([])
        for (const runId of ["round-1", "round-2"]) {
          const tree = yield* state.waitingTree(runId)
          expect(tree.map((row) => [row.runId, row.reason, row.token])).toEqual([
            ["round-2", "approval", "round-2-token"]
          ])
          expect(tree[0]!.request).toEqual(JSON.parse(clarification))
        }
      })
    ))

  it.effect("terminates and returns each wait once if corrupt SQL edges form a cycle", () =>
    withState((state) =>
      Effect.gen(function*() {
        yield* insertRun({ runId: "cycle-root", createdAtMs: 1, waiting: { reason: "event", token: "root" } })
        yield* insertRun({
          runId: "cycle-child",
          parent: "cycle-root",
          createdAtMs: 2,
          waiting: { reason: "approval", token: "child" }
        })
        // Bypass recordRunParent's cycle guard to exercise the reader's final bound.
        yield* insertParent("cycle-root", "cycle-child", 3)

        expect((yield* state.waitingTree("cycle-root")).map((row) => row.runId))
          .toEqual(["cycle-root", "cycle-child"])
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
      expect((yield* state.waitingTree("root", { detached: "include" })).map((row) => row.runId))
        .toEqual(["attached", "under-detached"])
    }))
})
