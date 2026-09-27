/**
 * Inert mise version-authority declarations and tool references.
 *
 * mise is the version pin authority for every toolchain layer in a
 * multi-language workspace: the `[tools]` table of the declared
 * `.mise.toml`/`mise.toml` keys the tools a target uses, so bumping one pin
 * invalidates exactly the targets keyed on that tool. This module declares
 * the config as a workspace toolchain layer and the `bin` reference a
 * target uses to name one config-pinned executable; resolution and the
 * typed host refusal when mise is absent live in the planner.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"

/**
 * A mise config participating in the workspace toolchain layer list.
 *
 * @category declarations
 * @since 0.1.0
 */
export const Declaration = Schema.TaggedStruct("Mise", {
  config: Input.File
})

/**
 * A mise config participating in the workspace toolchain layer list.
 *
 * @category declarations
 * @since 0.1.0
 */
export type Declaration = typeof Declaration.Type

/**
 * Checks whether a value is an `S.Mise` declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isDeclaration: (value: unknown) => value is Declaration = Schema.is(Declaration)

const make = (options: { readonly config: Input.File }): Declaration => {
  if (typeof options !== "object" || options === null) throw new TypeError("Mise options must be an object")
  for (const key of Object.getOwnPropertyNames(options)) {
    if (key !== "config") throw new TypeError(`Mise received unknown option ${JSON.stringify(key)}`)
  }
  if (options.config?._tag !== "File") throw new TypeError("Mise config must be an S.file declaration")
  return Object.freeze(Declaration.make({ config: options.config }))
}

/**
 * `S.Mise({ config })`, with `S.Mise.bin(name)` for config-pinned tools.
 *
 * @category declarations
 * @since 0.1.0
 */
export const Mise: typeof make & { readonly bin: (name: string) => Reference.MiseBin } = Object.assign(make, {
  bin: Reference.miseBin
})
