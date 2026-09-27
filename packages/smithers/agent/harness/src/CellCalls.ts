/**
 * Registry-backed resolution for the flow calls a cell makes.
 *
 * A cell's only authority is `ctx.call(flow, input)`, so every effect an agent
 * can reach is a registered flow. This module is where a call name becomes a
 * flow: it resolves the name against `@smthrs/registry` — the same registry
 * that discovered `flow.ts`, `flow.mdx`, and `SKILL.md` under the documented
 * precedence — and dispatches to the body the descriptor declares.
 *
 * It is deliberately not a second registry. Discovery, precedence, first-found
 * collision handling, and progressive disclosure all stay in
 * `@smthrs/registry`; this module only decides which body runs and turns
 * every resolution problem into a {@link Cell.CallResult} the cell can inspect.
 *
 * The split between a failed result and a failed effect is the contract
 * `EngineLike.call` declares. A refusal the agent could plausibly correct — an
 * unknown flow, a badly shaped input, a flow this host does not implement — is
 * a `failure` result, so the cell observes a resolved `{ ok: false, error }`
 * envelope and may recover by branching on `.ok === false` and `.error.code`.
 * Ordinary call failures do not throw. Anything the cell must never swallow,
 * such as a permission park or an abort, stays in the error channel of the
 * implementation that raised it.
 *
 * The resolver's shape is exactly `FlowEngineLike.CallRunner["run"]`, so a
 * durable host wires it in without this browser-safe package depending on the
 * engine binding.
 *
 * Governing design: `../docs/concepts.md#durable-cell-loop` and
 * `../docs/concepts.md#flow-registry`.
 *
 * @since 0.1.0
 */

import * as MarkdownFlow from "@smthrs/registry/MarkdownFlow"
import type * as Registry from "@smthrs/registry/Registry"
import { Effect, Option, Schema } from "effect"
import * as Cell from "./Cell.ts"
import type * as FlowBinding from "./FlowBinding.ts"
import { HarnessError } from "./HarnessError.ts"
import { refusal } from "./internal/refusal.ts"

/**
 * One module-backed flow, implemented by the host that discovered it.
 *
 * Discovery reads a module's metadata without evaluating it, so a descriptor
 * never carries a callable body. The host binds the implementation it loaded
 * for the flow, which keeps module evaluation out of both discovery and this
 * package.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Implementation = (
  call: Cell.Call
) => Effect.Effect<Cell.CallResult, HarnessError>

/**
 * One discovered markdown flow, rendered against the call's arguments.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Prompt {
  readonly call: Cell.Call
  readonly text: string
}

/**
 * Runs a rendered markdown flow.
 *
 * A markdown flow is a prompt, so running one is a nested agent run rather than
 * a function call. The host supplies that runner; this module only resolves and
 * renders. A runner whose child declares the `auto` model routes that child
 * through `SeatRouter.durable` from `@smthrs/agent`, keyed by the child run.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type PromptRunner = (
  prompt: Prompt
) => Effect.Effect<Cell.CallResult, HarnessError>

/**
 * The collaborators registry-backed resolution needs.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  readonly registry: Registry.Registry
  /**
   * The composed executable bindings this host resolved.
   *
   * Standard capabilities, plugin-contributed flows, incoming MCP tools, and
   * durable children all arrive here, and all of them resolve through the one
   * snapshot the registry disclosed.
   */
  readonly catalog?: FlowBinding.Catalog | undefined
  /** Host implementations for module-backed flows, keyed by flow name. */
  readonly implementations?: ReadonlyMap<string, Implementation> | undefined
  /** Runs a rendered markdown flow. A host with none answers with a resolved failure envelope. */
  readonly prompt?: PromptRunner | undefined
}

/**
 * Resolves one cell call to the registered flow that answers it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Resolver {
  readonly run: (call: Cell.Call) => Effect.Effect<Cell.CallResult, HarnessError>
}

/**
 * Constructs registry-backed call resolution.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: Options): Resolver => ({
  run: (call) =>
    Effect.gen(function*() {
      const found = yield* options.registry.getOption(call.flowName)
      if (Option.isNone(found)) {
        return refusal(
          "unknown_flow",
          `Flow ${call.flowName} is not in the registry. Only the flows in ctx.flows are callable.`
        )
      }
      const descriptor = found.value
      if (!descriptor.modelInvocable) {
        return refusal("capability_refused", `Flow ${call.flowName} is not model-invocable.`)
      }
      // The registry is refreshable, so the entry could have moved between the
      // frame that showed the model this catalog and the boundary that runs the
      // call. Re-deriving the digest here is what keeps a call bound to the
      // declaration the agent actually chose.
      if (Cell.declarationDigest(descriptor) !== call.identity.declaration) {
        return refusal(
          "declaration_changed",
          `The registry entry for ${call.flowName} changed after this cell was written. Read ctx.flows again and reissue the call.`
        )
      }

      // An executable binding answers first, because a binding *is* the
      // implementation of the declaration it projected. The identity check is
      // what keeps that honest: if the name resolved to some other declaration
      // — a discovered flow shadowing the binding, or two compositions crossed
      // — the call is refused rather than dispatched to the wrong body.
      const binding = options.catalog?.bindings.get(call.flowName)
      if (binding !== undefined) {
        if (Cell.declarationDigest(binding.descriptor) !== Cell.declarationDigest(descriptor)) {
          return refusal(
            "declaration_changed",
            `Flow ${call.flowName} is disclosed by a declaration that does not match the bound implementation. The host must not bind two different declarations to one name.`
          )
        }
        return yield* binding.run(call)
      }

      if (descriptor.body._tag === "Markdown") {
        const prompt = options.prompt
        if (prompt === undefined) {
          return refusal("unimplemented", `Flow ${call.flowName} is a markdown flow and this host runs none.`)
        }
        const decoded = Schema.decodeUnknownResult(MarkdownFlow.Input)(call.input)
        if (decoded._tag === "Failure") {
          return refusal("invalid_input", `Flow ${call.flowName} takes { args: string }.`)
        }
        const text = yield* options.registry.runPrompt(call.flowName, decoded.success).pipe(
          Effect.mapError((cause) =>
            new HarnessError({
              code: "engine_failed",
              message: `The body of markdown flow ${call.flowName} could not be loaded`,
              cause
            })
          )
        )
        return yield* prompt({ call, text })
      }

      const implementation = options.implementations?.get(call.flowName)
      if (implementation === undefined) {
        return refusal(
          "unimplemented",
          `Flow ${call.flowName} is discovered but this host has no implementation bound for it.`
        )
      }
      return yield* implementation(call)
    })
})
