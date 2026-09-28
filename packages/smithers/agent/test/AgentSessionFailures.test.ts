/**
 * The executor's failure edges, one refusing collaborator at a time.
 *
 * `AgentSession.test.ts` drives the whole production stack along the path
 * where every collaborator answers. What that can never reach is the other
 * half of the composition: the control store, the journal, the decision store,
 * the status fence, the registry, and the durable engine each have a refusal
 * the executor must contain rather than propagate, and a stack whose
 * collaborators all work cannot produce one. So this file assembles the same
 * executor over stubs and refuses in exactly one place per case.
 *
 * Two collaborators stay real. The durable engine is `FlowEngine.layerMemory`,
 * so registration, execution, polling, and resumption behave as production
 * does; and the approval flow is the real `StandardFlows.approval` binding, so
 * an ask reads its decision exactly the way a cell's `ctx.call("ask", …)`
 * reaches it. The agent is a stub, because the loop itself is asserted in
 * `Agent.test.ts` — here it is the injection point for the two hooks the
 * executor hands it, `authorize` and the composed `ask` flow.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { ClaimLost, LaunchFailed, PersistenceError } from "@smthrs/control/ControlError"
import type * as ControlExecutor from "@smthrs/control/ControlExecutor"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { RunStatus } from "@smthrs/control/ControlSchema"
import { FlowEngine } from "@smthrs/engine"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { type Flow, FlowRuntime } from "@smthrs/flow"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { HarnessError } from "@smthrs/harness/HarnessError"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { RegistryError } from "@smthrs/registry/RegistryError"
import { Ownership, RunStore } from "@smthrs/run-store"
import { Clock, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, PubSub, Schema, Scope, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentSession from "../src/AgentSession.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"
import * as Safety from "./Safety.ts"

const route: FlowEngineLike.RouteResolver = {
  prepare: () =>
    Effect.succeed({
      routeId: "route-a",
      protocolId: "test-protocol",
      method: "POST",
      url: "https://example.invalid/v1/messages",
      publicHeaders: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
      bodyText: "{}"
    })
}

const model = Model.make({ stream: () => Stream.empty })

const flowId = "agents/notes"

const descriptorOf = (seat: Option.Option<string>): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    name: flowId,
    description: "The notes agent.",
    body: new Descriptor.BodyRefMarkdown({
      path: "/flows/agents/notes/flow.md",
      baseDirectory: "/flows/agents/notes",
      contentDigest: "a".repeat(64)
    }),
    input: new Descriptor.SchemaRefNone(),
    output: new Descriptor.SchemaRefNone(),
    model: seat,
    flows: [],
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
    placement: Option.none(),
    modelInvocable: false,
    path: "/flows/agents/notes",
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })

const seated = descriptorOf(Option.some("anthropic:test-model"))

const promptBody = new Descriptor.FlowBodyPrompt({
  text: "Keep the note log tidy.",
  baseDirectory: "/flows/agents/notes"
})

const moduleBody = new Descriptor.FlowBodyModule({ path: "/flows/agents/notes/flow.ts" })

const envelope = { capabilities: [], flows: [], budget: {} }

const runId = "run-1"
const planId = "plan-1"

const launchInput: ControlExecutor.Launch = {
  plan: {
    card: {
      planId,
      flowId,
      digest: "plan-digest",
      executionDigest: Descriptor.executionDigest(seated),
      inputSummary: "{}",
      envelope,
      deployClass: false,
      nodes: [],
      approval: {
        target: { _tag: "Plan", planId, digest: "plan-digest", envelope },
        scope: "run",
        idempotencyKey: `approve:${planId}`
      }
    },
    decodedInput: {},
    decision: "approved"
  },
  run: { runId, flowId, status: "running", planId, createdAt: 1, updatedAt: 1 }
}

const accepted = { _tag: "Accepted" as const, seq: JournalEvent.Seq.make(1), sourceSeq: JournalEvent.SourceSeq.make(1) }

/**
 * The ten `ControlRuntime` members the executor actually reaches, and no
 * others. Writing the stub against this shape rather than the whole service
 * states the executor's real dependency surface: a run driver reads the run
 * and its plan, registers its own fiber for cancellation, registers and reads
 * approvals, fences every status write, and — since a decision on an in-run
 * approval is recorded rather than performed (triage B-15) — claims the row it
 * is about to re-drive and follows the durable resume delegations.
 */
interface RuntimeStub {
  readonly pendingSignals: ControlRuntime["Service"]["pendingSignals"]
  readonly pageRunIds: ControlRuntime["Service"]["pageRunIds"]
  readonly deliveredSignals: ControlRuntime["Service"]["deliveredSignals"]
  readonly getRun: ControlRuntime["Service"]["getRun"]
  readonly getPlan: ControlRuntime["Service"]["getPlan"]
  readonly registerFiber: ControlRuntime["Service"]["registerFiber"]
  readonly registerApproval: ControlRuntime["Service"]["registerApproval"]
  readonly claimFence: ControlRuntime["Service"]["claimFence"]
  readonly writeStatus: ControlRuntime["Service"]["writeStatus"]
  readonly resume: ControlRuntime["Service"]["resume"]
  readonly pendingResumes: ControlRuntime["Service"]["pendingResumes"]
  readonly clearResume: ControlRuntime["Service"]["clearResume"]
  readonly requestResume: ControlRuntime["Service"]["requestResume"]
}

interface Recorder {
  /** Every fenced status transition the executor wrote, in order. */
  readonly statuses: Array<RunStatus>
  /** Every durable journal event the executor emitted, in order. */
  readonly journaled: Array<{ readonly eventType: string; readonly payload: unknown }>
  /** Fires on the first status write, so a scenario never sleeps blindly. */
  readonly settled: Deferred.Deferred<RunStatus>
  /** Fires when the resume bridge has actually subscribed to the journal. */
  readonly subscribed: Deferred.Deferred<void>
}

const recorder = (): Recorder => ({
  statuses: [],
  journaled: [],
  settled: Deferred.makeUnsafe<RunStatus>(),
  subscribed: Deferred.makeUnsafe<void>()
})

const runtimeLayer = (
  record: Recorder,
  overrides: Partial<RuntimeStub> = {}
): Layer.Layer<ControlRuntime> => {
  const stub: RuntimeStub = {
    pendingSignals: Effect.succeed([]),
    pageRunIds: () => Effect.succeed({ ids: [], through: 0 }),
    deliveredSignals: () => Effect.succeed([]),
    getRun: () => Effect.succeed(launchInput.run),
    getPlan: () => Effect.succeed(launchInput.plan),
    registerFiber: () => Effect.void,
    registerApproval: (target) => Effect.succeed({ tokenId: target.requestId, target, _tag: "Pending" }),
    claimFence: () => Effect.succeed("fence-1"),
    writeStatus: (_runId, _fence, status) =>
      Effect.sync(() => {
        record.statuses.push(status)
        Deferred.doneUnsafe(record.settled, Effect.succeed(status))
        return { ...launchInput.run, status }
      }),
    resume: () => Effect.succeed(launchInput.run),
    // No delegation is standing by default, so the durable follower has
    // nothing to take up and every case below observes only what it published.
    pendingResumes: Effect.succeed([]),
    clearResume: () => Effect.void,
    // A delivered answer records the resume it is owed, so the port asks for
    // one; no case below reads the sequence back.
    requestResume: () => Effect.succeed(1),
    ...overrides
  }
  return Layer.succeed(ControlRuntime)(stub as unknown as ControlRuntime["Service"])
}

const journalLayer = (
  record: Recorder,
  overrides: Partial<Journal.Service> = {}
): Layer.Layer<Journal.Journal> =>
  Layer.succeed(Journal.Journal)(
    Journal.makeNoop({
      entries: () => Effect.succeed({ entries: [], hasMore: false }),
      emitDurableUnfenced: (input) =>
        Effect.sync(() => {
          record.journaled.push({ eventType: input.eventType, payload: input.payload })
          return accepted
        }),
      emitLossy: () => Effect.succeed(accepted),
      ...overrides
    })
  )

const registryLayer = (overrides: Partial<Registry.Registry> = {}): Layer.Layer<Registry.Registry> =>
  Layer.succeed(Registry.Registry)(
    Registry.makeNoop({
      list: () => Effect.succeed([seated]),
      visible: () => Effect.succeed([]),
      get: () => Effect.succeed(seated),
      getOption: () => Effect.succeed(Option.some(seated)),
      loadBody: () => Effect.succeed(promptBody),
      ...overrides
    })
  )

const seatLayer = SeatResolver.layer({
  resolve: (id) =>
    Effect.succeed(Seat.make({ id, modelId: Seat.modelIdOf(id), model, route, contextWindowTokens: 200_000 }))
})

/** The ask call a stub agent issues, in the shape the cell boundary builds. */
const askCall = new Cell.Call({
  flowName: "ask",
  input: { question: "publish the log?" },
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  placement: Option.none(),
  identity: new Cell.CallIdentity({
    session: "session-1",
    frame: 0,
    cell: "cell-digest",
    ordinal: 0,
    declaration: "declaration-digest",
    layers: []
  })
})

