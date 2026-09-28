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
 * A BARE SPECIFIER IS NOT ALWAYS A PACKAGE. `@smthrs/flow` and `effect`
 * resolve into installed code, which is the host's own code and carries the
 * host's trust. But a loader can map a bare specifier onto the project's own
 * files: a package.json `imports` entry (`#impl` → `./impl.ts`), a tsconfig
 * or jsconfig `paths` alias or `baseUrl` (which Bun honours), and a package
 * importing itself by name through its `exports`. The walk follows the first
 * two to the files they name and pins those, and reports a `#` specifier it
 * cannot map and a self-import as unpinnable. What is left resolves into
 * installed packages and is not measured.
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
 * computed, every mention of `createRequire` (called, imported, or renamed),
 * every `require` used as a value rather than called (`const r = require`),
 * and every import of `module` or `node:module`, since each yields a loader
 * whose calls this scan cannot follow. The target of one is decided at run time, so
 * no static walk can pin it, and a module carrying one is reported as
 * unpinnable rather than as pinned. `absolute` lists the literal specifiers
 * that name a file by absolute path or `file:` URL; the pin records paths
 * relative to the entry and does not follow them, so they are unpinnable too.
 * `bare` lists every other literal specifier except `node:` and `bun:`
 * builtins; {@link collect} decides which of them name project files.
 *
 * @category parsing
 * @since 1.0.0-rc.0
 * @private
 */
