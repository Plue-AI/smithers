/**
 * Detached children, on the real durable engine and the real control plane.
 *
 * `ChildFlows` has shipped its three lifecycle flows with `makeNoop` as the
 * only implementation: every `agent/spawn` a cell wrote answered
 * `ChildError { code: "unsupported" }`, so the detached half of subflows was a
 * declaration and nothing else. `EngineChildren` is the implementation, and
 * what makes it worth having is that all three operations are DURABLE — the
 * child is a run row with its own claim and its own journal, not a fiber.
 *
 * Every case below composes the production `EngineStore` and the production
 * `ControlLive` over one SQLite database, so `send` travels the same path an
 * operator's steer does. Two cases go further:
 *
 * - `await` is proved across a real FILE. Two independently constructed store
 *   bundles open it in turn — two connections, two engines, and the first
 *   composition fully closed before the second opens — so the value the second
 *   answers with can only have come off disk.
 * - `send` is proved through the child's own turn boundary. The child drains
 *   the queue itself with the production `Harness.Notifications` source and
 *   returns what it read, so the assertion is on the child's OUTPUT rather
 *   than on a drain the test performed on the child's behalf.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as ControlService from "@smthrs/control/Control"
import { RunNotFound } from "@smthrs/control/ControlError"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlLive from "@smthrs/control/ControlLive"
import type { Receipt } from "@smthrs/control/ControlSchema"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import { FlowEngine } from "@smthrs/engine"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Notifications } from "@smthrs/harness"
import * as Cell from "@smthrs/harness/Cell"
import * as Jj from "@smthrs/kernel/Jj"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { Registry } from "@smthrs/registry"
import { RunStore } from "@smthrs/run-store"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import type * as Scope from "effect/Scope"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as ChildFlows from "../src/ChildFlows.ts"
import * as EngineChildren from "../src/EngineChildren.ts"

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "engine-children-snapshot" as never, changeId: "engine-children-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const Parent = Flow.make("agent/test/children-parent", {
  payload: {},
  success: Schema.String,
  error: Schema.Never,
  body: () => Node.succeed("")
})

/**
 * A second parent, so a lifecycle call can name a child it did not start.
 *
 * A flow of its own rather than a second execution of `Parent`, because the
 * intruder has to run its own body: the ownership question is about the run
 * that is EXECUTING the call, and the answer has to come back as that run's
 * output.
 */
const Intruder = Flow.make("agent/test/children-intruder", {
  payload: {},
  success: Schema.String,
  error: Schema.Never,
  body: () => Node.succeed("")
})

const Worker = Flow.make("agent/test/children-worker", {
  payload: {},
  success: Schema.String,
  error: Schema.Never,
  body: () => Node.succeed("")
})

const Structured = Flow.make("agent/test/children-structured", {
  payload: {},
  success: Schema.Struct({ ok: Schema.Boolean }),
  error: Schema.Never,
  body: () => Node.succeed({ ok: true })
})

const Silent = Flow.make("agent/test/children-silent", {
  payload: {},
  success: Schema.Void,
  error: Schema.Never,
  body: () => Node.succeed(undefined)
})

const Unstarted = Flow.make("agent/test/children-unstarted", {
  payload: {},
  success: Schema.String,
  error: Schema.Never,
  body: () => Node.succeed("")
})

const Counted = Flow.make("agent/test/children-counted", {
  payload: { count: Schema.Number },
  success: Schema.String,
  error: Schema.Never,
  body: () => Node.succeed("")
})

class WorkerRefusal extends Schema.TaggedError<WorkerRefusal>()("agent/test/WorkerRefusal", {
  message: Schema.String
}) {}

const Refusing = Flow.make("agent/test/children-refusing", {
  payload: {},
  success: Schema.String,
  error: WorkerRefusal,
  body: () => Node.succeed("")
})

/**
 * A child that parks, then reports what it was told while it was parked.
 *
 * The drain is the production `Harness.Notifications` source, which is the
 * same object the agent loop installs as its `Steering.Source`, and it runs
 * after the child resumes — a turn boundary the child reached on its own.
 * Whatever the parent steered has to survive the park to appear in the output.
 */
const Steerable = Flow.make("agent/test/children-steerable", {
  payload: {},
  success: Schema.String,
  error: Schema.Never,
  body: () => Node.succeed("")
})

const gate = DurableDeferred.make("agent/test/children-gate", { success: Schema.String })

/** The park a parent waits at between two of its own sends. */
const parkGate = DurableDeferred.make("agent/test/children-park", { success: Schema.String })

/**
 * The park a parent waits at after its one send, so a SECOND composition is
 * the thing that re-drives that send.
 */
const redriveGate = DurableDeferred.make("agent/test/children-redrive", { success: Schema.String })

/** The same park, for the case whose second drive says something different. */
const collideGate = DurableDeferred.make("agent/test/children-collide", { success: Schema.String })

/** Every flow this host is willing to start as a child. */
const childFlows = [Worker, Structured, Silent, Unstarted, Counted, Refusing, Steerable]

/** The text of one rendered steering insert. */
const textOf = (message: ModelRequest.Message): string =>
  message.content
    .map((part) => (part as { readonly type: string; readonly text?: string }).text ?? "")
    .join("")

/**
 * Everything one host composes: the durable stores, the engine's collaborators,
 * and the production control plane over the same database.
 *
 * Taking the database by name is what makes the cross-process case reachable.
 * `:memory:` gives each call a private database, which is the cheap default;
 * a path gives two calls one file and two connections, which is what a second
 * process has.
 */
const host = (filename: string) => {
  const stores = Layer.mergeAll(
    TestStores.layerAt(filename),
    StepBoundary.layerTest(),
    Layer.succeed(Jj.Jj)(jj)
  ).pipe(Layer.provideMerge(NodeCrypto.layer))
  const withQueue = Layer.provideMerge(NotificationQueue.layer, stores)
  const controlDependencies = Layer.mergeAll(
    SqlControlRuntime.layer(),
    Registry.layerNoop(),
    ControlExecutor.layerNoop()
  )
  return Layer.provideMerge(
    Layer.orDie(Layer.provide(ControlLive.layer, controlDependencies)),
    withQueue
  )
}

const engine = (hostId: string) =>
  EngineStore.make({
    owner: { hostId },
    journalSource: hostId
  })

/**
 * Everything one composed host offers a case, named so no case says `any`.
 *
 * Read off {@link host} rather than listed by hand: the union is exactly what
 * that composition provides, so a service added to the stack reaches the cases
 * without a second edit and a service removed from it fails the compile.
 */
type HostServices = Layer.Success<ReturnType<typeof host>>

/** Runs one body against one freshly composed host. */
const runOn = <A, E>(
  filename: string,
  body: Effect.Effect<A, E, HostServices | Scope.Scope>
): Promise<A> => Effect.runPromise(Effect.scoped(body).pipe(Effect.provide(host(filename))))

const run = <A, E>(body: Effect.Effect<A, E, HostServices | Scope.Scope>): Promise<A> => runOn(":memory:", body)