/** Successful stub runs must claim completion, just like the production loop. */
const completed = Stream.make(
  new AgentEvent.TransitionApplied({
    eventType: "flows.harness.transition-applied.v1",
    transition: new Cell.Complete({ output: "done" })
  })
)

/** An agent that gates one ask through the executor's own `authorize` hook. */
const askingAgent: Agent.Service = Agent.makeNoop({
  run: (options) =>
    Stream.unwrap(
      Effect.as(options.authorize === undefined ? Effect.void : options.authorize(askCall), completed)
    )
})

/**
 * An agent that calls the `ask` flow the executor composed, the way a cell
 * does — through the binding, so the asker's grant-store read happens exactly
 * where the harness makes it happen.
 */
const answeringAgent = (answers: Array<unknown>): Agent.Service =>
  Agent.makeNoop({
    run: (options) =>
      Stream.unwrap(
        Effect.gen(function*() {
          const sources: ReadonlyArray<FlowBinding.Source> = options.flows ?? []
          const source = sources.find((entry) => entry.name === "host/approval")
          const bindings = source === undefined ? [] : yield* source.bindings()
          const binding = bindings.find((entry) => entry.descriptor.name === "ask")
          if (binding === undefined) return Stream.empty
          answers.push((yield* binding.run(askCall)).value)
          return completed
        })
      )
  })

type EngineService = FlowRuntime.FlowRuntime["Service"]

interface ScenarioOptions {
  readonly nowMs?: number
  readonly abandonedParkAfter?: Duration.Duration | undefined
  readonly canExecute?: AgentSession.Options["canExecute"]
  readonly runs?: Partial<RunStore.Service> | undefined
  readonly agent?: Agent.Service | undefined
  readonly runtime?: Partial<RuntimeStub> | undefined
  readonly journal?: Partial<Journal.Service> | undefined
  readonly registry?: Partial<Registry.Registry> | undefined
  readonly catalog?: Executable.Catalog | undefined
  readonly engine?: ((service: EngineService) => EngineService) | undefined
  readonly orderTerminalStatus?: AgentSession.Options["orderTerminalStatus"]
}

const engineLayer = (
  decorate: ScenarioOptions["engine"]
): Layer.Layer<FlowRuntime.FlowRuntime> =>
  decorate === undefined
    ? FlowEngine.layerMemory
    : Layer.effect(FlowRuntime.FlowRuntime)(
      Effect.map(
        Effect.gen(function*() {
          return yield* FlowRuntime.FlowRuntime
        }),
        decorate
      )
    ).pipe(Layer.provide(FlowEngine.layerMemory))

/**
 * Builds the executor over the stub composition and hands it to `scenario`.
 *
 * The scope is the executor's own: it owns the registered agent flow, the
 * resume bridge, and every forked run driver, so a scenario that outlived it
 * would be asserting against a torn-down composition.
 */
const withExecutor = <A>(
  record: Recorder,
  options: ScenarioOptions,
  scenario: (executor: ControlExecutor.Service) => Effect.Effect<A, unknown>
): Promise<A> =>
  Effect.gen(function*() {
    const executor = yield* AgentSession.make({
      canExecute: options.canExecute,
      abandonedParkAfter: options.abandonedParkAfter,
      orderTerminalStatus: options.orderTerminalStatus,
      limits: { calls: 4 },
      maxFrames: 2,
      quotaPolicy: Safety.quotaPolicy,
      budget: Safety.budget
    })
    return yield* scenario(executor)
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Agent.Agent)(options.agent ?? Agent.makeNoop({ run: () => completed })),
        seatLayer,
        runtimeLayer(record, options.runtime),
        registryLayer(options.registry),
        options.catalog === undefined ? Layer.empty : Layer.succeed(Executable.Catalog, options.catalog),
        journalLayer(record, options.journal),
        NotificationQueue.layerNoop(),
        engineLayer(options.engine),
        // The two engine stores the cancel and signal ports write through.
        // This suite exercises the control seam, not those ports, so the
        // stubs are the ones that record nothing.
        RunStore.layerNoop({
          // This reference engine has no durable lineages either. Cancellation
          // of an absent SQL execution is unknown, not a failed database.
          requestCancelLineage: () => Effect.succeed({ _tag: "NotFound" } as const),
          latestRound: () =>
            Effect.fail(
              new RunStore.RunStoreError({
                code: "not_found_row",
                method: "latestRound",
                message: "The reference memory engine has no durable run row",
                cause: undefined
              })
            ),
          // The memory engine has no SQL rows, but it does answer poll(). An
          // unavailable store is a different condition and prevents resume.
          get: () =>
            Effect.fail(
              new RunStore.RunStoreError({
                code: "not_found_row",
                method: "get",
                message: "The reference memory engine has no durable run row",
                cause: undefined
              })
            ),
          ...options.runs
        }),
        DurableEngineState.layerMemory,
        NodeCrypto.layer
      )
    ),
    Effect.scoped,
    Effect.provideServiceEffect(
      Clock.Clock,
      Effect.map(Clock.Clock, (clock) =>
        options.nowMs === undefined ? clock : {
          ...clock,
          currentTimeMillis: Effect.succeed(options.nowMs),
          currentTimeMillisUnsafe: () => options.nowMs!
        })
    ),
    Effect.runPromise
  ) as Promise<A>

/** Launches one run and waits for the first fenced status it writes. */
const launched = (
  record: Recorder,
  options: ScenarioOptions = {}
): Promise<{ readonly acceptance: ControlExecutor.Acceptance; readonly status: RunStatus }> =>
  withExecutor(record, options, (executor) =>
    Effect.gen(function*() {
      const acceptance = yield* executor.launch(launchInput)
      const status = yield* Deferred.await(record.settled).pipe(
        Effect.timeout(Duration.seconds(10)),
        Effect.catchCause(() => Effect.succeed("accepted" as RunStatus))
      )
      return { acceptance, status }
    }))

const causeOf = (record: Recorder): string => {
  const failed = record.journaled.find((entry) => entry.eventType === "control.run.failed")
  return String((failed?.payload as { readonly cause?: unknown } | undefined)?.cause)
}

describe("the executor's control-store seam", () => {
  /**
   * The settled-run guard reads the control row before every round, so a
   * control database that cannot answer must not stop a live run from being
   * driven. A composition with no evidence drives; only a row that says the
   * run is over stops it.
   */
  it("drives a run whose control row cannot be read once the round starts", async () => {
    const record = recorder()
    let reads = 0
    const result = await launched(record, {
      runtime: {
        getRun: () =>
          Effect.suspend(() => {
            reads = reads + 1
            // The admission read is answered; every read after it is refused.
            return reads === 1
              ? Effect.succeed(launchInput.run)
              : Effect.fail(
                new PersistenceError({
                  operation: "ControlRuntime.getRun",
                  message: "the control database is unreadable"
                })
              )
          })
      }
    })

    expect(result.acceptance).toBe("accepted")
    expect(result.status).toBe("completed")
    expect(reads).toBeGreaterThan(1)
  })

  it("reports a control store that cannot register the approval as a typed harness failure", async () => {
    const record = recorder()
    const result = await launched(record, {
      agent: askingAgent,
      runtime: {
        registerApproval: () =>
          Effect.fail(
            new PersistenceError({ operation: "registerApproval", message: "the control store is gone" })
          )
      }
    })

    expect(result.acceptance).toBe("accepted")
    // The run failed rather than parking: an ask whose token was never
    // registered has no park for an operator to resume from.
    expect(result.status).toBe("failed")
    expect(causeOf(record)).toContain("The approval request and token could not be committed")
  })

  it("reports a journal that cannot record the approval request as a typed harness failure", async () => {
    const record = recorder()
    const result = await launched(record, {
      agent: askingAgent,
      journal: {
        // Only the approval request is refused. The status writes that follow
        // must still land, or the failure this case is about is invisible.
        emitDurableUnfenced: (input) =>
          input.eventType === "control.approval.requested"
            ? Effect.fail(new Journal.JournalError({ code: "queue_overflow", message: "the journal is full" }))
            : Effect.sync(() => {
              record.journaled.push({ eventType: input.eventType, payload: input.payload })
              return accepted
            })
      }
    })

    expect(result.status).toBe("failed")
    expect(causeOf(record)).toContain("The approval request and token could not be committed")
  })

  it("reports an unreadable approval decision instead of inventing an answer", async () => {
    const record = recorder()
    const answers: Array<unknown> = []
    const result = await launched(record, {
      agent: answeringAgent(answers),
      runtime: {
        registerApproval: () =>
          Effect.fail(new PersistenceError({ operation: "approval", message: "the decision store is gone" }))
      }
    })

    // The ask never produced an answer, and the failure is the run's, not a
    // call result the cell could have caught.
    expect(answers).toEqual([])
    expect(result.status).toBe("failed")
    expect(causeOf(record)).toContain(`The approval decision could not be read for run ${runId}`)
  })

  it("answers an explicitly denied ask without inferring the answer from grants", async () => {
    const record = recorder()
    const answers: Array<unknown> = []
    const result = await launched(record, {
      agent: answeringAgent(answers),
      runtime: {
        registerApproval: (target) =>
          Effect.succeed({
            _tag: "Denied",
            tokenId: target.requestId,
            target,
            decisionPrincipal: { id: "reviewer", kind: "operator", stampedAt: 1 },
            decidedAt: 1
          })
      }
    })

    expect(result.status).toBe("completed")
    expect(answers).toEqual([{ answer: "denied", approved: false }])
  })

  it("refuses to answer a pending ask even when the authorization hook is bypassed", async () => {
    const record = recorder()
    const answers: Array<unknown> = []
    const result = await launched(record, { agent: answeringAgent(answers) })
    expect(result.status).toBe("failed")
    expect(answers).toEqual([])
    expect(causeOf(record)).toContain("The ask has no approval decision yet")
  })
})

