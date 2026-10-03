/**
 * The `grep` flow and its Smithers Ripgrep Subset v1 contract.
 *
 * Supported ripgrep semantics: Rust-style regular expressions restricted to
 * Smithers Ripgrep ASCII v1; `-F` (`fixedStrings`); `-i` (`ignoreCase`) and `-S`
 * (`smartCase`); ordered `-g` include/exclude globs; `-A`, `-B`, and `-C`
 * context; per-file `--max-count`; `--files-with-matches`; `--hidden`; and
 * deterministic path/line ordering. Root and nested .gitignore files apply by
 * default, including outside git repositories. `noIgnore: true` opts out.
 * Parent/global ignore files, .git/info/exclude, .ignore and .rgignore are not
 * read. File-type registries are outside v1, and there is no `types` field to
 * pass. Patterns are capped at 4096 ASCII bytes and counted repetitions at 1000. Invalid UTF-8 is replacement-decoded; NUL-bearing
 * files are skipped and counted, while an explicitly named binary file is a
 * typed failure.
 *
 * Results are match-centric, which is `rg --json`'s own grouping: `limit`
 * counts matches, each match carries the context lines that belong to it, and
 * every context line belongs to exactly one match. A budget that counted rows
 * could spend itself on context and drop the match — astropy-7166 paid three
 * frames for exactly that — so a hit is never droppable to make room for its
 * own surroundings. Truncation is disclosed through `notice`.
 *
 * Each returned hit also carries the definition enclosing it when the file's
 * shape says so plainly, so a read window is computed rather than guessed, and
 * a metacharacter pattern that finds nothing is retried as a literal with
 * `retriedAsLiteral` set. Both are properties of the contract rather than of a
 * peer: they are computed in `internal/Grouping.ts` for both implementations.
 *
 * `globs` accepts exactly the shapes `glob` accepts and reads them the same
 * way: every pattern is matched against each candidate's path *relative to
 * `root`*, a pattern without `/` matches the basename at any depth, and a
 * leading `/` or `./` anchors at the root rather than naming a filesystem
 * absolute path. A `root` that names one file is searched whatever the globs
 * say. Caller globs filter after ignores; they never override them. See `Glob` for the full statement of the rules. A search that matched
 * nothing because a positive glob was unsatisfiable says so through `notice`
 * instead of returning a silent empty result.
 *
 * `filesSearched` counts every file the walk and globs admitted, including the binaries
 * `skippedBinary` reports and any file the process could not open. A walk
 * skips what it cannot read rather than failing the call.
 *
 * Native and in-process implementations are peers behind `Search.Search`.
 * This module declares and validates the call; it performs no host access.
 *
 * @since 1.0.0
 */

import { Effect, Schema } from "effect"
import { capability, envelope, rootSubtree } from "./internal/Declaration.ts"
import { invalidInput } from "./internal/SearchContract.ts"
import { MAX_GREP_MATCHES } from "./internal/Text.ts"
import * as Search from "./Search.ts"
import * as Contract from "./SearchContract.ts"
import * as StdError from "./StdError.ts"