/** Runs one body inside a temporary directory that is removed afterwards. */
const withTempFile = async <A>(body: (filename: string) => Promise<A>): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "engine-children-"))
  try {
    return await body(join(directory, "runs.db"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Waits for a run row to reach `status`, or gives up loudly. */
const untilStatus = (
  store: RunStore.Service,
  runId: string,
  status: RunStore.RunRow["status"],
  attempts = 400
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const row = yield* Effect.orDie(store.get(runId))
    if (row.status === status) return
    if (attempts <= 0) return yield* Effect.die(new Error(`run ${runId} never reached ${status} (${row.status})`))
    yield* Effect.sleep("10 millis")
    return yield* untilStatus(store, runId, status, attempts - 1)
  })

/** Waits for a run row to reach `completed`, or gives up loudly. */
const untilCompleted = (store: RunStore.Service, runId: string, attempts = 400): Effect.Effect<void> =>
  untilStatus(store, runId, "completed", attempts)

/** Waits for a run row to reach `suspended`, or gives up loudly. */
const untilSuspended = (store: RunStore.Service, runId: string, attempts = 400): Effect.Effect<void> =>
  untilStatus(store, runId, "suspended", attempts)

/** Waits for a run row to reach `failed`, or gives up loudly. */
const untilFailed = (store: RunStore.Service, runId: string, attempts = 400): Effect.Effect<void> =>
  untilStatus(store, runId, "failed", attempts)

/**
 * A children port whose run store completes `polled` once `await` has read
 * `child`'s row twice: it found the child unsettled and came back to look
 * again, which is the waiting path a test means to exercise.
 */
const pollingChildren = (child: string, polled: Deferred.Deferred<void>) =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    let reads = 0
    const counting: RunStore.Service = {
      ...store,
      get: (runId) =>
        runId !== child ? store.get(runId) : store.get(runId).pipe(
          Effect.tap(() => (++reads >= 2 ? Deferred.succeed(polled, undefined) : Effect.void))
        )
    }
    return yield* children().pipe(Effect.provideService(RunStore.RunStore, counting))
  })

/**
 * Registers the child flows on an engine, with the handler each one needs.
 *
 * `Unstarted` is deliberately absent: it is a flow this host declares a child
 * MAY run and that the engine cannot actually run, which is the composition
 * mistake `spawn` reports.
 */
const registerChildren = (runtime: FlowRuntime.FlowRuntime["Service"]) =>
  Effect.gen(function*() {
    yield* runtime.register(Worker, () => Effect.succeed("worker finished"))
    yield* runtime.register(Structured, () => Effect.succeed({ ok: true }))
    yield* runtime.register(Silent, () => Effect.void)
    yield* runtime.register(Counted, ({ count }) => Effect.succeed(`counted ${count}`))
  })

const children = (options?: Partial<EngineChildren.Options>) =>
  EngineChildren.make({
    flows: childFlows,
    pollInterval: "1 millis",
    startTimeout: "2 seconds",
    ...options
  })

/**
 * The composed control plane, with the tag of every steer receipt it answers
 * appended to `receipts`.
 *
 * The real `ControlLive` still decides every one of them. The wrapper exists
 * because the receipt is what `send` has to act on and nothing outside the
 * port can otherwise see which one it got: `{ delivered: true }` looks the
 * same whether the control plane accepted the message, recognised it as one
 * it had already applied, or refused it.
 */
const observingControl = (
  receipts: Array<string>
): Effect.Effect<ControlService.Service, never, ControlService.Control> =>
  Effect.map(ControlService.Control, (control) =>
    ControlService.make({
      ...control,
      steer: (input) =>
        control.steer(input).pipe(
          Effect.tap((receipt) => Effect.sync(() => receipts.push(receipt._tag)))
        )
    }))

/** The `ChildError` a refused lifecycle call failed with. */
const childErrorOf = (exit: Exit.Exit<unknown, unknown>): ChildFlows.ChildError | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  const reason = exit.cause.reasons[0]
  return (reason as { readonly error?: ChildFlows.ChildError } | undefined)?.error
}