describe("the executor's status fence", () => {
  it("keeps an authoritative terminal status when lifecycle journaling fails", async () => {
    const record = recorder()
    const registered = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>()
    const result = await withExecutor(
      record,
      {
        runtime: {
          registerFiber: (_runId, fiber) => Deferred.succeed(registered, fiber).pipe(Effect.asVoid)
        },
        journal: {
          emitDurableUnfenced: () =>
            Effect.fail(new Journal.JournalError({ code: "queue_overflow", message: "the journal is full" }))
        },
        engine: (engine) =>
          ({ ...engine, execute: () => Effect.fail("engine admission failed") }) as unknown as EngineService
      },
      (executor) =>
        Effect.gen(function*() {
          const acceptance = yield* executor.launch(launchInput)
          const fiber = yield* Deferred.await(registered)
          yield* Fiber.await(fiber)
          return { acceptance, status: record.statuses.at(-1) }
        })
    )

    expect(result).toEqual({ acceptance: "accepted", status: "failed" })
    expect(record.statuses).toEqual(["failed"])
  })

  it("propagates a failed authoritative status write through the owned driver", async () => {
    const record = recorder()
    const registered = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>()
    const result = await withExecutor(
      record,
      {
        runtime: {
          claimFence: () => Effect.die("the fence was claimed away"),
          registerFiber: (_runId, fiber) => Deferred.succeed(registered, fiber).pipe(Effect.asVoid)
        },
        engine: (engine) =>
          ({ ...engine, execute: () => Effect.fail("engine admission failed") }) as unknown as EngineService
      },
      (executor) =>
        Effect.gen(function*() {
          yield* executor.launch(launchInput)
          const fiber = yield* Deferred.await(registered)
          return yield* Fiber.await(fiber)
        })
    )

    expect(result._tag).toBe("Failure")
    expect(record.statuses).toEqual([])
    expect(record.journaled.filter((entry) => entry.eventType.startsWith("control.run."))).toEqual([])
  })
})

describe("the executor's registry seam", () => {
  it("refuses an approved prompt plan without a measured execution identity before starting the agent", async () => {
    const record = recorder()
    let agentCalls = 0
    const failure = await withExecutor(record, {
      agent: Agent.makeNoop({
        run: () => {
          agentCalls++
          return Stream.empty
        }
      })
    }, (executor) =>
      Effect.flip(executor.launch({
        ...launchInput,
        plan: { ...launchInput.plan, card: { ...launchInput.plan.card, executionDigest: undefined } }
      })))
    expect(failure).toBeInstanceOf(LaunchFailed)
    expect((failure as LaunchFailed).message).toContain("create and approve a new plan")
    expect(agentCalls).toBe(0)
    expect(record.statuses).toEqual([])
  })

  it("refuses a launch whose discovered body cannot be loaded", async () => {
    const record = recorder()
    const failure = await withExecutor(
      record,
      {
        registry: {
          loadBody: () =>
            Effect.fail(new RegistryError({ code: "body_unavailable", message: "the flow file was deleted" }))
        }
      },
      (executor) => Effect.flip(executor.launch(launchInput))
    )

    expect(failure).toBeInstanceOf(LaunchFailed)
    expect((failure as LaunchFailed).message).toBe(`The body of flow ${flowId} could not be loaded`)
    // The refusal carries the registry's own typed failure, not its toString.
    // `body_unavailable` and `body_unreadable` need different operator answers,
    // and a stringified cause offers no field to route on.
    const cause = (failure as LaunchFailed).cause as RegistryError
    expect(cause).toBeInstanceOf(RegistryError)
    expect(cause.code).toBe("body_unavailable")
    expect(cause.message).toBe("the flow file was deleted")
    expect(record.statuses).toEqual([])
  })

  it("fails the run when the registry loses the flow's seat between the launch and the body", async () => {
    const record = recorder()
    // The launch reads `getOption` and the body reads `get`, so a registry
    // that answers them differently is exactly the race the body re-validates
    // against.
    const result = await launched(record, { registry: { get: () => Effect.succeed(descriptorOf(Option.none())) } })

    expect(result.acceptance).toBe("accepted")
    expect(result.status).toBe("failed")
    expect(causeOf(record)).toContain("changed or has no approved executable identity")
  })

  it.each([false, true])("fails a body changed to a module with a catalog refusal: %s", async (withRefusal) => {
    const record = recorder()
    let loads = 0
    const result = await launched(record, {
      registry: { loadBody: () => Effect.sync(() => (loads++ === 0 ? promptBody : moduleBody)) },
      catalog: withRefusal ?
        {
          executables: [],
          refused: [
            new Executable.ExecutableError({
              code: "missing_delegate",
              flow: flowId,
              available: [],
              message: "The module delegate was not registered"
            })
          ]
        } :
        undefined
    })

    expect(result.acceptance).toBe("accepted")
    expect(result.status).toBe("failed")
    // Admission is checked again before execution; changed executable
    // identities are refused before a harness is constructed.
    expect(causeOf(record)).toContain(
      withRefusal
        ? "The module delegate was not registered"
        : "has no registered executable matching its approved identity"
    )
    expect(causeOf(record)).toContain("LaunchFailed")
    expect(causeOf(record)).not.toContain("SeatUnresolved")
  })

  /**
   * `runs resume --allow-code-drift` records the flow's current digest on the
   * run. The body re-checks the code it enters on every execution, and
   * checking the plan's digest there refused the very resume the operator
   * allowed: the run was accepted, then failed on its first round (#1807).
   */
  it("runs the changed code an operator adopted on the run with --allow-code-drift", async () => {
    const edited = new Descriptor.FlowDescriptor({
      ...seated,
      body: new Descriptor.BodyRefMarkdown({ ...seated.body, contentDigest: "e".repeat(64) } as never)
    })
    const adopted = { ...launchInput.run, executionDigest: Descriptor.executionDigest(edited) }
    expect(adopted.executionDigest).not.toBe(launchInput.plan.card.executionDigest)
    const run = (recorded: typeof launchInput.run) => {
      const record = recorder()
      // The launch reads `getOption` (the code the plan approved); the body
      // reads `get`, the code on disk after the edit.
      return launched(record, {
        registry: { get: () => Effect.succeed(edited) },
        runtime: { getRun: () => Effect.succeed(recorded) }
      }).then((result) => ({ ...result, cause: causeOf(record) }))
    }

    const allowed = await run(adopted)
    expect(allowed.status).toBe("completed")
    // Nothing adopted: the plan's digest still binds the run.
    const refused = await run(launchInput.run)
    expect(refused.status).toBe("failed")
    expect(refused.cause).toContain("changed or has no approved executable identity")
  })

  /**
   * A self-contained module flow runs the modules its entry imports from
   * beside itself. Those are pinned on the descriptor and ride
   * `executionDigest`, which is the value this guard compares, so editing one
   * after approval has to cost the approval. Before they were pinned, the entry
   * digest matched and the edited sibling ran under the old approval.
   */
  it("refuses a self-contained module flow whose imported sibling changed after approval", async () => {
    const record = recorder()
    const pinnedTo = (helper: string) =>
      new Descriptor.FlowDescriptor({
        ...seated,
        flows: [],
        body: new Descriptor.BodyRefModule({
          path: "/flows/agents/notes/flow.ts",
          contentDigest: "b".repeat(64),
          imports: [{ path: "helper.ts", contentDigest: helper }]
        })
      })
    const approvedDescriptor = pinnedTo("c".repeat(64))
    const editedDescriptor = pinnedTo("d".repeat(64))
    // Only the sibling moved: the entry file is byte-identical.
    expect(editedDescriptor.body.contentDigest).toBe(approvedDescriptor.body.contentDigest)

    const result = await withExecutor(
      record,
      {
        registry: {
          get: () => Effect.succeed(approvedDescriptor),
          getOption: () => Effect.succeed(Option.some(approvedDescriptor)),
          loadBody: () => Effect.succeed(moduleBody)
        },
        // The host's catalog holds what is on disk NOW.
        catalog: {
          executables: [({ descriptor: editedDescriptor, delegate: undefined }) as never],
          refused: []
        }
      },
      (executor) =>
        Effect.flip(executor.launch({
          ...launchInput,
          plan: {
            ...launchInput.plan,
            card: {
              ...launchInput.plan.card,
              executionDigest: Descriptor.executionDigest(approvedDescriptor)
            }
          }
        }))
    )

    // Refused at the launch, before any harness or model boundary opened.
    expect(result).toBeInstanceOf(LaunchFailed)
    expect(result.message).toContain("has no registered executable matching its approved identity")
    expect(record.statuses).toEqual([])
  })

  /**
   * The seam that decides what `smthrs up <flow>` exits with when the catalog
   * refused the flow.
   *
   * A refusal is a warning in the catalog so one broken entry cannot take `ls`
   * down with it. Asking to RUN that entry is the other half: this is where the
   * registry's typed `ExecutableError` becomes the launch failure a command
   * exits non-zero on, carrying the refusal itself rather than its text, so a
   * caller can route on `code` instead of matching a sentence.
   */
  it("fails a launch of a refused module with the registry's own typed refusal", async () => {
    const record = recorder()
    const refusal = new Executable.ExecutableError({
      code: "body_unavailable",
      flow: flowId,
      path: "/flows/agents/notes/flow.ts",
      available: [],
      message:
        `the body of flow "${flowId}" changed at "helper.ts", a module "/flows/agents/notes/flow.ts" imports, after discovery; refresh the registry before running it`
    })
    const moduleDescriptor = new Descriptor.FlowDescriptor({
      ...seated,
      flows: [],
      body: new Descriptor.BodyRefModule({
        path: "/flows/agents/notes/flow.ts",
        contentDigest: "b".repeat(64)
      })
    })

    const failure = await withExecutor(
      record,
      {
        registry: {
          get: () => Effect.succeed(moduleDescriptor),
          getOption: () => Effect.succeed(Option.some(moduleDescriptor)),
          loadBody: () => Effect.succeed(moduleBody)
        },
        catalog: { executables: [], refused: [refusal] }
      },
      (executor) =>
        Effect.flip(executor.launch({
          ...launchInput,
          plan: {
            ...launchInput.plan,
            card: { ...launchInput.plan.card, executionDigest: Descriptor.executionDigest(moduleDescriptor) }
          }
        }))
    )

    expect(failure).toBeInstanceOf(LaunchFailed)
    // The refusal reaches the operator intact: its own message, and the error
    // value itself as the cause.
    expect(failure.message).toContain("changed at \"helper.ts\"")
    expect(failure.cause).toBeInstanceOf(Executable.ExecutableError)
    expect((failure.cause as Executable.ExecutableError).code).toBe("body_unavailable")
    // Nothing ran, and nothing was recorded as running.
    expect(record.statuses).toEqual([])
  })

  it("leaves a flow the registry does not disclose pending, and drives nothing", async () => {
    const record = recorder()
    const acceptance = await withExecutor(
      record,
      { registry: { getOption: () => Effect.succeed(Option.none()) } },
      (executor) => executor.launch(launchInput)
    )

    expect(acceptance).toBe("pending")
    expect(record.statuses).toEqual([])
  })

  /**
   * A prompt flow that declares no seat is refused, not left pending.
   *
   * `pending` says "not mine, somebody else may take it". No agent host can
   * ever take a prompt flow with no seat, so the acceptance promised a driver
   * that was never coming: `smithers init hello && smithers up hello` exited 1
   * and left `run-1` at `accepted` with nothing running (release rehearsal).
   */
  it("refuses a discovered flow with no declared seat, and drives nothing", async () => {
    const record = recorder()
    const failure = await withExecutor(
      record,
      { registry: { getOption: () => Effect.succeed(Option.some(descriptorOf(Option.none()))) } },
      (executor) =>
        Effect.flip(executor.launch({
          ...launchInput,
          plan: {
            ...launchInput.plan,
            card: { ...launchInput.plan.card, executionDigest: Descriptor.executionDigest(descriptorOf(Option.none())) }
          }
        }))
    )

    expect(failure.message).toContain("declares no model seat")
    expect(failure.message).toContain("model:")
    expect(failure.runId).toBe(launchInput.run.runId)
    expect(record.statuses).toEqual([])
  })

  it("leaves a seated flow with a module body pending, and drives nothing", async () => {
    const record = recorder()
    const acceptance = await withExecutor(
      record,
      { registry: { loadBody: () => Effect.succeed(moduleBody) } },
      (executor) => executor.launch(launchInput)
    )

    expect(acceptance).toBe("pending")
    expect(record.statuses).toEqual([])
  })
})

