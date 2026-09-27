/**
 * PACKAGE.ts memory surfaces: the `S.Memory.Retain` target and the
 * `S.Memory.SmithersCloud` workspace declaration.
 *
 * Phase W1 is construct-only; the target constructor validates attrs by
 * schema and installs a {@link Target.notImplemented} implementation, and
 * the workspace declaration is inert data.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"
import * as Secret from "./Secret.ts"
import * as Target from "./Target.ts"

/**
 * Attrs for {@link Retain}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RetainAttrs = Schema.Struct({
  source: Reference.GitCommit,
  tags: Schema.Array(Schema.NonEmptyString)
})

const retainDefinition = Target.make("Memory.Retain", {
  attrs: RetainAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Memory.Retain")
})

/**
 * Retains the referenced commit in the configured memory bank.
 *
 * @category targets
 * @since 0.1.0
 */
export const Retain = retainDefinition

/**
 * The validated attrs of one `Memory.Retain` target.
 *
 * @category accessors
 * @since 0.1.0
 */
export const retainAttrsOf = (target: Target.AnyTarget): (typeof RetainAttrs)["Type"] => {
  const metadata = Target.metadata(target)
  if (metadata.target !== "Memory.Retain") {
    throw new TypeError(`expected a Memory.Retain target, received ${metadata.target}`)
  }
  return metadata.attrs as (typeof RetainAttrs)["Type"]
}

/**
 * Schema for the Smithers Cloud memory workspace declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SmithersCloudDeclaration = Schema.TaggedStruct("MemorySmithersCloud", {
  bank: Schema.Array(Schema.NonEmptyString),
  autoInject: Schema.optional(Schema.Number),
  init: Schema.optional(Schema.Struct({
    script: Input.File,
    secrets: Schema.optional(Schema.Array(Secret.HttpCredential))
  }))
})

/**
 * The Smithers Cloud memory workspace declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type SmithersCloudDeclaration = typeof SmithersCloudDeclaration.Type

/**
 * Checks whether a value is the Smithers Cloud memory declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isSmithersCloudDeclaration: (value: unknown) => value is SmithersCloudDeclaration = Schema.is(
  SmithersCloudDeclaration
)

/**
 * Declares Smithers Cloud as the workspace memory bank.
 *
 * @category constructors
 * @since 0.1.0
 */
export const SmithersCloud = (options: {
  readonly bank: ReadonlyArray<string>
  readonly autoInject?: number | undefined
  readonly init?: {
    readonly script: Input.File
    readonly secrets?: ReadonlyArray<Secret.HttpCredential> | undefined
  } | undefined
}): SmithersCloudDeclaration =>
  SmithersCloudDeclaration.make({
    bank: [...options.bank],
    ...(options.autoInject === undefined ? {} : { autoInject: options.autoInject }),
    ...(options.init === undefined ? {} : {
      init: {
        script: options.init.script,
        ...(options.init.secrets === undefined ? {} : { secrets: [...options.init.secrets] })
      }
    })
  })