describe("EngineChildren.spawn", () => {
  it("distinguishes a delimiter-bearing direct child from a nested child", () => {
    const direct = EngineChildren.childExecutionId("root", EngineChildren.childExecutionId("review", "check"))
    const nested = EngineChildren.childExecutionId(EngineChildren.childExecutionId("root", "review"), "check")
    expect(direct).not.toBe(nested)
    expect(EngineChildren.childExecutionId("root", "review/check")).not.toBe(direct)
  })

  it("keeps direct and nested children independent and lets their ancestor collect both", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-nested-identity")
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      yield* registerChildren(runtime)
      yield* runtime.register(Worker, () =>
        port.spawn({
          flow: Counted._tag,
          label: "check",
          input: { count: 2 }
        }).pipe(Effect.map(({ child }) => child), Effect.orDie))
      yield* runtime.register(Parent, () =>
        Effect.gen(function*() {
          const direct = yield* port.spawn({
            flow: Counted._tag,
            label: EngineChildren.childExecutionId("review", "check"),
            input: { count: 1 }
          })
          const reviewer = yield* port.spawn({ flow: Worker._tag, label: "review" })
          const nested = (yield* port.await(reviewer)).output
          expect(direct.child).not.toBe(nested)
          expect((yield* port.await(direct)).output).toBe("counted 1")
          expect((yield* port.await({ child: nested })).output).toBe("counted 2")
          return "independent"
        }).pipe(Effect.orDie))
      expect(yield* runtime.execute(Parent, { executionId: "nested-parent", payload: {} })).toBe("independent")
    })))

  it("starts a durable child that outlives the run that spawned it", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-spawn")
      const store = yield* RunStore.RunStore
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      yield* registerChildren(runtime)
      yield* runtime.register(Parent, () =>
        Effect.all([
          port.spawn({ flow: Worker._tag, label: "worker" }),
          // No label: the flow's own name identifies the child, which is what
          // a cell that spawns one of a kind writes.
          port.spawn({ flow: Structured._tag })
        ]).pipe(Effect.map(([first, second]) => `${first.child} ${second.child}`), Effect.orDie))

      const ids = yield* runtime.execute(Parent, { executionId: "spawn-parent", payload: {} })
      const [child, unlabelled] = ids.split(" ") as [string, string]
      const parentRow = yield* store.get("spawn-parent")
      const childRow = yield* store.get(child)

      expect(child).toBe(EngineChildren.childExecutionId("spawn-parent", "worker"))
      expect(unlabelled).toBe(EngineChildren.childExecutionId("spawn-parent", Structured._tag))
      expect(parentRow.status).toBe("completed")
      // Detached in the durable sense: the parent's terminal transition read
      // this policy off the child's own row and left it alone.
      expect((JSON.parse(childRow.stateJson) as { readonly onParentExit?: string }).onParentExit).toBe("detach")
      expect(childRow.cancelRequestedAtMs).toBeNull()
    })))

  it("releases an admitted startup fiber from its parent's lifetime", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-admitted")
      const store = yield* RunStore.RunStore
      const finish = yield* Deferred.make<void>()
      const completed = yield* Deferred.make<void>()
      let cleaned = false
      const admitted: FlowRuntime.FlowRuntime["Service"] = {
        ...runtime,
        execute: (_flow, options) =>
          store.create(
            options.executionId,
            JSON.stringify({ flowName: Worker._tag })
          ).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.ensuring(Effect.sync(() => {
              cleaned = true
            })),
            Effect.ensuring(Deferred.succeed(completed, undefined)),
            Effect.as(options.executionId),
            Effect.orDie
          )
      }
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, admitted))
      yield* runtime.register(Parent, () =>
        port.spawn({ flow: Worker._tag }).pipe(
          Effect.map(({ child }) => child),
          Effect.orDie
        ))
      const child = yield* runtime.execute(Parent, { executionId: "admitted-parent", payload: {} })
      expect((yield* store.get(child)).runId).toBe(child)
      expect(cleaned).toBe(false)
      yield* Deferred.succeed(finish, undefined)
      yield* Deferred.await(completed)
      expect(cleaned).toBe(true)
    })))

  it("refuses a flow this host does not run", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-unknown")
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      yield* runtime.register(Parent, () =>
        port.spawn({ flow: "agent/test/nothing-declares-this" }).pipe(
          Effect.map((spawned) => spawned.child),
          Effect.catch((error) => Effect.succeed(`${(error as ChildFlows.ChildError).code}`))
        ))

      return expect(
        yield* runtime.execute(Parent, { executionId: "spawn-unknown", payload: {} })
      ).toBe("not_found")
    })))

  it("uses labels as child identity and defaults them to the flow name", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-label-identity")
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      yield* registerChildren(runtime)
      yield* runtime.register(Parent, () =>
        Effect.gen(function*() {
          const first = yield* port.spawn({ flow: Worker._tag })
          const second = yield* port.spawn({ flow: Worker._tag })
          const labelledA = yield* port.spawn({ flow: Worker._tag, label: "reviewer-a" })
          const labelledB = yield* port.spawn({ flow: Worker._tag, label: "reviewer-b" })
          return JSON.stringify({ first, second, labelledA, labelledB })
        }).pipe(Effect.orDie))

      const encoded = yield* runtime.execute(Parent, { executionId: "spawn-labels", payload: {} })
      const ids = JSON.parse(encoded) as Record<string, { readonly child: string }>

      expect(ids["first"]?.child).toBe(ids["second"]?.child)
      expect(ids["labelledA"]?.child).not.toBe(ids["labelledB"]?.child)
    })))

  it("reports an unregistered declared flow as a failed start", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-unstarted")
      const store = yield* RunStore.RunStore
      // The start budget is generous on purpose: the refusal must come from
      // watching the start attempt END without a run row, not from running out
      // of patience. A budget-driven answer would take two seconds and say
      // `failed`, which tells a cell to retry something that can never work.
      const port = yield* children({ startTimeout: "30 seconds" }).pipe(
        Effect.provideService(FlowRuntime.FlowRuntime, runtime)
      )
      yield* runtime.register(Parent, () =>
        port.spawn({ flow: Unstarted._tag, label: "ghost" }).pipe(
          Effect.map((spawned) => spawned.child),
          Effect.catch((error) => Effect.succeed(`${(error as ChildFlows.ChildError).code}`))
        ))

      const code = yield* runtime.execute(Parent, { executionId: "spawn-unstarted", payload: {} })
      const row = yield* Effect.exit(store.get(EngineChildren.childExecutionId("spawn-unstarted", "ghost")))

      expect(code).toBe("failed")
      // Nothing durable was created, but the declaration exists: the ended
      // start attempt is an engine failure rather than an absent flow.
      expect(Exit.isFailure(row)).toBe(true)
    })))

  it("reports a start attempt that succeeds without creating a child as a failed start", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-missing-row")
      const rowless: FlowRuntime.FlowRuntime["Service"] = {
        ...runtime,
        execute: () => Effect.succeed("no child was registered")
      }
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, rowless))
      yield* runtime.register(Parent, () =>
        port.spawn({ flow: Worker._tag, label: "missing" }).pipe(
          Effect.map((spawned) => spawned.child),
          Effect.catch((error) =>
            Effect.succeed(
              `${(error as ChildFlows.ChildError).code}: ${(error as ChildFlows.ChildError).message}`
            )
          )
        ))

      // The declaration was found before the start was attempted, so the flow
      // exists on this host and `not_found` would be a lie a cell acts on: it
      // is the answer that tells a cell to stop asking for this flow at all.
      const answer = yield* runtime.execute(Parent, { executionId: "spawn-missing-row", payload: {} })
      expect(answer.startsWith("failed:")).toBe(true)
      expect(answer).toContain("rather than a missing flow")
    })))

  it("reports a child payload rejected by its schema as a failed start", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-invalid-payload")
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      yield* registerChildren(runtime)
      yield* runtime.register(Parent, () =>
        port.spawn({ flow: Counted._tag, input: { count: "many" } as never }).pipe(
          Effect.map((spawned) => spawned.child),
          Effect.catch((error) =>
            Effect.succeed(`${(error as ChildFlows.ChildError).code}|${(error as ChildFlows.ChildError).message}`)
          )
        ))

      const refusal = yield* runtime.execute(Parent, { executionId: "spawn-invalid-payload", payload: {} })
      expect(refusal).toContain("failed|")
      expect(refusal).toContain("count")
    })))

  it("gives up on a start that neither creates a run nor ends", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-spawn-stalled")
      // A runtime that accepts the start and never comes back: a wedged
      // coordinator, a lock nobody releases. The start attempt has not ended,
      // so the not-registered answer does not apply, and no run row will ever
      // appear — the budget is the only thing that can end the wait.
      let cleaned = false
      const stalled: FlowRuntime.FlowRuntime["Service"] = {
        ...runtime,
        execute: () =>
          Effect.never.pipe(Effect.ensuring(Effect.sync(() => {
            cleaned = true
          })))
      }
      const port = yield* children({ startTimeout: "10 millis" }).pipe(
        Effect.provideService(FlowRuntime.FlowRuntime, stalled)
      )
      yield* runtime.register(Parent, () =>
        port.spawn({ flow: Worker._tag, label: "stalled" }).pipe(
          Effect.map((spawned) => spawned.child),
          Effect.catch((error) => Effect.succeed(`${(error as ChildFlows.ChildError).code}`))
        ))

      expect(
        yield* runtime.execute(Parent, { executionId: "spawn-stalled", payload: {} })
      ).toBe("failed")
      expect(cleaned).toBe(true)
    })))

  it("does not start abandoned work when a dependency recovers after timeout", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-recovering")
      const dependency = yield* Deferred.make<void>()
      let executions = 0
      let cleaned = 0
      const recovering: FlowRuntime.FlowRuntime["Service"] = {
        ...runtime,
        execute: (flow, options) =>
          Deferred.await(dependency).pipe(
            Effect.andThen(Effect.sync(() => {
              executions++
            })),
            Effect.andThen(runtime.execute(flow, options)),
            Effect.ensuring(Effect.sync(() => {
              cleaned++
            }))
          )
      }
      const port = yield* children({ startTimeout: "20 millis" }).pipe(
        Effect.provideService(FlowRuntime.FlowRuntime, recovering)
      )
      yield* registerChildren(runtime)
      yield* runtime.register(Parent, () =>
        Effect.gen(function*() {
          const first = yield* Effect.exit(port.spawn({ flow: Worker._tag, label: "retry" }))
          expect(childErrorOf(first)?.code).toBe("failed")
          expect(cleaned).toBe(1)
          yield* Deferred.succeed(dependency, undefined)
          const second = yield* port.spawn({ flow: Worker._tag, label: "retry" })
          return (yield* port.await(second)).output
        }).pipe(Effect.orDie))
      expect(yield* runtime.execute(Parent, { executionId: "recovering-parent", payload: {} }))
        .toBe("worker finished")
      expect(executions).toBe(1)
    })))

  it.each(["store failure", "interruption"] as const)(
    "cleans up startup on %s",
    (failure) =>
      run(Effect.gen(function*() {
        const runtime = yield* engine(`children-cleanup-${failure}`)
        const store = yield* RunStore.RunStore
        const entered = yield* Deferred.make<void>()
        let cleaned = false
        const stalled: FlowRuntime.FlowRuntime["Service"] = {
          ...runtime,
          execute: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.sync(() => {
                cleaned = true
              }))
            )
        }
        const port = yield* children().pipe(
          Effect.provideService(FlowRuntime.FlowRuntime, stalled),
          Effect.provideService(RunStore.RunStore, {
            ...store,
            get: (id) =>
              failure === "store failure"
                ? Deferred.await(entered).pipe(Effect.andThen(Effect.die("store unavailable")))
                : store.get(id)
          })
        )
        yield* runtime.register(Parent, () =>
          Effect.gen(function*() {
            const spawning = yield* Effect.forkChild(port.spawn({ flow: Worker._tag }))
            yield* Deferred.await(entered)
            if (failure === "interruption") yield* Fiber.interrupt(spawning)
            expect(Exit.isFailure(yield* Fiber.await(spawning))).toBe(true)
            expect(cleaned).toBe(true)
            return "cleaned"
          }))
        expect(yield* runtime.execute(Parent, { executionId: `cleanup-${failure}`, payload: {} })).toBe("cleaned")
      }))
  )

  it("refuses to spawn outside a running flow", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-no-parent")
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      const exit = yield* Effect.exit(port.spawn({ flow: Worker._tag }))

      expect(childErrorOf(exit)?.code).toBe("unsupported")
    })))
})

