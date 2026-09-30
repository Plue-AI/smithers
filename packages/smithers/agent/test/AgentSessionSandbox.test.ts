/**
 * A flow's sandbox selection runs its tools on the machine the host provides
 * for it, one machine per run, and a selection the host cannot provide refuses
 * before any host code runs, including for old accepted runs.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { LaunchFailed } from "@smthrs/control/ControlError"
import type * as ControlExecutor from "@smthrs/control/ControlExecutor"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { RunStatus } from "@smthrs/control/ControlSchema"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as Jj from "@smthrs/kernel/Jj"
import * as Model from "@smthrs/model/Model"
import { NotificationQueue } from "@smthrs/notifications"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import { Cause, Deferred, Duration, Effect, Exit, Layer, Option, Schedule, Scope, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentSession from "../src/AgentSession.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"
import * as WorkspaceObservation from "../src/WorkspaceObservation.ts"
import * as Safety from "./Safety.ts"

const flowId = "agents/notes"
const runId = "run-1"
const planId = "plan-1"
const unconfiguredMessage =
  `Flow ${flowId} selects sandbox provider container: this host has no sandbox provider configured for it`
const moduleMessage = `Flow ${flowId} selects sandbox provider container: only prompt flows run in a sandbox`
const selection = { provider: "container", network: "none", cpus: 2 } as const

const descriptorOf = (kind: "Prompt" | "Module", selected: boolean): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    name: flowId,
    description: "The notes agent.",
    body: kind === "Prompt"
      ? new Descriptor.BodyRefMarkdown({
        path: "/flows/agents/notes/flow.md",
        baseDirectory: "/flows/agents/notes",
        contentDigest: "a".repeat(64)
      })
      : new Descriptor.BodyRefModule({
        path: "/flows/agents/notes/flow.ts",
        contentDigest: "b".repeat(64)
      }),
    input: new Descriptor.SchemaRefNone(),
    output: new Descriptor.SchemaRefNone(),
    model: Option.some("anthropic:test-model"),
    flows: [],
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
    placement: Option.none(),
    ...(selected ? { sandbox: selection } : {}),
    modelInvocable: false,
    path: "/flows/agents/notes",
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })

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
const completed = Stream.make(
  new AgentEvent.TransitionApplied({
    eventType: "flows.harness.transition-applied.v1",
    transition: new Cell.Complete({ output: "done" })
  })
)

/**
 * Use the real SQL-backed engine and its public executor. Host seams are
 * deliberate spies: no external model, filesystem, or module may run when
 * this host cannot satisfy the selected confinement boundary.
 */
interface Host {
  readonly sandbox?: AgentSession.Options["sandbox"]
  readonly flows?: ReadonlyArray<FlowBinding.Source>
  /** The agent's run; the default completes at once. */
  readonly agentRun?: (options: Agent.Options) => Stream.Stream<AgentEvent.AgentEvent, never, never>
  /** Gives the executor a workspace observer and a checkpoint store, as a native host does. */
  readonly hostTree?: boolean
  /** Waits in the executor's scope before it closes; the default waits for the persisted outcome. */
  readonly settle?: Effect.Effect<void>
}

