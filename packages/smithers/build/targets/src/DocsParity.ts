/**
 * Package documentation parity checks.
 *
 * Checks that a README exists, has a title, and meets the configured minimum
 * prose length. The README is a declared input. This target does not check
 * JSDoc or compare documentation with source code.
 *
 * @since 0.1.0
 */

import { Action, type FlowRuntime } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as NodePath from "node:path"
import { failureMessage } from "./GeneratedFile.ts"
import * as Input from "./Input.ts"
import * as SafeFs from "./SafeFs.ts"
import * as Target from "./Target.ts"

/**
 * Default number of prose characters a README must carry beyond its badges,
 * links, headings, lists, and code.
 *
 * A substantive package description clears it; a title over a badge row does
 * not.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultMinimumProseCharacters = 120

/**
 * Maximum README size materialized by one parity check.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumReadmeBytes = 4 * 1024 * 1024

/**
 * A package's documentation is missing or too thin to describe the package.
 *
 * `path` is the workspace-relative README path the check read.
 *
 * @category errors
 * @since 0.1.0
 */
export class DocsParityError extends Schema.TaggedError<DocsParityError>()(
  "smithers-build/DocsParityError",
  {
    path: Schema.NonEmptyString,
    message: Schema.NonEmptyString
  }
) {}

/**
 * Payload for one README parity check.
 *
 * `path` is workspace-relative and resolves against the workspace root at
 * execution time.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ReadmePayload = Schema.Struct({
  path: Schema.NonEmptyString,
  minimumProseCharacters: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(maximumReadmeBytes)
  )
})

/**
 * Payload for one README parity check.
 *
 * @category models
 * @since 0.1.0
 */
export type ReadmePayload = typeof ReadmePayload.Type

/**
 * What reading one README yields: its level-one title and its prose length.
 *
 * `title` is undefined and `proseCharacters` is zero when the README carries
 * neither.
 *
 * @category models
 * @since 0.1.0
 */
export interface Summary {
  readonly title: string | undefined
  readonly proseCharacters: number
}

const fence = /^ {0,3}(`{3,}|~{3,})/

/** Drops fenced code blocks so a fence's blank lines never split a block. */
const withoutFences = (text: string): string => {
  const kept: Array<string> = []
  let open: { readonly character: string; readonly length: number } | undefined
  for (const line of text.split("\n")) {
    const marker = fence.exec(line)?.[1]
    if (open === undefined && marker !== undefined) {
      open = { character: marker[0]!, length: marker.length }
      continue
    }
    if (open !== undefined) {
      const current = open
      const candidate = line.trim()
      if (
        candidate.length >= current.length &&
        [...candidate].every((character) => character === current.character)
      ) open = undefined
      continue
    }
    kept.push(line)
  }
  return kept.join("\n")
}

/**
 * Reduces one markdown block to the words a reader would read.
 *
 * Images lose everything, links keep their text and lose their target, and
 * inline code, emphasis, and autolinks lose their markers. A block of badges
 * is a row of linked images, so it reduces to nothing.
 */
const proseOf = (block: string): string =>
  block
    .replaceAll(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replaceAll(/!\[[^\]]*\]\[[^\]]*\]/g, "")
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replaceAll(/<[^>\s]+>/g, "")
    .replaceAll(/https?:\/\/\S+/g, "")
    .replaceAll(/`+/g, "")
    .replaceAll(/[*_~]/g, "")
    .trim()

const heading = /^ {0,3}#{1,6}\s/
const listItem = /^ {0,3}(?:[-*+]\s|\d+[.)]\s)/
const title = /^ {0,3}#\s+(.*\S)\s*$/
const linkDefinition = /^ {0,3}\[[^\]]+\]:\s*\S+/
const tableDivider = /^ {0,3}:?-+:?(?:\s*\|\s*:?-+:?)+\s*\|?\s*$/

/** Whether a block is prose rather than a heading, list, quote, table, or HTML. */
const isProseBlock = (block: string): boolean => {
  const lines = block.split("\n")
  const first = lines[0] ?? ""
  return !/^(?: {4}|\t)/.test(first) &&
    !heading.test(first) &&
    !listItem.test(first) &&
    !linkDefinition.test(first) &&
    !/^ {0,3}>/.test(first) &&
    !/^ {0,3}\|/.test(first) &&
    !tableDivider.test(lines[1] ?? "") &&
    !/^ {0,3}</.test(first) &&
    !/^ {0,3}(?:-{3,}|={3,}|\*{3,}|_{3,})\s*$/.test(first)
}

/**
 * Reads one README's title and prose length without touching the filesystem.
 *
 * The title is the first level-one ATX heading. Prose is every blank-line
 * separated block that is not a heading, list, blockquote, table, thematic
 * break, HTML, or fenced code, measured after badges and link targets are
 * stripped. Exported so the parity policy is testable as a pure function.
 *
 * @category parsing
 * @since 0.1.0
 */
