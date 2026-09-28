/**
 * Static filesystem declaration vocabulary shared by planning and execution.
 *
 * Declared paths use `/` as their canonical separator and normalize Unicode
 * to NFC. Workspace-relative paths reject C0 controls (U+0000 through U+001F)
 * and DEL (U+007F), which name nothing a supported filesystem can open. C1
 * controls (U+0080 through U+009F) remain accepted because those bytes are
 * legal in a POSIX file name.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * How strictly a declared file set is enforced at the boundary.
 *
 * `hard` rejects undeclared access. `expected` records access for validation
 * after execution without requiring the sandbox to reject it immediately.
 *
 * This is the ONE spelling of the pair. `Plan.NodeEffects.boundaryMode` is this
 * schema and so is `@smthrs/flow`'s `Action.BoundaryMode`; the literal used to
 * be written out in all three places.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const BoundaryMode = Schema.Literals(["hard", "expected"])

/**
 * The value form of {@link BoundaryMode}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type BoundaryMode = typeof BoundaryMode.Type

/**
 * The canonical spelling of a declared path or pattern: every separator is
 * `/`, and Unicode is normalized to NFC.
 *
 * {@link workspaceRelative} accepts a backslash as a separator, so
 * `dist\same.js` and `dist/same.js` are two spellings of ONE workspace path.
 * Every exact-path comparison in this module goes through this form, because
 * comparing the raw spellings would let the separator alias defeat overlap
 * detection exactly as `.` segments and empty segments would.
 *
 * @category accessors
 * @since 0.1.0
 * @slop
 */
export const canonical = (path: string): string => path.replaceAll("\\", "/").normalize("NFC")

/**
 * The {@link canonical} spelling with letter case folded away.
 *
 * A case-insensitive filesystem (default macOS APFS, Windows NTFS) opens
 * `src/A.ts` and `src/a.ts` as one file, so static overlap compares this form:
 * two declarations that differ only in case must serialize. Folding goes
 * through upper case because that mapping is context-free, so it folds each
 * character alone and commutes with splitting a path into segments.
 *
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const folded = (path: string): string => canonical(path).toUpperCase().normalize("NFC")

/** Workspace-relative glob pattern.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Pattern = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (pattern) => workspaceRelative(pattern) || "file patterns must be workspace-relative and cannot traverse upward",
    { title: "workspaceRelativePattern" }
  )
)

/**
 * Whether a declared path or pattern stays inside the workspace and names it
 * one way only. Refuses absolute paths (POSIX and drive-letter), upward
 * traversal, and the aliasing forms — `.` segments, empty segments — that
 * would let two spellings of one file defeat exact-string overlap detection.
 *
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const workspaceRelative = (pattern: string): boolean => {
  for (let index = 0; index < pattern.length; index++) {
    const code = pattern.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return false
  }
  if (pattern.startsWith("/")) return false
  const segments = canonical(pattern).split("/")
  // `C:foo` is drive-relative on Windows, so any drive-letter prefix escapes.
  if (/^[A-Za-z]:/.test(segments[0]!) || segments[0]!.endsWith(":")) return false
  return segments.every((segment) => segment !== ".." && segment !== "." && segment !== "")
}

/** Bazel-style file glob.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Glob = Schema.TaggedStruct("Glob", {
  include: Schema.NonEmptyArray(Pattern),
  exclude: Schema.optional(Schema.Array(Pattern))
})

/** Bazel-style file glob.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Glob = typeof Glob.Type

/** A directory output captured and replayed as one tree artifact.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const TreeArtifact = Schema.TaggedStruct("TreeArtifact", {
  path: Pattern
})

/** A directory output captured and replayed as one tree artifact.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TreeArtifact = typeof TreeArtifact.Type

/** One leaf of a named filegroup.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Entry = Schema.Union([Pattern, Glob, TreeArtifact])

/** One leaf of a named filegroup.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Entry = typeof Entry.Type

/** A declaration valid in a read set.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const ReadEntry = Schema.Union([Pattern, Glob])

/** A declaration valid in a read set.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ReadEntry = typeof ReadEntry.Type

/** A named reusable collection expanded before measurement.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Filegroup = Schema.TaggedStruct("Filegroup", {
  name: Schema.NonEmptyString,
  entries: Schema.Array(Entry)
})

/** A named reusable collection expanded before measurement.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Filegroup = typeof Filegroup.Type

/** A named read-only collection.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const ReadFilegroup = Schema.TaggedStruct("Filegroup", {
  name: Schema.NonEmptyString,
  entries: Schema.Array(ReadEntry)
})

/** A named read-only collection.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ReadFilegroup = typeof ReadFilegroup.Type

/** Any declaration accepted by a plan effect set.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Declaration = Schema.Union([Entry, Filegroup])

/** Any declaration accepted by a plan effect set.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Declaration = typeof Declaration.Type

/** Any declaration accepted by a plan read set.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const ReadDeclaration = Schema.Union([ReadEntry, ReadFilegroup])

/** Any declaration accepted by a plan read set.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ReadDeclaration = typeof ReadDeclaration.Type

/** Creates a named filegroup.
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeFilegroup = (name: string, entries: ReadonlyArray<Entry>): Filegroup => ({
  _tag: "Filegroup",
  name,
  entries
})

/** Expands filegroups deterministically, preserving declaration order.
 * @category accessors
 * @since 0.1.0
 * @slop
 */
