/** Pre-body control refusals must cross the same durable boundary as agent failures. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { ClaimLost } from "@smthrs/control/ControlError"
import type * as ControlExecutor from "@smthrs/control/ControlExecutor"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import * as Jj from "@smthrs/kernel/Jj"
import * as Model from "@smthrs/model/Model"
import { NotificationQueue } from "@smthrs/notifications"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { RunStore } from "@smthrs/run-store"
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect"
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

const seatLayer = SeatResolver.layer({
  resolve: (id) =>
    Effect.succeed(Seat.make({ id, modelId: Seat.modelIdOf(id), model, route, contextWindowTokens: 200_000 }))
})

const loss = new ClaimLost({ runId })

const run = async (contention: boolean) => {
  let entered = false
  let agentRuns = 0
  let cancellations = 0
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* FlowRuntime.FlowRuntime
      const store = yield* RunStore.RunStore
      const control = {
        pendingSignals: Effect.succeed([]),
        pageRunIds: () => Effect.succeed({ ids: [], through: 0 }),
        deliveredSignals: () => Effect.succeed([]),
        getRun: () => Effect.succeed({ ...launchInput.run, status: entered && !contention ? "parked" : "running" }),
        recordedCode: () => Effect.succeed({}),
        getPlan: () => Effect.succeed(launchInput.plan),
        registerFiber: () => Effect.void,
        pendingResumes: Effect.suspend(() => entered && !contention ? Effect.fail(loss) : Effect.succeed([])),
        claimFence: () => contention && entered ? Effect.fail(loss) : Effect.succeed("fence-1"),
        resume: () => Effect.fail(loss),
        writeStatus: () => Effect.succeed(launchInput.run)
      } as unknown as ControlRuntime["Service"]
      const executor = yield* AgentSession.make({
        limits: { calls: 4 },
        maxFrames: 2,
        quotaPolicy: Safety.quotaPolicy,
        budget: Safety.budget
      }).pipe(
        Effect.provideService(ControlRuntime, control),
        Effect.provideService(RunStore.RunStore, {
          ...store,
          requestCancelLineage: (...args) => {
            cancellations++
            return store.requestCancelLineage(...args)
          }
        })
      )
      yield* executor.launch(launchInput)
      return yield* runtime.poll(AgentSession.agentFlow, runId).pipe(
        Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed(Option.none())),
        Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced("10 millis") }),
        Effect.timeout(Duration.seconds(10))
      )
    }).pipe(
      Effect.provide(Layer.mergeAll(
        Layer.succeed(Agent.Agent)(Agent.makeNoop({
          run: () => {
            agentRuns++
            return Stream.empty
          }
        })),
        seatLayer,
        Layer.succeed(Registry.Registry)(Registry.makeNoop({
          get: () => Effect.succeed(seated),
          getOption: () => Effect.succeed(Option.some(seated)),
          loadBody: () => Effect.succeed(promptBody),
          visible: () => Effect.succeed([])
        })),
        Journal.layerNoop(),
        NotificationQueue.layerNoop(),
        Layer.effect(FlowRuntime.FlowRuntime)(Effect.map(FlowRuntime.FlowRuntime, (runtime) => ({
          ...runtime,
          execute: (flow, options) =>
            Effect.suspend(() => {
              entered = true
              return runtime.execute(flow, options)
            })
        }))).pipe(
          Layer.provideMerge(
            EngineStore.layer({
              owner: { hostId: "typed-boundary" },
              journalSource: "typed-boundary",
              isAlive: () => Effect.succeed(false)
            })
          ),
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
  return { agentRuns, cancellations, result }
}

describe("AgentSession pre-body typed failure boundary", () => {
  it("persists ClaimLost before starting the agent without replacing it with UnencodableResult", async () => {
    const { result, agentRuns, cancellations } = await run(false)
    expect(agentRuns).toBe(0)
    expect(cancellations).toBe(0)
    expect(result).toEqual(Option.some(expect.objectContaining({ _tag: "Complete" })))
    const encoded = JSON.stringify(result)
    expect(encoded).toContain("/control/ClaimLost")
    expect(encoded).not.toContain("UnencodableResult")
  })

  it("releases engine ownership when a live peer refuses the control claim without cancelling children", async () => {
    const { result, agentRuns, cancellations } = await run(true)
    expect(agentRuns).toBe(0)
    expect(cancellations).toBe(0)
    expect(result).toEqual(Option.some(expect.objectContaining({ _tag: "Suspended" })))
  })
})
