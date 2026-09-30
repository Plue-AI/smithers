import { NodeServices } from "@effect/platform-node"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import type * as SeatRouter from "@smthrs/agent/SeatRouter"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import {
  environmentDispatcher,
  layerSeatCatalog,
  rebuildableTransport,
  seatResolver,
  supervisorStance
} from "@smthrs/cli/NodeControl"
import { Action, HumanTask, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import type * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, type Scope } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { hostname } from "node:os"
import { dirname } from "node:path"
import ReleaseContent from "../release-content/flow.ts"
import * as Content from "../release-content/workflow.ts"
import ReleaseFlow from "../release/flow.ts"
import * as Release from "../release/workflow.ts"
import { evaluatorLayer } from "../repository/jev-checks.ts"
import { relativePath } from "./io.ts"
import { actionLayers } from "./operations.ts"

/** Host composition only. Bun owns its fetch pool; Node owns replaceable Undici
 * agents, built from the egress proxy this process's environment names so a
 * proxied host reaches the provider at all. */
export const modelTransport: Effect.Effect<RequestExecutor.Transport, never, Scope.Scope> = Effect.suspend(() =>
  typeof (globalThis as { Bun?: unknown }).Bun === "undefined"
    ? rebuildableTransport(environmentDispatcher(process.env))
    : Effect.map(HttpClient.HttpClient, RequestExecutor.fixed).pipe(Effect.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })))
    ))
)

/** The same provider/auth routing as the Smithers CLI, with named release roles. */
export const liveSeats = (model: string) =>
  Layer.effect(
    SeatResolver.SeatResolver,
    Effect.gen(function*() {
      const transport = yield* modelTransport
      const executor = yield* RequestExecutor.makeWith(transport)
      const resolver = seatResolver(process.env, executor)
      return SeatResolver.make({ resolve: () => resolver.resolve(model) })
    })
  )

/** The same subscription judge and proxy-aware transport as the native host. */
export const hostEvaluator = (
  environment: Readonly<Record<string, string | undefined>>,
  jevHttp?: Layer.Layer<HttpClient.HttpClient>
): Layer.Layer<Evaluator.Evaluator> => evaluatorLayer(environment, jevHttp)

export const agentLayers = (
  seats: Layer.Layer<SeatResolver.SeatResolver>,
  maxTokens: number,
  evaluator: Layer.Layer<Evaluator.Evaluator> = hostEvaluator(process.env),
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>
    readonly catalog?: Layer.Layer<SeatRouter.Catalog>
  } = {}
) => {
  // Writers receive a bounded evidence snapshot. They have no shell, network,
  // filesystem or publication tools; deterministic actions own that work.
  const environment = options.environment ?? process.env
  const catalog = options.catalog ?? layerSeatCatalog(environment)
  const stance = supervisorStance(environment)
  const host = Layer.effect(
    AgentAction.Host,
    Effect.gen(function*() {
      const registry = yield* Registry.Registry
      const judge = yield* Effect.context<Evaluator.Evaluator>()
      return {
        registry,
        flows: [StandardFlows.jev(judge)],
        supervisor: { stance },
        limits: { memoryBytes: 128 * 1024 * 1024, steps: 25_000_000, calls: 8 },
        capabilityEnvelope: AgentSession.patterns(["model:call:typesafe-ai/jev"]),
        maxFrames: 8,
        defaultCorrections: 2,
        judged: true
      }
    })
  ).pipe(Layer.provide(Registry.layerFromDescriptors([])), Layer.provide(NodeServices.layer))
  return Layer.mergeAll(
    Content.Analyze.layer,
    Content.OutlineTemplate.layer,
    Content.DraftChangelog.layer,
    Content.DraftThread.layer,
    Content.OutlineBlog.layer,
    Content.DraftBlog.layer,
    Content.Score.layer,
    Content.Revise.layer,
    Release.AuditDocs.layer
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(host, seats, catalog, Agent.layer)),
    Layer.provideMerge(
      Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layer({ tokens: { max: maxTokens, onExceeded: "fail" } }))
    ),
    Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(evaluator)
  )
}

export const runtime = (options: {
  readonly root: string
  readonly filename: string
  readonly model: string
  readonly maxTokens: number
}) => {
  const evaluator = hostEvaluator(process.env)
  const registration = Layer.mergeAll(
    actionLayers({
      root: options.root,
      evaluator,
      reviewDirectory: relativePath(options.root, dirname(options.filename))
    }),
    agentLayers(liveSeats(options.model), options.maxTokens, evaluator),
    HumanTask.layer,
    Interpreter.layer(ReleaseContent),
    Interpreter.layer(ReleaseFlow)
  ).pipe(Layer.provideMerge(Action.layerImplementations))
  return NodeRuntime.layerHost({
    filename: options.filename,
    workspaceRoot: options.root,
    owner: { hostId: hostname() }
  }, registration)
}
