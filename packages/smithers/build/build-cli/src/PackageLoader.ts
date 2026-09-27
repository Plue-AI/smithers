/**
 * Trusted PACKAGE.ts / WORKSPACE.ts evaluation through tsx.
 *
 * One command evaluates one module instance per declaration file: every
 * discovered file is imported through a single generated entry module, so a
 * Package imported by three siblings and by the loader itself is one
 * namespace and its targets keep one identity — which is what lets one
 * target carry exactly one label.
 *
 * Before anything evaluates, a static import scan walks the transitive
 * relative-import closure of every PACKAGE.ts — helper modules included — so
 * a cycle routed through a helper still fails as `package_import_cycle` with
 * the full chain, a helper importing WORKSPACE.ts still fails the one-way
 * rule, and the per-process load cache re-keys when a helper changes. The
 * scan is lexical but comment- and string-aware; a specifier mentioned in a
 * comment never creates an edge. A specifier whose resolution names a
 * discovered PACKAGE.ts under different case is fatal: on a case-insensitive
 * filesystem it would evaluate a second module instance of the same physical
 * file and split one target identity in two.
 *
 * ## Trust boundary
 *
 * A PACKAGE.ts is executable TypeScript evaluated in this process, exactly
 * as trusted as the repository's own code. See `Workspace.importNamespace`
 * for the full statement; it applies unchanged here.
 *
 * @since 0.1.0
 */

import { Smithers } from "@smthrs/targets"
import * as Package from "@smthrs/targets/Package"
import * as SafeFs from "@smthrs/targets/SafeFs"
import * as Target from "@smthrs/targets/Target"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { pathToFileURL } from "node:url"
import * as Diagnostic from "./Diagnostic.ts"
import { importDeclarationModule } from "./effect-resolution.js"
import { type LoadedFactory, validateFactoryModule } from "./FactoryLoader.ts"
import { assertDeclarationDependencies } from "./internal/DeclarationDependencies.ts"
import { byCodeUnit, posix } from "./internal/Text.ts"
import type { Discovery } from "./PackageDiscovery.ts"
import { PackageError } from "./PackageError.ts"
import { validateWorkspaceModule } from "./WorkspaceLoader.ts"

/**
 * One evaluated, validated PACKAGE.ts module.
 *
 * @category models
 * @since 0.1.0
 */
export interface LoadedPackage {
  /** The workspace-relative module path, for example `src/PACKAGE.ts`. */
  readonly file: string
  /** The package path the file's directory derives, `""` for the root. */
  readonly packagePath: string
  /** The validated Package value. */
  readonly value: Package.PackageValue
}

/**
 * One command's evaluated declaration graph.
 *
 * @category models
 * @since 0.1.0
 */
export interface LoadedGraph {
  readonly root: string
  readonly workspace: WorkspaceDeclaration.WorkspaceDeclaration
  /** The factory declared beside the workspace, when `FACTORY.ts` exists. */
  readonly factory: LoadedFactory | undefined
  readonly packages: ReadonlyArray<LoadedPackage>
}

const packagePathOf = (file: string): string => {
  const directory = posix(NodePath.dirname(file))
  return directory === "." ? "" : directory
}

/**
 * Extracts the import specifiers a declaration module names.
 *
 * The scan is lexical but comment- and string-aware: it walks the source
 * once, skips line and block comments, template literals, and regular
 * expression literals, and records a string literal only when the token
 * immediately before it is the keyword `from` or `import`. A specifier
 * mentioned inside a comment or an ordinary string therefore never creates
 * an edge. It is still not a full parser: dynamic `import(...)` expressions
 * are out of scope for declaration modules, exactly as before.
 */
