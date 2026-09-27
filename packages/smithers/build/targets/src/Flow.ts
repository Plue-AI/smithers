/**
 * Flow declarations for `.smithers/FACTORY.ts`.
 *
 * A repository's flows live under `flows/` and describe themselves in their
 * own entry files: the description, the capabilities, the model. What a flow
 * cannot say about itself is how the repository presents it: the one-line
 * `summary` a listing shows under the id, and whether it is `featured`, one
 * of the handful the repository recommends first. That prose belongs to the
 * factory declaration, under `S.Factory({ flows })`, riding the same
 * `summary` and `featured` pair every target carries.
 *
 * `Smithers.Flow` is that declaration. It is inert: it names a flow id and
 * carries its presentation, and nothing reads it until the
 * `FactoryProjection` target projects the declarations over the discovered
 * flows into the `flows` rows of `.smithers/factory.json`. A declaration
 * that names no discovered flow fails that projection by id, so a typo is
 * never silently featured.
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"
import * as NodeUtil from "node:util/types"
import * as Target from "./Target.ts"

/**
 * Maximum length of one declared flow id.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumIdLength = 256

/**
 * The shape of a discovered flow id: path segments of letters, digits, `-`,
 * `_`, and `.`, joined by `/`, exactly as discovery derives them from the
 * directory path below `flows/`.
 *
 * @category constants
 * @since 1.0.0
 */
export const idPattern = /^(?!\.\.?(?:\/|$))[A-Za-z0-9_.-]+(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9_.-]+)*$/

/**
 * Schema for one inert flow declaration.
 *
 * `summary` is absent rather than empty when a declaration carries none, and
 * `featured` is always present, so a catalog row never has to guess at a
 * default the declaration did not state.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Declaration = Schema.TaggedStruct("FlowDeclaration", {
  /** The flow id, the directory path below `flows/`. */
  flow: Schema.NonEmptyString.check(Schema.isMaxLength(maximumIdLength), Schema.isPattern(idPattern)),
  /** The one-line summary a listing shows under the id. */
  summary: Schema.optional(Schema.NonEmptyString),
  /** Whether the repository recommends this flow first. */
  featured: Schema.Boolean
})

/**
 * One inert flow declaration.
 *
 * @category models
 * @since 1.0.0
 */
export type Declaration = typeof Declaration.Type

/**
 * What a `FACTORY.ts` writes to declare a flow's presentation.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options extends Target.Presentation {
  /** The flow id, the directory path below `flows/`. */
  readonly flow: string
}

const optionKeys: ReadonlySet<string> = new Set(["flow", "summary", "featured"])

/**
 * Reports whether a value is a flow declaration.
 *
 * @category guards
 * @since 1.0.0
 */
export const isFlowDeclaration: (value: unknown) => value is Declaration = Schema.is(Declaration)

/**
 * Declares how the repository presents one of its flows.
 *
 * The declaration is validated where it is written: the id has to be a
 * discovery-shaped path, the summary one non-empty line, and `featured` a
 * boolean. Whether the id names a flow that exists is decided when the
 * catalog is rendered, because only discovery knows.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const review = Smithers.Flow({
 *   flow: "review",
 *   summary: "Review the working-copy change and return a verdict with reasons.",
 *   featured: true
 * })
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export const Flow = (options: Options): Declaration => {
  if (
    typeof options !== "object" || options === null || Array.isArray(options) || NodeUtil.isProxy(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) throw new TypeError("Flow options must be a plain object")
  if (Object.getOwnPropertySymbols(options).length > 0) {
    throw new TypeError("Flow options must not contain symbol properties")
  }
  const plain: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(options)) {
    if (!optionKeys.has(key)) throw new TypeError(`Flow received unknown option ${JSON.stringify(key)}`)
    const descriptor = Object.getOwnPropertyDescriptor(options, key) as PropertyDescriptor
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`Flow option ${key} must be an enumerable data property`)
    }
    plain[key] = descriptor.value
  }
  const split = Target.splitPresentation(plain)
  if (typeof split === "string") throw new TypeError(`Flow ${JSON.stringify(plain["flow"])}: ${split}`)
  const flow = (split.attrs as Record<string, unknown>)["flow"]
  if (typeof flow !== "string" || !flow.isWellFormed()) throw new TypeError("Flow id must be a well-formed string")
  if (flow.length > maximumIdLength || !idPattern.test(flow)) {
    throw new TypeError(
      `Flow id must be a directory path below flows/ (segments of letters, digits, "-", "_", "."): ${
        JSON.stringify(flow)
      }`
    )
  }
  return Object.freeze(Declaration.make({
    flow,
    ...(split.presentation.summary === undefined ? {} : { summary: split.presentation.summary }),
    featured: split.presentation.featured
  }))
}
