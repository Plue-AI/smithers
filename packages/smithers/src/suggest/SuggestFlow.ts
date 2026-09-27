/**
 * The bundled flow `smthrs suggest` runs to implement one suggestion, and the
 * Node composition it runs under.
 *
 * One model-backed step: the brief in, an {@link Implemented} out. The agent
 * writes through the standard filesystem flows over a kernel-guarded
 * filesystem pinned to the project root, with no shell, so the promise the
 * verb makes ("writes files and never commits") is enforced by the grant
 * store rather than asserted by a prompt sentence: `.git/` and `.flows/` are
 * denied, every other path under the root is allowed, and nothing else
 * exists.
 *
 * The composition mirrors `@smthrs/migrate`'s `Layers`: the deterministic
 * half (the scan) never enters here, the credentialed half runs through the
 * CLI's own seat resolver so the seat this verb chose is exactly a seat
 * `smthrs up` can run, and a scripted composition replaces only the model.
 *
 * @since 1.0.0-rc.0
 */

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import { Capability, GrantStore, Permission, Workspace } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Evaluator from "@smthrs/model/Evaluator"
import type * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as EgressHttpClient from "@smthrs/platform-node/EgressHttpClient"
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import * as NodeControl from "../NodeControl.ts"
import * as Project from "../Project.ts"
import * as Brief from "./Brief.ts"

/**
 * What the agent hands back: the files it wrote, the command that runs them,
 * and what a reader should know first.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Implemented = Schema.Struct({
  files: Schema.Array(Schema.String),
  command: Schema.String,
  notes: Schema.String
})

/**
 * The decoded answer of one implementation.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Implemented = typeof Implemented.Type

/**
 * The seat role the action declares. The composition maps it onto the seat
 * the verb chose; no model id appears in this module.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const seat = "suggest"

/**
 * How many cell frames one implementation gets before the step fails.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maxFrames = 40

/**
 * The wall clock one implementation gets, in milliseconds.
 *
 * Named once because both ceilings read it: the sandbox's {@link limits} and
 * the model {@link budget}. Every field of `Sandbox.Limits` is optional, so
 * reading the number back off `limits` types as `number | undefined`; the
 * constant is what makes "the same wall clock" a fact the compiler can see
 * rather than a sentence in a comment.
 */
const totalMs = 1_800_000

/**
 * The sandbox budget every cell runs under.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const limits: Sandbox.Limits = {
  calls: 200,
  memoryBytes: 256 * 1024 * 1024,
  steps: 50_000_000,
  callMs: 600_000,
  totalMs
}

/**
 * The implementing step: one brief in, one {@link Implemented} out.
 *
 * @category actions
 * @since 1.0.0-rc.0
 */
export const implement = AgentAction.make("smthrs/suggest-v1/Implement", {
  payload: { brief: Schema.String },
  output: Implemented,
  seat,
  system: [Brief.system],
  prompt: ({ brief }) => brief,
  corrections: 1,
  maxFrames
})

/**
 * The flow id, as the journal records it.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const tag = "smthrs/suggest-v1"

/**
 * The bundled flow: exactly the implementing step.
 *
 * @category flows
 * @since 1.0.0-rc.0
 */
export const flow = Flow.make(tag, {
  payload: { brief: Schema.String },
  success: Implemented,
  error: AgentAction.AgentFailure,
  body: ({ brief }) => implement.call({ brief })
})