export const expand = (declarations: ReadonlyArray<Declaration>): ReadonlyArray<Entry> =>
  declarations.flatMap((declaration) =>
    typeof declaration !== "string" && declaration._tag === "Filegroup" ? declaration.entries : [declaration]
  )

/** Expands read filegroups deterministically, preserving declaration order.
 * @category accessors
 * @since 0.1.0
 * @slop
 */
export const expandReads = (declarations: ReadonlyArray<ReadDeclaration>): ReadonlyArray<ReadEntry> =>
  declarations.flatMap((declaration) =>
    typeof declaration !== "string" && declaration._tag === "Filegroup" ? declaration.entries : [declaration]
  )

/** Whether a value is a glob declaration.
 * @category guards
 * @since 0.1.0
 * @slop
 */
export const isGlob = (value: unknown): value is Glob =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === "Glob"

/** Whether a value is a tree artifact declaration.
 * @category guards
 * @since 0.1.0
 * @slop
 */
export const isTreeArtifact = (value: unknown): value is TreeArtifact =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === "TreeArtifact"

/** KMP searches a literal without rescanning a long near-matching prefix. */
const literalSearch = (literal: string) => {
  const fallback = new Uint32Array(literal.length)
  let matched = 0
  for (let index = 1; index < literal.length; index++) {
    while (matched > 0 && literal[index] !== literal[matched]) matched = fallback[matched - 1]!
    if (literal[index] === literal[matched]) matched++
    fallback[index] = matched
  }
  return (path: string, start: number, end: number): number => {
    let matched = 0
    for (let index = start; index < end; index++) {
      while (matched > 0 && path[index] !== literal[matched]) matched = fallback[matched - 1]!
      if (path[index] === literal[matched]) matched++
      if (matched === literal.length) return index + 1
    }
    return -1
  }
}

/** Anchored ends and disjoint literal searches make each segment match linear. */
const segmentMatcher = (segment: string): (path: string) => boolean => {
  const chunks = segment.split(/\*+/)
  const prefix = chunks.shift()!
  if (chunks.length === 0) return (path) => path === prefix
  const suffix = chunks.pop()!
  const searches = chunks.map(literalSearch)
  return (path) => {
    const end = path.length - suffix.length
    if (prefix.length > end || !path.startsWith(prefix) || !path.endsWith(suffix)) return false
    let position = prefix.length
    for (const search of searches) {
      position = search(path, position, end)
      if (position === -1) return false
    }
    return true
  }
}

const patternMatchers = new Map<string, (path: string) => boolean>()

/** Compile once per canonical spelling; recursive segments use no backtracking. */
const patternMatcher = (pattern: string): (path: string) => boolean => {
  const key = canonical(pattern)
  const cached = patternMatchers.get(key)
  if (cached !== undefined) return cached
  const segments = key.split("/").map((segment) => segment === "**" ? undefined : segmentMatcher(segment))
  const matcher = (path: string): boolean => {
    const parts = path.split("/")
    // Suffix membership: next[j] says the remaining pattern matches parts[j..].
    // Each pattern/path segment pair is visited once, even with repeated **.
    let next = new Uint8Array(parts.length + 1)
    next[parts.length] = 1
    for (let index = segments.length - 1; index >= 0; index--) {
      const segment = segments[index]
      const current = new Uint8Array(parts.length + 1)
      for (let part = parts.length - 1; part >= 0; part--) {
        current[part] = segment === undefined
          // A trailing ** accepts every remaining code unit. It still needs
          // the separator preceding it: src/** does not match bare src.
          ? Number(
            index === segments.length - 1 || next[part] === 1 ||
              (parts[part] !== "" && current[part + 1] === 1)
          )
          : Number(next[part + 1] === 1 && segment(parts[part]!))
      }
      next = current
    }
    return next[0] === 1
  }
  patternMatchers.set(key, matcher)
  return matcher
}