const run = async (
  kind: "Prompt" | "Module",
  selected: boolean,
  previouslyAccepted = false,
  withCatalog = true,
  host: Host = {}
) => {
  let bodyLoads = 0
  let seatResolutions = 0
  let agentRuns = 0
  let moduleRuns = 0
  const statusWrites: Array<{ runId: string; fence: string; status: RunStatus }> = []
  const descriptor = descriptorOf(kind, selected)
  const envelope = { capabilities: [], flows: [], budget: {} }
  const launchInput: ControlExecutor.Launch = {
    plan: {
      card: {
        planId,
        flowId,
        digest: "plan-digest",
        executionDigest: Descriptor.executionDigest(descriptor),
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
  let controlRun = launchInput.run
  const control = {
    pendingSignals: Effect.succeed([]),
    pageRunIds: () => Effect.succeed({ ids: [], through: 0 }),
    deliveredSignals: () => Effect.succeed([]),
    getRun: () => Effect.sync(() => controlRun),
    recordedCode: () => Effect.succeed({}),
    getPlan: () => Effect.succeed(launchInput.plan),
    registerFiber: () => Effect.void,
    pendingResumes: Effect.succeed([]),
    claimFence: () => Effect.succeed("fence-1"),
    resume: () => Effect.sync(() => controlRun),
    writeStatus: (currentRunId: string, fence: string, status: RunStatus) =>
      Effect.sync(() => {
        statusWrites.push({ runId: currentRunId, fence, status })
        controlRun = { ...controlRun, status }
        return controlRun
      })
  } as unknown as ControlRuntime["Service"]
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* FlowRuntime.FlowRuntime
      const journal = yield* Journal.Journal
      const executor = yield* AgentSession.make({
        limits: { calls: 4 },
        maxFrames: 2,
        quotaPolicy: Safety.quotaPolicy,
        budget: Safety.budget,
        flows: host.flows,
        sandbox: host.sandbox
      }).pipe(Effect.provideService(ControlRuntime, control))
      const launched = previouslyAccepted
        ? yield* Effect.exit(runtime.execute(AgentSession.agentFlow, {
          executionId: runId,
          payload: { runId, planId }
        }))
        : yield* Effect.exit(executor.launch(launchInput))
      // A rejected launch has no execution to poll. Old accepted executions
      // cross the persisted typed-failure boundary even though they fail.
      if (host.settle !== undefined) {
        yield* host.settle
        return { launched, persisted: Option.none(), entries: [] }
      }
      const persisted = !previouslyAccepted && Exit.isFailure(launched)
        ? Option.none()
        : yield* runtime.poll(AgentSession.agentFlow, runId).pipe(
          Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed(Option.none())),
          Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced("10 millis") }),
          Effect.timeout(Duration.seconds(10))
        )
      const entries = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1_000 })
      return { launched, persisted, entries: entries.entries }
    }).pipe(
      Effect.provide(Layer.mergeAll(
        Layer.succeed(Agent.Agent)(Agent.makeNoop({
          run: (options) => {
            agentRuns++
            return host.agentRun?.(options) ?? completed
          }
        })),
        SeatResolver.layer({
          resolve: (id) =>
            Effect.sync(() => {
              seatResolutions++
              return Seat.make({ id, modelId: Seat.modelIdOf(id), model, route, contextWindowTokens: 200_000 })
            })
        }),
        Layer.succeed(Registry.Registry)(Registry.makeNoop({
          get: () => Effect.succeed(descriptor),
          getOption: () => Effect.succeed(Option.some(descriptor)),
          loadBody: () =>
            Effect.sync(() => {
              bodyLoads++
              return kind === "Prompt"
                ? new Descriptor.FlowBodyPrompt({
                  text: "Keep the note log tidy.",
                  baseDirectory: "/flows/agents/notes"
                })
                : new Descriptor.FlowBodyModule({ path: "/flows/agents/notes/flow.ts" })
            }),
          visible: () => Effect.succeed([])
        })),
        withCatalog ?
          Layer.succeed(Executable.Catalog, {
            executables: [{
              descriptor,
              delegate: undefined,
              flow: {
                execute: () =>
                  Effect.sync(() => {
                    moduleRuns++
                    return "done"
                  })
              }
            } as unknown as Executable.Executable],
            refused: []
          }) :
          Layer.empty,
        NotificationQueue.layerNoop(),
        host.hostTree === true
          ? Layer.merge(
            Layer.succeed(WorkspaceObservation.Observer)(
              WorkspaceObservation.Observer.of({ observe: Effect.die("the host tree is not measured here") })
            ),
            Layer.succeed(Checkpoints.Checkpoints)({} as Checkpoints.Checkpoints)
          )
          : Layer.empty,
        EngineStore.layer({
          owner: { hostId: "sandbox-refusal" },
          journalSource: "sandbox-refusal",
          isAlive: () => Effect.succeed(false)
        }).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(StepBoundary.layerTest()),
          Layer.provideMerge(TestStores.layerAt(":memory:")),
          Layer.provideMerge(Layer.merge(
            NodeCrypto.layer,
            Layer.succeed(Jj.Jj)(Jj.make({
              snapshot: () => Effect.succeed({ commitId: "test" as never, changeId: "test" as never }),
              restore: () => Effect.void,
              diff: () => Effect.succeed(""),
              workspaceAdd: () => Effect.void,
              workspaceForget: () => Effect.void,
              status: () => Effect.succeed("")
            }))
          ))
        ),
        NodeCrypto.layer
      )),
      Effect.scoped
    )
  )
  return { ...result, bodyLoads, seatResolutions, agentRuns, moduleRuns, statusWrites, controlRun }
}

