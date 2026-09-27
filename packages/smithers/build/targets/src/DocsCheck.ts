/**
 * `S.Docs.Check`: the freshness gate for a file an agent wrote.
 *
 * `Agent.Diff` and `Docs.Page` are `cache: false` because an agent is not a
 * pure function of its inputs, so the tree itself is the cache: a generated
 * page is committed beside a stamp recording the content key of every input
 * the writer read and the digest of the page it produced. This rule
 * recomputes that key and fails, deterministically and without spawning an
 * agent, when the committed page is older than what produced it.
 *
 * The key is not a hash this module invents. The planner already digests
 * every declared input at plan time (`Workspace.ExpandedInput.files`, one
 * `{path, digest}` row per file); {@link closureDigest} is that same encoding
 * applied to the union of the rows the `inputs` attr resolves to. The verdict
 * and the node's own cache key are therefore computed from the same bytes by
 * construction. It deliberately is not the node's key preview: that folds in
 * the executor implementation fingerprint, the attrs schema identity, and the
 * execution mode, so a committed stamp equal to it would rot on every build
 * tool release rather than only when an input moved.
 *
 * One sidecar per page, not one manifest per package: a shared manifest makes
 * every regeneration a merge conflict and every stale page a site-wide red,
 * while a sidecar fails one page and diffs beside it.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

/**
 * The stamp layout this module writes and reads. A stamp of another format
 * is not a stamp: the check reports it `missing` so the page is re-stamped
 * rather than judged against fields that no longer mean what they did.
 *
 * @category constants
 * @since 0.1.0
 */
export const stampFormat = 1

/**
 * Schema for one file recorded in a stamp: its workspace-relative path and
 * its content digest, `null` when the file did not exist when the stamp was
 * written. A declared-but-absent input is still part of the closure, so its
 * later appearance is a change.
 *
 * @category schemas
 * @since 0.1.0
 */
export const StampFile = Schema.Struct({
  path: Schema.NonEmptyString,
  digest: Schema.NullOr(Schema.String)
})

/**
 * One file recorded in a stamp.
 *
 * @category models
 * @since 0.1.0
 */
export type StampFile = typeof StampFile.Type

/**
 * Schema for the committed sidecar that records what produced one page.
 *
 * `closure` is {@link closureDigest} over `inputs`, kept beside the list it
 * summarizes so a reader compares one line and a diff shows which path moved.
 * `producer` is provenance only, a model id or a prompt path; it is written
 * for the record and never compared.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Stamp = Schema.Struct({
  format: Schema.Literal(stampFormat),
  producer: Schema.NullOr(Schema.String),
  output: StampFile,
  closure: Schema.NonEmptyString,
  inputs: Schema.Array(StampFile)
})

/**
 * The committed sidecar that records what produced one page.
 *
 * @category models
 * @since 0.1.0
 */
export type Stamp = typeof Stamp.Type

/**
 * Why one freshness check failed.
 *
 * `stale`: an input moved after the stamp was written, so the page has to be
 * regenerated. `modified`: the page was edited by hand after the stamp, so
 * the edit belongs in the brief or the prompt and the page has to be
 * regenerated. `missing`: there is no stamp to judge against, or no page.
 * Every reason is answered by regenerating and re-stamping the page.
 *
 * @category schemas
 * @since 0.1.0
 */
export const StaleReason = Schema.Literals(["stale", "modified", "missing"])

/**
 * Why one freshness check failed.
 *
 * @category models
 * @since 0.1.0
 */
export type StaleReason = typeof StaleReason.Type

/**
 * A committed page is older than its inputs, was edited after it was
 * stamped, or has no stamp.
 *
 * `page` is the generated file the check judged, `stamp` is its sidecar, and
 * `path` is the first path that explains the verdict: the input that moved
 * for `stale`, the page for `modified`, the stamp or the page for `missing`.
 *
 * @category errors
 * @since 0.1.0
 */
export class StaleError extends Schema.TaggedError<StaleError>()(
  "smithers-build/StaleError",
  {
    page: Schema.NonEmptyString,
    stamp: Schema.NonEmptyString,
    reason: StaleReason,
    path: Schema.NonEmptyString,
    message: Schema.NonEmptyString
  }
) {}

/** Sorts by UTF-16 code unit, the order {@link Input.digestFiles} uses. */
const byPath = (left: { readonly path: string }, right: { readonly path: string }): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0

/**
 * The resolved rows in the planner's canonical form: one row per path, sorted
 * by path, `digest` left undefined for a file that does not exist. A file two
 * globs both match contributes one row; two rows disagreeing about one path's
 * content are an ambiguous closure and refused.
 */
const canonicalRows = (
  files: ReadonlyArray<Input.FileDigest | StampFile>
): ReadonlyArray<Input.FileDigest> => {
  const rows = new Map<string, Input.FileDigest>()
  for (const file of files) {
    const digest = file.digest ?? undefined
    const existing = rows.get(file.path)
    if (existing !== undefined && existing.digest !== digest) {
      throw new Error(
        `the input closure names ${JSON.stringify(file.path)} twice, with two different digests`
      )
    }
    rows.set(file.path, digest === undefined ? { path: file.path, digest: undefined } : { path: file.path, digest })
  }
  return [...rows.values()].sort(byPath)
}

