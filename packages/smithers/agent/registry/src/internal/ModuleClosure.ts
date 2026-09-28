/**
 * The other files a discovered module's body runs.
 *
 * A module body's `contentDigest` measures the ENTRY FILE and nothing else,
 * and {@link module:Executable.fromDescriptor} imports a verified copy of those
 * entry bytes written as a SIBLING of the original, precisely so the entry's
 * relative imports resolve to the live files beside it. Everything reached that
 * way is code the flow runs and the entry digest never saw: a sibling edited
 * after a plan was approved would keep the approval.
 *
 * This module closes that gap by naming what the entry reaches. It walks the
 * transitive closure of RELATIVE specifiers (`./`, `../`) statically — the same
 * lexer `ModuleMetadata` reads declarations with — and records each reached
 * module as a path relative to the entry's directory plus the digest of its
 * bytes. Discovery puts that list on the module {@link module:Descriptor.BodyRef},
 * so it rides `Descriptor.executionDigest` through the existing schema
 * encoding, and the loader recomputes it before importing anything.
 *
 * BARE SPECIFIERS ARE OUT OF SCOPE. `@smthrs/flow`, `effect`, and every other
 * package specifier resolve into installed code, which is the host's own code
 * and carries the host's trust; a flow that can name a package can already name
 * the package the host itself runs on. Only the project's own files — the ones
 * an author edits beside the flow — are pinned here.
 *
 * TYPE-ONLY IMPORTS ARE PINNED TOO. `import type ... from "./x.ts"` is erased
 * before anything runs, so pinning it is conservative rather than necessary. It
 * costs an approval when a types-only sibling changes and saves deciding, per
 * specifier, whether a compiler would have erased it.
 *
 * @since 1.0.0-rc.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import type { ModuleImport } from "../Descriptor.ts"
import { stringLiteral, tokenize } from "./ModuleMetadata.ts"

/**
 * How many modules one entry's closure may name.
 *
 * A closure past the bound is not pinned and says so, because the alternative
 * is a discovery scan whose cost is a flow author's import graph.
 *
 * @category constants
 * @since 1.0.0-rc.0
 * @private
 */
export const closureFileLimit = 512

/**
 * How many bytes one entry's closure may total.
 *
 * @category constants
 * @since 1.0.0-rc.0
 * @private
 */
export const closureByteLimit = 16 * 1024 * 1024

/**
 * The suffixes a specifier is resolved through, in order.
 *
 * The empty suffix is first because the repository writes most specifiers with
 * their extension; the rest are what an extensionless specifier such as
 * `"../coding/schema"` means under this project's loaders.
 */
const suffixes = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"]

/**
 * The TypeScript sources a JavaScript specifier stands for.
 *
 * Under NodeNext, `import "./schema.js"` names `schema.ts`: the author writes
 * the extension the module will have after compilation. TypeScript and Bun
 * both resolve it that way when no `.js` file exists, so the pinner does too.
 */