const refusalOf = (launched: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(launched) ? Cause.squash(launched.cause) : undefined

describe("AgentSession selected sandbox refusal", () => {
  it("refuses a selected prompt sandbox at launch on a host with no provider, before loading host code", async () => {
    const result = await run("Prompt", true)
    expect(refusalOf(result.launched)).toBeInstanceOf(LaunchFailed)
    expect(refusalOf(result.launched)).toMatchObject({
      _tag: "/control/LaunchFailed",
      runId,
      message: unconfiguredMessage,
      cause: { _tag: "@smthrs/agent/AgentSession/SandboxRefused", provider: "container", reason: "unconfigured" }
    })
    expect(result.bodyLoads).toBe(0)
    expect(result.seatResolutions).toBe(0)
    expect(result.agentRuns).toBe(0)
    expect(result.statusWrites).toEqual([])
  })

  it.each([true, false])(
    "refuses a selected module sandbox before loading host code (provider configured: %s)",
    async (configured) => {
      let opened = 0
      const result = await run("Module", true, false, true, {
        ...(configured
          ? {
            sandbox: () =>
              Effect.succeed(() =>
                Effect.sync(() => {
                  opened++
                  return { flows: [] }
                })
              )
          }
          : {})
      })
      expect(refusalOf(result.launched)).toMatchObject({
        _tag: "/control/LaunchFailed",
        runId,
        message: moduleMessage,
        cause: { reason: "module" }
      })
      expect(opened).toBe(0)
      expect(result.bodyLoads).toBe(0)
      expect(result.moduleRuns).toBe(0)
      expect(result.statusWrites).toEqual([])
    }
  )

  it("refuses a selected module sandbox even when this host has no executable catalog", async () => {
    const result = await run("Module", true, false, false)
    expect(refusalOf(result.launched)).toMatchObject({ _tag: "/control/LaunchFailed", runId, message: moduleMessage })
    expect(result.bodyLoads).toBe(0)
    expect(result.moduleRuns).toBe(0)
    expect(result.statusWrites).toEqual([])
  })

  it("refuses a selection the configured provider cannot honor, with the provider's reason", async () => {
    const selections: Array<Descriptor.SandboxSelection> = []
    const result = await run("Prompt", true, false, true, {
      sandbox: (selection) =>
        Effect.suspend(() => {
          selections.push(selection)
          return Effect.fail(
            new AgentSession.SandboxRefused({
              provider: selection.provider,
              reason: "options",
              message: "cannot enforce limits.cpus"
            })
          )
        })
    })
    expect(selections).toEqual([selection])
    expect(refusalOf(result.launched)).toMatchObject({
      _tag: "/control/LaunchFailed",
      message: `Flow ${flowId} selects sandbox provider container: cannot enforce limits.cpus`,
      cause: { reason: "options" }
    })
    expect(result.agentRuns).toBe(0)
    expect(result.statusWrites).toEqual([])
  })

  it.each(["Prompt", "Module"] as const)(
    "persists refusal for an already accepted %s run before entering its body",
    async (kind) => {
      const message = kind === "Prompt" ? unconfiguredMessage : moduleMessage
      const result = await run(kind, true, true)
      expect(result.persisted).toEqual(Option.some(expect.objectContaining({ _tag: "Complete" })))
      if (Option.isSome(result.persisted) && result.persisted.value._tag === "Complete") {
        expect(result.persisted.value.exit).toMatchObject({ _tag: "Failure" })
        if (Exit.isFailure(result.persisted.value.exit)) {
          expect(Cause.squash(result.persisted.value.exit.cause)).toMatchObject({
            _tag: "/control/LaunchFailed",
            runId,
            message
          })
        }
      }
      expect(JSON.stringify(result.persisted)).not.toContain("UnencodableResult")
      expect(result.bodyLoads).toBe(0)
      expect(result.seatResolutions).toBe(0)
      expect(result.agentRuns).toBe(0)
      expect(result.moduleRuns).toBe(0)
      expect(result.statusWrites).toEqual([{ runId, fence: "fence-1", status: "failed" }])
      expect(result.controlRun.status).toBe("failed")
      expect(result.entries.some((entry) => entry.eventType === "control.run.completed")).toBe(false)
      const failure = result.entries.find((entry) => entry.eventType === "control.run.failed")
      expect(failure?.payload).toMatchObject({ runId, status: "failed", fault: { class: "user" } })
      expect(failure?.payload).toMatchObject({ cause: expect.stringContaining(message) })
    }
  )

  it("runs an unselected prompt through the agent and persists completion", async () => {
    const result = await run("Prompt", false)
    expect(result.launched).toMatchObject({ _tag: "Success", value: "accepted" })
    expect(result.agentRuns).toBe(1)
    expect(result.bodyLoads).toBeGreaterThan(0)
    expect(result.seatResolutions).toBeGreaterThan(0)
    expect(result.moduleRuns).toBe(0)
    expect(result.persisted).toEqual(Option.some(expect.objectContaining({
      _tag: "Complete",
      exit: expect.objectContaining({ _tag: "Success" })
    })))
  })
})

/** A machine as a test sees it: what was acquired under which key, and when it ended. */
const machines = () => {
  const log: Array<string> = []
  const selections: Array<Descriptor.SandboxSelection> = []
  const machineSource = FlowBinding.source("sandbox/tools", [])
  const hostSource = FlowBinding.source("host/tools", [])
  const sandbox: AgentSession.Options["sandbox"] = (chosen) =>
    Effect.sync(() => {
      selections.push(chosen)
      return (session) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            log.push(`acquire ${session}`)
            return { flows: [machineSource] }
          }),
          () => Effect.sync(() => log.push(`release ${session}`))
        )
    })
  return { log, selections, sandbox, machineSource, hostSource }
}

