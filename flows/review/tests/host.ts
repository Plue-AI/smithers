/** Test-only composition. Production /review receives these services from its normal host. */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import type * as SeatResolver from "@smthrs/agent/SeatResolver"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Option } from "effect"
import Review, { layer as implementations } from "../flow.ts"

/** Builds ordinary test services without replacing review implementations. */
export const host = (
  seats: Layer.Layer<SeatResolver.SeatResolver>,
  budget = Budget.layer({ latency: { maxMillis: 600_000 } })
) =>
  Agent.layer.pipe(Layer.provideMerge(Layer.mergeAll(
    AgentAction.layerHost({
      registry: Registry.makeNoop({
        list: () => Effect.succeed([]),
        visible: () => Effect.succeed([]),
        getOption: () => Effect.succeed(Option.none())
      }),
      limits: { calls: 8 },
      maxFrames: 4,
      claimCap: 0
    }),
    seats,
    budget,
    QuotaPolicy.layerDefault(),
    Agent.layerDefaults,
    FlowEngine.layerMemory,
    Action.layerImplementations,
    NodeCrypto.layer,
    NodeFileSystem.layer,
    NodePath.layer,
    NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
    Evaluator.layerUnavailable()
  )))

/** Review against a caller-owned engine, seat resolver, budget and evaluator. */
export const layerMemory = (
  seats: Layer.Layer<SeatResolver.SeatResolver>,
  _environment?: Readonly<Record<string, string | undefined>>
) => Layer.merge(implementations, Interpreter.layer(Review)).pipe(Layer.provideMerge(host(seats)))
