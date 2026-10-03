/**
 * Edit flow declaration and portable handler.
 *
 * Three rules, each of them paid for by a measured failure:
 *
 * 1. **Exact or loud.** The anchor matches the file's bytes or the call fails
 *    with the file's actual bytes at the nearest region. No fuzzy apply reports
 *    success (sympy-15380 corrupted a file that way), and no failure returns a
 *    bare `null` (sphinx-7590 abandoned a correct edit twice against one).
 * 2. **Anchors by reference.** A prior `grep` or `read` already located the
 *    region; `startLine`/`endLine` re-use that hit instead of retyping the text,
 *    and `expect` turns the retyped copy into a checked assertion rather than a
 *    search key.
 * 3. **The hunk comes back.** The result carries the applied region as raw text
 *    with its line range, so a mis-indented edit costs one glance instead of an
 *    investigation (sphinx-7233 lost its verdict to a hunk nobody could see).
 *    With a `LanguageServer` bound, the file's errors after the edit come back
 *    too.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { capability, envelope } from "./internal/Declaration.ts"
import * as Diagnostics from "./internal/Diagnostics.ts"
import * as FileMutation from "./internal/FileMutation.ts"
import * as FsFailure from "./internal/FsFailure.ts"
import * as Match from "./internal/Match.ts"
import * as Preserve from "./internal/Preserve.ts"
import { sourceLines } from "./internal/Text.ts"
import * as StdError from "./StdError.ts"

/**
 * Registry name for the edit flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "edit"

/**
 * Model-facing description of the edit flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description =
  "Edit a file by exact text (oldString, unique unless replaceAll) or by an earlier hit's line range (startLine/endLine, optional expect). A miss returns the file's real text; a hit returns the hunk."

/**
 * Input schema for the edit flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  path: Schema.String.annotate({ description: "Path of the file to edit" }),
  oldString: Schema.optional(Schema.String).annotate({
    description: "Exact text to replace, byte for byte, including surrounding context"
  }),
  startLine: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "First 1-based line to replace, from a prior read or grep hit; pair with endLine"
  }),
  endLine: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "Last 1-based line to replace, inclusive"
  }),
  expect: Schema.optional(Schema.String).annotate({
    description: "What those lines currently hold; the edit fails loudly if they hold anything else"
  }),
  newString: Schema.String.annotate({ description: "Replacement text" }),
  replaceAll: Schema.optional(Schema.Boolean).annotate({ description: "Replace every occurrence instead of one" })
})

/**
 * Decoded input accepted by the `edit` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * Output schema for the edit flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  path: Schema.String.annotate({ description: "Path that was edited" }),
  replacements: Schema.Number.annotate({ description: "Number of occurrences replaced" }),
  startLine: Schema.Number.annotate({ description: "First 1-based line of the returned hunk" }),
  endLine: Schema.Number.annotate({ description: "Last 1-based line of the returned hunk" }),
  hunk: Schema.String.annotate({
    description: "The edited region as it now stands, raw and with its exact indentation, plus two lines of context"
  }),
  errors: Schema.optional(Schema.Array(Diagnostics.Problem)).annotate({
    description: "Errors the language server reports in the file after the edit; absent when no server answered"
  })
})

/**
 * Decoded output returned by the `edit` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * Static conservative effect envelope for the edit flow.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({ tier: "compensable", mode: "hermetic", reads: ["/**"], writes: ["/**"] })

/**
 * Narrows the edit effect envelope to one input path.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (input: typeof Input.Type) =>
  envelope({ tier: "compensable", mode: "hermetic", reads: [input.path], writes: [input.path] })

/**
 * Capabilities required by the edit flow.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("fs:read", "/**"), capability("fs:write", "/**")]

/**
 * Declaration-only edit flow.
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
  verb: { pending: "editing", success: "edited", failure: "failed to edit" },
  subject: "path",
  result: "edit"
} as const

const invalid = (path: string, message: string): StdError.StdError =>
  new StdError.StdError({ code: "invalid_input", message, path })

/** The failure text for an anchor that is not in the file, with the file's own bytes. */
const miss = (path: string, content: string, needle: string, subject: string): StdError.StdError => {
  const region = Match.nearest(content, needle)
  return new StdError.StdError({
    code: "no_match",
    message: region === undefined
      ? `${subject} does not occur in ${path}, and no line of it occurs there either — this is the wrong file, or the region is not what you remember. Read it and anchor on what it actually holds.`
      : `${subject} does not occur in ${path}. Lines ${region.startLine}-${region.endLine} actually hold this, raw:\n${region.text}\n\nCopy the lines you meant from that text, or anchor by startLine/endLine instead.`,
    path
  })
}

/** The byte span of an inclusive 1-based line range, or the failure explaining why not. */
const lineSpan = (
  path: string,
  content: string,
  startLine: number,
  endLine: number
): { readonly start: number; readonly end: number } | StdError.StdError => {
  const lines = sourceLines(content)
  if (endLine < startLine) return invalid(path, `endLine ${endLine} is before startLine ${startLine}`)
  if (startLine > lines.length) {
    return new StdError.StdError({
      code: "offset_out_of_range",
      message: `${path} has ${lines.length} lines, so line ${startLine} is outside it`,
      path
    })
  }
  if (endLine > lines.length) {
    return new StdError.StdError({
      code: "offset_out_of_range",
      message: `Requested endLine ${endLine}, but ${path} has ${lines.length} lines`,
      path
    })
  }
  const last = endLine
  let start = 0
  for (let index = 0; index < startLine - 1; index++) start += lines[index]!.length + 1
  let end = start
  for (let index = startLine - 1; index < last; index++) end += lines[index]!.length + (index === last - 1 ? 0 : 1)
  return { start, end }
}

