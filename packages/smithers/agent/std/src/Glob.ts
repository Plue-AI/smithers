/**
 * The `glob` projection of Smithers Ripgrep Subset v1.
 *
 * It has the same two peer implementations as `grep` and supports the
 * `rg --files -g` pattern subset: `*`, `**`, `?`, and brace alternatives;
 * results are path sorted; hidden files are opt-in; root and nested .gitignore
 * files apply by default (even outside git repositories). `noIgnore: true` opts
 * out. Parent/global ignore files, .git/info/exclude, .ignore and .rgignore
 * are not read. Caller globs filter the remaining files without overriding
 * ignores. An explicitly named ignored or skipped directory is still searched.
 *
 * **Patterns are relative to `root`, never to the filesystem.** A candidate is
 * matched by the path it has *relative to the search root*, so `tests/**\/*.py`
 * — what every caller writing a project-relative pattern means — matches
 * `<root>/tests/admin_views/admin.py`. Three rules follow, and both peers
 * implement all three identically:
 *
 * - A pattern with no `/` matches the **basename** at any depth: `*.py` finds
 *   every Python file in the subtree.
 * - A pattern containing `/` is matched against the root-relative path and is
 *   anchored at the root: `tests/*.py` matches `<root>/tests/a.py` and not
 *   `<root>/src/tests/a.py`.
 * - A leading `/` is the same anchor spelled explicitly, not a filesystem
 *   absolute path: `/a.py` matches only `<root>/a.py`, where bare `a.py` would
 *   match any `a.py` in the subtree. A leading `./` means the same anchor.
 *
 * `**` crosses directory boundaries, `*` and `?` stay inside one segment, and
 * `?` consumes one UTF-8 byte. Trailing spaces are not part of a pattern:
 * `rg` reads `-g` by gitignore's rules and drops them, so `"a.ts "` finds
 * `a.ts`, and a pattern left blank by that is rejected rather than read as no
 * filter at all.
 *
 * A `root` that names one file is that file. It is reported whatever the
 * pattern says, because `rg` searches a path given on its command line without
 * consulting `-g`, and a walk that reaches one file has nothing to filter.
 *
 * A walk skips what it cannot read — a dangling symlink, a link cycle, a
 * directory the process may not list — and reports everything it did reach.
 * One unreadable entry never fails the call.
 *
 * The consequence worth stating is the one that cost a SWE-bench run 41 of its
 * 43 frames: an *absolute* pattern such as `/home/repo/tests/**` is read as the
 * root-relative path `home/repo/tests/**`, which nothing under a root of
 * `/home/repo` can match. That answer is now never silent — a pattern no file
 * under the root could match reports why through `notice`, so "unsatisfiable"
 * and "searched and found none" stay distinguishable.
 *
 * @since 1.0.0
 */

import { Effect, Schema } from "effect"
import { capability, envelope, rootSubtree } from "./internal/Declaration.ts"
import { MAX_ENTRIES } from "./internal/Text.ts"
import * as Search from "./Search.ts"
import * as Contract from "./SearchContract.ts"
import type * as StdError from "./StdError.ts"

/**
 * The registry name for glob.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "glob"
/**
 * The model-facing glob description.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description = "Find files through the Smithers Ripgrep Subset v1 contract."
/**
 * Input accepted by {@link flow} and {@link run}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  pattern: Schema.NonEmptyString.annotate({
    description:
      "Ripgrep -g pattern, matched against paths relative to root, never absolute paths: *, ?, {a,b} stay inside one segment, ** crosses directories, a pattern without / matches any basename, and a leading / anchors at root."
  }),
  root: Schema.optional(Schema.String).annotate({
    description: "Search root the pattern is relative to; defaults to . (the host workspace)."
  }),
  hidden: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep --hidden." }),
  noIgnore: Schema.optional(Schema.Boolean).annotate({
    description:
      "Honor root-scoped .gitignore files by default. Set true to include ignored paths; hidden and fixed directory skips still apply."
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: `Maximum paths, capped at ${MAX_ENTRIES}.`
  })
})
/**
 * Decoded input accepted by the `glob` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type
/**
 * Output produced by {@link run}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  paths: Schema.Array(Schema.String),
  total: Schema.Int,
  truncated: Schema.Boolean,
  notice: Schema.optional(Schema.String)
})
/**
 * Decoded output returned by the `glob` flow.
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
 * Capability strings requested by glob.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("fs:read", "/**")]
/**
 * Declaration-only glob flow.
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
  verb: { pending: "listing", success: "listed", failure: "failed to list" },
  subject: "pattern",
  result: "paths"
} as const

/**
 * Runs one `rg --files -g` contract call through the selected peer implementation.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("Glob.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, Search.Search> {
  const patternError = Contract.validateGlob(input.pattern)
  if (patternError !== undefined) return yield* Effect.fail(patternError)
  const search = yield* Search.Search
  return yield* search.glob({
    pattern: input.pattern,
    root: input.root ?? ".",
    hidden: input.hidden ?? false,
    noIgnore: input.noIgnore ?? false,
    limit: Math.min(input.limit ?? MAX_ENTRIES, MAX_ENTRIES)
  })
})