const importSpecifiers = (source: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  const length = source.length
  let index = 0
  /** The identifier most recently completed; "" after any punctuation. */
  let lastWord = ""
  /** The last significant character, for the regex-position heuristic. */
  let lastSignificant = ""
  const wordChar = /[A-Za-z0-9_$]/
  while (index < length) {
    const char = source[index]!
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index)
      index = end === -1 ? length : end + 1
      continue
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2)
      index = end === -1 ? length : end + 2
      continue
    }
    if (char === "\"" || char === "'") {
      index += 1
      let value = ""
      let closed = false
      while (index < length) {
        const c = source[index]!
        if (c === "\\") {
          value += source.slice(index, index + 2)
          index += 2
          continue
        }
        if (c === char) {
          index += 1
          closed = true
          break
        }
        if (c === "\n") break
        value += c
        index += 1
      }
      if (closed && value !== "" && (lastWord === "from" || lastWord === "import")) found.push(value)
      lastWord = ""
      lastSignificant = char
      continue
    }
    if (char === "`") {
      index += 1
      let depth = 0
      while (index < length) {
        const c = source[index]!
        if (c === "\\") {
          index += 2
          continue
        }
        if (depth === 0 && c === "`") {
          index += 1
          break
        }
        if (c === "$" && source[index + 1] === "{") {
          depth += 1
          index += 2
          continue
        }
        if (depth > 0 && c === "}") depth -= 1
        index += 1
      }
      lastWord = ""
      lastSignificant = "`"
      continue
    }
    if (char === "/") {
      const regexPosition = lastSignificant === "" ||
        "=([{,;:!&|?+-*%<>~^".includes(lastSignificant) ||
        regexKeywords.has(lastWord)
      if (regexPosition) {
        index += 1
        let inClass = false
        while (index < length) {
          const c = source[index]!
          if (c === "\\") {
            index += 2
            continue
          }
          if (c === "[") inClass = true
          else if (c === "]") inClass = false
          else if (c === "/" && !inClass) {
            index += 1
            break
          } else if (c === "\n") break
          index += 1
        }
      } else {
        index += 1
      }
      lastWord = ""
      lastSignificant = "/"
      continue
    }
    if (wordChar.test(char)) {
      let end = index + 1
      while (end < length && wordChar.test(source[end]!)) end += 1
      lastWord = source.slice(index, end)
      lastSignificant = source[end - 1]!
      index = end
      continue
    }
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      index += 1
      continue
    }
    lastWord = ""
    lastSignificant = char
    index += 1
  }
  return found
}

/** Words after which a `/` starts a regular expression, not a division. */
const regexKeywords: ReadonlySet<string> = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "instanceof",
  "do",
  "else",
  "yield",
  "await"
])

/** Resolves one relative specifier to a workspace-relative posix path. */
const resolveRelative = (file: string, specifier: string): string => {
  const joined = posix(NodePath.normalize(NodePath.join(NodePath.dirname(file), specifier)))
  return joined === "." ? "" : joined
}

/**
 * The on-disk files a NodeNext specifier may resolve to, in tsx's order: the
 * `.ts` sibling first, the literal file second. A specifier without a
 * scannable extension (JSON, assets) resolves to nothing here; the real
 * import fails loudly if it is genuinely broken.
 */
const moduleCandidates = (resolved: string): ReadonlyArray<string> => {
  if (resolved.endsWith(".js")) return [`${resolved.slice(0, -3)}.ts`, resolved]
  if (resolved.endsWith(".mjs")) return [`${resolved.slice(0, -4)}.mts`, resolved]
  if (resolved.endsWith(".cjs")) return [`${resolved.slice(0, -4)}.cts`, resolved]
  if (resolved.endsWith(".ts") || resolved.endsWith(".mts") || resolved.endsWith(".cts")) return [resolved]
  return []
}

interface StaticScan {
  /** module file -> imported module files, over the whole scanned closure */
  readonly edges: ReadonlyMap<string, ReadonlyArray<string>>
  /** Every scanned module file — declaration files plus helpers — sorted. */
  readonly files: ReadonlyArray<string>
}

/**
 * Scans the transitive relative-import closure of every PACKAGE.ts, then the
 * WORKSPACE.ts closure.
 *
 * The Package pass enforces containment, the one-way WORKSPACE rule, and
 * exact-case specifiers for discovered PACKAGE.ts files. The workspace pass
 * collects files for the graph digest only — WORKSPACE.ts may import
 * Packages and its own siblings freely — but the exact-case rule still
 * applies, because a case-mismatched Package import would split target
 * identity no matter who wrote it.
 */
