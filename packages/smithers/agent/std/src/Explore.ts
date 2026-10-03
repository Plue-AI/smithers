/**
 * Read-only workspace reconnaissance as a dynamic flow.
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"
import * as Glob from "./Glob.ts"
import * as Grep from "./Grep.ts"
import { envelope } from "./internal/Declaration.ts"
import * as Ls from "./Ls.ts"
import * as Read from "./Read.ts"

/**
 * Registry name for the explore flow.
 *
 * @category metadata
 * @since 1.0.0
 */
export const name = "explore" as const

/**
 * Model-facing description of the explore flow.
 *
 * @category metadata
 * @since 1.0.0
 */
export const description =
  "Investigate the workspace read-only, cite every finding as file:line, report evidence only, and never propose edits."

/**
 * Input accepted by the explore flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  prompt: Schema.String.annotate({
    description: "The workspace question to investigate."
  })
})

/**
 * Decoded input accepted by the `explore` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * Output returned by the explore flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  findings: Schema.String.annotate({
    description: "Evidence-backed findings with file:line citations."
  })
})

/**
 * Decoded output returned by the `explore` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * Static effect envelope for read-only workspace reconnaissance.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({
  tier: "sealed",
  mode: "hermetic",
  reads: ["/**"],
  writes: []
})

/**
 * Narrows the explore effect declaration for one decoded input.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (_input: typeof Input.Type) => effects

const flows = Object.freeze(
  [
    Read.flow,
    Ls.flow,
    Glob.flow,
    Grep.flow
  ] as const
)

/**
 * Transitive capabilities of the read-only flows available to explore.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities: ReadonlyArray<string> = Object.freeze(
  [...new Set(flows.flatMap((flow) => flow.capabilities))].sort()
)

/**
 * Constructs an explore flow, optionally pinned to a model.
 *
 * Model selection remains optional so the invoking seat can inject its model.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: {
  readonly model?: string | undefined
}) => ({
  name,
  description,
  input: Input,
  output: Output,
  model: options.model,
  flows,
  prompt: description,
  capabilities,
  effects
} as const)

/**
 * Default explore declaration with seat-selected model injection.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = make({})