describe("EngineChildren.await", () => {
  it("returns the child's output to a second engine over the same database file", () =>
    withTempFile(async (filename) => {
      const child = await runOn(
        filename,
        Effect.gen(function*() {
          const spawner = yield* engine("children-await-a")
          const store = yield* RunStore.RunStore
          const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, spawner))
          yield* registerChildren(spawner)
          yield* spawner.register(Parent, () =>
            port.spawn({ flow: Worker._tag, label: "collected" }).pipe(
              Effect.map((spawned) => spawned.child),
              Effect.orDie
            ))
          const spawned = yield* spawner.execute(Parent, { executionId: "await-parent", payload: {} })
          // Let the detached child settle before this whole composition — its
          // engine, its connection, its fibers — is torn down.
          yield* untilCompleted(store, spawned)
          return spawned
        })
      )

      // A SECOND composition over the same file: a new SQLite connection, a
      // new engine, a new owner, and no object the first one built. Whatever
      // it answers with came off disk.
      const collected = await runOn(
        filename,
        Effect.gen(function*() {
          const collector = yield* engine("children-await-b")
          yield* collector.register(Worker, () => Effect.succeed("worker finished"))
          const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, collector))
          return yield* port.await({ child })
        })
      )

      expect(collected).toEqual({ child, output: "worker finished" })
    }))

  it("waits for a child that has not settled yet", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-await-waiting")
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      // A child parked on a durable deferred: it exists, it is not settled,
      // and the only way `await` can answer is by looking again later.
      yield* runtime.register(Worker, () => DurableDeferred.await(gate))
      const spawnedChild = yield* Deferred.make<string>()
      const parentPark = DurableDeferred.make("children/await-parent", { success: Schema.Void })
      yield* runtime.register(Parent, () =>
        Effect.gen(function*() {
          const spawned = yield* port.spawn({ flow: Worker._tag, label: "slow" }).pipe(Effect.orDie)
          yield* Deferred.succeed(spawnedChild, spawned.child)
          yield* DurableDeferred.await(parentPark)
          return spawned.child
        }))
      // A completed parent cancels its linked children. Keep the parent active
      // while this test waits for the child to finish.
      yield* runtime.execute(Parent, { executionId: "await-waiting", payload: {}, discard: true })
      const child = yield* Deferred.await(spawnedChild)

      const polled = yield* Deferred.make<void>()
      const watched = yield* pollingChildren(child, polled).pipe(
        Effect.provideService(FlowRuntime.FlowRuntime, runtime)
      )
      const collector = yield* Effect.forkChild(watched.await({ child }), { startImmediately: true })
      yield* Deferred.await(polled)
      yield* runtime.deferredDone(gate, {
        flowName: Worker._tag,
        executionId: child,
        deferredName: gate.name,
        exit: Exit.succeed("resumed")
      })

      const collected = yield* Fiber.join(collector)
      expect(collected.output).toBe("resumed")
    })))

  it("waits for a child that exists but has not started", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-await-unstarted-row")
      const store = yield* RunStore.RunStore
      yield* runtime.register(Worker, () => Effect.succeed("worker finished"))
      // A run row with no result at all: created, claimed by nobody, never
      // driven. `await` has nothing to read yet and has to come back.
      yield* store.create(
        "pending-child",
        JSON.stringify({ version: 1, flowName: Worker._tag, payload: {} }),
        { lineageId: FlowEngine.Round.initial("pending-child").rootExecutionId, roundOrdinal: 0 }
      )

      const polled = yield* Deferred.make<void>()
      const watched = yield* pollingChildren("pending-child", polled).pipe(
        Effect.provideService(FlowRuntime.FlowRuntime, runtime)
      )
      const collector = yield* Effect.forkChild(watched.await({ child: "pending-child" }), {
        startImmediately: true
      })
      yield* Deferred.await(polled)
      yield* runtime.execute(Worker, { executionId: "pending-child", payload: {} })

      expect((yield* Fiber.join(collector)).output).toBe("worker finished")
    })))

  it("renders a structured child as JSON and a void child as null", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-await-shapes")
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      yield* registerChildren(runtime)
      yield* runtime.register(Parent, () =>
        Effect.all([
          port.spawn({ flow: Structured._tag, label: "structured" }),
          port.spawn({ flow: Silent._tag, label: "silent" })
        ]).pipe(Effect.map(([first, second]) => `${first.child} ${second.child}`), Effect.orDie))
      const ids = yield* runtime.execute(Parent, { executionId: "await-shapes", payload: {} })
      const [structured, silent] = ids.split(" ") as [string, string]

      expect((yield* port.await({ child: structured })).output).toBe(`{"ok":true}`)
      expect((yield* port.await({ child: silent })).output).toBe("null")
    })))

  it("includes a typed child failure tag in the await refusal", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-await-failed")
      const store = yield* RunStore.RunStore
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      yield* runtime.register(Refusing, () => Effect.fail(new WorkerRefusal({ message: "worker refused" })))
      yield* runtime.register(Parent, () =>
        port.spawn({ flow: Refusing._tag, label: "doomed" }).pipe(
          Effect.map((spawned) => spawned.child),
          Effect.orDie
        ))
      const child = yield* runtime.execute(Parent, { executionId: "await-failed", payload: {} })
      // The forked drive settles the child; wait for it before reading.
      yield* untilFailed(store, child)

      const refusal = childErrorOf(yield* Effect.exit(port.await({ child })))
      expect(refusal?.code).toBe("failed")
      expect(refusal?.message).toContain("agent/test/WorkerRefusal")
    })))

  it("refuses a round that handed off instead of answering", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-await-handoff")
      const store = yield* RunStore.RunStore
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      // A trampolining child settles its first execution id with a HANDOFF:
      // the lineage continues under a new id, so this one will never hold a
      // value and an await that kept polling it would never return.
      yield* store.create(
        "handed-off-child",
        JSON.stringify({
          version: 1,
          flowName: Worker._tag,
          payload: {},
          result: { _tag: "Handoff", flow: Worker._tag, payload: {} }
        })
      )

      expect(
        childErrorOf(yield* Effect.exit(port.await({ child: "handed-off-child" })))?.code
      ).toBe("failed")
    })))

  it("reports a cancelled child, an unknown child, and a child whose flow is unknown", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-await-refusals")
      const store = yield* RunStore.RunStore
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      yield* store.create(
        "cancelled-child",
        JSON.stringify({ version: 1, flowName: Worker._tag, payload: {} })
      )
      // The cancel stamp is the CALLER's timestamp and the store writes it
      // unchecked, while `decodeRunRow` refuses any row whose
      // `cancelRequestedAtMs` precedes `createdAtMs`. A literal would persist a
      // row every later `get` rejects forever, so the request is stamped from
      // the row the store just created.
      const created = yield* store.get("cancelled-child")
      const requested = yield* store.requestCancel("cancelled-child", created.createdAtMs)
      expect(requested._tag).toBe("CancelRequested")
      const cancelled = yield* store.get("cancelled-child")
      const claimed = yield* store.claimAndOwn(
        "cancelled-child",
        { status: cancelled.status, owner: cancelled.owner, heartbeatAtMs: cancelled.heartbeatAtMs },
        { hostId: "children-await-refusals", pid: 1, nonce: "cancel" },
        created.createdAtMs
      )
      // Asserted rather than discarded: a refused claim would otherwise surface
      // as an unrelated failure several statements later.
      expect(claimed._tag).toBe("Activated")
      const transitioned = yield* store.transitionOwned(
        "cancelled-child",
        { hostId: "children-await-refusals", pid: 1, nonce: "cancel" },
        "cancelled",
        JSON.stringify({ version: 1, flowName: Worker._tag, payload: {} })
      )
      expect(transitioned._tag).toBe("Transitioned")
      yield* store.create(
        "foreign-flow-child",
        JSON.stringify({ version: 1, flowName: "agent/test/not-declared-here", payload: {} })
      )

      const codes: Array<string | undefined> = []
      for (const child of ["cancelled-child", "no-such-child", "foreign-flow-child"]) {
        codes.push(childErrorOf(yield* Effect.exit(port.await({ child })))?.code)
      }

      expect(codes).toEqual(["failed", "not_found", "not_found"])
    })))

  it("fails typed rather than guessing when the run store itself is broken", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-await-broken")
      const store = yield* RunStore.RunStore
      const broken: RunStore.Service = {
        ...store,
        get: () =>
          Effect.fail(
            new RunStore.RunStoreError({
              code: "persistence_failed",
              method: "get",
              message: "the database is gone",
              cause: undefined
            })
          )
      }
      const port = yield* children().pipe(
        Effect.provideService(FlowRuntime.FlowRuntime, runtime),
        Effect.provideService(RunStore.RunStore, broken)
      )

      const exit = yield* Effect.exit(port.await({ child: "any-child" }))
      // A store that cannot answer is not a missing child: reporting
      // `not_found` here would tell a cell its child never existed. Nor is it
      // a defect in the calling cell: a busy database is data it can see.
      expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(false)
      expect(childErrorOf(exit)).toMatchObject({ code: "failed", message: expect.stringContaining("any-child") })
    })))

  it.each([
    {
      name: "the port's bound",
      options: { awaitTimeout: "30 millis" as const },
      timeoutSeconds: undefined,
      bound: "30ms"
    },
    { name: "the call's timeoutSeconds", options: {}, timeoutSeconds: 1, bound: "1s" }
  ])(
    "answers still_running for a child that does not settle within $name",
    ({ bound, options, timeoutSeconds }) =>
      run(Effect.gen(function*() {
        const runtime = yield* engine(`children-await-bounded-${bound}`)
        const store = yield* RunStore.RunStore
        const port = yield* children(options).pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
        yield* runtime.register(Worker, () => Effect.succeed("worker finished"))
        // A row nobody ever drives: the child a parked approval leaves behind.
        yield* store.create(
          "stuck-child",
          JSON.stringify({ version: 1, flowName: Worker._tag, payload: {} }),
          { lineageId: FlowEngine.Round.initial("stuck-child").rootExecutionId, roundOrdinal: 0 }
        )
        const exit = yield* Effect.exit(
          port.await({ child: "stuck-child", ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) })
        )
        expect(childErrorOf(exit)).toMatchObject({
          code: "still_running",
          message: expect.stringContaining(`after ${bound}`)
        })
      }))
  )

  /**
   * A child await that gave up is a timeout, and the cell and a guarded host
   * must read it as one: the `agent/await` binding reports the port's
   * `still_running` under the call boundary's own `timeout` code, which is
   * the code a host that guards timeouts parks the run on (#2120).
   */
  it("reports an await that gave up as a timeout through its binding", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-await-binding")
      const store = yield* RunStore.RunStore
      const port = yield* children({ awaitTimeout: "30 millis" }).pipe(
        Effect.provideService(FlowRuntime.FlowRuntime, runtime)
      )
      yield* runtime.register(Worker, () => Effect.succeed("worker finished"))
      yield* store.create(
        "stuck-child",
        JSON.stringify({ version: 1, flowName: Worker._tag, payload: {} }),
        { lineageId: FlowEngine.Round.initial("stuck-child").rootExecutionId, roundOrdinal: 0 }
      )
      const bindings = yield* ChildFlows.source(port).bindings()
      const awaiting = bindings.find((binding) => binding.descriptor.name === "agent/await")!
      const result = yield* awaiting.run(
        new Cell.Call({
          flowName: "agent/await",
          input: { child: "stuck-child" },
          capabilities: [],
          effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
          placement: Option.none(),
          identity: new Cell.CallIdentity({
            session: "session-1",
            frame: 0,
            cell: Cell.source("await ctx.call(\"agent/await\", { child: \"stuck-child\" })").digest,
            ordinal: 0,
            declaration: "declaration-digest",
            layers: []
          })
        })
      )
      expect(result).toMatchObject({
        outcome: "failure",
        code: "timeout",
        message: expect.stringContaining("still running")
      })
    })))
})

