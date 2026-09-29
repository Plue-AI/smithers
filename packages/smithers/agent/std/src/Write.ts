/**
 * Write flow declaration and portable handler.
 *
 * @since 1.0.0
 */

import * as Flow from "@smthrs/core/Flow"
import * as Path from "@smthrs/kernel/Path"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { capability, envelope } from "./internal/Declaration.ts"
import * as FsFailure from "./internal/FsFailure.ts"
import * as Preserve from "./internal/Preserve.ts"
import * as StdError from "./StdError.ts"

/**
 * Registry name for the write flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "write"

/**
 * Model-facing description of the write flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description =
  "Write UTF-8 text to a path, replacing any existing file; parent directories are created. Prefer edit for targeted changes."

/**
 * Input schema for the write flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  path: Schema.String.annotate({ description: "Path of the file to write" }),
  content: Schema.String.annotate({ description: "Complete UTF-8 file contents" })
})

/**
 * Decoded input accepted by the `write` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * Output schema for the write flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  path: Schema.String.annotate({ description: "Path that was written" }),
  bytesWritten: Schema.Number.annotate({ description: "Number of UTF-8 bytes written" }),
  created: Schema.Boolean.annotate({ description: "Whether the file did not previously exist" })
})

/**
 * Decoded output returned by the `write` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * Static conservative effect envelope for the write flow.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({ tier: "compensable", mode: "hermetic", reads: ["/**"], writes: ["/**"] })

/**
 * Narrows the write effect envelope to one input path.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (input: typeof Input.Type) =>
  envelope({ tier: "compensable", mode: "hermetic", reads: [input.path], writes: [input.path] })

/**
 * Capabilities required by the write flow.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("fs:read", "/**"), capability("fs:write", "/**")]

/**
 * Declaration-only write flow.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

/**
 * What a call to this flow does, for a reader of a run.
 *
 * Display metadata only. `@smthrs/registry` `Descriptor.FlowActivity` is the
 * governing vocabulary and `StandardFlows` binds this value onto the flow's
 * descriptor, where the binding site checks it. `declarationDigest` excludes
 * it, so declaring it cannot invalidate a call identity or a cached prompt.
 *
 * @category presentation
 * @since 1.0.0-rc.0
 */
export const activity = "writes" as const

/**
 * How one recorded call to this flow reads: the verb for each settlement, the
 * input field that is its subject, and the measured output fields a one-line
 * summary may count.
 *
 * Display metadata only, governed by `@smthrs/registry`
 * `Descriptor.CallPresentation` and checked where `StandardFlows` binds it.
 *
 * @category presentation
 * @since 1.0.0-rc.0
 */
export const presentation = {
  verb: { pending: "writing", success: "wrote", failure: "failed to write" },
  subject: "path",
  result: "write"
} as const

const writeError = (path: string, message: string): StdError.StdError =>
  new StdError.StdError({ code: "command_failed", message, path })

/**
 * Replaces a file's contents through the permission-aware kernel filesystem.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("Write.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const existed = yield* fileSystem.exists(input.path).pipe(Effect.orElseSucceed(() => false))
  if (existed) {
    const info = yield* fileSystem.stat(input.path).pipe(
      Effect.mapError(
        FsFailure.denied(input.path, () => writeError(input.path, `Could not inspect ${input.path} before writing`))
      )
    )
    if (info.type === "Directory") {
      return yield* Effect.fail(writeError(input.path, `Cannot write a file over directory ${input.path}`))
    }
  }
  yield* fileSystem.makeDirectory(path.dirname(input.path), { recursive: true }).pipe(
    Effect.mapError(
      FsFailure.denied(
        input.path,
        () => writeError(input.path, `Could not create the parent directory of ${input.path}`)
      )
    )
  )
  yield* Preserve.writeFileString(fileSystem, input.path, input.content).pipe(
    Effect.mapError((error) =>
      error.reason.method === "chmod"
        ? writeError(input.path, `Could not preserve the mode of ${input.path} before replacement by chmod`)
        : FsFailure.denied(input.path, () => writeError(input.path, `Could not write ${input.path}`))(error)
    )
  )
  return {
    path: input.path,
    bytesWritten: new TextEncoder().encode(input.content).byteLength,
    created: !existed
  }
})
