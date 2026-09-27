/**
 * The seam between a resolved route and whatever actually runs a flow.
 *
 * @since 0.1.0
 */

import type * as Flow from "@smthrs/core/Flow"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { FsError } from "./FsError.ts"

/**
 * One materialized invocation.
 *
 * @category models
 * @since 0.1.0
 */
export interface Invocation {
  readonly name: string
  readonly flow: Flow.Any
  readonly input: unknown
}

/**
 * Executes a materialized flow.
 *
 * The projections in this package never execute a flow themselves: the harness
 * owns the run loop, permissions, and durability, so it supplies this service.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly invoke: (invocation: Invocation) => Effect.Effect<unknown, FsError>
}

/**
 * The flow invocation service.
 *
 * @category services
 * @since 0.1.0
 */
export class FlowInvoker extends Context.Service<FlowInvoker, Service>()("/fs/FlowInvoker") {}

const ownInvoke = (input: unknown, description: string): Service["invoke"] => {
  if (typeof input !== "object" || input === null) throw new TypeError(description)
  const descriptor = Object.getOwnPropertyDescriptor(input, "invoke")
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") {
    throw new TypeError(description)
  }
  return descriptor.value
}

/**
 * Constructs a flow invoker from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => {
  const invoke = ownInvoke(implementation, "FlowInvoker implementations require an own invoke function")
  return Object.freeze(FlowInvoker.of({ invoke }))
}

/**
 * Constructs an invoker that fails every invocation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const descriptor = Object.getOwnPropertyDescriptor(overrides, "invoke")
  if (descriptor !== undefined && (!("value" in descriptor) || typeof descriptor.value !== "function")) {
    throw new TypeError("FlowInvoker overrides require an own invoke function")
  }
  return make({
    invoke: descriptor?.value ?? Effect.fn("FlowInvoker.invoke")(() =>
      Effect.fail(
        new FsError({
          code: "invocation_unavailable",
          method: "FlowInvoker.invoke",
          description: "No flow invoker is installed"
        })
      )
    )
  })
}

/**
 * Provides an invoker that fails every invocation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<FlowInvoker> =>
  Layer.succeed(FlowInvoker, makeNoop(overrides))