describe("EngineChildren.send", () => {
  it("steers a parked child, which reads the messages at its own turn boundary", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-send")
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      // The child parks, and only AFTER it resumes does it drain — through
      // the same `Harness.Notifications` source the agent loop installs. What
      // it returns is what it actually received at its own boundary.
      yield* runtime.register(Steerable, (_payload, executionId) =>
        Effect.gen(function*() {
          yield* DurableDeferred.await(gate)
          const steering = yield* Notifications.make({ runId: executionId, lineageId: executionId })
          const drained = yield* steering.drain({ boundary: "turn-1", wouldIdle: false })
          return drained.inserts.map(textOf).join(" | ")
        }).pipe(Effect.orDie))
      yield* runtime.register(Parent, () =>
        Effect.gen(function*() {
          const spawned = yield* port.spawn({ flow: Steerable._tag, label: "steerable" })
          yield* port.send({ child: spawned.child, message: "change course" })
          yield* port.send({ child: spawned.child, message: "and again" })
          return spawned.child
        }).pipe(Effect.orDie))

      const child = yield* runtime.execute(Parent, { executionId: "send-parent", payload: {} })
      yield* runtime.deferredDone(gate, {
        flowName: Steerable._tag,
        executionId: child,
        deferredName: gate.name,
        exit: Exit.succeed("resumed")
      })
      const collected = yield* port.await({ child }).pipe(
        Effect.provideService(FlowRuntime.FlowRuntime, runtime)
      )

      // Both messages, in order, inside the child's own output. Nothing in
      // this case drained the queue on the child's behalf.
      expect(collected.output).toContain("change course")
      expect(collected.output).toContain("and again")
      expect(collected.output.indexOf("change course")).toBeLessThan(collected.output.indexOf("and again"))
    })))

  it("gives each send its own message, and a replayed send the same one", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-send-identity")
      const queue = yield* NotificationQueue.NotificationQueue
      const store = yield* RunStore.RunStore
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      yield* store.create(
        EngineChildren.childExecutionId("send-identity", "identity"),
        JSON.stringify({ version: 1, flowName: Worker._tag, payload: {} })
      )
      // Two sends with the SAME text. A content-addressed id would collapse
      // them into one delivery; the step key gives each call site its own
      // ordinal, so the child hears both.
      yield* runtime.register(Parent, () =>
        Effect.gen(function*() {
          yield* port.send({
            child: EngineChildren.childExecutionId("send-identity", "identity"),
            message: "same words"
          })
          yield* port.send({
            child: EngineChildren.childExecutionId("send-identity", "identity"),
            message: "same words"
          })
          return "sent"
        }).pipe(Effect.orDie))

      yield* runtime.execute(Parent, { executionId: "send-identity", payload: {} })
      const drained = yield* queue.drain({
        runId: EngineChildren.childExecutionId("send-identity", "identity"),
        targetLineageId: EngineChildren.childExecutionId("send-identity", "identity"),
        boundary: "turn-1",
        wouldIdle: false
      })

      expect(drained.notifications.map((notification) => notification.payload)).toEqual([
        { kind: "Message", body: "same words" },
        { kind: "Message", body: "same words" }
      ])
      expect(new Set(drained.notifications.map((notification) => notification.id)).size).toBe(2)
    })))

  it("numbers two independently built ports off the parent, not off themselves", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-send-two-ports")
      const queue = yield* NotificationQueue.NotificationQueue
      const store = yield* RunStore.RunStore
      // Two ports built separately: neither holds what the other sent, which
      // is the shape a parent resumed in another process has and the shape
      // two collaborating cells have. A counter kept inside a port would name
      // both of these sends `steer:1` and the queue would drop the second.
      // The step key is allocated on the PARENT's flow instance, so the two
      // ports take consecutive ordinals without knowing about each other.
      const first = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      const second = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      yield* store.create(
        EngineChildren.childExecutionId("send-two-ports", "two-port"),
        JSON.stringify({ version: 1, flowName: Worker._tag, payload: {} })
      )
      yield* runtime.register(Parent, () =>
        Effect.gen(function*() {
          yield* first.send({
            child: EngineChildren.childExecutionId("send-two-ports", "two-port"),
            message: "same words"
          })
          yield* second.send({
            child: EngineChildren.childExecutionId("send-two-ports", "two-port"),
            message: "same words"
          })
          return "sent"
        }).pipe(Effect.orDie))

      yield* runtime.execute(Parent, { executionId: "send-two-ports", payload: {} })
      const drained = yield* queue.drain({
        runId: EngineChildren.childExecutionId("send-two-ports", "two-port"),
        targetLineageId: EngineChildren.childExecutionId("send-two-ports", "two-port"),
        boundary: "turn-1",
        wouldIdle: false
      })

      expect(drained.notifications.map((notification) => notification.payload)).toEqual([
        { kind: "Message", body: "same words" },
        { kind: "Message", body: "same words" }
      ])
      expect(new Set(drained.notifications.map((notification) => notification.id)).size).toBe(2)
    })))

  it("keeps a live send distinct from one a replayed step already made", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-send-across-park")
      const queue = yield* NotificationQueue.NotificationQueue
      const store = yield* RunStore.RunStore
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      yield* store.create(
        EngineChildren.childExecutionId("send-across-park", "parked-send"),
        JSON.stringify({ version: 1, flowName: Worker._tag, payload: {} })
      )
      let announcements = 0
      // Sealed, so the engine records this dispatch's outcome and REPLAYS it
      // on the drive that resumes the parent: the send inside it does not run
      // a second time, and therefore does not advance a counter the second
      // send would otherwise be numbered by.
      const Announce = Action.make({
        name: "agent/test/children-announce",
        tier: "sealed",
        execute: Effect.gen(function*() {
          announcements += 1
          yield* port.send({
            child: EngineChildren.childExecutionId("send-across-park", "parked-send"),
            message: "first"
          })
        }).pipe(Effect.orDie)
      })
      yield* runtime.register(Parent, () =>
        Effect.gen(function*() {
          yield* Announce
          yield* DurableDeferred.await(parkGate)
          yield* port.send({
            child: EngineChildren.childExecutionId("send-across-park", "parked-send"),
            message: "second"
          })
          return "sent"
        }).pipe(Effect.orDie))

      yield* runtime.execute(Parent, { executionId: "send-across-park", payload: {}, discard: true })
      yield* runtime.deferredDone(parkGate, {
        flowName: Parent._tag,
        executionId: "send-across-park",
        deferredName: parkGate.name,
        exit: Exit.succeed("carry on")
      })
      const settled = yield* runtime.execute(Parent, { executionId: "send-across-park", payload: {} })
      const drained = yield* queue.drain({
        runId: EngineChildren.childExecutionId("send-across-park", "parked-send"),
        targetLineageId: EngineChildren.childExecutionId("send-across-park", "parked-send"),
        boundary: "turn-1",
        wouldIdle: false
      })

      expect(settled).toBe("sent")
      // The replayed step really did not run again, which is the condition
      // that collapsed the two sends onto one key.
      expect(announcements).toBe(1)
      expect(drained.notifications.map((notification) => notification.payload)).toEqual([
        { kind: "Message", body: "first" },
        { kind: "Message", body: "second" }
      ])
      expect(new Set(drained.notifications.map((notification) => notification.id)).size).toBe(2)
    })))

  it("re-drives a parked send into the message the control plane already applied", () =>
    withTempFile(async (filename) => {
      // One send, then a park. The first composition is torn down while the
      // parent is still parked, so the drive that reaches the send a second
      // time belongs to a composition that holds nothing the first one built.
      const body = (port: ChildFlows.Children, message: string) =>
        Effect.gen(function*() {
          const delivered = yield* port.send({
            child: EngineChildren.childExecutionId("send-redrive", "redrive"),
            message
          }).pipe(
            Effect.map((sent) => `${sent.delivered}`),
            Effect.catch((error) =>
              Effect.succeed(`${(error as ChildFlows.ChildError).code} ${(error as ChildFlows.ChildError).message}`)
            )
          )
          yield* DurableDeferred.await(redriveGate)
          return delivered
        }).pipe(Effect.orDie)

      const first: Array<string> = []
      await runOn(
        filename,
        Effect.gen(function*() {
          const runtime = yield* engine("children-send-redrive-a")
          const store = yield* RunStore.RunStore
          const control = yield* observingControl(first)
          const port = yield* children().pipe(
            Effect.provideService(FlowRuntime.FlowRuntime, runtime),
            Effect.provideService(ControlService.Control, control)
          )
          yield* store.create(
            EngineChildren.childExecutionId("send-redrive", "redrive"),
            JSON.stringify({ version: 1, flowName: Worker._tag, payload: {} })
          )
          yield* runtime.register(Parent, () => body(port, "hold position"))
          yield* runtime.execute(Parent, { executionId: "send-redrive", payload: {}, discard: true })
        })
      )

      const second: Array<string> = []
      const { drained, settled } = await runOn(
        filename,
        Effect.gen(function*() {
          const runtime = yield* engine("children-send-redrive-b")
          const queue = yield* NotificationQueue.NotificationQueue
          const control = yield* observingControl(second)
          const port = yield* children().pipe(
            Effect.provideService(FlowRuntime.FlowRuntime, runtime),
            Effect.provideService(ControlService.Control, control)
          )
          yield* runtime.register(Parent, () => body(port, "hold position"))
          yield* runtime.deferredDone(redriveGate, {
            flowName: Parent._tag,
            executionId: "send-redrive",
            deferredName: redriveGate.name,
            exit: Exit.succeed("carry on")
          })
          const settled = yield* runtime.execute(Parent, { executionId: "send-redrive", payload: {} })
          const drained = yield* queue.drain({
            runId: EngineChildren.childExecutionId("send-redrive", "redrive"),
            targetLineageId: EngineChildren.childExecutionId("send-redrive", "redrive"),
            boundary: "turn-1",
            wouldIdle: false
          })
          return { drained, settled }
        })
      )

      expect(first).toEqual(["Accepted"])
      // The re-drive derived the same key AND the same message, so the
      // control plane recognised its own earlier admission. A clock reading
      // anywhere in what it fingerprints would make this a `Conflict`.
      expect(second).toEqual(["AlreadyApplied"])
      expect(settled).toBe("true")
      // One message on the child's queue, not two: the replay path is what
      // `delivered: true` reported the second time.
      expect(drained.notifications.map((notification) => notification.payload)).toEqual([
        { kind: "Message", body: "hold position" }
      ])
    }))

  it("fails a send whose key already carries a different message", () =>
    withTempFile(async (filename) => {
      // Same call site, same parent, same ordinal — a different thing said.
      // That is a real collision on the message key, and the only honest
      // answer is a refusal: the words in this call were never delivered.
      const body = (port: ChildFlows.Children, message: string) =>
        Effect.gen(function*() {
          const outcome = yield* port.send({
            child: EngineChildren.childExecutionId("send-collide", "collide"),
            message
          }).pipe(
            Effect.map((sent) => `${sent.delivered}`),
            Effect.catch((error) =>
              Effect.succeed(`${(error as ChildFlows.ChildError).code} ${(error as ChildFlows.ChildError).message}`)
            )
          )
          yield* DurableDeferred.await(collideGate)
          return outcome
        }).pipe(Effect.orDie)

      await runOn(
        filename,
        Effect.gen(function*() {
          const runtime = yield* engine("children-send-collide-a")
          const store = yield* RunStore.RunStore
          const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
          yield* store.create(
            EngineChildren.childExecutionId("send-collide", "collide"),
            JSON.stringify({ version: 1, flowName: Worker._tag, payload: {} })
          )
          yield* runtime.register(Parent, () => body(port, "hold position"))
          yield* runtime.execute(Parent, { executionId: "send-collide", payload: {}, discard: true })
        })
      )

      const receipts: Array<string> = []
      const { drained, settled } = await runOn(
        filename,
        Effect.gen(function*() {
          const runtime = yield* engine("children-send-collide-b")
          const queue = yield* NotificationQueue.NotificationQueue
          const control = yield* observingControl(receipts)
          const port = yield* children().pipe(
            Effect.provideService(FlowRuntime.FlowRuntime, runtime),
            Effect.provideService(ControlService.Control, control)
          )
          yield* runtime.register(Parent, () => body(port, "break formation"))
          yield* runtime.deferredDone(collideGate, {
            flowName: Parent._tag,
            executionId: "send-collide",
            deferredName: collideGate.name,
            exit: Exit.succeed("carry on")
          })
          const settled = yield* runtime.execute(Parent, { executionId: "send-collide", payload: {} })
          const drained = yield* queue.drain({
            runId: EngineChildren.childExecutionId("send-collide", "collide"),
            targetLineageId: EngineChildren.childExecutionId("send-collide", "collide"),
            boundary: "turn-1",
            wouldIdle: false
          })
          return { drained, settled }
        })
      )

      expect(receipts).toEqual(["Conflict"])
      expect(settled).toMatch(/^failed /)
      // The refusal names the key, because that is the one piece of evidence
      // that tells the two collisions apart when someone reads the log.
      expect(settled).toContain("key1_")
      expect(drained.notifications.map((notification) => notification.payload)).toEqual([
        { kind: "Message", body: "hold position" }
      ])
    }))

  it("leaves a foreign engine's parked child to its own driver", () =>
    // The wake half of the cross-owner rule: a control plane never CLAIMS a
    // run another driver owns. Steering a parked child from a control plane
    // that launched nothing must queue the message and leave the park alone —
    // claiming it would strand the row under a fence no engine re-drives, and
    // the child would never hear its own deferred complete.
    withTempFile(async (filename) => {
      // Composition A: the engine that owns the child. The child parks on the
      // gate; once it resumes it drains its own queue and reports what it
      // heard.
      const child = await runOn(
        filename,
        Effect.gen(function*() {
          const runtime = yield* engine("children-foreign-wake-a")
          const store = yield* RunStore.RunStore
          const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
          yield* runtime.register(Steerable, (_payload, executionId) =>
            Effect.gen(function*() {
              yield* DurableDeferred.await(gate)
              const steering = yield* Notifications.make({ runId: executionId, lineageId: executionId })
              const drained = yield* steering.drain({ boundary: "turn-1", wouldIdle: false })
              return drained.inserts.map(textOf).join(" | ")
            }).pipe(Effect.orDie))
          yield* runtime.register(Parent, () =>
            port.spawn({ flow: Steerable._tag, label: "foreign" }).pipe(
              Effect.map((spawned) => spawned.child),
              Effect.orDie
            ))
          const spawned = yield* runtime.execute(Parent, { executionId: "foreign-wake-parent", payload: {} })
          // The park must be durable before this composition closes.
          yield* untilSuspended(store, spawned)
          return spawned
        })
      )

      // Composition B: a control plane over the same file that launched
      // nothing. The steer is accepted — it is a durable wake request — and
      // the park holds: still suspended, still unowned.
      await runOn(
        filename,
        Effect.gen(function*() {
          const control = yield* ControlService.Control
          const store = yield* RunStore.RunStore
          const receipt = yield* control.steer({
            runId: child,
            message: {
              messageId: "foreign-wake-steer",
              runId: child,
              body: "carry on",
              principal: { id: "operator", kind: "test", stampedAt: 1 },
              createdAt: 1
            },
            idempotencyKey: "steer:foreign-wake"
          }).pipe(Effect.orDie)
          expect(receipt._tag).toBe("Accepted")
          const row = yield* Effect.orDie(store.get(child))
          expect(row.status).toBe("suspended")
          expect(row.owner).toBeNull()
        })
      )

      // Composition C: the owning driver's own wake. The deferred completes,
      // the child resumes exactly once, and the steer is in its output.
      const collected = await runOn(
        filename,
        Effect.gen(function*() {
          const runtime = yield* engine("children-foreign-wake-c")
          const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
          yield* runtime.register(Steerable, (_payload, executionId) =>
            Effect.gen(function*() {
              yield* DurableDeferred.await(gate)
              const steering = yield* Notifications.make({ runId: executionId, lineageId: executionId })
              const drained = yield* steering.drain({ boundary: "turn-1", wouldIdle: false })
              return drained.inserts.map(textOf).join(" | ")
            }).pipe(Effect.orDie))
          yield* runtime.deferredDone(gate, {
            flowName: Steerable._tag,
            executionId: child,
            deferredName: gate.name,
            exit: Exit.succeed("resumed")
          })
          return yield* port.await({ child })
        })
      )

      expect(collected.output).toContain("carry on")
    }))

  it("refuses a receipt that is not a delivery", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-send-receipts")
      const queue = yield* NotificationQueue.NotificationQueue
      const store = yield* RunStore.RunStore
      const control = yield* ControlService.Control
      // Two answers the `Receipt` union carries and a control plane behind an
      // RPC boundary gives: the child ended before the message could land,
      // and a mutation nobody has decided yet. Neither is a delivery, and the
      // port has no business calling either one delivered.
      const answering = (receipt: Receipt) =>
        children().pipe(
          Effect.provideService(FlowRuntime.FlowRuntime, runtime),
          Effect.provideService(
            ControlService.Control,
            ControlService.make({ ...control, steer: () => Effect.succeed(receipt) })
          )
        )
      const terminal = yield* answering({
        _tag: "Terminal",
        runId: EngineChildren.childExecutionId("send-receipts", "receipt"),
        status: "completed"
      })
      const parked = yield* answering({
        _tag: "Parked",
        receiptId: "receipt-1",
        planId: "plan-1",
        status: "waiting-approval"
      })
      yield* store.create(
        EngineChildren.childExecutionId("send-receipts", "receipt"),
        JSON.stringify({ version: 1, flowName: Worker._tag, payload: {} })
      )
      const reported = (port: ChildFlows.Children, message: string) =>
        port.send({ child: EngineChildren.childExecutionId("send-receipts", "receipt"), message }).pipe(
          Effect.map(() => "delivered"),
          Effect.catch((error) => Effect.succeed((error as ChildFlows.ChildError).message))
        )
      yield* runtime.register(Parent, () =>
        Effect.gen(function*() {
          const ended = yield* reported(terminal, "too late")
          const undecided = yield* reported(parked, "undecided")
          return `${ended} | ${undecided}`
        }).pipe(Effect.orDie))

      const outcome = yield* runtime.execute(Parent, { executionId: "send-receipts", payload: {} })
      const drained = yield* queue.drain({
        runId: EngineChildren.childExecutionId("send-receipts", "receipt"),
        targetLineageId: EngineChildren.childExecutionId("send-receipts", "receipt"),
        boundary: "turn-1",
        wouldIdle: false
      })

      expect(outcome).toContain(
        `agent/send could not steer ${
          EngineChildren.childExecutionId("send-receipts", "receipt")
        }: the child run is completed.`
      )
      expect(outcome).toContain(
        `agent/send could not steer ${
          EngineChildren.childExecutionId("send-receipts", "receipt")
        }: the control plane answered Parked.`
      )
      // Nothing was admitted, which is exactly why neither call may answer
      // `delivered`.
      expect(drained.notifications).toEqual([])
    })))

  it("refuses an unknown child and a call outside a running flow", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-send-refusals")
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      yield* runtime.register(Parent, () =>
        port.send({ child: EngineChildren.childExecutionId("send-refusals", "no-such-child"), message: "hello" }).pipe(
          Effect.map(() =>
            "delivered"
          ),
          Effect.catch((error) => Effect.succeed(`${(error as ChildFlows.ChildError).code}`))
        ))

      const inside = yield* runtime.execute(Parent, { executionId: "send-refusals", payload: {} })
      const outside = yield* Effect.exit(
        port.send({ child: EngineChildren.childExecutionId("send-refusals", "no-such-child"), message: "hello" })
      )

      expect(inside).toBe("not_found")
      expect(childErrorOf(outside)?.code).toBe("unsupported")
    })))

  it("reports a child the control plane does not know, even when the row is here", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-send-foreign")
      const store = yield* RunStore.RunStore
      const control = yield* ControlService.Control
      // The control plane and this host disagree about which runs exist,
      // which is what a control plane serving another deployment looks like.
      // The row is right here, so the port cannot answer from the store; the
      // refusal has to be read off the control plane's own answer.
      const foreign: typeof control = {
        ...control,
        steer: (input) => Effect.fail(new RunNotFound({ runId: input.runId }))
      }
      const port = yield* children().pipe(
        Effect.provideService(FlowRuntime.FlowRuntime, runtime),
        Effect.provideService(ControlService.Control, foreign)
      )
      yield* store.create(
        EngineChildren.childExecutionId("send-foreign", "foreign-steer"),
        JSON.stringify({ version: 1, flowName: Worker._tag, payload: {} })
      )
      yield* runtime.register(Parent, () =>
        port.send({ child: EngineChildren.childExecutionId("send-foreign", "foreign-steer"), message: "hello" }).pipe(
          Effect.map(() =>
            "delivered"
          ),
          Effect.catch((error) => Effect.succeed(`${(error as ChildFlows.ChildError).code}`))
        ))

      return expect(
        yield* runtime.execute(Parent, { executionId: "send-foreign", payload: {} })
      ).toBe("not_found")
    })))

  it("reports a control plane that could not accept the message", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-send-broken")
      const store = yield* RunStore.RunStore
      const port = yield* Effect.provide(children(), ControlService.layerNoop).pipe(
        Effect.provideService(FlowRuntime.FlowRuntime, runtime)
      )
      yield* store.create(
        EngineChildren.childExecutionId("send-broken", "steerable"),
        JSON.stringify({ version: 1, flowName: Worker._tag, payload: {} })
      )
      yield* runtime.register(Parent, () =>
        port.send({ child: EngineChildren.childExecutionId("send-broken", "steerable"), message: "hello" }).pipe(
          Effect.map(() =>
            "delivered"
          ),
          Effect.catch((error) => Effect.succeed(`${(error as ChildFlows.ChildError).code}`))
        ))

      return expect(
        yield* runtime.execute(Parent, { executionId: "send-broken", payload: {} })
      ).toBe("failed")
    })))
})