const scanImports = async (discovery: Discovery): Promise<StaticScan> => {
  const packageSet = new Set(discovery.packageFiles)
  const foldedPackages = new Map<string, string>()
  for (const file of discovery.packageFiles) foldedPackages.set(file.toLowerCase(), file)
  const edges = new Map<string, ReadonlyArray<string>>()
  const scanned = new Set<string>()
  const texts = new Map<string, string | undefined>()
  const readModule = async (file: string): Promise<string | undefined> => {
    if (texts.has(file)) return texts.get(file)
    const text = await SafeFs.readText(NodePath.join(discovery.root, file), {
      root: discovery.root,
      what: file,
      maximumBytes: SafeFs.maximumTextBytes
    })
    texts.set(file, text)
    return text
  }
  const scanPass = async (
    roots: ReadonlyArray<string>,
    rules: { readonly contained: boolean; readonly workspaceOneWay: boolean }
  ): Promise<void> => {
    const queue = [...roots]
    while (queue.length > 0) {
      const file = queue.shift()!
      if (scanned.has(file)) continue
      scanned.add(file)
      const text = await readModule(file)
      if (text === undefined) {
        if (packageSet.has(file)) {
          throw new PackageError("module_missing", "PACKAGE.ts disappeared before it was scanned", { path: file })
        }
        continue
      }
      const found: Array<string> = []
      for (const specifier of importSpecifiers(text)) {
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue
        const resolved = resolveRelative(file, specifier)
        if (resolved.startsWith("../") || NodePath.isAbsolute(resolved)) {
          if (!rules.contained) continue
          throw new PackageError(
            "module_outside_workspace",
            `a relative import leaves the workspace: ${JSON.stringify(specifier)}`,
            { path: file }
          )
        }
        const basename = resolved.split("/").at(-1) ?? ""
        if (basename === "WORKSPACE.ts" || basename === "WORKSPACE.js") {
          if (!rules.workspaceOneWay) continue
          throw new PackageError(
            "unsupported_module_specifier",
            "a module reachable from a Package imports WORKSPACE.ts; the dependency is one-way — only WORKSPACE.ts may import Packages",
            { path: file }
          )
        }
        for (const candidate of moduleCandidates(resolved)) {
          const exact = foldedPackages.get(candidate.toLowerCase())
          if (exact !== undefined) {
            if (exact !== candidate) {
              throw new PackageError(
                "case_collision",
                `import ${JSON.stringify(specifier)} resolves to ${exact} under different case (${candidate}); ` +
                  "a case-mismatched specifier would evaluate a second instance of the module",
                { path: file }
              )
            }
            found.push(exact)
            queue.push(exact)
            break
          }
          if (await readModule(candidate) !== undefined) {
            found.push(candidate)
            queue.push(candidate)
            break
          }
        }
      }
      edges.set(file, found)
    }
  }
  await scanPass(discovery.packageFiles, { contained: true, workspaceOneWay: true })
  await scanPass([discovery.workspaceFile], { contained: false, workspaceOneWay: false })
  if (discovery.factoryFile !== undefined) {
    await scanPass([discovery.factoryFile], { contained: true, workspaceOneWay: false })
    checkFactoryImports(discovery, edges)
  }
  return { edges, files: [...scanned].sort(byCodeUnit) }
}

/**
 * Fails when FACTORY.ts reaches a PACKAGE.ts through its own imports. The
 * walk stops at WORKSPACE.ts, which may import Packages for git hooks: the
 * factory names its targets by label, and the one-way rule is between the
 * factory and every Package, not between the factory and the workspace.
 */
