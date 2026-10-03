/**
 * Read flow declaration and portable handler.
 *
 * `content` is raw file text. It used to be rendered as `NNN\t<line>`, and that
 * rendering was the single most expensive tool defect measured on the 45-instance
 * SWE-bench trace program: an anchor copied out of a read carried the gutter, so
 * every `edit` built from a read missed, and every cell that wanted a literal
 * line had to strip the prefix in JavaScript first. Two instances (django-13346,
 * django-14351) spent whole frames writing string surgery against text the file
 * does not contain. Line numbers are facts about the page, so they are page
 * fields — `startLine` and `endLine` — and never bytes inside the text.
 *
 * Every line in `content` is a whole line: a page cut short by the byte budget
 * drops its trailing partial line rather than handing back a fragment that looks
 * like an anchor and is not one. CRLF lines retain their trailing CR; only
 * the page's final LF is omitted.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { capability, envelope } from "./internal/Declaration.ts"
import * as FsFailure from "./internal/FsFailure.ts"
import { DEFAULT_READ_LIMIT, MAX_LINE_CHARS, MAX_OUTPUT_BYTES, notice, slice, truncateBytes } from "./internal/Text.ts"
import * as StdError from "./StdError.ts"

/**
 * Registry name for the read flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "read"

/**
 * Model-facing description of the read flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description =
  "Read a text file by 1-based offset and limit. content is RAW file text with no line-number prefixes, so any line of it is an edit anchor as it stands; the numbers are startLine/endLine."

/**
 * Input schema for the read flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  path: Schema.String.annotate({ description: "Path of the text file to read" }),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "1-based line offset"
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "Maximum number of lines to return"
  })
})

/**
 * Decoded input accepted by the `read` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * Output schema for the read flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  content: Schema.String.annotate({
    description: "Raw page text, preserving CR bytes and omitting the final LF; never line-number prefixed"
  }),
  startLine: Schema.Number.annotate({ description: "First returned 1-based line number" }),
  endLine: Schema.Number.annotate({
    description: "Last returned 1-based line number, or startLine - 1 when no lines are returned"
  }),
  totalLines: Schema.Number.annotate({ description: "Total number of source lines" }),
  truncated: Schema.Boolean.annotate({ description: "Whether displayed output was truncated" }),
  notice: Schema.optional(Schema.String.annotate({ description: "Truncation disclosure" }))
})

/**
 * Decoded output returned by the `read` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * Static conservative effect envelope for the read flow.
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
 * Narrows the read effect envelope to one input path.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (input: typeof Input.Type) =>
  envelope({
    tier: "sealed",
    mode: "hermetic",
    reads: [input.path],
    writes: []
  })

/**
 * Capabilities required by the read flow.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("fs:read", "/**")]

/**
 * Declaration-only read flow.
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
  verb: { pending: "reading", success: "read", failure: "failed to read" },
  subject: "path",
  result: "read"
} as const

const clipLine = (line: string): string => {
  let scalars = 0
  let end = 0
  for (const scalar of line) {
    if (scalars === MAX_LINE_CHARS) return line.slice(0, end)
    scalars++
    end += scalar.length
  }
  return line
}

/**
 * The largest file `read` loads.
 *
 * `read` decodes the whole file to count its lines, so the file is held in
 * memory twice over: its bytes and a UTF-16 string. Past this bound a page
 * read would cost the host gigabytes for a window of a few thousand lines,
 * and past 2 GiB Node cannot load the file at all.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_READ_FILE_BYTES = 64 * 1024 * 1024

const fileError = (path: string) => FsFailure.reading(path, `File not found: ${path}`)

const sharedPrefix = (left: string, right: string): number => {
  let index = 0
  while (index < left.length && index < right.length && left[index] === right[index]) index++
  return index
}

/**
 * Where a guessed relative path stops existing, and what is there instead.
 *
 * A worker that guesses `packages/smithers/flow/src/Flow.ts` learns nothing
 * from "not found" and guesses again. Naming the nearest directory that exists
 * and its entries, closest name first, turns the next call into a choice.
 * Absolute paths and paths that climb out with `..` get no listing: the call
 * declared one file, and the working tree is the only place a listing is
 * already the caller's to read.
 */
