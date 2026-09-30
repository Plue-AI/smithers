/** Selected sandboxes must refuse before host code runs, including old accepted runs. */
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
import { Journal, JournalEvent } from "@smthrs/journal"
import * as Jj from "@smthrs/kernel/Jj"
import * as Model from "@smthrs/model/Model"
import { NotificationQueue } from "@smthrs/notifications"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Cause, Duration, Effect, Exit, Layer, Option, Schedule, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentSession from "../src/AgentSession.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"
import * as Safety from "./Safety.ts"

const flowId = "agents/notes"
const runId = "run-1"
const planId = "plan-1"
const refusalMessage = `Flow ${flowId} selects sandbox provider container, which this agent host cannot execute`
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
const run = async (kind: "Prompt" | "Module", selected: boolean, previouslyAccepted = false, withCatalog = true) => {
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
        budget: Safety.budget
      }).pipe(Effect.provideService(ControlRuntime, control))
      const launched = previouslyAccepted
        ? yield* Effect.exit(runtime.execute(AgentSession.agentFlow, {
          executionId: runId,
          payload: { runId, planId }
        }))
        : yield* Effect.exit(executor.launch(launchInput))
      // A rejected launch has no execution to poll. Old accepted executions
      // cross the persisted typed-failure boundary even though they fail.
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
          run: () => {
            agentRuns++
            return completed
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

describe("AgentSession selected sandbox refusal", () => {
  it.each(["Prompt", "Module"] as const)(
    "refuses a selected %s sandbox at launch before loading host code",
    async (kind) => {
      const result = await run(kind, true)
      expect(Exit.isFailure(result.launched)).toBe(true)
      if (Exit.isFailure(result.launched)) {
        expect(Cause.squash(result.launched.cause)).toBeInstanceOf(LaunchFailed)
        expect(Cause.squash(result.launched.cause)).toMatchObject({
          _tag: "/control/LaunchFailed",
          runId,
          message: refusalMessage
        })
      }
      expect(result.bodyLoads).toBe(0)
      expect(result.seatResolutions).toBe(0)
      expect(result.agentRuns).toBe(0)
      expect(result.moduleRuns).toBe(0)
      expect(result.statusWrites).toEqual([])
    }
  )

  it("refuses a selected module sandbox even when this host has no executable catalog", async () => {
    const result = await run("Module", true, false, false)
    expect(Exit.isFailure(result.launched)).toBe(true)
    if (Exit.isFailure(result.launched)) {
      expect(Cause.squash(result.launched.cause)).toMatchObject({
        _tag: "/control/LaunchFailed",
        runId,
        message: refusalMessage
      })
    }
    expect(result.bodyLoads).toBe(0)
    expect(result.seatResolutions).toBe(0)
    expect(result.agentRuns).toBe(0)
    expect(result.moduleRuns).toBe(0)
    expect(result.statusWrites).toEqual([])
  })

  it.each(["Prompt", "Module"] as const)(
    "persists refusal for an already accepted %s run before entering its body",
    async (kind) => {
      const result = await run(kind, true, true)
      expect(result.persisted).toEqual(Option.some(expect.objectContaining({ _tag: "Complete" })))
      if (Option.isSome(result.persisted) && result.persisted.value._tag === "Complete") {
        expect(result.persisted.value.exit).toMatchObject({ _tag: "Failure" })
        if (Exit.isFailure(result.persisted.value.exit)) {
          expect(Cause.squash(result.persisted.value.exit.cause)).toMatchObject({
            _tag: "/control/LaunchFailed",
            runId,
            message: refusalMessage
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
      expect(failure?.payload).toMatchObject({
        runId,
        status: "failed",
        fault: { class: "infra" }
      })
      expect(failure?.payload).toMatchObject({ cause: expect.stringContaining(refusalMessage) })
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