/**
 * The action implementation and the flow registration.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = Layer.mergeAll(implement.layer, Interpreter.layer(flow)).pipe(
  Layer.provideMerge(Action.layerImplementations)
)

/**
 * The capability envelope the step runs under. Wider than the confinement,
 * for the reason `@smthrs/migrate`'s `Transform.envelope` gives: the envelope
 * has to subsume what the standard filesystem flows declare, and the grant
 * rules below are what actually bound the writes.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const envelope: ReadonlyArray<string> = ["fs:read:/**", "fs:write:/**"]

/**
 * The permission rules one implementation runs under: the project tree, the
 * model calls, and a denial of every filesystem action under `.git/` and
 * `.flows/`. No `proc:spawn` at all: the step writes files and runs nothing.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const rules = (root: string): ReadonlyArray<Permission.Rule> => {
  const trimmed = root.replace(/\/+$/, "")
  const allow = (action: Capability.PatternAction, resource: string): Permission.Rule =>
    new Permission.Rule({ effect: "allow", pattern: new Capability.CapabilityPattern({ action, resource }) })
  const deny = (action: Capability.PatternAction, resource: string): Permission.Rule =>
    new Permission.Rule({ effect: "deny", pattern: new Capability.CapabilityPattern({ action, resource }) })
  return [
    allow("fs:*", trimmed),
    allow("fs:*", `${trimmed}/**`),
    allow("net:*", "**"),
    allow("model:*", "**"),
    ...[`${trimmed}/.git`, Project.stateDirectory(root)].flatMap((
      state
    ) => [deny("fs:*", state), deny("fs:*", `${state}/**`)])
  ]
}

/**
 * A root that is not absolute builds grant patterns that match nothing, so it
 * is refused before any layer is built.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class RelativeRoot extends Error {
  override readonly name = "RelativeRoot"
  readonly root: string
  constructor(root: string) {
    super(`The suggest root must be an absolute path, and "${root}" is not`)
    this.root = root
  }
}

const grantsFor = (root: string): Layer.Layer<GrantStore.GrantStore> =>
  GrantStore.layer({ attended: false, rules: rules(root) }).pipe(Layer.provide(Workspace.layer(root)), Layer.orDie)

const hostFor = (root: string): Layer.Layer<AgentAction.Host, never, Evaluator.Evaluator> => {
  const grants = grantsFor(root)
  const platform = Layer.orDie(KernelFileSystem.layer).pipe(
    Layer.provide([Workspace.layer(root), grants]),
    Layer.provideMerge(Layer.provideMerge(AtomicFileSystem.layer, NodeServices.layer))
  )
  return Layer.effect(
    AgentAction.Host,
    Effect.gen(function*() {
      const filesystem = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      const judge = yield* Effect.context<Evaluator.Evaluator>()
      const registry = yield* Registry.Registry
      return AgentAction.makeHost({
        registry,
        limits,
        flows: [StandardFlows.filesystem(filesystem), StandardFlows.jev(judge)],
        capabilityEnvelope: AgentSession.patterns(envelope),
        maxFrames,
        judged: true
      })
    })
  ).pipe(Layer.provide(Registry.layerFromDescriptors([])), Layer.provide(platform))
}

/**
 * The spend ceiling one implementation runs under.
 *
 * Not unbounded, and not an approved plan envelope either: this verb is run
 * by hand and there is no control-plane card to read a budget off, so the
 * ceiling is declared here. It is what one suggestion is worth on someone
 * else's subscription, and the latency ceiling is the same wall clock
 * {@link limits} gives the sandbox, so neither half of the step can outlive
 * the other.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const budget: Budget.Policy = {
  tokens: { max: 400_000, onExceeded: "fail" },
  latency: { maxMillis: totalMs, onExceeded: "fail" }
}

const agentPolicy = Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layer(budget))

const layerSnapshotBoundary: Layer.Layer<FlowEngine.SnapshotBoundary> = Layer.succeed(FlowEngine.SnapshotBoundary)({
  snapshot: (options) => Effect.succeed({ boundary: "suggest-run", key: options.key }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(undefined)
})

/**
 * The judge behind the completion brake, read off the host's environment.
 *
 * The brake never falls back: a claim nothing could judge fails the run
 * instead of standing. Without `AI_GATEWAY_API_KEY` this is
 * a synchronous startup refusal. Offline hosts script their own judge.
 *
 * The gateway is reached through the egress proxy `environment` names; a bare
 * Undici pool would dial it directly and a default-deny host would drop that.
 */
const evaluatorFrom = (
  environment: Readonly<Record<string, string | undefined>>
): Layer.Layer<Evaluator.Evaluator> =>
  Evaluator.layerFromEnvironment(environment, "smithers suggest").pipe(
    Layer.provide(EgressHttpClient.layer(environment))
  )

const composed = (
  root: string,
  seats: Layer.Layer<SeatResolver.SeatResolver>,
  evaluator: Layer.Layer<Evaluator.Evaluator>
) =>
  layer.pipe(
    Layer.provideMerge(Layer.mergeAll(hostFor(root), seats, Agent.layer)),
    Layer.provideMerge(agentPolicy),
    Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(layerSnapshotBoundary),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(evaluator)
  )