const checkFactoryImports = (discovery: Discovery, edges: ReadonlyMap<string, ReadonlyArray<string>>): void => {
  const packageSet = new Set(discovery.packageFiles)
  const seen = new Set<string>()
  const stack: Array<Array<string>> = [[discovery.factoryFile!]]
  while (stack.length > 0) {
    const chain = stack.pop()!
    const file = chain.at(-1)!
    if (seen.has(file)) continue
    seen.add(file)
    for (const next of edges.get(file) ?? []) {
      if (next === discovery.workspaceFile) continue
      const nextChain = [...chain, next]
      if (packageSet.has(next) || (next.split("/").at(-1) ?? "") === "PACKAGE.ts") {
        throw new PackageError(
          "factory_imports_package",
          `FACTORY.ts imports a PACKAGE.ts; a factory names the targets it needs by label, S.label("//pkg:name"), never by import`,
          { path: discovery.factoryFile, chain: nextChain }
        )
      }
      stack.push(nextChain)
    }
  }
}

/**
 * Fails on the first import cycle that passes through a PACKAGE.ts, with the
 * full module chain — helper modules included. A cycle among helper modules
 * alone is legal ESM and is left to the module system.
 */
const checkCycles = (scan: StaticScan, files: ReadonlyArray<string>): void => {
  const packageSet = new Set(files)
  const visiting = new Set<string>()
  const done = new Set<string>()
  const stack: Array<string> = []
  const visit = (file: string): void => {
    if (done.has(file)) return
    if (visiting.has(file)) {
      const start = stack.indexOf(file)
      const chain = [...stack.slice(start), file]
      if (chain.some((entry) => packageSet.has(entry))) {
        throw new PackageError("package_import_cycle", "Package modules import each other in a cycle", {
          path: file,
          chain
        })
      }
      return
    }
    visiting.add(file)
    stack.push(file)
    for (const next of scan.edges.get(file) ?? []) visit(next)
    stack.pop()
    visiting.delete(file)
    done.add(file)
  }
  for (const file of files) visit(file)
}

/**
 * Digests every scanned module file — declaration files and the helpers they
 * import — so any edit re-keys the whole load.
 */
const graphDigest = async (discovery: Discovery, scannedFiles: ReadonlyArray<string>): Promise<string> => {
  const files = new Set<string>([discovery.workspaceFile, ...scannedFiles])
  // Sibling .smithers modules (agents.ts, sandbox.ts) load transitively from
  // WORKSPACE.ts; digest them even when unimported so editing one re-keys
  // the load.
  try {
    const siblings = await Fs.readdir(NodePath.join(discovery.root, ".smithers"))
    for (const name of siblings.sort()) {
      if (name.endsWith(".ts") && name !== "WORKSPACE.ts") files.add(`.smithers/${name}`)
    }
  } catch {
    // No .smithers directory: the root WORKSPACE.ts fallback is in use.
  }
  const digests: Array<string> = []
  for (const repository of discovery.repositories) {
    digests.push(`repo\0${repository.name}\0${repository.path}`)
  }
  for (const pruned of discovery.pruned) digests.push(`pruned\0${pruned}`)
  for (const file of [...files].sort(byCodeUnit)) {
    const digest = await SafeFs.digestFile(NodePath.join(discovery.root, file), { what: file })
    digests.push(`${file}\0${digest ?? "absent"}`)
  }
  return createHash("sha256").update(digests.join("\n")).digest("hex")
}

const loads = new Map<string, Promise<LoadedGraph>>()

/** One probed cache directory per workspace descriptor, per process. */
const probes = new Map<string, Promise<string | undefined>>()

const validatePackageModule = (namespace: unknown, file: string): Package.PackageValue => {
  if (typeof namespace !== "object" || namespace === null) {
    throw new PackageError("module_import_failed", "PACKAGE.ts did not evaluate to a module namespace", { path: file })
  }
  let value: Package.PackageValue | undefined
  for (const [name, exported] of Object.entries(namespace)) {
    if (Package.isPackage(exported)) {
      if (name !== "Package") {
        throw new PackageError(
          "invalid_package_export",
          `a Package value is exported as ${JSON.stringify(name)}; the one legal export name is Package`,
          { path: file }
        )
      }
      if (value !== undefined) {
        throw new PackageError("invalid_package_export", "PACKAGE.ts exports more than one Package value", {
          path: file
        })
      }
      value = exported
      continue
    }
    if (name === "Package") {
      throw new PackageError("invalid_package_export", "the Package export is not an S.Package value", { path: file })
    }
    if (Target.isTarget(exported)) {
      throw new PackageError(
        "naked_target_export",
        `PACKAGE.ts exports a naked target ${
          JSON.stringify(name)
        }; a target is addressable only through the Package map`,
        { path: file }
      )
    }
  }
  if (value === undefined) {
    throw new PackageError("package_export_missing", "PACKAGE.ts has no Package export", { path: file })
  }
  return value
}

