/**
 * apply_patch flow declaration and portable handler.
 *
 * A Codex CLI clone: the V4A patch grammar (`*** Begin Patch` /
 * `*** Add File:` / `*** Update File:` / `*** Delete File:` /
 * `*** End Patch`), the fuzzy context-matching applier, and Codex's error
 * and summary text, expressed as a flow over the kernel filesystem.
 *
 * @since 1.0.0
 */

import * as Path from "@smthrs/kernel/Path"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import * as ApplyPatchText from "./internal/ApplyPatch.ts"
import { capability, envelope } from "./internal/Declaration.ts"
import * as Diagnostics from "./internal/Diagnostics.ts"
import * as FileMutation from "./internal/FileMutation.ts"
import * as FsFailure from "./internal/FsFailure.ts"
import * as Preserve from "./internal/Preserve.ts"
import * as StdError from "./StdError.ts"

/**
 * Registry name for the apply_patch flow. Matches the Codex CLI tool name.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "apply_patch"

/**
 * Model-facing description of the apply_patch flow. Matches the Codex CLI
 * freeform tool description.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description =
  "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON."

/**
 * Input schema for the apply_patch flow.
 *
 * Codex delivers the patch as freeform text; the JSON function fallback uses
 * a single `input` field, which is the shape cloned here.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  input: Schema.String.annotate({ description: "The entire contents of the apply_patch command" })
})

/**
 * Decoded input accepted by the `apply_patch` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * Output schema for the apply_patch flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  output: Schema.String.annotate({
    description: "Codex-style summary: 'Success. Updated the following files:' with A/M/D lines"
  }),
  added: Schema.Array(Schema.String).annotate({ description: "Paths of files created by the patch" }),
  modified: Schema.Array(Schema.String).annotate({ description: "Paths of files updated by the patch" }),
  deleted: Schema.Array(Schema.String).annotate({ description: "Paths of files deleted by the patch" })
})

/**
 * Decoded output returned by the `apply_patch` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * Static conservative effect envelope for the apply_patch flow.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({ tier: "compensable", mode: "hermetic", reads: ["/**"], writes: ["/**"] })

/**
 * Narrows the effect envelope for a decoded invocation.
 *
 * A patch names its files inside its own text rather than in a decoded field,
 * and the parse that finds them is the same parse that can fail, so there is
 * nothing here to narrow before the handler runs: the static envelope is the
 * honest answer.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (_input: typeof Input.Type) => effects

/**
 * Capabilities required by the apply_patch flow.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("fs:read", "/**"), capability("fs:write", "/**")]

/**
 * Declaration-only apply_patch flow.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = { name, description, input: Input, output: Output, capabilities, effects } as const

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
  verb: { pending: "patching", success: "patched", failure: "failed to patch" },
  subject: "patch",
  result: "patch"
} as const

/**
 * Every path a patch writes, in the order it names them, including a move's
 * destination. The patch is read by the parser {@link run} uses, so a header
 * `run` accepts is never missed.
 *
 * Returns `undefined` when `run` would refuse the patch. A caller asking
 * permission for the call then asks for everything the flow declares.
 *
 * @category parsing
 * @since 1.0.0-rc.1
 */
export const paths = (patch: string): ReadonlyArray<string> | undefined => {
  let parsed: ApplyPatchText.ParsedPatch
  try {
    parsed = ApplyPatchText.parsePatch(patch)
  } catch {
    return undefined
  }
  return [
    ...new Set(
      parsed.hunks.flatMap((hunk) =>
        hunk.kind === "update" && hunk.movePath !== undefined ? [hunk.path, hunk.movePath] : [hunk.path]
      )
    )
  ]
}

/**
 * The one sentence a model sees for a failure this handler did not design.
 * The raw failure goes to the log, never into the tool result.
 */
const unknownFailureSentence = "Something went wrong on our side. Not your fault."