const typeScriptCounterparts: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  [".js", [".ts", ".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]]
]

/** The files a specifier naming a DIRECTORY resolves to. */
const indexNames = ["index.ts", "index.tsx", "index.mts", "index.js", "index.mjs"]

/**
 * What one module's source says it loads from beside itself.
 *
 * `opaque` counts the loads whose target is not a literal: an `import(...)` or
 * `require(...)` (including `import.meta.require(...)`) whose argument is
 * computed, and every `createRequire(...)`, which returns a loader whose
 * calls this scan cannot follow. The target of one is decided at run time, so
 * no static walk can pin it, and a module carrying one is reported as
 * unpinnable rather than as pinned. `absolute` lists the literal specifiers
 * that name a file by absolute path or `file:` URL; the pin records paths
 * relative to the entry and does not follow them, so they are unpinnable too.
 *
 * @category parsing
 * @since 1.0.0-rc.0
 * @private
 */
export const specifiersOf = (source: string): {
  readonly relative: ReadonlyArray<string>
  readonly opaque: number
  readonly absolute: ReadonlyArray<string>
} => {
  const tokens = tokenize(source)
  const relative: Array<string> = []
  const absolute: Array<string> = []
  let opaque = 0
  const record = (literal: string | undefined) => {
    if (literal === undefined) return
    if (literal.startsWith("./") || literal.startsWith("../")) relative.push(literal)
    else if (isAbsoluteSpecifier(literal)) absolute.push(literal)
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.kind !== "identifier") continue
    if (token.value === "createRequire" && tokens[index + 1]?.value === "(") {
      opaque++
      continue
    }
    if ((token.value === "import" || token.value === "require") && tokens[index + 1]?.value === "(") {
      const argument = tokens[index + 2]
      // `import("./x.ts")` and `require("./x.ts")` name their target;
      // `import(name)` does not, and neither does a template with a
      // substitution in it.
      const literal = argument?.kind === "string" ? stringLiteral(argument.value) : undefined
      if (literal === undefined || tokens[index + 3]?.value !== ")") opaque++
      else record(literal)
      continue
    }
    // `import "./side-effect.ts"`, which names no bindings and so has no `from`.
    if (token.value === "import" && tokens[index + 1]?.kind === "string") {
      record(stringLiteral(tokens[index + 1]!.value))
      continue
    }
    // Every other module specifier — `import … from "x"`, `export … from "x"`,
    // `export * from "x"` — sits immediately after the contextual keyword
    // `from`. A `from` followed by a string literal has no other meaning in a
    // module: an object key is `from:`, an argument is `from,`, an assignment
    // is `from =`.
    if (token.value === "from" && tokens[index + 1]?.kind === "string") {
      record(stringLiteral(tokens[index + 1]!.value))
    }
  }
  return { relative, opaque, absolute }
}

/** A specifier naming a file by absolute path or URL rather than beside the importer. */
const isAbsoluteSpecifier = (specifier: string): boolean =>
  specifier.startsWith("/") || specifier.startsWith("\\") || /^file:/i.test(specifier) ||
  /^[A-Za-z]:[\\/]/.test(specifier)

/** A POSIX-separated path from `fromDirectory` to `target`, for the record. */
const relativePath = (path: Path.Path, fromDirectory: string, target: string): string =>
  path.relative(fromDirectory, target).replaceAll("\\", "/")

/**
 * The file a relative specifier names, or `undefined` when nothing answers to
 * it. The order is the loader's: the exact path first, then the suffixes this
 * project's specifiers omit, then a directory's index.
 */
const resolve = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  fromDirectory: string,
  specifier: string
): Effect.Effect<string | undefined> =>
  Effect.gen(function*() {
    const base = path.resolve(fromDirectory, specifier)
    const exact = yield* Effect.result(fs.stat(base))
    if (exact._tag === "Success" && exact.success.type === "File") return base
    for (const [extension, sources] of typeScriptCounterparts) {
      if (!base.endsWith(extension)) continue
      for (const source of sources) {
        const candidate = `${base.slice(0, -extension.length)}${source}`
        const stat = yield* Effect.result(fs.stat(candidate))
        if (stat._tag === "Success" && stat.success.type === "File") return candidate
      }
    }
    for (const suffix of suffixes) {
      const candidate = `${base}${suffix}`
      const stat = yield* Effect.result(fs.stat(candidate))
      if (stat._tag === "Success" && stat.success.type === "File") return candidate
    }
    for (const name of indexNames) {
      const candidate = path.join(base, name)
      const stat = yield* Effect.result(fs.stat(candidate))
      if (stat._tag === "Success" && stat.success.type === "File") return candidate
    }
    return undefined
  })

/**
 * One module's digest and what it loads, read once per scan.
 *
 * Sibling flows in one project share most of their imports, so a scan that
 * re-read and re-tokenized each of them per flow would cost the union of the
 * closures times the number of flows.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @private
 */
export interface Cache {
  readonly files: Map<string, {
    readonly contentDigest: string
    readonly specifiers: ReadonlyArray<string>
    readonly opaque: number
    readonly absolute: ReadonlyArray<string>
  }>
}

/**
 * A fresh per-scan cache.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @private
 */
export const cache = (): Cache => ({ files: new Map() })

/** The record for a specifier nothing could be pinned for. */
const unpinnable = (description: string): ModuleImport => ({ path: description })

/**
 * Every module one entry reaches through relative specifiers, sorted by path.
 *
 * Never fails: a file that cannot be read, a specifier that resolves to
 * nothing, a computed `import()`, and a closure past its bound are all RECORDED
 * — as an entry carrying no `contentDigest` — rather than raised, because
 * discovery lists a directory a person is editing and one unreadable sibling is
 * not a reason to drop the flow from the catalog. Refusing to RUN such a flow
 * is {@link module:Executable}'s decision, made where the code is about to be
 * imported.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @private
 */