/**
 * The content key of one page's input closure.
 *
 * This is the planner's own per-input encoding — `Input.digestText` over the
 * JSON of the sorted `{path, digest}` rows, a row without a digest for a
 * declared file that is absent — applied to the union of every input's rows.
 * The order the rows arrive in does not matter, and a path listed twice
 * counts once, so the key depends on the files' paths and contents and on
 * nothing about how they were declared or listed.
 *
 * @category digests
 * @since 0.1.0
 */
export const closureDigest = (files: ReadonlyArray<Input.FileDigest | StampFile>): string =>
  Input.digestText(JSON.stringify(canonicalRows(files)))

const stampFile = (file: Input.FileDigest | StampFile): StampFile => ({
  path: file.path,
  digest: file.digest ?? null
})

/**
 * Builds the stamp for a page as it stands now, with its inputs sorted.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeStamp = (options: {
  readonly producer: string | null | undefined
  readonly output: Input.FileDigest
  readonly inputs: ReadonlyArray<Input.FileDigest>
}): Stamp => {
  const rows = canonicalRows(options.inputs)
  return {
    format: stampFormat,
    producer: options.producer ?? null,
    output: stampFile(options.output),
    closure: closureDigest(rows),
    inputs: rows.map(stampFile)
  }
}

/**
 * Renders a stamp as the committed JSON text: two-space indent, fixed key
 * order, trailing newline, so two stamps over one closure are byte-equal.
 *
 * @category rendering
 * @since 0.1.0
 */
export const renderStamp = (stamp: Stamp): string =>
  `${
    JSON.stringify(
      {
        format: stamp.format,
        producer: stamp.producer,
        output: { path: stamp.output.path, digest: stamp.output.digest },
        closure: stamp.closure,
        inputs: stamp.inputs.map((file) => ({ path: file.path, digest: file.digest }))
      },
      null,
      2
    )
  }\n`

const decodeStamp = Schema.decodeUnknownOption(Stamp)

/**
 * Reads a stamp back out of its committed text, or nothing when the text is
 * not a stamp of the current format.
 *
 * @category parsing
 * @since 0.1.0
 */
export const parseStamp = (text: string): Stamp | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const decoded = decodeStamp(parsed)
  return decoded._tag === "Some" ? decoded.value : undefined
}

/**
 * How one input differs between a stamp and the tree.
 *
 * @category models
 * @since 0.1.0
 */
export interface Difference {
  readonly path: string
  readonly change: "added" | "removed" | "changed"
}

/**
 * The first path, in sorted order, at which two closures disagree.
 *
 * `added` and `removed` are relative to `before`: a path only `after` has
 * was added to the closure, a path only `before` has was removed from it.
 *
 * @category digests
 * @since 0.1.0
 */
export const firstDifference = (
  before: ReadonlyArray<Input.FileDigest | StampFile>,
  after: ReadonlyArray<Input.FileDigest | StampFile>
): Difference | undefined => {
  const previous = canonicalRows(before)
  const current = canonicalRows(after)
  let left = 0
  let right = 0
  while (left < previous.length || right < current.length) {
    const was = previous[left]
    const is = current[right]
    if (was === undefined) return { path: is!.path, change: "added" }
    if (is === undefined) return { path: was.path, change: "removed" }
    if (was.path < is.path) return { path: was.path, change: "removed" }
    if (was.path > is.path) return { path: is.path, change: "added" }
    if (was.digest !== is.digest) return { path: was.path, change: "changed" }
    left += 1
    right += 1
  }
  return undefined
}

/**
 * Judges one page against its stamp, or passes it.
 *
 * `stamp` is the parsed sidecar, undefined when there is none. `output` is
 * the page as it stands in the tree and `inputs` is its closure as the
 * planner resolved it now. The verdict is the closure key, the same bytes the
 * node was keyed on; {@link firstDifference} only names the path that
 * explains it. A closure mismatch wins over a modified page: regeneration
 * answers both, and the input that moved is the more useful thing to name.
 *
 * @category validation
 * @since 0.1.0
 */
export const judge = (options: {
  readonly page: string
  readonly stampPath: string
  readonly stamp: Stamp | undefined
  readonly output: Input.FileDigest
  readonly inputs: ReadonlyArray<Input.FileDigest>
}): StaleError | undefined => {
  const { page, stampPath } = options
  const fail = (reason: StaleReason, path: string, message: string): StaleError =>
    new StaleError({ page, stamp: stampPath, reason, path, message })
  if (options.stamp === undefined) {
    return fail("missing", stampPath, `${page} has no stamp at ${stampPath}; regenerate the page and stamp it`)
  }
  if (options.output.digest === undefined) {
    return fail("missing", page, `${page} is missing but ${stampPath} stamps it; regenerate the page`)
  }
  if (closureDigest(options.inputs) !== options.stamp.closure) {
    // A hand-corrupted stamp can name one path twice, which no closure this
    // module writes ever does. That is answered by regenerating like any
    // other mismatch, so it reports the verdict rather than throwing out of
    // the executor's lane.
    let difference: Difference | undefined
    try {
      difference = firstDifference(options.stamp.inputs, options.inputs)
    } catch {
      difference = undefined
    }
    if (difference === undefined) {
      return fail(
        "stale",
        page,
        `${page} was stamped against an input closure whose key has moved; regenerate the page`
      )
    }
    const verb = difference.change === "changed" ? "changed" : `was ${difference.change}`
    return fail(
      "stale",
      difference.path,
      `${page} is stale: input ${difference.path} ${verb} since ${stampPath} was written; regenerate the page`
    )
  }
  if (options.stamp.output.digest !== options.output.digest) {
    return fail(
      "modified",
      page,
      `${page} was edited after ${stampPath} was written; put the change in the brief or the prompt and regenerate`
    )
  }
  return undefined
}