describe("the executor's driver admission fence", () => {
  for (const status of ["waiting-approval", "parked"] as const) {
    it(`parks a background round held by another host (${status})`, async () => {
      const record = recorder()
      let registration: {
        readonly flow: Flow.Any
        readonly execute: (
          payload: { readonly runId: string; readonly planId: string },
          executionId: string
        ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance>
      } | undefined
      let bodies = 0
      await withExecutor(record, {
        runtime: { getRun: () => Effect.succeed({ ...launchInput.run, status, parkedBy: "foreign-host-fence" }) },
        agent: Agent.makeNoop({
          run: () => {
            bodies++
            return completed
          }
        }),
        engine: (engine) => ({
          ...engine,
          register: (flow, execute) =>
            Effect.gen(function*() {
              registration = { flow, execute } as typeof registration
              yield* engine.register(flow, execute)
            })
        })
      }, () =>
        Effect.gen(function*() {
          if (registration === undefined) return yield* Effect.die("agent flow was not registered")
          const instance = FlowEngine.makeInstance(registration.flow, runId)
          const child = yield* registration.execute({ runId, planId }, runId).pipe(
            Effect.provideService(FlowRuntime.FlowInstance, instance),
            Effect.ensuring(Scope.close(instance.scope, Exit.void)),
            Effect.forkChild
          )
          const exit = yield* Fiber.await(child)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(instance.suspended).toBe(true)
          expect(instance.waiting?.reason).toBe(status === "waiting-approval" ? "approval" : "event")
          expect(bodies).toBe(0)
          expect(record.statuses).toEqual([])
        }))
    })
  }

  it("keeps the newer body cancellable when an older overlapping driver finishes", async () => {
    const record = recorder()
    const firstStarted = Deferred.makeUnsafe<void>()
    const secondStarted = Deferred.makeUnsafe<void>()
    const finishFirst = Deferred.makeUnsafe<void>()
    const secondInterrupted = Deferred.makeUnsafe<void>()
    const drives: Array<Fiber.Fiber<unknown, unknown>> = []
    let bodies = 0
    let registration: {
      readonly flow: Flow.Any
      readonly scope: Scope.Scope
      readonly execute: (
        payload: { readonly runId: string; readonly planId: string },
        executionId: string
      ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance>
    } | undefined

    await withExecutor(record, {
      runtime: {
        registerFiber: (_runId, fiber) =>
          Effect.sync(() => {
            drives.push(fiber)
          })
      },
      agent: Agent.makeNoop({
        run: () =>
          Stream.unwrap(Effect.sync(() => {
            bodies++
            return bodies === 1
              ? Stream.fromEffectDrain(
                Deferred.succeed(firstStarted, void 0).pipe(Effect.andThen(Deferred.await(finishFirst)))
              )
              : Stream.fromEffectDrain(
                Deferred.succeed(secondStarted, void 0).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(secondInterrupted, void 0))
                )
              )
          }))
      }),
      engine: (engine) => ({
        ...engine,
        register: (flow, execute) =>
          Effect.gen(function*() {
            registration = { flow, execute, scope: yield* Effect.scope } as typeof registration
            yield* engine.register(flow, execute)
          }),
        // Model a recovered owner starting the successor before its predecessor
        // unwinds. Engine bodies have their own scope: interrupting a driver's
        // join cannot stop them unless the executor retained the newest body.
        execute: ((_flow: Flow.Any, options: {
          readonly executionId: string
          readonly payload: { readonly runId: string; readonly planId: string }
        }) =>
          Effect.gen(function*() {
            if (registration === undefined) return yield* Effect.die("flow was not registered")
            const registered = registration
            const instance = FlowEngine.makeInstance(registered.flow, options.executionId)
            const fiber = yield* registered.execute(
              options.payload as { readonly runId: string; readonly planId: string },
              options.executionId
            ).pipe(
              Effect.provideService(FlowRuntime.FlowInstance, instance),
              Effect.ensuring(Scope.close(instance.scope, Exit.void)),
              Effect.forkIn(registered.scope)
            )
            yield* Fiber.join(fiber)
            return options.executionId
          })) as EngineService["execute"]
      })
    }, (executor) =>
      Effect.gen(function*() {
        expect(yield* executor.launch(launchInput)).toBe("accepted")
        yield* Deferred.await(firstStarted)
        expect(yield* executor.launch(launchInput)).toBe("accepted")
        yield* Deferred.await(secondStarted)
        expect(drives).toHaveLength(2)
        yield* Deferred.succeed(finishFirst, void 0)
        expect((yield* Fiber.await(drives[0]!))._tag).toBe("Success")
        expect(yield* Deferred.isDone(secondInterrupted)).toBe(false)

        yield* Fiber.interrupt(drives[1]!)
        yield* Deferred.await(secondInterrupted).pipe(Effect.timeout(Duration.seconds(10)))
        expect(bodies).toBe(2)
      }))
  })

  it("interrupts a driver that is cancelled before its flow body starts", async () => {
    const record = recorder()
    const registered = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>()
    const executing = Deferred.makeUnsafe<void>()
    const exit = await withExecutor(
      record,
      {
        runtime: {
          getRun: () => Effect.succeed({ ...launchInput.run, status: "running" }),
          registerFiber: (_runId, fiber) => Deferred.succeed(registered, fiber).pipe(Effect.asVoid)
        },
        engine: (engine) =>
          ({
            ...engine,
            execute: () => Effect.andThen(Deferred.succeed(executing, void 0), Effect.never)
          }) as unknown as EngineService
      },
      (executor) =>
        Effect.gen(function*() {
          yield* executor.launch(launchInput)
          const fiber = yield* Deferred.await(registered)
          yield* Deferred.await(executing)
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        })
    )

    expect(exit._tag).toBe("Failure")
    expect(record.statuses).toEqual([])
  })

  it("never executes a driver when registration fails", async () => {
    const record = recorder()
    let executions = 0
    const failure = await withExecutor(
      record,
      {
        runtime: {
          registerFiber: () =>
            Effect.fail(new PersistenceError({ operation: "registerFiber", message: "registration refused" }))
        },
        engine: (engine) =>
          ({
            ...engine,
            execute: (...args: ReadonlyArray<unknown>) => {
              executions += 1
              return (engine.execute as unknown as (...values: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(
                ...args
              )
            }
          }) as unknown as EngineService
      },
      (executor) => Effect.flip(executor.launch(launchInput))
    )

    expect(failure).toMatchObject({ code: "launch_failed", runId })
    expect(executions).toBe(0)
  })

  it("treats a terminal control row as a stop signal, not start permission", async () => {
    const record = recorder()
    const checked = Deferred.makeUnsafe<void>()
    let executions = 0
    const acceptance = await withExecutor(
      record,
      {
        runtime: {
          getRun: () =>
            Effect.sync(() => {
              Deferred.doneUnsafe(checked, Effect.void)
              return { ...launchInput.run, status: "cancelled" as const }
            })
        },
        engine: (engine) =>
          ({
            ...engine,
            execute: () => Effect.sync(() => void (executions += 1))
          }) as unknown as EngineService
      },
      (executor) =>
        Effect.gen(function*() {
          const result = yield* executor.launch(launchInput)
          yield* Deferred.await(checked)
          return result
        })
    )

    expect(acceptance).toBe("accepted")
    expect(executions).toBe(0)
  })

  it("writes failed when the engine rejects before entering the registered body", async () => {
    const record = recorder()
    const result = await launched(record, {
      engine: (engine) =>
        ({ ...engine, execute: () => Effect.fail("engine admission failed") }) as unknown as EngineService
    })

    expect(result).toEqual({ acceptance: "accepted", status: "failed" })
  })

  it("journals the provider code and message ahead of the outer frame stack", async () => {
    const record = recorder()
    const failure = new HarnessError({
      code: "model_failed",
      message: "The cell frame failed",
      cause: new ModelError({ code: "quota_exceeded", message: "Add credits to continue." })
    })
    const result = await launched(record, {
      agent: Agent.makeNoop({ run: () => Stream.fail(failure) })
    })
    expect(result.status).toBe("failed")
    expect(causeOf(record).split("\n")[0]).toBe("quota_exceeded: Add credits to continue.")
    expect(causeOf(record)).toContain("The cell frame failed")
  })

  it("retains the engine's cause when a defect has no typed message fields", async () => {
    const record = recorder()
    const result = await launched(record, {
      agent: Agent.makeNoop({ run: () => Stream.die("opaque model transport defect") })
    })
    expect(result.status).toBe("failed")
    expect(causeOf(record)).toContain("opaque model transport defect")
    expect(causeOf(record)).not.toContain("undefined")
  })
})

describe("the executor's resume bridge", () => {
  const entry = (runId: string, eventType: string): JournalEvent.Entry =>
    new JournalEvent.Entry({
      runId: JournalEvent.RunId.make(runId),
      seq: JournalEvent.Seq.make(1),
      eventId: `event-${runId}`,
      sourceId: JournalEvent.SourceId.make("/test/control"),
      sourceSeq: JournalEvent.SourceSeq.make(1),
      emittedAtMs: 1,
      eventType,
      payload: {},
      meta: {}
    })

  it("keeps following the journal after the engine refuses one re-drive", async () => {
    const record = recorder()
    const resumed: Array<string> = []
    const bothResumed = Deferred.makeUnsafe<void>()
    const hub = await Effect.runPromise(PubSub.unbounded<JournalEvent.Entry>())
    const attempted = await withExecutor(
      record,
      {
        journal: {
          changes: Effect.tap(PubSub.subscribe(hub), () => Deferred.succeed(record.subscribed, void 0))
        },
        engine: (engine) =>
          ({
            ...engine,
            poll: () => Effect.succeed(Option.some({ _tag: "Suspended" })),
            resume: (_flow: unknown, executionId: string) =>
              Effect.suspend(() => {
                resumed.push(executionId)
                if (resumed.length === 2) Deferred.doneUnsafe(bothResumed, Effect.void)
                // The first re-drive dies. The bridge has to survive it and
                // still be following the journal when the next event lands.
                return resumed.length === 1 ? Effect.die("the engine refused the re-drive") : Effect.void
              })
          }) as unknown as EngineService
      },
      () =>
        Effect.gen(function*() {
          yield* Deferred.await(record.subscribed)
          yield* PubSub.publish(hub, entry("run-refused", "control.run.resume"))
          yield* PubSub.publish(hub, entry("run-accepted", "control.run.resumed"))
          yield* Deferred.await(bothResumed)
          return resumed
        })
    )

    // Both event types mean "re-drive", and the second was still delivered
    // after the first one's engine failure was contained.
    expect(attempted).toEqual(["run-refused", "run-accepted"])
  })

  it("re-drives a run another host parked when an operator's own resume asks for it", async () => {
    const record = recorder()
    const resumed: Array<string> = []
    const drove = Deferred.makeUnsafe<void>()
    const hub = await Effect.runPromise(PubSub.unbounded<JournalEvent.Entry>())
    const attempted = await withExecutor(
      record,
      {
        journal: {
          changes: Effect.tap(PubSub.subscribe(hub), () => Deferred.succeed(record.subscribed, void 0))
        },
        runtime: {
          getRun: () => Effect.succeed({ ...launchInput.run, parkedBy: "fence-another-host" })
        },
        engine: (engine) =>
          ({
            ...engine,
            poll: () => Effect.succeed(Option.some({ _tag: "Suspended" })),
            resume: (_flow: unknown, executionId: string) =>
              Effect.sync(() => {
                resumed.push(executionId)
                Deferred.doneUnsafe(drove, Effect.void)
              })
          }) as unknown as EngineService
      },
      () =>
        Effect.gen(function*() {
          yield* Deferred.await(record.subscribed)
          yield* PubSub.publish(hub, entry("run-wedged", "control.run.resume"))
          yield* Deferred.await(drove)
          return resumed
        })
    )

    // `control.run.resume` is an operator's own remedy, and the call that
    // journaled it already claimed the row in this process. A wedged run is by
    // definition one nobody is driving, so the hosting guard — which exists to
    // stop an APPROVAL from taking a run away from its host — does not apply
    // here. Guarding it would leave the operator a claimed row nothing re-drives.
    expect(attempted).toEqual(["run-wedged"])
  })

  it("ignores a journal entry that is not a resume event", async () => {
    const record = recorder()
    const resumed: Array<string> = []
    const resumedOnce = Deferred.makeUnsafe<void>()
    const hub = await Effect.runPromise(PubSub.unbounded<JournalEvent.Entry>())
    const attempted = await withExecutor(
      record,
      {
        journal: {
          changes: Effect.tap(PubSub.subscribe(hub), () => Deferred.succeed(record.subscribed, void 0))
        },
        engine: (engine) =>
          ({
            ...engine,
            poll: () => Effect.succeed(Option.some({ _tag: "Suspended" })),
            resume: (_flow: unknown, executionId: string) =>
              Effect.sync(() => {
                resumed.push(executionId)
                Deferred.doneUnsafe(resumedOnce, Effect.void)
              })
          }) as unknown as EngineService
      },
      () =>
        Effect.gen(function*() {
          yield* Deferred.await(record.subscribed)
          yield* PubSub.publish(hub, entry("run-other", "control.run.completed"))
          yield* PubSub.publish(hub, entry("run-resumed", "control.run.resumed"))
          yield* Deferred.await(resumedOnce)
          return resumed
        })
    )

    expect(attempted).toEqual(["run-resumed"])
  })

  it("does not re-drive an execution that never parked", async () => {
    const record = recorder()
    const resumed: Array<string> = []
    const polled = Deferred.makeUnsafe<void>()
    const hub = await Effect.runPromise(PubSub.unbounded<JournalEvent.Entry>())
    const attempted = await withExecutor(
      record,
      {
        journal: {
          changes: Effect.tap(PubSub.subscribe(hub), () => Deferred.succeed(record.subscribed, void 0))
        },
        engine: (engine) =>
          ({
            ...engine,
            poll: () => Deferred.succeed(polled, void 0).pipe(Effect.as(Option.some({ _tag: "Completed" }))),
            resume: (_flow: unknown, executionId: string) => Effect.sync(() => void resumed.push(executionId))
          }) as unknown as EngineService
      },
      () =>
        Effect.gen(function*() {
          yield* Deferred.await(record.subscribed)
          yield* PubSub.publish(hub, entry("run-settled", "control.run.resume"))
          yield* Deferred.await(polled)
          return resumed
        })
    )

    expect(attempted).toEqual([])
  })

  it("leaves a run a live peer holds to the peer, and re-drives nothing", async () => {
    const record = recorder()
    const resumed: Array<string> = []
    const refused = Deferred.makeUnsafe<void>()
    const hub = await Effect.runPromise(PubSub.unbounded<JournalEvent.Entry>())
    const attempted = await withExecutor(
      record,
      {
        journal: {
          changes: Effect.tap(PubSub.subscribe(hub), () => Deferred.succeed(record.subscribed, void 0))
        },
        runtime: {
          // What a claim answers while another process is driving the run.
          resume: (runId) =>
            Deferred.succeed(refused, void 0).pipe(Effect.andThen(Effect.fail(new ClaimLost({ runId }))))
        },
        engine: (engine) =>
          ({
            ...engine,
            poll: () => Effect.succeed(Option.some({ _tag: "Suspended" })),
            resume: (_flow: unknown, executionId: string) => Effect.sync(() => void resumed.push(executionId))
          }) as unknown as EngineService
      },
      () =>
        Effect.gen(function*() {
          yield* Deferred.await(record.subscribed)
          yield* PubSub.publish(hub, entry("run-held", "control.run.resumed"))
          yield* Deferred.await(refused)
          yield* Effect.yieldNow
          return resumed
        })
    )

    // A run this executor cannot fence is a run it cannot settle, so it does
    // not start one: the owner's own poll takes the delegation up instead.
    expect(attempted).toEqual([])
  })

  it("takes up the delegations it hosts and leaves the rest standing", async () => {
    const record = recorder()
    const resumed: Array<string> = []
    const cleared: Array<string> = []
    const done = Deferred.makeUnsafe<void>()
    const drove = Deferred.makeUnsafe<void>()
    const attempted = await withExecutor(
      record,
      {
        runtime: {
          // The delegation this executor cannot host comes FIRST, and the
          // follower drains the list in order, so the assertions below read a
          // list both entries have been through rather than a race.
          pendingResumes: Effect.succeed([
            { runId: "run-elsewhere", sequence: 8, requestedAtMs: 1 },
            { runId: "run-hosted", sequence: 7, requestedAtMs: 1 }
          ]),
          clearResume: (runId) =>
            Effect.sync(() => {
              cleared.push(runId)
              Deferred.doneUnsafe(done, Effect.void)
            })
        },
        engine: (engine) =>
          ({
            ...engine,
            // Only one of the two executions is in this engine. The other is
            // refused the way every runtime refuses an id it has no record of,
            // which is also why the wait for it ends at once instead of
            // holding the follower through the whole park budget.
            poll: (_flow: unknown, executionId: string) =>
              executionId === "run-hosted"
                ? Effect.succeed(Option.some({ _tag: "Suspended" }))
                : Effect.fail(new FlowRuntime.FlowExecutionNotFound({ code: "execution_not_found", executionId })),
            resume: (_flow: unknown, executionId: string) =>
              Effect.sync(() => {
                resumed.push(executionId)
                Deferred.doneUnsafe(drove, Effect.void)
              })
          }) as unknown as EngineService
      },
      // The re-drive is forked, so both halves are awaited: the clear proves
      // the delegation was consumed, the drive proves the run was restarted.
      () => Effect.as(Effect.all([Deferred.await(done), Deferred.await(drove)]), { resumed, cleared })
    )

    // The delegation this executor hosts is taken up and cleared. The other
    // one is left exactly where it is: clearing it would strand a run whose
    // host has not seen the decision yet.
    expect(attempted.cleared).toEqual(["run-hosted"])
    expect(attempted.resumed).toEqual(["run-hosted"])
  })

  it.each([undefined, Duration.millis(100)])(
    "adopts at the cutoff and leaves a delegation one millisecond younger standing (%s)",
    async (abandonedParkAfter) => {
      const record = recorder()
      const resumed: Array<string> = []
      const cleared: Array<string> = []
      const done = Deferred.makeUnsafe<void>()
      const drove = Deferred.makeUnsafe<void>()
      const nowMs = 60_000
      const cutoff = Duration.toMillis(abandonedParkAfter ?? Ownership.heartbeatStaleAfter)
      const attempted = await withExecutor(record, {
        nowMs,
        abandonedParkAfter,
        runtime: {
          getRun: (runId) =>
            Effect.succeed(
              runId === "run-hosted" ? launchInput.run : { ...launchInput.run, parkedBy: "fence-another-host" }
            ),
          // The hosted sentinel comes last, so the assertion observes a full
          // pass even when a boundary mutation refuses the abandoned park.
          pendingResumes: Effect.succeed([
            { runId: "run-younger", sequence: 8, requestedAtMs: nowMs - cutoff + 1 },
            { runId: "run-boundary", sequence: 9, requestedAtMs: nowMs - cutoff },
            { runId: "run-hosted", sequence: 7, requestedAtMs: nowMs }
          ]),
          clearResume: (runId) =>
            Effect.sync(() => {
              cleared.push(runId)
              if (runId === "run-hosted") Deferred.doneUnsafe(done, Effect.void)
            })
        },
        engine: (engine) =>
          ({
            ...engine,
            poll: () => Effect.succeed(Option.some({ _tag: "Suspended" })),
            resume: (_flow: unknown, executionId: string) =>
              Effect.sync(() => {
                resumed.push(executionId)
                if (executionId === "run-hosted") Deferred.doneUnsafe(drove, Effect.void)
              })
          }) as unknown as EngineService
      }, () => Effect.as(Effect.all([Deferred.await(done), Deferred.await(drove)]), { resumed, cleared }))

      expect(attempted.resumed).toEqual(["run-boundary", "run-hosted"])
      expect(attempted.cleared).toEqual(["run-boundary", "run-hosted"])
    }
  )

  it("keeps the executor alive when the control store cannot list resume delegations", async () => {
    const record = recorder()
    const result = await launched(record, {
      runtime: {
        pendingResumes: Effect.fail(
          new PersistenceError({
            operation: "ControlRuntime.pendingResumes",
            message: "the control database is unreadable"
          })
        )
      }
    })

    // The durable follower is contained the same way the journal bridge is: a
    // control store that cannot answer stops resumes, not launches.
    expect(result.acceptance).toBe("accepted")
    expect(result.status).toBe("completed")
  })

  it("stops the bridge without stopping the executor when the journal subscription itself fails", async () => {
    const record = recorder()
    const result = await launched(record, { journal: { changes: Effect.die("the journal cannot publish changes") } })

    // The bridge is dead, so nothing would re-drive a parked run — but a
    // launch still runs to completion, which is the containment the catch
    // exists to buy.
    expect(result.acceptance).toBe("accepted")
    expect(result.status).toBe("completed")
  })
})

describe("the executor's resume port", () => {
  it.each([false, true])("honors the workspace execution guard (%s) before taking up a resume", async (allowed) => {
    const record = recorder()
    const checked: Array<string> = []
    let polls = 0
    const uptake = await withExecutor(record, {
      canExecute: (id) =>
        Effect.sync(() => {
          checked.push(id)
          return allowed
        }),
      engine: (engine) =>
        ({
          ...engine,
          poll: () =>
            Effect.sync(() => {
              polls++
              return Option.some({ _tag: "Suspended" })
            }),
          resume: () => Effect.void
        }) as unknown as EngineService
    }, (executor) => executor.resumeRun({ runId: "routed-run" }))
    expect(checked).toEqual(["routed-run"])
    expect(uptake).toBe(allowed ? "resuming" : "unknown")
    expect(polls).toBe(allowed ? 1 : 0)
  })

  it("keeps a resume pending when the durable run store is unavailable", async () => {
    const record = recorder()
    let polls = 0
    const uptake = await withExecutor(record, {
      runs: {
        get: () =>
          Effect.fail(
            new RunStore.RunStoreError({
              code: "persistence_failed",
              method: "get",
              message: "injected I/O failure",
              cause: undefined
            })
          )
      },
      engine: (engine) =>
        ({
          ...engine,
          poll: () =>
            Effect.sync(() => {
              polls++
              return Option.some({ _tag: "Suspended" })
            })
        }) as unknown as EngineService
    }, (executor) => executor.resumeRun({ runId: "unavailable-run" }))
    expect(uptake).toBe("unknown")
    expect(polls).toBe(0)
  })

  it("re-drives a run it hosts and reports that it is driving", async () => {
    const record = recorder()
    const resumed: Array<string> = []
    const drove = Deferred.makeUnsafe<void>()
    const observed = await withExecutor(
      record,
      {
        engine: (engine) =>
          ({
            ...engine,
            poll: () => Effect.succeed(Option.some({ _tag: "Suspended" })),
            resume: (_flow: unknown, executionId: string) =>
              Effect.sync(() => {
                resumed.push(executionId)
                Deferred.doneUnsafe(drove, Effect.void)
              })
          }) as unknown as EngineService
      },
      (executor) =>
        Effect.gen(function*() {
          const uptake = yield* executor.resumeRun({ runId: "run-port" })
          yield* Deferred.await(drove)
          return { uptake, resumed }
        })
    )

    // `resuming` is the control plane's cue to stop: the run is moving under
    // this executor's fence, so the delegation can be cleared.
    expect(observed.uptake).toBe("resuming")
    expect(observed.resumed).toEqual(["run-port"])
  })

  it("reports an engine that cannot say whether the run is parked as unknown", async () => {
    const record = recorder()
    const resumed: Array<string> = []
    const observed = await withExecutor(
      record,
      {
        engine: (engine) =>
          ({
            ...engine,
            poll: () => Effect.die("the execution store is unreadable"),
            resume: (_flow: unknown, executionId: string) => Effect.sync(() => void resumed.push(executionId))
          }) as unknown as EngineService
      },
      (executor) => Effect.map(executor.resumeRun({ runId: "run-unreadable" }), (uptake) => ({ uptake, resumed }))
    )

    // The delegation stays standing rather than being cleared against a read
    // that failed, and the control plane is not failed by an engine defect.
    expect(observed.uptake).toBe("unknown")
    expect(observed.resumed).toEqual([])
  })

  it("reports a run another composition parked as unknown, however visible the execution is", async () => {
    const record = recorder()
    const resumed: Array<string> = []
    const observed = await withExecutor(
      record,
      {
        runtime: {
          getRun: () => Effect.succeed({ ...launchInput.run, parkedBy: "fence-another-host" })
        },
        engine: (engine) =>
          ({
            ...engine,
            poll: () => Effect.succeed(Option.some({ _tag: "Suspended" })),
            resume: (_flow: unknown, executionId: string) => Effect.sync(() => void resumed.push(executionId))
          }) as unknown as EngineService
      },
      (executor) => Effect.map(executor.resumeRun({ runId: "run-parked-elsewhere" }), (uptake) => ({ uptake, resumed }))
    )

    // The port is the decision path: a `smithers approve` reaches it with a
    // decision it has just taken, which is no evidence at all that the host
    // that parked the run is gone. It answers `unknown`, the delegation stays
    // standing, and the run keeps waiting for the process that parked it.
    expect(observed.uptake).toBe("unknown")
    expect(observed.resumed).toEqual([])
  })

  it("takes up a run whose control row cannot be read at all, as it did before the guard", async () => {
    const record = recorder()
    const resumed: Array<string> = []
    const drove = Deferred.makeUnsafe<void>()
    const observed = await withExecutor(
      record,
      {
        runtime: {
          getRun: () =>
            Effect.fail(
              new PersistenceError({
                operation: "ControlRuntime.getRun",
                message: "the control database is unreadable"
              })
            )
        },
        engine: (engine) =>
          ({
            ...engine,
            poll: () => Effect.succeed(Option.some({ _tag: "Suspended" })),
            resume: (_flow: unknown, executionId: string) =>
              Effect.sync(() => {
                resumed.push(executionId)
                Deferred.doneUnsafe(drove, Effect.void)
              })
          }) as unknown as EngineService
      },
      (executor) =>
        Effect.gen(function*() {
          const uptake = yield* executor.resumeRun({ runId: "run-unreadable-row" })
          yield* Deferred.await(drove)
          return { uptake, resumed }
        })
    )

    // A store that cannot answer is not evidence that another host parked the
    // run, so the refusal it produces must not become one: the take-up falls
    // back to what it did before `parkedBy` existed rather than stranding a
    // run this executor may well be hosting.
    expect(observed.uptake).toBe("resuming")
    expect(observed.resumed).toEqual(["run-unreadable-row"])
  })

  it("reports a run it does not host as unknown, and drives nothing", async () => {
    const record = recorder()
    const resumed: Array<string> = []
    const observed = await withExecutor(
      record,
      {
        engine: (engine) =>
          ({
            ...engine,
            poll: () => Effect.succeed(Option.none()),
            resume: (_flow: unknown, executionId: string) => Effect.sync(() => void resumed.push(executionId))
          }) as unknown as EngineService
      },
      (executor) => Effect.map(executor.resumeRun({ runId: "run-elsewhere" }), (uptake) => ({ uptake, resumed }))
    )

    expect(observed.uptake).toBe("unknown")
    expect(observed.resumed).toEqual([])
  })
})

describe("the agent flow the executor registers", () => {
  it("carries an inert plan-time body: the registered execute is the behaviour", async () => {
    const record = recorder()
    const registered: Array<unknown> = []
    await withExecutor(
      record,
      {
        engine: (engine) =>
          ({
            ...engine,
            register: (flow: unknown, execute: unknown) => {
              registered.push(flow)
              return (engine.register as unknown as (f: unknown, e: unknown) => Effect.Effect<void, never, never>)(
                flow,
                execute
              )
            }
          }) as unknown as EngineService
      },
      () => Effect.void
    )

    expect(registered).toHaveLength(1)
    const flow = registered[0] as {
      readonly _tag: string
      readonly body: (payload: { readonly runId: string; readonly planId: string }) => unknown
    }
    expect(flow._tag).toBe("agent/run")
    // Inert means the body ignores its payload entirely and settles with
    // nothing: two different runs compile to the same node, and that node is
    // a bare success.
    expect(flow.body({ runId: "run-a", planId: "plan-a" })).toEqual(Node.succeed(undefined))
    expect(flow.body({ runId: "run-b", planId: "plan-b" })).toEqual(
      flow.body({ runId: "run-a", planId: "plan-a" })
    )
  })
})

describe("the executor's engine ports", () => {
  it("answers a cancel and a signal for a run its engine does not have", async () => {
    const record = recorder()
    const observed = await withExecutor(record, {}, (executor) =>
      Effect.gen(function*() {
        return {
          cancel: yield* executor.requestCancel({ runId: launchInput.run.runId }),
          signal: yield* executor.deliverSignal({
            runId: launchInput.run.runId,
            signal: { name: "approval", payload: null }
          })
        }
      }))

    // The stub stores hold no row and no wait point, and neither port invents
    // one: `unknown` is what the control plane needs to hear so it records the
    // request for whichever executor eventually drives the run.
    expect(observed.cancel).toBe("unknown")
    expect(observed.signal).toBe("unknown")
  })
})

describe("the settlement a failure is persisted as", () => {
  /**
   * `agent/run` declares `error: Schema.Unknown`, which `Schema.toCodecJson`
   * reads as "any JSON value". Every real agent failure is an `Error`
   * instance, so the codec rejected every one, `engine-store` degraded the
   * settlement into a projection, and it announced that in a second WARN stack
   * beside the run's own `An agent run failed` (release validation observation N1).
   * Rendering the error to the text the operator already reads is what makes
   * the settlement encodable.
   */
  it("keeps a tagged schema error as a plain object with its refusal fields", () => {
    class Refusal extends Schema.TaggedError<Refusal>()("agent/test/SettlementRefusal", {
      reason: Schema.String,
      retryable: Schema.Boolean
    }) {}
    const rendered = AgentSession.settlementFailure(
      new Refusal({ reason: "no credits remaining", retryable: false })
    )

    expect(rendered).toEqual({
      _tag: "agent/test/SettlementRefusal",
      reason: "no credits remaining",
      retryable: false
    })
    expect(Object.getPrototypeOf(rendered)).toBe(Object.prototype)
  })

  it("renders a class instance to its enumerable fields", () => {
    class Refusal {
      readonly reason = "billing"
    }

    expect(AgentSession.settlementFailure(new Refusal())).toEqual({ reason: "billing" })
  })

  it("renders JSON-compatible projections before falling back to text", () => {
    expect(typeof AgentSession.settlementFailure(() => undefined)).toBe("string")
    // `Error.message` is an own property but a non-enumerable one, so the
    // round trip dropped it and a nested cause settled as `{}`: the record said
    // something failed and nothing about what.
    expect(AgentSession.settlementFailure({ nested: { deep: new Error("boom") } })).toEqual({
      nested: { deep: { message: "boom" } }
    })
    expect(AgentSession.settlementFailure([1, new Error("boom")])).toEqual([1, { message: "boom" }])
    // A message-less error still renders to its enumerable fields alone.
    expect(AgentSession.settlementFailure({ nested: new Error("") })).toEqual({ nested: {} })
    // An object whose `toJSON` answers `undefined` renders to nothing at all
    // rather than to a JSON value, which is the other way the round trip can
    // decline a failure the text renderer still has to carry.
    expect(typeof AgentSession.settlementFailure({ toJSON: () => undefined })).toBe("string")
  })

  it("renders a non-JSON primitive as text rather than letting JSON rewrite it", () => {
    // `JSON.stringify` does not REFUSE `Infinity` and `NaN`, it rewrites both
    // to `null`. Round-tripping them therefore settled an arithmetic failure
    // with the same recorded value as a run that failed with a literal `null`,
    // and nothing downstream could tell the two apart. The round trip is now
    // reserved for objects, so these reach the text renderer.
    for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const rendered = AgentSession.settlementFailure(value)
      expect(typeof rendered).toBe("string")
      expect(rendered).toContain(String(value))
    }
    expect(AgentSession.settlementFailure(null)).toBe(null)
    expect(typeof AgentSession.settlementFailure(undefined)).toBe("string")
    expect(typeof AgentSession.settlementFailure(10n)).toBe("string")
  })

  it("renders a cyclic or very deep value instead of throwing from the mapper", () => {
    // `settlementFailure` runs inside Effect.mapError on the failure channel:
    // a walk that throws turns a clean failure into a defect from the mapper.
    const cyclic: Record<string, unknown> = { flowId: "agents/notes" }
    cyclic["self"] = cyclic
    expect(typeof AgentSession.settlementFailure(cyclic)).toBe("string")

    let deep: Record<string, unknown> = {}
    for (let level = 0; level < 20_000; level++) deep = { deep }
    expect(typeof AgentSession.settlementFailure(deep)).toBe("string")

    // The band between the two limits, which is where a real nested cause
    // lands: `JSON` renders and re-reads it without complaint, and the walk
    // still refuses it, so the round trip produces a value the settlement
    // codec would reject and the text fallback is what the row must carry.
    let past: Record<string, unknown> = {}
    for (let level = 0; level < 400; level++) past = { past }
    expect(JSON.parse(JSON.stringify(past))).toEqual(past)
    expect(typeof AgentSession.settlementFailure(past)).toBe("string")

    // A value that repeats a child without a cycle is still JSON.
    const shared = { id: 1 }
    const repeated = { a: shared, b: shared }
    expect(AgentSession.settlementFailure(repeated)).toBe(repeated)
  })

  it("passes a JSON value through untouched", () => {
    const json = { flowId: "agents/notes", attempts: 2, ok: false, tags: ["a", "b"], note: null }

    expect(AgentSession.settlementFailure(json)).toBe(json)
    expect(AgentSession.settlementFailure("plain")).toBe("plain")
    expect(AgentSession.settlementFailure(7)).toBe(7)
    expect(AgentSession.settlementFailure(true)).toBe(true)
    expect(AgentSession.settlementFailure(null)).toBe(null)
    expect(AgentSession.settlementFailure(Object.create(null) as Record<string, unknown>)).toEqual({})
  })
})

/**
 * The ordering a native host puts between its two independent writers.
 *
 * This executor journals `control.run.completed` from the flow body's exit,
 * inside the engine's registered handler. On the coding host the run's OUTPUT
 * reaches a reader by a second route entirely: the engine commits the round
 * after that handler returns, and a follower copies its
 * `flows.engine.run-decision` into the control journal afterwards. A gateway
 * folding the control journal between the two saw `completed` with no output,
 * which is how two production runs of `repository-jobs/issues` differed.
 *
 * `orderTerminalStatus` is the host's wait between them. Nothing here sleeps:
 * the hook IS the gate, so while it is parked the executor provably has no
 * other path to a terminal status, and the journal stub below signals the
 * exact write rather than a moment after it.
 */
describe("the executor's terminal ordering", () => {
  /** A journal that records as the default one does and names the write. */
  const journalWatching = (record: Recorder, wrote: Deferred.Deferred<void>): Partial<Journal.Service> => ({
    emitDurableUnfenced: (input) =>
      Effect.sync(() => {
        record.journaled.push({ eventType: input.eventType, payload: input.payload })
        if (input.eventType.startsWith("control.run.")) Deferred.doneUnsafe(wrote, Effect.void)
        return accepted
      })
  })

  it("journals no terminal status while the host's ordering holds it", async () => {
    const record = recorder()
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const wrote = Deferred.makeUnsafe<void>()
    const ordered: Array<string> = []

    const observed = await withExecutor(record, {
      journal: journalWatching(record, wrote),
      orderTerminalStatus: (id) =>
        Effect.andThen(
          Effect.sync(() => {
            ordered.push(id)
            Deferred.doneUnsafe(entered, Effect.void)
          }),
          Deferred.await(release)
        )
    }, (executor) =>
      Effect.gen(function*() {
        const acceptance = yield* executor.launch(launchInput)
        // Whichever happens first is the whole finding: a terminal status that
        // reaches the journal before the host's ordering is entered is the
        // unordered write the production runs made.
        const first = yield* Effect.raceFirst(
          Effect.as(Deferred.await(wrote), "status-written"),
          Effect.as(Deferred.await(entered), "ordering-entered")
        ).pipe(Effect.timeout(Duration.seconds(10)))
        const heldStatuses = [...record.statuses]
        const heldEvents = record.journaled.map((entry) => entry.eventType)
        yield* Deferred.succeed(release, void 0)
        yield* Deferred.await(wrote).pipe(Effect.timeout(Duration.seconds(10)))
        return {
          acceptance,
          first,
          heldStatuses,
          heldEvents,
          statuses: [...record.statuses],
          settledEvents: record.journaled.map((entry) => entry.eventType)
        }
      }))

    expect(observed.acceptance).toBe("accepted")
    expect(observed.first).toBe("ordering-entered")
    expect(ordered).toEqual([runId])
    // The run has finished and its status is still unwritten: that is the whole
    // point. A reader folding the journal here cannot see a terminal status.
    expect(observed.heldStatuses).toEqual([])
    expect(observed.heldEvents.filter((kind) => kind.startsWith("control.run."))).toEqual([])
    expect(observed.statuses).toEqual(["completed"])
    expect(observed.settledEvents).toContain("control.run.completed")
  })

  it("still ends the run when the ordering dies instead of answering", async () => {
    const record = recorder()
    const wrote = Deferred.makeUnsafe<void>()

    const observed = await withExecutor(record, {
      journal: journalWatching(record, wrote),
      orderTerminalStatus: () => Effect.die("the host's observation is gone")
    }, (executor) =>
      Effect.gen(function*() {
        yield* executor.launch(launchInput)
        yield* Deferred.await(wrote).pipe(Effect.timeout(Duration.seconds(10)))
        return { statuses: [...record.statuses], events: record.journaled.map((entry) => entry.eventType) }
      }))

    expect(observed.statuses).toEqual(["completed"])
    expect(observed.events).toContain("control.run.completed")
  })

  it("says so when the ordered write is refused, rather than losing it silently", async () => {
    const record = recorder()
    const attempted = Deferred.makeUnsafe<void>()

    const observed = await withExecutor(record, {
      journal: {
        emitDurableUnfenced: (input) =>
          input.eventType.startsWith("control.run.")
            ? Effect.andThen(
              Effect.sync(() => Deferred.doneUnsafe(attempted, Effect.void)),
              Effect.fail(new Journal.JournalError({ code: "queue_overflow", message: "the journal is full" }))
            )
            : Effect.sync(() => {
              record.journaled.push({ eventType: input.eventType, payload: input.payload })
              return accepted
            })
      },
      orderTerminalStatus: () => Effect.void
    }, (executor) =>
      Effect.gen(function*() {
        yield* executor.launch(launchInput)
        yield* Deferred.await(attempted).pipe(Effect.timeout(Duration.seconds(10)))
        return { statuses: [...record.statuses] }
      }))

    // Nothing joins the detached fiber, so the refusal has to be recorded where
    // it happens. The fenced transition still ran; only the record was refused.
    expect(observed.statuses).toEqual(["completed"])
  })

  it("writes nothing on a fiber interrupted out from under the ordering", async () => {
    const record = recorder()
    const entered = Deferred.makeUnsafe<void>()

    const observed = await withExecutor(record, {
      orderTerminalStatus: () =>
        Effect.andThen(
          Effect.sync(() => Deferred.doneUnsafe(entered, Effect.void)),
          Effect.interrupt
        )
    }, (executor) =>
      Effect.gen(function*() {
        yield* executor.launch(launchInput)
        yield* Deferred.await(entered).pipe(Effect.timeout(Duration.seconds(10)))
        yield* Effect.repeat(Effect.yieldNow, { times: 500 })
        return { statuses: [...record.statuses] }
      }))

    // Only a closing scope interrupts this fiber, and the run's row is then
    // reclaimable by the next process by design. Writing through the interrupt
    // would be this composition answering for a host that has already gone.
    expect(observed.statuses).toEqual([])
  })

  it("writes the terminal status inline when no host orders it", async () => {
    const record = recorder()

    const observed = await launched(record)

    expect(observed.acceptance).toBe("accepted")
    expect(observed.status).toBe("completed")
    expect(record.statuses).toEqual(["completed"])
  })
})