const undefinedRead = /Cannot read properties of undefined \(reading '([^']+)'\)/

/**
 * The capitalized members the `Smithers` surface exports: the namespaces and
 * rule constructors a PACKAGE.ts reaches through `S.`.
 */
const surfaceNamespaces = (): string => Object.keys(Smithers).filter((key) => /^[A-Z]/.test(key)).sort().join(", ")

/**
 * A declaration that names a namespace this surface lacks (`S.Go.Test(...)`)
 * fails as a property read off `undefined`, which names the member but not
 * the missing namespace. Append what the surface does export so the author
 * sees the gap instead of a bare JavaScript TypeError.
 */
const undefinedNamespaceHint = (message: string): string => {
  const match = undefinedRead.exec(message)
  if (match === null) return message
  return `${message}; a declaration read .${match[1]} off undefined. ` +
    `If that value is S.<Name>, this loader exports no such namespace; it exports: ${surfaceNamespaces()}`
}

const importGraph = async (discovery: Discovery): Promise<LoadedGraph> => {
  const entryDirectory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-package-entry-"))
  const lines: Array<string> = []
  const bindings: Array<string> = []
  const workspaceUrl = pathToFileURL(NodePath.join(discovery.root, discovery.workspaceFile)).href
  lines.push(`import * as workspaceModule from ${JSON.stringify(workspaceUrl)}`)
  if (discovery.factoryFile !== undefined) {
    const factoryUrl = pathToFileURL(NodePath.join(discovery.root, discovery.factoryFile)).href
    lines.push(`import * as factoryModule from ${JSON.stringify(factoryUrl)}`)
    lines.push(`export const factory = factoryModule`)
  } else {
    lines.push(`export const factory = undefined`)
  }
  discovery.packageFiles.forEach((file, index) => {
    const url = pathToFileURL(NodePath.join(discovery.root, file)).href
    lines.push(`import * as p${index} from ${JSON.stringify(url)}`)
    bindings.push(`[${JSON.stringify(file)}, p${index}]`)
  })
  lines.push(`export const workspace = workspaceModule`)
  lines.push(`export const packages = [${bindings.join(", ")}]`)
  const entryPath = NodePath.join(entryDirectory, "entry.mjs")
  await Fs.writeFile(entryPath, `${lines.join("\n")}\n`, "utf8")
  let entry: {
    readonly workspace: unknown
    readonly factory: unknown
    readonly packages: ReadonlyArray<readonly [string, unknown]>
  }
  try {
    entry = await importDeclarationModule(pathToFileURL(entryPath).href, import.meta.url) as typeof entry
  } catch (cause) {
    if (cause instanceof PackageError) throw cause
    // The cause's own message carries what the author needs — a rejected
    // declaration names its PACKAGE.ts path, line, and the failing attr —
    // so fold it in rather than blaming WORKSPACE.ts for every failure.
    throw new PackageError(
      "module_import_failed",
      `evaluating the workspace's declaration modules failed: ${undefinedNamespaceHint(Diagnostic.describe(cause))}`,
      { cause }
    )
  } finally {
    // The entry module is evaluated and held by the module registry; the
    // file has no further reader. Every CLI invocation loads a graph, so
    // leaving the directory behind is one leaked temp dir per command.
    await Fs.rm(entryDirectory, { recursive: true, force: true })
  }
  const workspace = validateWorkspaceModule(entry.workspace, discovery.workspaceFile)
  const factory = discovery.factoryFile === undefined
    ? undefined
    : validateFactoryModule(entry.factory, discovery.factoryFile)
  const packages: Array<LoadedPackage> = []
  for (const [file, namespace] of entry.packages) {
    packages.push({
      file,
      packagePath: packagePathOf(file),
      value: validatePackageModule(namespace, file)
    })
  }
  return { root: discovery.root, workspace, factory, packages }
}