const nearest = (
  fileSystem: FileSystem.FileSystem,
  path: string
): Effect.Effect<string> =>
  Effect.gen(function*() {
    const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".")
    if (path.startsWith("/") || segments.includes("..")) return ""
    for (let depth = segments.length - 1; depth >= 0; depth--) {
      const directory = segments.slice(0, depth).join("/")
      const entries = yield* fileSystem.readDirectory(directory === "" ? "." : directory).pipe(Effect.option)
      if (Option.isNone(entries)) continue
      const missing = segments[depth]!.toLowerCase()
      const ranked = entries.value
        .filter((entry) => !entry.startsWith("."))
        .map((entry) => ({ entry, score: sharedPrefix(entry.toLowerCase(), missing) }))
        .sort((left, right) => right.score - left.score)
        .map(({ entry }) => entry)
      if (ranked.length === 0) return ""
      const shown = ranked.slice(0, 12).join(", ")
      const more = ranked.length > 12 ? ` and ${ranked.length - 12} more` : ""
      return `. ${directory === "" ? "The working directory" : directory} holds: ${shown}${more}.`
    }
    return ""
  })

const missingFile = (fileSystem: FileSystem.FileSystem, path: string) =>
  Effect.flatMap(nearest(fileSystem, path), (hint) =>
    Effect.fail(
      new StdError.StdError({
        code: "not_found",
        message: `File not found: ${path}${hint}`,
        path
      })
    ))

/**
 * Reads, validates, and renders one page of a UTF-8 text file.
 *
 * The kernel filesystem exposes bytes rather than a guaranteed UTF-8 string,
 * so decoding is deliberately fatal to keep binary input in the typed channel.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("Read.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem
  const info = yield* fileSystem.stat(input.path).pipe(
    Effect.catchTag(
      "PlatformError",
      (error) =>
        error.reason._tag === "NotFound"
          ? missingFile(fileSystem, input.path)
          : Effect.fail(fileError(input.path)(error))
    )
  )
  if (info.type === "Directory") {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "is_directory",
        message: `Cannot read a directory: ${input.path}`,
        path: input.path
      })
    )
  }
  if (info.type !== "File") {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "not_found",
        message: `File not found: ${input.path}`,
        path: input.path
      })
    )
  }
  const size = Number(info.size)
  if (size > MAX_READ_FILE_BYTES) {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "response_too_large",
        message:
          `${input.path} is ${size} bytes, over the ${MAX_READ_FILE_BYTES}-byte read limit; search it with grep or print a line range with bash`,
        path: input.path
      })
    )
  }
  const bytes = yield* fileSystem.readFile(input.path).pipe(Effect.mapError(fileError(input.path)))
  if (bytes.includes(0)) {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "binary_file",
        message: `Cannot read binary file: ${input.path}`,
        path: input.path
      })
    )
  }
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () =>
      new StdError.StdError({
        code: "binary_file",
        message: `File is not valid UTF-8: ${input.path}`,
        path: input.path
      })
  })
  const offset = input.offset ?? 1
  const page = slice(text, { offset, limit: input.limit ?? DEFAULT_READ_LIMIT })
  // An empty file has no lines, and reading one is not an out-of-range read:
  // the caller asked for the first page and there is nothing on it. Only an
  // offset past the first line of a file that has none is out of range.
  if (offset > Math.max(page.totalLines, 1)) {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "offset_out_of_range",
        message: `Line offset ${offset} is outside ${input.path}`,
        path: input.path
      })
    )
  }
  const lines = page.lines.map(clipLine)
  const longLinesTruncated = lines.some((line, index) => line !== page.lines[index])
  const rendered = truncateBytes(lines.join("\n"), MAX_OUTPUT_BYTES, { keep: "head" })
  // A byte budget cuts mid-line. A partial line reads like an anchor and is not
  // one, so the page ends at the last whole line it could afford.
  const whole = rendered.truncated
    ? rendered.text.slice(0, Math.max(0, rendered.text.lastIndexOf("\n")))
    : rendered.text
  const shown = rendered.truncated ? (whole === "" ? 0 : whole.split("\n").length) : lines.length
  const endLine = page.startLine + shown - 1
  const truncated = longLinesTruncated || rendered.truncated || page.endLine < page.totalLines
  const clipped = longLinesTruncated
    ? ` Lines longer than ${MAX_LINE_CHARS} Unicode scalar values are clipped, so such a line is not an edit anchor.`
    : ""
  return {
    content: whole,
    startLine: page.startLine,
    endLine,
    totalLines: page.totalLines,
    truncated,
    ...(truncated ? { notice: `${notice("lines", shown, page.totalLines)}${clipped}` } : {})
  }
})