export const collect = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  entryPath: string,
  entrySource: string,
  memo: Cache = cache(),
  /** The bounds, lowered by the suite that proves they are enforced. */
  bounds: { readonly files: number; readonly bytes: number } = {
    files: closureFileLimit,
    bytes: closureByteLimit
  }
): Effect.Effect<ReadonlyArray<ModuleImport>> =>
  Effect.gen(function*() {
    const normalizedEntryPath = path.resolve(entryPath)
    const entryDirectory = path.dirname(normalizedEntryPath)
    const found = new Map<string, ModuleImport>()
    const visited = new Set<string>([normalizedEntryPath])
    // `pending` carries the importer so an unresolvable specifier can name the
    // file that asked for it rather than only the specifier nothing answered.
    const pending: Array<{ readonly from: string; readonly directory: string; readonly specifier: string }> = []
    let bytes = 0
    const enqueue = (from: string, directory: string, specifiers: ReadonlyArray<string>) => {
      for (const specifier of specifiers) pending.push({ from, directory, specifier })
    }
    const reportOpaque = (importer: string, count: number) => {
      if (count === 0) return
      const description = `${importer} computes the target of ${count} import() or require() call(s)`
      found.set(description, unpinnable(description))
    }
    const reportAbsolute = (importer: string, specifiers: ReadonlyArray<string>) => {
      for (const specifier of specifiers) {
        const description = `${importer} imports "${specifier}", an absolute specifier the pin does not follow`
        found.set(description, unpinnable(description))
      }
    }
    const { absolute, opaque, relative } = specifiersOf(entrySource)
    if (opaque > 0) {
      found.set(
        normalizedEntryPath,
        unpinnable(`the entry computes the target of ${opaque} import() or require() call(s)`)
      )
    }
    reportAbsolute("the entry", absolute)
    enqueue(normalizedEntryPath, entryDirectory, relative)

    while (pending.length > 0) {
      const { directory, from, specifier } = pending.shift()!
      const resolved = yield* resolve(fs, path, directory, specifier)
      const importer = from === normalizedEntryPath ? "the entry" : `"${relativePath(path, entryDirectory, from)}"`
      if (resolved === undefined) {
        const description = `${importer} imports "${specifier}", which resolves to no file`
        found.set(description, unpinnable(description))
        continue
      }
      // A cycle is ordinary: `visited` is what ends the walk, and a module
      // already recorded keeps the one record it has.
      if (visited.has(resolved)) continue
      visited.add(resolved)
      if (visited.size > bounds.files) {
        const description = `the closure names more than ${bounds.files} modules`
        found.set(description, unpinnable(description))
        break
      }
      const recorded = relativePath(path, entryDirectory, resolved)
      const cached = memo.files.get(resolved)
      if (cached !== undefined) {
        found.set(recorded, { path: recorded, contentDigest: cached.contentDigest })
        reportOpaque(`"${recorded}"`, cached.opaque)
        reportAbsolute(`"${recorded}"`, cached.absolute)
        enqueue(resolved, path.dirname(resolved), cached.specifiers)
        continue
      }
      const read = yield* Effect.result(fs.readFile(resolved))
      if (read._tag === "Failure") {
        const description = `"${recorded}" could not be read`
        found.set(description, unpinnable(description))
        continue
      }
      bytes += read.success.length
      if (bytes > bounds.bytes) {
        const description = `the closure totals more than ${bounds.bytes} bytes`
        found.set(description, unpinnable(description))
        break
      }
      const contentDigest = Digest.digest(read.success)
      const specifiers = specifiersOf(new TextDecoder().decode(read.success))
      reportOpaque(`"${recorded}"`, specifiers.opaque)
      reportAbsolute(`"${recorded}"`, specifiers.absolute)
      memo.files.set(resolved, {
        contentDigest,
        specifiers: specifiers.relative,
        opaque: specifiers.opaque,
        absolute: specifiers.absolute
      })
      found.set(recorded, { path: recorded, contentDigest })
      enqueue(resolved, path.dirname(resolved), specifiers.relative)
    }

    return [...found.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  })
