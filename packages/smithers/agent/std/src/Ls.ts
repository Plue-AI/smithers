/**
 * Directory listing flow declaration and portable handler.
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
import { DEFAULT_READ_LIMIT, MAX_ENTRIES, notice } from "./internal/Text.ts"
import * as StdError from "./StdError.ts"

/**
 * The registry name of the `ls` flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "ls"

/**
 * The one-line description the model sees for the `ls` flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description =
  "List a directory with directories first, trailing /, and locale-independent UTF-16 code-unit ordering; use 1-based offset and limit to page large listings."

/**
 * What the `ls` flow accepts.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  path: Schema.String.annotate({ description: "Directory path to list" }),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "1-based entry offset"
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "Maximum entries to return"
  })
})

/**
 * Decoded input accepted by the `ls` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * What the `ls` flow returns.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  entries: Schema.Array(Schema.Struct({
    name: Schema.String.annotate({ description: "Entry name; directories end in /" }),
    kind: Schema.Literals(["file", "directory"]).annotate({ description: "Entry kind" })
  })),
  total: Schema.Number.annotate({ description: "Total entries before paging" }),
  truncated: Schema.Boolean.annotate({ description: "Whether more entries remain" }),
  notice: Schema.optional(Schema.String.annotate({ description: "Truncation disclosure" }))
})

/**
 * Decoded output returned by the `ls` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * The declared effect envelope of the `ls` flow, before any input is known.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({ tier: "sealed", mode: "hermetic", reads: ["/**"], writes: [] })

/**
 * Narrows {@link effects} to what this particular input actually touches.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (input: typeof Input.Type) =>
  envelope({ tier: "sealed", mode: "hermetic", reads: [input.path], writes: [] })

/**
 * The authority the `ls` flow requires.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("fs:read", "/**")]

/**
 * The `ls` flow declaration: schemas, capabilities, and effects, with the
 * implementation attached separately.
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
export const activity = "reads" as const

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
  verb: { pending: "listing", success: "listed", failure: "failed to list" },
  subject: "path",
  result: "entries"
} as const

// localeCompare changes with host locale and ICU data. Code-unit comparisons
// keep journalled directory listings identical on every host.
const byText = (left: string, right: string): number => (left < right ? -1 : Number(left > right))

/**
 * Lists a directory deterministically. A file supplied as `path` is reported
 * as `not_a_directory`.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("Ls.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const info = yield* fileSystem.stat(input.path).pipe(
    Effect.mapError(FsFailure.reading(input.path, `Directory not found: ${input.path}`))
  )
  if (info.type !== "Directory") {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "not_a_directory",
        message: `Cannot list a file: ${input.path}`,
        path: input.path
      })
    )
  }
  const names = yield* fileSystem.readDirectory(input.path).pipe(
    Effect.mapError(FsFailure.reading(input.path, `Directory not found: ${input.path}`))
  )
  const sortedNames = [...names].sort(byText)
  const offset = input.offset ?? 1
  // An empty directory is not an out-of-range listing: the caller asked for
  // the first page and there is nothing on it. This matches `read`, which
  // answers an empty page for an empty file and refuses only a real overshoot.
  if (offset > Math.max(sortedNames.length, 1)) {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "offset_out_of_range",
        message: `Entry offset ${offset} is outside ${input.path}, which has ${sortedNames.length} entries`,
        path: input.path
      })
    )
  }
  const limit = Math.min(input.limit ?? DEFAULT_READ_LIMIT, MAX_ENTRIES)
  // Every entry is described before the page is cut, because the order the
  // description promises is directories first and a kind is a stat away.
  // Statting only the page and ordering inside it made the order local to the
  // page: a directory `zdir/` beside a file `a.txt` came back as
  // `[zdir/, a.txt]` unpaged and as `[a.txt]` then `[zdir/]` at `limit: 1`, so
  // `offset` addressed a different listing at every page size and an agent
  // paging a large directory could see one entry twice and another never.
  //
  // A per-entry stat can fail on a name the directory legitimately
  // contains — a dangling symlink, or a file the guarded filesystem refuses
  // to describe. The name is still real (readDirectory returned it), so the
  // listing reports it as a plain entry instead of dying: one broken link in
  // a repository root used to fail the whole `ls` and cost the agent a frame
  // per attempt.
  const described = yield* Effect.forEach(
    sortedNames,
    (entry) =>
      fileSystem.stat(path.join(input.path, entry)).pipe(
        Effect.map((entryInfo) => ({
          name: entryInfo.type === "Directory" ? `${entry}/` : entry,
          kind: entryInfo.type === "Directory" ? "directory" as const : "file" as const
        })),
        Effect.catch(() => Effect.succeed({ name: entry, kind: "file" as const }))
      ),
    { concurrency: 16 }
  )
  const ordered = [...described].sort((left, right) =>
    left.kind === right.kind ? byText(left.name, right.name) : left.kind === "directory" ? -1 : 1
  )
  const selected = ordered.slice(offset - 1, offset - 1 + limit)
  const truncated = offset - 1 + selected.length < ordered.length
  return {
    entries: selected,
    total: ordered.length,
    truncated,
    ...(truncated ? { notice: notice("entries", selected.length, ordered.length) } : {})
  }
})