export const specifiersOf = (source: string): {
  readonly relative: ReadonlyArray<string>
  readonly opaque: number
  readonly absolute: ReadonlyArray<string>
  readonly bare: ReadonlyArray<string>
} => {
  const tokens = tokenize(source)
  const relative: Array<string> = []
  const absolute: Array<string> = []
  const bare: Array<string> = []
  let opaque = 0
  const record = (literal: string | undefined) => {
    if (literal === undefined) return
    if (literal.startsWith("./") || literal.startsWith("../")) relative.push(literal)
    else if (isAbsoluteSpecifier(literal)) absolute.push(literal)
    else if (literal === "module" || literal === "node:module") opaque++
    else if (!literal.startsWith("node:") && !literal.startsWith("bun:")) bare.push(literal)
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.kind !== "identifier") continue
    // `createRequire` in any position: `createRequire(...)`, and the renames
    // `import { createRequire as load }` and `const load = createRequire`
    // that would otherwise hide the call behind another name.
    if (token.value === "createRequire") {
      opaque++
      continue
    }
    // `require` used as a value — `const load = require`, `[require][0]`,
    // `fn(require)` — is a loader under another name. `require.resolve`
    // names a path without loading it, and an object key `{ require: … }` is
    // not the binding.
    if (token.value === "require" && tokens[index + 1]?.value !== "(") {
      const next = tokens[index + 1]?.value
      const previous = tokens[index - 1]?.value
      const resolveOnly = next === "." && tokens[index + 2]?.value === "resolve"
      const objectKey = next === ":" && (previous === "{" || previous === ",")
      if (!resolveOnly && !objectKey) opaque++
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
  return { relative, opaque, absolute, bare }
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
 * A JSON document that may carry comments and trailing commas, as tsconfig and
 * jsconfig files do. `undefined` when it is not an object even then.
 */
const parseJsonc = (text: string): Record<string, unknown> | undefined => {
  let out = ""
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (character === "\"") {
      let end = index + 1
      while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1
      out += text.slice(index, end + 1)
      index = end
    } else if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++
    } else if (character === "/" && text[index + 1] === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++
      index++
    } else {
      out += character
    }
  }
  try {
    const parsed: unknown = JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** A record field that is itself a plain object. */
const objectField = (value: unknown, key: string): Record<string, unknown> | undefined => {
  const field = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined
  return typeof field === "object" && field !== null && !Array.isArray(field)
    ? field as Record<string, unknown>
    : undefined
}

/**
 * What a `paths`/`imports`-style pattern key makes of a specifier: the text
 * its one `*` stands for, `""` for an exact key, or `undefined` for no match.
 */
const matchPattern = (key: string, specifier: string): string | undefined => {
  const star = key.indexOf("*")
  if (star === -1) return key === specifier ? "" : undefined
  const prefix = key.slice(0, star)
  const suffix = key.slice(star + 1)
  return specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : undefined
}

/** Every string a package.json `imports` target can stand for, across its conditions. */
const targetLeaves = (target: unknown): ReadonlyArray<string> =>
  typeof target === "string"
    ? [target]
    : Array.isArray(target)
    ? target.flatMap(targetLeaves)
    : typeof target === "object" && target !== null
    ? Object.values(target).flatMap(targetLeaves)
    : []

/** The package a bare specifier names: `@scope/name` or `name`. */
const packageName = (specifier: string): string => {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
}

/** The files, and the refusals, one bare specifier comes to from one directory. */
interface BareTargets {
  readonly files: ReadonlyArray<string>
  readonly unpinnable: ReadonlyArray<string>
}

/**
 * The project files a bare specifier can load from `directory`, by every
 * mapping a loader honours, and what could not be followed.
 *
 * A `#` specifier is a package.json `imports` key, resolved against the
 * nearest package.json the way Node and Bun do. Any other bare specifier is
 * checked against the `paths` and `baseUrl` of EVERY tsconfig.json and
 * jsconfig.json above the importer, followed through `extends`: which one a
 * loader consults differs between loaders, and pinning a file a loader would
 * not have picked costs an approval, never a hole. A candidate that is not a
 * file is dropped, which is how `"*": ["./*"]` leaves `effect` to the
 * installed package. A specifier naming the nearest package.json's own `name`
 * is a self-import through `exports`, which this walk does not follow.
 */
const bareTargets = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  specifier: string,
  configs: Map<string, Record<string, unknown> | undefined>
): Effect.Effect<BareTargets> =>
  Effect.gen(function*() {
    // A config that is missing, unreadable or not a JSON object is no config.
    const readConfig = (file: string) =>
      Effect.gen(function*() {
        if (configs.has(file)) return configs.get(file)
        const bytes = yield* Effect.result(fs.readFile(file))
        const parsed = bytes._tag === "Success" ? parseJsonc(new TextDecoder().decode(bytes.success)) : undefined
        configs.set(file, parsed)
        return parsed
      })
    const ancestors: Array<string> = []
    for (let current = path.resolve(directory);;) {
      ancestors.push(current)
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    let nearestPackage: { readonly directory: string; readonly json: Record<string, unknown> } | undefined
    for (const candidate of ancestors) {
      const json = yield* readConfig(path.join(candidate, "package.json"))
      if (json === undefined) continue
      nearestPackage = { directory: candidate, json }
      break
    }
    const files: Array<string> = []
    const unpinnable: Array<string> = []

    if (specifier.startsWith("#")) {
      let matched = false
      for (const [key, target] of Object.entries(objectField(nearestPackage?.json, "imports") ?? {})) {
        const star = matchPattern(key, specifier)
        if (star === undefined) continue
        matched = true
        for (const leaf of targetLeaves(target)) {
          if (leaf.startsWith("./")) files.push(path.resolve(nearestPackage!.directory, leaf.replaceAll("*", star)))
          else unpinnable.push(`"${specifier}" maps to "${leaf}", which the pin does not follow`)
        }
      }
      if (!matched) unpinnable.push(`"${specifier}" names no package.json "imports" entry the pin can follow`)
      return { files, unpinnable }
    }

    const name = nearestPackage?.json["name"]
    if (name === packageName(specifier) && nearestPackage?.json["exports"] !== undefined) {
      unpinnable.push(
        `"${specifier}" imports the flow's own package through its "exports", which the pin does not follow`
      )
    }

    // One config's effective `paths` and `baseUrl`, through `extends`. A
    // config that extends itself, however indirectly, stops at `seen`.
    interface Effective {
      readonly paths?: { readonly map: Record<string, unknown>; readonly base: string }
      readonly baseUrl?: string
    }
    const effective = (
      file: string,
      json: Record<string, unknown>,
      seen: ReadonlySet<string>
    ): Effect.Effect<Effective> =>
      Effect.gen(function*() {
        const here = path.dirname(file)
        let inherited: Effective = {}
        const extended = json["extends"]
        for (const parent of Array.isArray(extended) ? extended : [extended]) {
          if (typeof parent !== "string") continue
          const bases = parent.startsWith(".") || path.isAbsolute(parent)
            ? [path.resolve(here, parent)]
            : ancestors.map((dir) => path.join(dir, "node_modules", parent))
          const candidates = bases.flatMap((base) => [base, `${base}.json`, path.join(base, "tsconfig.json")])
          for (const candidate of candidates) {
            const parentJson = yield* readConfig(candidate)
            if (parentJson === undefined || seen.has(candidate)) continue
            inherited = { ...inherited, ...(yield* effective(candidate, parentJson, new Set([...seen, candidate]))) }
            break
          }
        }
        const options = objectField(json, "compilerOptions")
        const map = objectField(options, "paths")
        const baseUrl = options?.["baseUrl"]
        return {
          ...inherited,
          ...(typeof baseUrl === "string" ? { baseUrl: path.resolve(here, baseUrl) } : {}),
          ...(map === undefined ? {} : { paths: { map, base: here } })
        }
      })

    for (const candidate of ancestors) {
      for (const configName of ["tsconfig.json", "jsconfig.json"]) {
        const file = path.join(candidate, configName)
        const json = yield* readConfig(file)
        if (json === undefined) continue
        const { baseUrl, paths } = yield* effective(file, json, new Set([file]))
        if (paths !== undefined) {
          for (const [key, targets] of Object.entries(paths.map)) {
            const star = matchPattern(key, specifier)
            if (star === undefined || !Array.isArray(targets)) continue
            for (const target of targets) {
              if (typeof target === "string") {
                files.push(path.resolve(baseUrl ?? paths.base, target.replaceAll("*", star)))
              }
            }
          }
        }
        if (baseUrl !== undefined) files.push(path.resolve(baseUrl, specifier))
      }
    }
    return { files, unpinnable }
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
    readonly bare: ReadonlyArray<string>
  }>
  /** Parsed package.json, tsconfig.json and jsconfig.json files, by path. */
  readonly configs: Map<string, Record<string, unknown> | undefined>
  /** What each bare specifier came to, keyed by importer directory and specifier. */
  readonly bare: Map<string, BareTargets>
}

/**
 * A fresh per-scan cache.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @private
 */
export const cache = (): Cache => ({ files: new Map(), configs: new Map(), bare: new Map() })

/** The record for a specifier nothing could be pinned for. */
const unpinnable = (description: string): ModuleImport => ({ path: description })

/**
 * Every module one entry reaches through relative specifiers and through the
 * loader mappings of bare ones ({@link bareTargets}), sorted by path.
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
    // A bare specifier is followed only when a loader maps it onto a project
    // file; the files it maps to are walked like relative ones, so a later
    // edit to the mapping or to the file is a changed closure.
    const followBare = (importer: string, from: string, specifiers: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        const directory = path.dirname(from)
        for (const specifier of specifiers) {
          const key = `${directory}\0${specifier}`
          const targets = memo.bare.get(key) ?? (yield* bareTargets(fs, path, directory, specifier, memo.configs))
          memo.bare.set(key, targets)
          for (const reason of targets.unpinnable) {
            const description = `${importer} imports ${reason}`
            found.set(description, unpinnable(description))
          }
          for (const file of targets.files) {
            if ((yield* resolve(fs, path, directory, file)) !== undefined) {
              pending.push({ from, directory, specifier: file })
            }
          }
        }
      })
    const { absolute, bare, opaque, relative } = specifiersOf(entrySource)
    if (opaque > 0) {
      found.set(
        normalizedEntryPath,
        unpinnable(`the entry computes the target of ${opaque} import() or require() call(s)`)
      )
    }
    reportAbsolute("the entry", absolute)
    enqueue(normalizedEntryPath, entryDirectory, relative)
    yield* followBare("the entry", normalizedEntryPath, bare)

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
        yield* followBare(`"${recorded}"`, resolved, cached.bare)
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
        absolute: specifiers.absolute,
        bare: specifiers.bare
      })
      found.set(recorded, { path: recorded, contentDigest })
      enqueue(resolved, path.dirname(resolved), specifiers.relative)
      yield* followBare(`"${recorded}"`, resolved, specifiers.bare)
    }

    return [...found.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  })