/**
 * Evaluates and validates every discovered declaration module, once per
 * content digest per process. The digest covers the transitive
 * relative-import closure — helper modules included — so editing any module
 * a PACKAGE.ts imports re-keys the load.
 *
 * @category loading
 * @since 0.1.0
 */
export const load = async (discovery: Discovery): Promise<LoadedGraph> => {
  const scan = await scanImports(discovery)
  checkCycles(scan, discovery.packageFiles)
  assertDeclarationDependencies(scan.files.map((file) => NodePath.join(discovery.root, file)), { bootstrap: true })
  const digest = await graphDigest(discovery, scan.files)
  const key = `${discovery.root}\0${digest}`
  const existing = loads.get(key)
  if (existing !== undefined) return existing
  const loaded = importGraph(discovery)
  loads.set(key, loaded)
  // A failed load must not pin its rejection for the process lifetime: the
  // next command re-evaluates after the author fixes the file.
  loaded.catch(() => loads.delete(key))
  return loaded
}

/**
 * Evaluates only WORKSPACE.ts (with its own imports) and returns the
 * validated declaration, so discovery can read the two boundaries it bounds
 * itself with — the cache directory and the child repositories — before the
 * package walk.
 *
 * Every failure rejects: a typed `PackageError` from the scan or from the
 * declaration itself passes through untouched, and anything else is wrapped
 * as `module_import_failed` naming the workspace file. Nothing here resolves
 * to undefined, and this function keeps no memo of its own, so every call
 * re-evaluates the module.
 *
 * ## Evaluation lifetime
 *
 * Each call evaluates the workspace in a fresh tsx namespace, separate from
 * the one {@link load} uses. The full graph evaluates the workspace again,
 * with its packages sharing that graph's namespace, so target identity always
 * comes from the one real load and the namespace this call evaluates is
 * discarded once the declaration validates.
 *
 * @category loading
 * @since 0.1.0
 */
export const loadWorkspaceDeclaration = async (
  root: string,
  workspaceFile: string
): Promise<WorkspaceDeclaration.WorkspaceDeclaration> => {
  let namespace: unknown
  try {
    const canonicalRoot = await Fs.realpath(root)
    const scan = await scanImports({
      root: canonicalRoot,
      workspaceFile,
      packageFiles: [],
      cacheDirectory: "",
      repositories: [],
      pruned: [],
      directories: 0
    })
    assertDeclarationDependencies(scan.files.map((file) => NodePath.join(canonicalRoot, file)), { bootstrap: true })
    namespace = await importDeclarationModule(
      pathToFileURL(NodePath.join(root, workspaceFile)).href,
      import.meta.url
    )
  } catch (cause) {
    if (cause instanceof PackageError) throw cause
    throw new PackageError(
      "module_import_failed",
      `evaluating the workspace declaration failed: ${undefinedNamespaceHint(Diagnostic.describe(cause))}`,
      { path: workspaceFile, cause }
    )
  }
  return validateWorkspaceModule(namespace, workspaceFile)
}

/**
 * Reads the declared cache directory off the workspace declaration, so the
 * package walk can prune it before it lists anything.
 *
 * The probe is deliberately forgiving: any failure returns undefined and the
 * full load reports the real diagnostic. The memo below avoids repeating the
 * probe within one process; it does not invalidate module caches, and it
 * holds the probe alone — {@link loadWorkspaceDeclaration} above is
 * unmemoized.
 *
 * @category loading
 * @since 0.1.0
 */
export const probeCacheDirectory = (root: string, workspaceFile: string): Promise<string | undefined> => {
  const key = `${root}\0${workspaceFile}`
  const existing = probes.get(key)
  if (existing !== undefined) return existing
  const probed = loadWorkspaceDeclaration(root, workspaceFile).then(
    (workspace) => workspace.cache.directory,
    () => undefined
  )
  probes.set(key, probed)
  return probed
}