/**
 * Applies one exact-anchored edit through the permission-aware kernel filesystem.
 *
 * Every refusal names what the file actually holds. A non-unique match is a
 * refusal rather than a silent first-match edit, and it reports the lines every
 * occurrence sits on so the caller can widen the anchor without re-reading.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("Edit.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem
  const byLines = input.startLine !== undefined || input.endLine !== undefined
  if (input.oldString !== undefined && byLines) {
    return yield* Effect.fail(
      invalid(input.path, "Anchor by oldString or by startLine/endLine, not by both")
    )
  }
  if (input.oldString === undefined && !byLines) {
    return yield* Effect.fail(
      invalid(input.path, "Give either oldString or a startLine/endLine range; use the write flow to create a file")
    )
  }
  if (byLines && (input.startLine === undefined || input.endLine === undefined)) {
    return yield* Effect.fail(invalid(input.path, "A line anchor needs both startLine and endLine"))
  }
  if (input.oldString === "") {
    return yield* Effect.fail(
      invalid(input.path, "oldString must not be empty; use the write flow to create a file")
    )
  }
  if (input.oldString !== undefined && input.expect !== undefined) {
    return yield* Effect.fail(invalid(input.path, "expect cannot be used with oldString"))
  }
  if (byLines && input.replaceAll !== undefined) {
    return yield* Effect.fail(invalid(input.path, "replaceAll cannot be used with startLine/endLine"))
  }
  const edited = yield* Effect.scoped(Effect.gen(function*() {
    yield* FileMutation.acquire(fileSystem, [input.path])
    const bytes = yield* fileSystem.readFile(input.path).pipe(
      Effect.mapError(FsFailure.reading(input.path, `File not found: ${input.path}`))
    )
    if (bytes.includes(0)) {
      return yield* Effect.fail(
        new StdError.StdError({
          code: "binary_file",
          message: `Cannot read binary file: ${input.path}`,
          path: input.path
        })
      )
    }
    const content = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () =>
        new StdError.StdError({
          code: "binary_file",
          message: `File is not valid UTF-8: ${input.path}`,
          path: input.path
        })
    })

    const targets: Array<{ readonly start: number; readonly end: number }> = []
    if (input.oldString !== undefined) {
      const located = Match.locate(content, input.oldString)
      if (located.length === 0) return yield* Effect.fail(miss(input.path, content, input.oldString, "oldString"))
      if (located.length > 1 && input.replaceAll !== true) {
        const at = located.map((span) => span.startLine).join(", ")
        return yield* Effect.fail(
          invalid(
            input.path,
            `oldString occurs ${located.length} times in ${input.path}, on lines ${at}; add surrounding context to pick one, anchor by startLine/endLine, or set replaceAll`
          )
        )
      }
      targets.push(...(input.replaceAll === true ? located : [located[0]!]))
    } else {
      const span = lineSpan(input.path, content, input.startLine!, input.endLine!)
      if (span instanceof StdError.StdError) return yield* Effect.fail(span)
      if (input.expect !== undefined && content.slice(span.start, span.end) !== input.expect) {
        return yield* Effect.fail(
          new StdError.StdError({
            code: "no_match",
            message:
              `Lines ${input.startLine}-${input.endLine} of ${input.path} do not hold expect. They hold this, raw:\n${
                content.slice(span.start, span.end)
              }\n\nRe-read the file: it moved under the line numbers you anchored on.`,
            path: input.path
          })
        )
      }
      targets.push(span)
    }

    let replaced = ""
    let cursor = 0
    for (const span of targets) {
      replaced += content.slice(cursor, span.start) + input.newString
      cursor = span.end
    }
    replaced += content.slice(cursor)
    yield* Preserve.writeFileString(fileSystem, input.path, replaced).pipe(
      Effect.mapError((error) =>
        error.reason.method === "chmod"
          ? new StdError.StdError({
            code: "command_failed",
            message: `Could not preserve the mode of ${input.path} before replacement by chmod`,
            path: input.path
          })
          : FsFailure.denied(input.path, () =>
            new StdError.StdError({
              code: "command_failed",
              message: `Could not write ${input.path}`,
              path: input.path
            }))(
              error
            )
      )
    )
    // Synced under the file lock, so a later edit's text never reaches the
    // server before this one's.
    const server = yield* Diagnostics.sync(input.path, replaced)
    const first = targets[0]!
    const applied = Match.hunk(replaced, first.start, first.start + input.newString.length)
    const output: typeof Output.Type = {
      path: input.path,
      replacements: targets.length,
      startLine: applied.startLine,
      endLine: applied.endLine,
      hunk: applied.text
    }
    return { output, server }
  }))
  // Without a synced text the server can only describe the file as it was.
  const errors = edited.server === undefined ? undefined : yield* Diagnostics.errorsOf(edited.server, input.path)
  return errors === undefined ? edited.output : { ...edited.output, errors }
})