/**
 * What a Node host needs told.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface NodeConfig {
  /** Explicit offline judge; otherwise select the gateway before acquiring resources. */
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  readonly root: string
  /** The `provider:model` seat the role resolves to. */
  readonly seat: string
  readonly environment: Readonly<Record<string, string | undefined>>
}

/**
 * Everything an implementation needs on Node, including the credentialed
 * half: the CLI's own seat resolver, so the seat the verb chose is exactly
 * what `smthrs up` would run.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerNode = (config: NodeConfig) => {
  const evaluator = isAbsolute(config.root) ? config.evaluator ?? evaluatorFrom(config.environment) : undefined
  return Layer.unwrap(Effect.gen(function*() {
    if (!isAbsolute(config.root)) return yield* Effect.fail(new RelativeRoot(config.root))
    const executor = RequestExecutor.layer.pipe(
      Layer.provide(KernelHttpClient.layer),
      Layer.provide([EgressHttpClient.layer(config.environment), grantsFor(config.root)])
    )
    const seats = Layer.effect(
      SeatResolver.SeatResolver,
      Effect.map(RequestExecutor.RequestExecutor, (request) => {
        const resolver = NodeControl.seatResolver(config.environment, request)
        return SeatResolver.make({ resolve: () => resolver.resolve(config.seat) })
      })
    ).pipe(Layer.provide(executor))
    return composed(config.root, seats, evaluator!)
  }))
}

/**
 * The cell a scripted model answers one frame with.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Script = (asked: string) => string

/**
 * Ends a scripted cell with the value the declared output schema expects.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const done = (output: Implemented): string => `ctx.done(${JSON.stringify(JSON.stringify(output))})`

/**
 * A model that answers every frame with one scripted cell.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const scriptedModel = (script: Script): Model.Model => ({
  stream: (request) =>
    Stream.suspend(() => {
      const asked = [
        ...request.system.map((part) => part.text),
        ...request.messages.flatMap((message) =>
          message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        )
      ].join("\n")
      const cell = script(asked)
      return Stream.fromIterable([
        ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
        ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
        ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
        ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
      ])
    })
})

const preparedRequest = {
  routeId: "suggest",
  protocolId: "suggest",
  method: "POST" as const,
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

/**
 * The production composition with the model scripted: the guarded
 * filesystem, the grant store, the envelope, and the sandbox are real.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerScripted = (config: { readonly root: string; readonly script: Script }) =>
  Layer.unwrap(Effect.gen(function*() {
    if (!isAbsolute(config.root)) return yield* Effect.fail(new RelativeRoot(config.root))
    const model = scriptedModel(config.script)
    const seats = SeatResolver.layer({
      resolve: (id) =>
        Effect.succeed(
          Seat.make({
            id,
            modelId: Seat.modelIdOf(id),
            model,
            route: { prepare: () => Effect.succeed(preparedRequest) },
            contextWindowTokens: 200_000
          })
        )
    })
    // The model is scripted, so the judge is too: this composition reaches
    // no network, and the judge answers every classifier a judged run asks,
    // reading the commands recorded for the claim.
    return composed(config.root, seats, ScriptedJudge.layerAll)
  }))

/**
 * Runs the flow over one brief.
 *
 * The execution id is unique per start: the composition uses an in-memory
 * engine, and one implementation is one run.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const run = (brief: string) => flow.execute({ brief }, { executionId: `suggest-${randomUUID()}` })

/**
 * One sentence for a failed implementation.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const failureMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    const tag = "_tag" in error && typeof error._tag === "string"
      ? error._tag.slice(error._tag.lastIndexOf("/") + 1)
      : ""
    return tag === "" ? error.message : `${tag}: ${error.message}`
  }
  return String(error)
}

type Complete<L> = [L] extends [Layer.Layer<infer _A, infer _E, infer R>] ? [R] extends [never] ? true : false
  : false
type Expect<T extends true> = T

/**
 * Each composition root above owes nothing at the layer level.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type CompositionRootsAreComplete = [
  Expect<Complete<ReturnType<typeof layerNode>>>,
  Expect<Complete<ReturnType<typeof layerScripted>>>
]