export const summarize = (contents: string): Summary => {
  const body = withoutFences(contents)
  let found: string | undefined
  let proseCharacters = 0
  for (const block of body.split(/\n[ \t]*\n/)) {
    const trailingTrimmed = block.trimEnd()
    if (trailingTrimmed.trimStart() === "") continue
    const match = title.exec(trailingTrimmed.trimStart().split("\n")[0] ?? "")
    if (found === undefined && match?.[1] !== undefined) found = match[1]
    if (isProseBlock(trailingTrimmed)) proseCharacters += proseOf(trailingTrimmed).length
  }
  return { title: found, proseCharacters }
}

/**
 * Checks one package README for presence, a title, and real prose.
 *
 * @category actions
 * @since 0.1.0
 */
export const CheckDocs = Action.make("smithers-build/check-docs", {
  payload: ReadmePayload,
  error: DocsParityError,
  tier: "sealed"
})

/** Applies the parity policy to one README's contents. */
const judge = (payload: ReadmePayload, contents: string | undefined): Effect.Effect<void, DocsParityError> => {
  if (contents === undefined) {
    return Effect.fail(
      new DocsParityError({ path: payload.path, message: "the package has no README.md" })
    )
  }
  const summary = summarize(contents)
  if (summary.title === undefined) {
    return Effect.fail(
      new DocsParityError({ path: payload.path, message: "the README has no level-one title" })
    )
  }
  if (summary.proseCharacters < payload.minimumProseCharacters) {
    return Effect.fail(
      new DocsParityError({
        path: payload.path,
        message: `the README carries ${summary.proseCharacters} characters of prose beyond badges and links, ` +
          `below the ${payload.minimumProseCharacters} the package declares`
      })
    )
  }
  return Effect.void
}

/**
 * Implements {@link CheckDocs} with a read and {@link summarize}. The payload
 * path resolves against `workspaceRoot`.
 *
 * @category layers
 * @since 0.1.0
 */
export const checkDocs = (options: {
  readonly workspaceRoot: string
}, payload: ReadmePayload): Effect.Effect<void, DocsParityError> =>
  Effect.flatMap(
    Effect.tryPromise({
      try: async (signal) => {
        const root = await SafeFs.canonicalRoot(options.workspaceRoot)
        const relative = Input.resolvePath("", payload.path)
        return SafeFs.readText(NodePath.join(root, relative), {
          root,
          signal,
          symlinks: "follow",
          limit: maximumReadmeBytes,
          what: "package README"
        })
      },
      catch: (cause) => new DocsParityError({ path: payload.path, message: failureMessage(cause) })
    }),
    (contents) => judge(payload, contents)
  )

/**
 * Implements {@link CheckDocs} with confined, descriptor-stable, bounded
 * reads. The payload path resolves against `workspaceRoot`.
 *
 * @category layers
 * @since 0.1.0
 */
export const CheckDocsLive = (options: {
  readonly workspaceRoot: string
}): Layer.Layer<Action.Requirement<"smithers-build/check-docs">, never, FlowRuntime.FlowRuntime> =>
  CheckDocs.toLayer((payload) => checkDocs(options, payload))

/**
 * Attributes for {@link DocsParity}.
 *
 * `cwd` is the workspace-relative package directory and defaults to the
 * workspace root. `readme` resolves against it and is declared key material,
 * so editing the prose re-keys the target. `minimumProseCharacters` is the
 * prose floor the package holds itself to.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  readme: Input.File,
  deps: Schema.Array(Target.Target),
  minimumProseCharacters: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(maximumReadmeBytes)
  ).pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultMinimumProseCharacters))
  ),
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link DocsParity}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Checks that a package documents itself in prose beside its code.
 *
 * The body records one {@link CheckDocs} run over the declared README,
 * resolved against `cwd` the same way the planner resolves the declared
 * input. The check fails when the README is missing, carries no level-one
 * title, or reduces to fewer than `minimumProseCharacters` once badges, link
 * targets, headings, lists, tables, and fenced code are stripped, which is
 * what separates a real package contract from a scaffolded stub.
 *
 * The target participates in the `docs` verb alone, and the aggregate `ci`
 * command plans that verb alongside build, test, and lint. `smithers-build docs
 * //...` remains the focused way to run just this gate. Key material contains
 * the README digest, dependency keys, and the prose floor, so prose drift is
 * a cache miss like any other input change.
 * Executing the plan requires {@link CheckDocsLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const DocsParity = Target.make("DocsParity", {
  attrs: Attrs,
  kinds: ["docs"],
  error: DocsParityError,
  cache: true,
  implementation: (attrs) =>
    CheckDocs.call({
      path: Input.resolvePath(attrs.cwd, attrs.readme.path),
      minimumProseCharacters: attrs.minimumProseCharacters
    })
})