const unknownFailure = (error: unknown, path?: string): Effect.Effect<never, StdError.StdError> =>
  Effect.logError("apply_patch failed unexpectedly", error).pipe(
    Effect.andThen(Effect.fail(
      new StdError.StdError(
        path === undefined
          ? { code: "command_failed", message: unknownFailureSentence }
          : { code: "command_failed", message: unknownFailureSentence, path }
      )
    ))
  )

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

/**
 * Parses and applies a V4A patch through the permission-aware kernel
 * filesystem, preserving Codex error text.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("ApplyPatch.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  let parsed: ApplyPatchText.ParsedPatch
  try {
    parsed = ApplyPatchText.parsePatch(input.input)
  } catch (error) {
    if (error instanceof ApplyPatchText.ParseError) {
      return yield* Effect.fail(new StdError.StdError({ code: "invalid_input", message: error.message }))
    }
    return yield* unknownFailure(error)
  }

  // Every update hunk is derived from the file as it is on disk, so two
  // sections naming one path both start from the same original and the second
  // write erases the first — while the summary reports two modifications.
  // The preflight cannot honestly validate the second section against a file
  // the first has not written yet, so the patch is refused whole rather than
  // applied by halves. A file needing several edits carries several `@@`
  // chunks inside one section, which is the shape the parser already accepts.
  // Resolve against the injected workspace, then follow existing filesystem
  // aliases. For a new file, resolve its parent (which may be a symlink).
  const identity = (value: string) => {
    const resolved = path.resolve(value)
    return fileSystem.realPath(resolved).pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? fileSystem.realPath(path.dirname(resolved)).pipe(
            Effect.map((parent) => path.resolve(parent, path.basename(resolved))),
            Effect.catch((parentError) =>
              parentError.reason._tag === "NotFound"
                ? Effect.succeed(resolved)
                : Effect.fail(parentError)
            )
          )
          : Effect.fail(error)
      ),
      Effect.mapError(FsFailure.denied(value, () =>
        new StdError.StdError({
          code: "command_failed",
          message: `Failed to resolve patch path ${value}`,
          path: value
        })))
    )
  }
  const touched = new Set<string>()
  for (const hunk of parsed.hunks) {
    const source = yield* identity(hunk.path)
    const destination = hunk.kind === "update" && hunk.movePath !== undefined
      ? yield* identity(hunk.movePath)
      : undefined
    const claims: Array<[string, string]> = [[hunk.path, source]]
    if (hunk.kind === "update" && hunk.movePath !== undefined && destination !== source) {
      claims.push([hunk.movePath, destination!])
    }
    for (const [claimed, key] of claims) {
      if (touched.has(key)) {
        return yield* Effect.fail(
          new StdError.StdError({
            code: "invalid_input",
            message: `The patch names ${claimed} in more than one section; give one section per path`,
            path: claimed
          })
        )
      }
      touched.add(key)
    }
  }

  // Create only parents the patch already intends to create, before taking
  // stable sibling locks for new destinations as well as existing sources.
  for (const hunk of parsed.hunks) {
    const destination = hunk.kind === "add" ? hunk.path : hunk.kind === "update" ? hunk.movePath : undefined
    if (destination !== undefined) {
      yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true }).pipe(
        Effect.mapError(
          FsFailure.denied(destination, () =>
            new StdError.StdError({
              code: "command_failed",
              message: `Failed to create parent directories for ${destination}`,
              path: destination
            }))
        )
      )
    }
  }
  return yield* Effect.scoped(Effect.gen(function*() {
    yield* FileMutation.acquire(
      fileSystem,
      parsed.hunks.flatMap((hunk) =>
        hunk.kind === "update" && hunk.movePath !== undefined ? [hunk.path, hunk.movePath] : [hunk.path]
      ),
      path
    )
    const added: Array<string> = []
    const modified: Array<string> = []
    const deleted: Array<string> = []
    const prepared = new Map<ApplyPatchText.Hunk, string>()

    for (const hunk of parsed.hunks) {
      if (hunk.kind !== "update") continue
      const bytes = yield* fileSystem.readFile(hunk.path).pipe(
        Effect.mapError(FsFailure.reading(hunk.path, `Failed to read file to update ${hunk.path}`))
      )
      if (bytes.includes(0)) {
        return yield* Effect.fail(
          new StdError.StdError({
            code: "binary_file",
            message: `Cannot read binary file: ${hunk.path}`,
            path: hunk.path
          })
        )
      }
      const original = yield* Effect.try({
        try: () => decoder.decode(bytes),
        catch: () =>
          new StdError.StdError({
            code: "binary_file",
            message: `File is not valid UTF-8: ${hunk.path}`,
            path: hunk.path
          })
      })
      let contents: string
      try {
        contents = ApplyPatchText.deriveNewContents(original, hunk.path, hunk.chunks)
      } catch (error) {
        if (error instanceof ApplyPatchText.ComputeReplacementsError) {
          return yield* Effect.fail(
            new StdError.StdError({ code: "no_match", message: error.message, path: hunk.path })
          )
        }
        return yield* unknownFailure(error, hunk.path)
      }
      prepared.set(hunk, contents)
    }

    // A denial names itself, so the model does not retry a write the host refuses.
    const mutationFailure =
      (code: StdError.Code, message: string, offendingPath: string) =>
      (error: PlatformError.PlatformError): StdError.StdError =>
        error.reason._tag === "PermissionDenied"
          ? mutationError("permission_denied", `Permission denied: ${offendingPath}`, offendingPath)
          : mutationError(code, message, offendingPath)
    const mutationError = (code: StdError.Code, message: string, offendingPath: string): StdError.StdError =>
      new StdError.StdError({
        code,
        message: `${message}; applied before failure: added=${JSON.stringify(added)}, modified=${
          JSON.stringify(modified)
        }, deleted=${JSON.stringify(deleted)}`,
        path: offendingPath
      })

    for (const hunk of parsed.hunks) {
      switch (hunk.kind) {
        case "add": {
          yield* fileSystem.writeFile(hunk.path, encoder.encode(hunk.contents)).pipe(
            Effect.mapError(mutationFailure("command_failed", `Failed to write file ${hunk.path}`, hunk.path))
          )
          added.push(hunk.path)
          yield* Diagnostics.sync(path.resolve(hunk.path), hunk.contents)
          break
        }
        case "delete": {
          yield* fileSystem.remove(hunk.path).pipe(
            Effect.mapError(mutationFailure("not_found", `Failed to delete file ${hunk.path}`, hunk.path))
          )
          deleted.push(hunk.path)
          yield* Diagnostics.close(path.resolve(hunk.path))
          break
        }
        case "update": {
          const contents = prepared.get(hunk)!
          const destination = hunk.movePath ?? hunk.path
          yield* Preserve.writeFile(fileSystem, destination, encoder.encode(contents)).pipe(
            Effect.mapError((error) =>
              error.reason.method === "chmod"
                ? mutationError(
                  "command_failed",
                  `Could not preserve the mode of ${destination} before replacement by chmod`,
                  destination
                )
                : mutationFailure("command_failed", `Failed to write file ${destination}`, destination)(error)
            )
          )
          modified.push(destination)
          yield* Diagnostics.sync(path.resolve(destination), contents)
          if (hunk.movePath !== undefined && (yield* identity(hunk.movePath)) !== (yield* identity(hunk.path))) {
            yield* fileSystem.remove(hunk.path).pipe(
              Effect.mapError(mutationFailure("command_failed", `Failed to remove original ${hunk.path}`, hunk.path))
            )
            yield* Diagnostics.close(path.resolve(hunk.path))
          }
          break
        }
      }
    }

    return {
      output: ApplyPatchText.printSummary({ added, deleted, modified }),
      added,
      deleted,
      modified
    }
  }))
})