describe("EngineChildren.layer", () => {
  it("provides the port the agent's child flows are bound to", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-layer")
      const port = yield* Effect.provide(
        ChildFlows.Children,
        EngineChildren.layer({ flows: childFlows }).pipe(
          Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime)(runtime))
        )
      )
      expect(typeof port.spawn).toBe("function")
    })))
})

/**
 * Ownership: a lifecycle call reaches the caller's own children and no others.
 *
 * `await` and `send` take the child id as a plain string a cell writes, so
 * without a check that string is a selector over every run the host can see.
 * Both cases below run the intruder as a REAL flow on the same engine, against
 * a victim child that is settled (or parked and steerable), so the only thing
 * between the intruder and another run's result is the port's own refusal.
 */
describe("EngineChildren ownership", () => {
  it("refuses to await a run another parent started", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-await-unowned")
      const store = yield* RunStore.RunStore
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      yield* registerChildren(runtime)
      yield* runtime.register(Parent, () =>
        port.spawn({ flow: Worker._tag, label: "private" }).pipe(
          Effect.map((spawned) => spawned.child),
          Effect.orDie
        ))
      const victimChild = yield* runtime.execute(Parent, { executionId: "victim-parent", payload: {} })
      // Settled, so the only thing that can keep the victim's output out of
      // the intruder's answer is the refusal: the value is sitting there.
      yield* untilCompleted(store, victimChild)

      yield* runtime.register(Intruder, () =>
        port.await({ child: victimChild }).pipe(
          Effect.map((collected) => `collected ${collected.output}`),
          Effect.catch((error) =>
            Effect.succeed(`${(error as ChildFlows.ChildError).code} ${(error as ChildFlows.ChildError).message}`)
          )
        ))
      const answer = yield* runtime.execute(Intruder, { executionId: "intruder-parent", payload: {} })

      expect(answer).toContain("not_found")
      expect(answer).toContain(EngineChildren.childExecutionId("intruder-parent", "<label>"))
      // The victim's own value never crossed into the intruder's answer.
      expect(answer).not.toContain("worker finished")
    })))

  it("rejects malformed v2 ancestry and round-trips Unicode and delimiter-bearing components", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-id-parsing")
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      const parent = "parent:😀/child/embedded"
      yield* registerChildren(runtime)
      yield* runtime.register(Parent, () =>
        Effect.gen(function*() {
          for (const label of ["", "😀\n/child/check", "child-v2:0:0:"]) {
            const child = yield* port.spawn({ flow: Worker._tag, label })
            expect((yield* port.await(child)).output).toBe("worker finished")
          }
          for (const child of ["child-v2:999:short", "child-v2:0:01:x", "child-v2:0:1:x"]) {
            expect(childErrorOf(yield* Effect.exit(port.await({ child })))?.code).toBe("not_found")
          }
          return "checked"
        }).pipe(Effect.orDie))
      expect(yield* runtime.execute(Parent, { executionId: parent, payload: {} })).toBe("checked")
    })))

  it("collects its own child from inside its own body", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-owned")
      const port = yield* children().pipe(Effect.provideService(FlowRuntime.FlowRuntime, runtime))
      yield* registerChildren(runtime)
      // The ordinary path the refusal must leave alone: the run that spawned
      // the child is the run that collects it, inside its own body.
      yield* runtime.register(Parent, () =>
        Effect.gen(function*() {
          const spawned = yield* port.spawn({ flow: Worker._tag, label: "mine" })
          const collected = yield* port.await({ child: spawned.child })
          return collected.output
        }).pipe(Effect.orDie))

      expect(
        yield* runtime.execute(Parent, { executionId: "owner-parent", payload: {} })
      ).toBe("worker finished")
    })))

  it("refuses to steer a run another parent started", () =>
    run(Effect.gen(function*() {
      const runtime = yield* engine("children-send-unowned")
      const store = yield* RunStore.RunStore
      const receipts: Array<string> = []
      const control = yield* observingControl(receipts)
      const port = yield* children().pipe(
        Effect.provideService(FlowRuntime.FlowRuntime, runtime),
        Effect.provideService(ControlService.Control, control)
      )
      // Parked on the gate, so the control plane would admit a message for it.
      yield* runtime.register(Steerable, () => DurableDeferred.await(gate))
      yield* runtime.register(Parent, () =>
        port.spawn({ flow: Steerable._tag, label: "private" }).pipe(
          Effect.map((spawned) => spawned.child),
          Effect.orDie
        ))
      const victimChild = yield* runtime.execute(Parent, { executionId: "victim-send-parent", payload: {} })
      yield* untilSuspended(store, victimChild)

      yield* runtime.register(Intruder, () =>
        port.send({ child: victimChild, message: "do as I say" }).pipe(
          Effect.map(() => "delivered"),
          Effect.catch((error) =>
            Effect.succeed(`${(error as ChildFlows.ChildError).code} ${(error as ChildFlows.ChildError).message}`)
          )
        ))
      const answer = yield* runtime.execute(Intruder, { executionId: "intruder-send-parent", payload: {} })

      expect(answer).toContain("not_found")
      expect(answer).toContain(EngineChildren.childExecutionId("intruder-send-parent", "<label>"))
      // Refused before the control plane was asked, so nothing was admitted.
      expect(receipts).toEqual([])
    })))
})