/**
 * The registry name for grep.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "grep"
/**
 * The model-facing grep description.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description =
  "Search file contents through the Smithers Ripgrep Subset v1 contract. limit counts matches, each carrying its own context and enclosing definition; fixedStrings searches a literal, and one is retried."

/**
 * Input accepted by {@link flow} and {@link run}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  pattern: Schema.String.annotate({ description: "Smithers Ripgrep ASCII v1 expression." }),
  root: Schema.optional(Schema.String).annotate({
    description: "Search root the globs are relative to; defaults to . (the host workspace)."
  }),
  fixedStrings: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep -F." }),
  ignoreCase: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep -i." }),
  smartCase: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep -S." }),
  globs: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Ordered ripgrep -g globs, matched against paths relative to root, never absolute paths: a glob without / matches any basename, a leading / anchors at root, and ** crosses directories. Prefix exclusions with !."
  }),
  beforeContext: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Ripgrep -B."
  }),
  afterContext: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Ripgrep -A."
  }),
  context: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({ description: "Ripgrep -C." }),
  maxCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "Ripgrep --max-count, per file; at least 1."
  }),
  filesWithMatches: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep --files-with-matches." }),
  hidden: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep --hidden." }),
  symbols: Schema.optional(Schema.Boolean).annotate({
    description: "Report the definition enclosing each returned hit; true by default."
  }),
  noIgnore: Schema.optional(Schema.Boolean).annotate({
    description:
      "Honor root-scoped .gitignore files by default. Set true to include ignored paths; hidden and fixed directory skips still apply."
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: `Global result limit, capped at ${MAX_GREP_MATCHES}.`
  })
})

/**
 * Decoded input accepted by the `grep` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * One matching or context line.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ContextLine = Schema.Struct({
  line: Schema.Int.annotate({ description: "1-based line number" }),
  text: Schema.String
})

/**
 * The definition a hit sits inside, when the file's shape says so plainly.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Symbol = Schema.Struct({
  kind: Schema.String.annotate({ description: "The declaration keyword, such as def or class" }),
  name: Schema.String,
  startLine: Schema.Int.annotate({ description: "1-based first line of the definition" }),
  endLine: Schema.Int.annotate({
    description: "1-based last line of the definition; read this range, do not guess one"
  })
})

/**
 * One hit and the context that belongs to it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Match = Schema.Struct({
  file: Schema.String,
  line: Schema.Int,
  text: Schema.String,
  before: Schema.Array(ContextLine),
  after: Schema.Array(ContextLine),
  symbol: Schema.optional(Symbol)
})

/**
 * Output produced by {@link run}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  matches: Schema.Array(Match),
  files: Schema.Array(Schema.String),
  filesSearched: Schema.Int,
  skippedBinary: Schema.Int,
  truncated: Schema.Boolean,
  retriedAsLiteral: Schema.optional(Schema.Boolean).annotate({
    description: "Present when the pattern found nothing as a regex and these results come from re-running it literally"
  }),
  notice: Schema.optional(Schema.String)
})

/**
 * Decoded output returned by the `grep` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * Conservative sealed declaration for all workspace files.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({ tier: "sealed", mode: "hermetic", reads: ["/**"], writes: [] })
/**
 * Narrows the read declaration to the requested root subtree.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (input: { readonly root?: string | undefined }) =>
  envelope({ tier: "sealed", mode: "hermetic", reads: [rootSubtree(input.root ?? ".")], writes: [] })
/**
 * Capability strings requested by grep.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("fs:read", "/**")]
/**
 * Declaration-only grep flow.
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
  verb: { pending: "searching", success: "searched", failure: "failed to search" },
  subject: "pattern",
  result: "matches"
} as const

const normalize = (input: typeof Input.Type): Search.GrepInput | StdError.StdError => {
  if (input.ignoreCase === true && input.smartCase === true) {
    return invalidInput("-i and -S are mutually exclusive")
  }
  if (input.context !== undefined && (input.beforeContext !== undefined || input.afterContext !== undefined)) {
    return invalidInput("-C cannot be combined with -A or -B")
  }
  // `rg --max-count 0` answers nothing at all, not even the summary the native
  // peer parses, so a cap that admits no match is rejected rather than read
  // differently by each peer.
  if (input.maxCount !== undefined && input.maxCount < 1) {
    return invalidInput("--max-count must be at least 1")
  }
  const fixedStrings = input.fixedStrings ?? false
  const patternError = Contract.validatePattern(input.pattern, fixedStrings)
  if (patternError !== undefined) return patternError
  for (const glob of input.globs ?? []) {
    const globError = Contract.validateGlob(glob)
    if (globError !== undefined) return globError
  }
  return {
    pattern: input.pattern,
    root: input.root ?? ".",
    fixedStrings,
    ignoreCase: input.ignoreCase ?? false,
    smartCase: input.smartCase ?? false,
    globs: input.globs ?? [],
    beforeContext: input.context ?? input.beforeContext ?? 0,
    afterContext: input.context ?? input.afterContext ?? 0,
    maxCount: input.maxCount,
    filesWithMatches: input.filesWithMatches ?? false,
    hidden: input.hidden ?? false,
    noIgnore: input.noIgnore ?? false,
    symbols: input.symbols ?? true,
    limit: Math.min(input.limit ?? MAX_GREP_MATCHES, MAX_GREP_MATCHES)
  }
}

const metacharacters = /[\\^$.|?*+()[\]{}]/

const empty = (output: typeof Output.Type): boolean => output.matches.length === 0 && output.files.length === 0

/**
 * Runs one validated ripgrep-contract call through the selected peer implementation.
 *
 * A pattern full of metacharacters that finds nothing is the most common way a
 * search lies: `sphinx-16612` searched 867 files for a parenthesised name and
 * read `0 of 867` as "this symbol is not used here". The retry costs one more
 * pass over the same tree only in the case that already found nothing, and the
 * result says plainly that the answer came from the literal reading.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("Grep.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, Search.Search> {
  const normalized = normalize(input)
  if (normalized instanceof StdError.StdError) return yield* Effect.fail(normalized)
  const search = yield* Search.Search
  const result = yield* search.grep(normalized)
  if (normalized.fixedStrings || !empty(result) || !metacharacters.test(normalized.pattern)) return result
  const literal = yield* search.grep({ ...normalized, fixedStrings: true })
  if (empty(literal)) return result
  const explanation =
    `The pattern found nothing as a regular expression and these results come from re-running it literally (fixedStrings: true).`
  return {
    ...literal,
    retriedAsLiteral: true,
    notice: literal.notice === undefined ? explanation : `${explanation} ${literal.notice}`
  }
})