describe("AgentSession selected sandbox execution", () => {
  const observing =
    (seen: Array<{ readonly sources: ReadonlyArray<string>; readonly tree: boolean }>) => (options: Agent.Options) =>
      Stream.unwrap(Effect.gen(function*() {
        seen.push({
          sources: (options.flows ?? []).map((source) => source.name),
          tree: Option.isSome(yield* Effect.serviceOption(WorkspaceObservation.Observer)) ||
            Option.isSome(yield* Effect.serviceOption(Checkpoints.Checkpoints))
        })
        return completed
      }))

  it("runs the tools on one machine acquired for the run, and ends it when the run settles", async () => {
    const machine = machines()
    const seen: Array<{ readonly sources: ReadonlyArray<string>; readonly tree: boolean }> = []
    const result = await run("Prompt", true, false, true, {
      sandbox: machine.sandbox,
      flows: [machine.hostSource],
      hostTree: true,
      agentRun: observing(seen)
    })
    expect(result.launched).toMatchObject({ _tag: "Success", value: "accepted" })
    // Asked at launch and again by the body, always for the flow's own selection.
    expect(machine.selections).toEqual([selection, selection])
    // The machine's tools replace the host's; the standard clock and ask stay.
    // The host's observer and checkpoint store measure the host tree, which
    // this run never touches, so it gets neither.
    expect(seen).toEqual([{ sources: ["sandbox/tools", "engine/clock", "host/approval"], tree: false }])
    expect(machine.log).toEqual([`acquire sandbox:${runId}`, `release sandbox:${runId}`])
    expect(result.statusWrites.map((write) => write.status)).toEqual(["completed"])
  })

  it("keeps the host's tools, observer and checkpoints for an unselected run and acquires nothing", async () => {
    const machine = machines()
    const seen: Array<{ readonly sources: ReadonlyArray<string>; readonly tree: boolean }> = []
    const result = await run("Prompt", false, false, true, {
      sandbox: machine.sandbox,
      flows: [machine.hostSource],
      hostTree: true,
      agentRun: observing(seen)
    })
    expect(result.launched).toMatchObject({ _tag: "Success", value: "accepted" })
    expect(seen).toEqual([{ sources: ["host/tools", "engine/clock", "host/approval"], tree: true }])
    expect(machine.selections).toEqual([])
    expect(machine.log).toEqual([])
  })

  it("fails the run and ends a half-acquired machine when acquisition fails", async () => {
    const log: Array<string> = []
    const result = await run("Prompt", true, false, true, {
      sandbox: () =>
        Effect.succeed((session) =>
          Effect.acquireRelease(
            Effect.sync(() => log.push(`reserve ${session}`)),
            () => Effect.sync(() => log.push(`free ${session}`))
          ).pipe(Effect.andThen(Effect.fail(new Error("the machine did not boot"))))
        )
    })
    expect(result.launched).toMatchObject({ _tag: "Success", value: "accepted" })
    expect(result.agentRuns).toBe(0)
    expect(log).toEqual([`reserve sandbox:${runId}`, `free sandbox:${runId}`])
    expect(result.statusWrites.length).toBeGreaterThan(0)
    expect(result.statusWrites.every((write) => write.status === "failed")).toBe(true)
  })

  it("keeps the machine of a run still driving until the executor closes, and ends it after the body", async () => {
    const machine = machines()
    const entered = Deferred.makeUnsafe<void>()
    const result = await run("Prompt", true, false, true, {
      sandbox: machine.sandbox,
      // The body's own cleanup still acts on the machine, and takes a while.
      agentRun: () =>
        Stream.concat(
          Stream.fromEffect(Effect.as(Deferred.succeed(entered, void 0), completed)).pipe(Stream.drain),
          Stream.never
        ).pipe(
          Stream.ensuring(Effect.andThen(Effect.sleep("200 millis"), Effect.sync(() => machine.log.push("body ended"))))
        ),
      settle: Deferred.await(entered).pipe(Effect.timeout("10 seconds"), Effect.orDie)
    })
    expect(result.launched).toMatchObject({ _tag: "Success", value: "accepted" })
    // Released by the closing executor, never by a settlement: the run did not
    // settle. The machine outlives the body that was still using it.
    expect(machine.log).toEqual([`acquire sandbox:${runId}`, "body ended", `release sandbox:${runId}`])
    expect(result.statusWrites).toEqual([])
  })
})