/**
 * Schema for one member of the `inputs` attr: a declared file, a declared
 * glob, or a target whose files the page was written from (a Filegroup).
 * A git diff is not a producer of a page and is refused by shape.
 *
 * @category schemas
 * @since 0.1.0
 */
export const InputMember = Schema.Union([Target.Target, Input.File, Input.Glob])

/**
 * One member of the `inputs` attr.
 *
 * @category models
 * @since 0.1.0
 */
export type InputMember = typeof InputMember.Type

/**
 * Schema for the `inputs` attr. `S.glob([...])` returns an array, so a
 * member may itself be an array of members.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Inputs = Schema.Array(Schema.Union([InputMember, Schema.Array(InputMember)]))

/**
 * Attributes for {@link Check}.
 *
 * `stamp` is the committed sidecar, `output` is the generated page, and
 * `inputs` is everything the writer read to produce it. All three resolve
 * the way every declared input does: `//` from the workspace root, otherwise
 * from the declaring package. `producer` is recorded in the stamp as
 * provenance, a model id or a prompt path, and never compared.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  stamp: Input.File,
  output: Input.File,
  inputs: Inputs,
  producer: Schema.optional(Schema.NonEmptyString)
})

/**
 * Attributes for {@link Check}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

const definition = Target.make("Docs.Check", {
  // `lint` and `docs` are the checking verbs, so the aggregate `ci` (which
  // plans both) fails on a stale page and never rewrites a committed file.
  // The refresh is `docs --write`, matching `Generate`, `Owners.*`, and
  // `Github.CiGen`: an unattended verb checks, an explicit flag applies.
  kinds: ["lint", "docs"],
  attrs: Attrs,
  error: Schema.Union([StaleError, Target.NotImplemented]),
  // Everything the verdict depends on is key material: the stamp, the page,
  // and every input are declared inputs of this node, and a Filegroup
  // member's key covers its files.
  cache: true,
  implementation: () => Target.notImplemented("Docs.Check")
})

/** The declared file paths a member array names, arrays flattened. */
const declaredPaths = (members: ReadonlyArray<unknown>): ReadonlyArray<string> => {
  const paths: Array<string> = []
  for (const member of members) {
    for (const entry of Array.isArray(member) ? member : [member]) {
      if (Input.isDeclared(entry) && entry._tag === "File") paths.push(entry.path)
    }
  }
  return paths
}

/**
 * Checks that a committed agent-written page is no older than its inputs.
 *
 * Under `lint` and plain `docs`, and therefore under `ci`, the executor
 * digests the page and every file the `inputs` reach — through Filegroups,
 * with the rows the plan keyed the node on — reads the stamp, and fails with
 * {@link StaleError} when an input moved (`stale`), the page was edited after
 * it was stamped (`modified`), or there is no stamp or no page (`missing`).
 * The failure names the page and the first path that explains it. Under
 * `docs --write`, or the bare label with `--write`, the executor writes the
 * stamp for the page as it stands, which is the step a writer runs after
 * regenerating.
 *
 * The check is a pure function of the stamp, the page, and the closure, all
 * of which are declared key material, so a green verdict is cached and an
 * unchanged page costs nothing.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * export const fresh = S.Docs.Check({
 *   stamp: S.file("//apps/site/pages/intro/stamp.json"),
 *   output: S.file("//apps/site/src/content/docs/docs/intro.mdx"),
 *   inputs: [S.file("//apps/site/pages/intro/brief.md"), S.glob("//packages/flow/src/*.ts")],
 *   producer: "claude-opus-5 prompts/tutorial.md"
 * })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export const Check = Target.guard(definition, (attrs) => {
  const stamp = attrs.stamp?.path
  const output = attrs.output?.path
  if (stamp !== undefined && stamp === output) {
    throw new Error(
      `Docs.Check names ${
        JSON.stringify(stamp)
      } as both the stamp and the page; one file cannot stamp itself, they must not be the same file`
    )
  }
  for (const path of declaredPaths(Array.isArray(attrs.inputs) ? attrs.inputs : [])) {
    if (path === stamp || path === output) {
      throw new Error(
        `Docs.Check lists ${JSON.stringify(path)} as its own input; the stamp and the page are what the inputs produce`
      )
    }
  }
})