/** Tests one workspace-relative path against one Bazel-style pattern.
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const matchesPattern = (pattern: string, path: string): boolean => patternMatcher(pattern)(path)

/** Tests one file path against a glob, including exclusions.
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const matchesGlob = (glob: Glob, path: string): boolean =>
  glob.include.some((pattern) => matchesPattern(pattern, path)) &&
  !(glob.exclude ?? []).some((pattern) => matchesPattern(pattern, path))

const beneath = (tree: string, path: string): boolean => {
  const root = folded(tree)
  const inside = folded(path)
  return inside === root || inside.startsWith(`${root}/`)
}

/** {@link matchesGlob} over {@link folded} spellings of the glob and the path. */
const matchesGlobFolded = (glob: Glob, path: string): boolean => {
  const inside = folded(path)
  return glob.include.some((pattern) => matchesPattern(folded(pattern), inside)) &&
    !(glob.exclude ?? []).some((pattern) => matchesPattern(folded(pattern), inside))
}

/**
 * Whether a plain-string entry is a pattern rather than an exact path. The
 * runtime boundary (`engine-store` `WorkspaceSandbox`) honors `*` and `**` in a
 * string entry, so static overlap must read it the same way.
 */
const wildcard = (entry: string): boolean => entry.includes("*")

/**
 * Conservative static overlap. `true` may over-serialize; `false` proves that
 * no path can belong to both declarations.
 *
 * A plain string containing `*` is a pattern, matched with
 * {@link matchesPattern}; two patterns, or a pattern against a Glob or
 * TreeArtifact, overlap conservatively.
 *
 * Exact paths, wildcard strings, and tree roots compare in their
 * {@link folded} form, so separator aliases, canonically equivalent Unicode
 * spellings, and spellings that differ only in letter case overlap. A Glob
 * against an exact path matches both its `include` and `exclude` patterns in
 * folded form. {@link matchesGlob} itself stays case-sensitive and tests the path bytes it
 * is handed; its property suite pins a backslash inside a path segment as
 * literal text, so canonicalizing a measured path before matching is its
 * caller's decision, not this module's.
 *
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const overlaps = (left: Entry, right: Entry): boolean => {
  if (typeof left === "string" && typeof right === "string") {
    const leftWild = wildcard(left)
    const rightWild = wildcard(right)
    if (leftWild && rightWild) return true
    if (leftWild) return matchesPattern(folded(left), folded(right))
    if (rightWild) return matchesPattern(folded(right), folded(left))
    return folded(left) === folded(right)
  }
  // A string holding `*` is a pattern (see {@link wildcard}); against a Glob or
  // a TreeArtifact it answers as conservatively as glob against glob.
  if (typeof left === "string" && wildcard(left) && !(typeof right === "string")) return true
  if (typeof right === "string" && wildcard(right) && !(typeof left === "string")) return true
  if (typeof left === "string" && isGlob(right)) return matchesGlobFolded(right, left)
  if (isGlob(left) && typeof right === "string") return matchesGlobFolded(left, right)
  if (isGlob(left) && isGlob(right)) return true
  if (isTreeArtifact(left) && typeof right === "string") return beneath(left.path, right)
  if (typeof left === "string" && isTreeArtifact(right)) return beneath(right.path, left)
  if (isTreeArtifact(left) && isTreeArtifact(right)) {
    return beneath(left.path, right.path) || beneath(right.path, left.path)
  }
  if (isTreeArtifact(left) && isGlob(right)) return true
  /* v8 ignore else -- the closed Entry union leaves only Glob/TreeArtifact here */
  if (isGlob(left) && isTreeArtifact(right)) return overlaps(right, left)
  /* v8 ignore next -- Entry's closed union makes every pair return above */
  return true
}
