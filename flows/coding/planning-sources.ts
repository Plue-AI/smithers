/** Planning reads the files a request names, so the planner never has to ask a
 * human to paste a file that the workspace already holds. The paths are the
 * request's own and those `memory` chose for it, read through the same
 * sandboxed primitive the wiki uses, and capped per file and in total so a
 * large repository cannot flood a planning prompt.
 */
import { normalizePath } from "@smthrs/agent/Memory"
import * as Digest from "@smthrs/core/Digest"
import { Effect, FileSystem, Path, Schema } from "effect"

/** One file is bounded evidence; the whole attachment is bounded again. */
export const maxSourceBytes = 32 * 1024
export const maxSourcesBytes = 128 * 1024
export const maxSources = 24
/** A file larger than this is not read at all; planning is not a code search. */
export const maxFileBytes = 512_000

export const Source = Schema.Struct({
  path: Schema.NonEmptyString,
  // The digest of the WHOLE file, not of the retained text, so a freshness
  // check still notices an edit made past the truncation point.
  digest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  text: Schema.String.check(Schema.isMaxLength(maxSourceBytes)),
  truncated: Schema.Boolean
})
export type Source = typeof Source.Type

/** Path extraction is `memory`'s, so planning and memory read one request the same way. */
export { extractPaths, normalizePath } from "@smthrs/agent/Memory"

const encoder = new TextEncoder()
const clamp = (text: string, limit: number) => {
  const bytes = encoder.encode(text)
  if (bytes.length <= limit) return { text, truncated: false }
  if (limit <= 0) return { text: "", truncated: true }
  // A multi-byte character split by the cap decodes to one replacement; the
  // retained text must stay exactly the file's own leading bytes.
  const decoded = new TextDecoder().decode(bytes.subarray(0, limit))
  return { text: decoded.endsWith("�") ? decoded.slice(0, -1) : decoded, truncated: true }
}

/** An absent path is a fact a plan can state; an unreadable one is neither
 * evidence nor a stated absence, so the two outcomes stay distinguishable.
 */
export type Readback =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" }

export interface SourceReader {
  readonly read: (relative: string) => Effect.Effect<Readback, never>
  /** Repository-relative top level names, for README discovery. */
  readonly names: Effect.Effect<ReadonlyArray<string>, never>
}

/** Realpath under the root, regular files only, text only, bounded size. */
export const reader = (
  root: string,
  hostFilesystem?: FileSystem.FileSystem
): Effect.Effect<SourceReader, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = hostFilesystem ?? (yield* FileSystem.FileSystem), path = yield* Path.Path
    const base = yield* Effect.orElseSucceed(fs.realPath(root), () => root)
    const unreadable = { kind: "unreadable" } as const
    const read = (relative: string): Effect.Effect<Readback, never> =>
      Effect.gen(function*() {
        const name = normalizePath(relative)
        if (name === null) return unreadable
        const resolved = path.resolve(base, name)
        const file = yield* Effect.orElseSucceed(fs.realPath(resolved), () => "")
        if (file === "") {
          return (yield* Effect.orElseSucceed(fs.exists(resolved), () => true))
            ? unreadable
            : { kind: "missing" as const }
        }
        // A symlink out of the workspace is not this repository's source.
        if (!file.startsWith(base + path.sep)) return unreadable
        const stat = yield* Effect.orElseSucceed(fs.stat(file), () => null)
        if (!stat || stat.type !== "File" || stat.size > BigInt(maxFileBytes)) return unreadable
        const text = yield* Effect.orElseSucceed(fs.readFileString(file), () => null)
        return text === null || text.includes("\0") ? unreadable : { kind: "text" as const, text }
      })
    const names = Effect.orElseSucceed(fs.readDirectory(base), () => [] as ReadonlyArray<string>)
    return { read, names }
  })

/** The repository's own README is evidence for nearly every prose request. */
export const readmePaths = (reader: SourceReader) =>
  Effect.map(reader.names, (names) => names.filter((name) => /^README(\.[A-Za-z0-9]+)?$/i.test(name)).sort())

/** Existing project guidance and manifests, without generated artifacts or
 * recursive scanning. Requested source paths keep first claim on the budget. */
export const repositoryContextPaths = (reader: SourceReader) =>
  Effect.map(reader.names, (names) => [
    ...names.filter((name) => /^README(\.[A-Za-z0-9]+)?$/i.test(name)).sort(),
    ...names.filter((name) =>
      /^(?:AGENTS\.md|CONTRIBUTING(?:\.[A-Za-z0-9]+)?|package\.json|Cargo\.toml|go\.mod|pyproject\.toml)$/i.test(name)
    ).sort()
  ])

export interface Collected {
  readonly sources: ReadonlyArray<Source>
  /** Named paths that do not exist, so a plan can state that instead of asking. */
  readonly missing: ReadonlyArray<string>
}

/** Paths are read in the order given; the earliest mention keeps the budget. */
export const collectSources = (reader: SourceReader, paths: ReadonlyArray<string>): Effect.Effect<Collected, never> =>
  Effect.gen(function*() {
    const sources: Array<Source> = []
    const missing: Array<string> = []
    const seen = new Set<string>()
    let used = 0
    for (const relative of paths) {
      const name = normalizePath(relative)
      if (name === null || seen.has(name) || sources.length + missing.length >= maxSources) continue
      seen.add(name)
      const result = yield* reader.read(name)
      if (result.kind !== "text") {
        if (result.kind === "missing") missing.push(name)
        continue
      }
      const retained = clamp(result.text, Math.min(maxSourceBytes, maxSourcesBytes - used))
      used += encoder.encode(retained.text).length
      sources.push({
        path: name,
        digest: Digest.digest(result.text),
        text: retained.text,
        truncated: retained.truncated
      })
    }
    return { sources, missing }
  })

/** Re-reads what planning attached, so a plan cannot be built on stale text. */
export const staleSources = (reader: SourceReader, collected: Collected): Effect.Effect<ReadonlyArray<string>, never> =>
  Effect.gen(function*() {
    const stale: Array<string> = []
    for (const source of collected.sources) {
      const result = yield* reader.read(source.path)
      if (result.kind !== "text" || Digest.digest(result.text) !== source.digest) stale.push(source.path)
    }
    for (const name of collected.missing) {
      if ((yield* reader.read(name)).kind !== "missing") stale.push(name)
    }
    return stale
  })
