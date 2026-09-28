/** Deployment recipe for one pinned public invocation. The native runtime owns every graph and receipt. */
import type * as Evaluator from "@smthrs/model/Evaluator"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, FileSystem, Layer } from "effect"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"

export interface Options {
  readonly root: string
  readonly stateRoot: string
  readonly flow: string
  readonly sourceDigest: string
  readonly credential: string
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator>
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

type Measured = { readonly path: string; readonly contentDigest?: string | undefined }

const byPath = (modules: ReadonlyArray<Measured>) =>
  [...modules].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/**
 * The pinned identity of `flows/<name>/flow.ts`: SHA-256 over the entry bytes,
 * then `\0<path>\0<sha256>` for each module the entry loads from beside itself
 * (POSIX path relative to the entry's directory), then
 * `\0config\0<name>\0<sha256>` for each resolver file at the repository root
 * ({@link resolverFiles}), each group sorted by path. A flow with neither pins
 * `sha256(flow.ts)`. `undefined` when a module cannot be measured.
 */
export const sourceDigest = (
  entry: Uint8Array,
  imports: ReadonlyArray<Measured>,
  configuration: ReadonlyArray<Measured> = []
): string | undefined => {
  const hash = createHash("sha256").update(entry)
  for (const module of byPath(imports)) {
    if (module.contentDigest === undefined) return undefined
    hash.update(`\0${module.path}\0${module.contentDigest}`)
  }
  for (const file of byPath(configuration)) {
    if (file.contentDigest === undefined) return undefined
    hash.update(`\0config\0${file.path}\0${file.contentDigest}`)
  }
  return hash.digest("hex")
}

/** Files that change how Bun resolves a bare specifier from a directory. */
export const resolverFiles = ["tsconfig.json", "jsconfig.json", "package.json", "bunfig.toml"] as const

/**
 * A root package.json redirects a non-relative specifier into unmeasured
 * repository code through `imports` (`#alias`) or a `name` + `exports`
 * self-reference. Unparseable bytes are refused rather than guessed at.
 */
const redirectsSpecifiers = (bytes: Uint8Array): boolean => {
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof json !== "object" || json === null || Array.isArray(json)) return true
    return "imports" in json || ("name" in json && "exports" in json)
  } catch {
    return true
  }
}

/**
 * Every non-relative specifier must reach the host's pinned libraries, never
 * repository code. Bun and Node resolve one through tsconfig/jsconfig `paths`
 * and `baseUrl`, package.json `imports` and self-reference, and every
 * `node_modules` from the importing file up. Below the root none may exist
 * beside the flow or its closure; root/node_modules may hold only the pinned
 * library links; root resolver files are pinned by content and refused when
 * they `extends`, map `paths`, set `baseUrl`, declare `imports`, or name
 * themselves with `exports`.
 */
const resolverConfiguration = (
  root: string,
  stateRoot: string,
  entryDirectory: string,
  imports: ReadonlyArray<Measured>
): ReadonlyArray<Measured> => {
  const refuse = (path: string) => {
    throw new Error(`Invocation refuses repository resolver configuration at ${relative(root, path) || "."}`)
  }
  const directories = new Set<string>()
  for (const module of [{ path: "flow.ts" }, ...imports]) {
    const directory = dirname(resolve(entryDirectory, module.path))
    if (directory !== root && !directory.startsWith(root + sep)) refuse(directory)
    for (let current = directory; current !== root; current = dirname(current)) directories.add(current)
  }
  for (const directory of directories) {
    for (const name of [...resolverFiles, "node_modules"]) {
      if (existsSync(join(directory, name))) refuse(join(directory, name))
    }
  }
  const libraries = realpathSync(join(stateRoot, "libraries")) + sep
  const modules = join(root, "node_modules")
  for (const name of existsSync(modules) ? readdirSync(modules) : []) {
    const entries = name.startsWith("@") ? readdirSync(join(modules, name)).map((child) => join(name, child)) : [name]
    for (const entry of entries) {
      if (!realpathSync(join(modules, entry)).startsWith(libraries)) refuse(join(modules, entry))
    }
  }
  return resolverFiles.flatMap((name) => {
    const path = join(root, name)
    if (!existsSync(path)) return []
    const bytes = readFileSync(path)
    if (name.endsWith("config.json") && /extends|paths|baseUrl|\\u/.test(bytes.toString("utf8"))) refuse(path)
    if (name === "package.json" && redirectsSpecifiers(bytes)) refuse(path)
    return [{ path: name, contentDigest: sha256(bytes) }]
  })
}

export const layer = (platform: NativeControl.Platform, options: Options) => {
  const root = resolve(options.root), stateRoot = resolve(options.stateRoot)
  if (
    !options.credential || !/^[a-f0-9]{64}$/.test(options.sourceDigest) || !options.flow ||
    options.flow.split("/").some((part) => !part || part.startsWith(".") || part.includes("\\")) ||
    stateRoot === root || stateRoot.startsWith(root + sep)
  ) throw new Error("Invalid pinned invocation host identity")
  const native = NativeControl.make(platform)
  const registry = native.layerRegistry(root)
  return Layer.unwrap(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const source = yield* fs.readFile(resolve(root, "flows", options.flow, "flow.ts"))
      // Measure from static discovery before anything is imported, then load
      // only this flow: the catalog imports every descriptor it is given, and a
      // neighbouring flow's top-level code would run beside the credential.
      const modules = Layer.unwrap(
        Effect.gen(function*() {
          const all = yield* Registry.Registry
          const descriptor = (yield* all.list()).find((entry) => entry.name === options.flow)
          const body = descriptor?.body
          if (body?._tag !== "Module" || body.contentDigest !== sha256(source)) {
            throw new Error("Pinned invocation source changed")
          }
          // The pin measures the entry, its relative-import closure (which the
          // registry re-measures before import), and the root resolver files.
          // Resolver configuration anywhere else on the closure's path is refused.
          const imports = body.imports ?? []
          const configuration = resolverConfiguration(root, stateRoot, resolve(root, "flows", options.flow), imports)
          if (sourceDigest(source, imports, configuration) !== options.sourceDigest) {
            throw new Error("Pinned invocation source changed")
          }
          const built = yield* Executable.catalog({ delegates: [] }).pipe(
            Effect.provideService(Registry.Registry, { ...all, list: () => Effect.succeed([descriptor!]) }),
            Effect.provideService(FileSystem.FileSystem, fs)
          )
          const target = built.executables.find((entry) => entry.descriptor.name === options.flow)
          if (target === undefined) {
            throw new Error("Invocation requires an executable canonical Flow.make declaration", {
              cause: built.refused.find((entry) => entry.flow === options.flow)
            })
          }
          // A tag other than the path would register this body under another name.
          if (target.declaredTag !== options.flow) {
            throw new Error("Invocation Flow.make tag must match its flows/<name>/flow.ts path")
          }
          return Layer.mergeAll(
            Executable.layerRefreshable(built, { delegates: [], refreshable: () => false }),
            target.layer
          )
        })
      ).pipe(Layer.orDie)
      // Authenticated gateway identity is the only approver. Native module
      // authority restores the approved envelope on every resumed handler.
      return native.layerHost(
        {
          root,
          stateRoot,
          credential: options.credential,
          approvalAuthority: native.gatewayApprovalAuthority,
          evaluator: options.evaluator
        },
        modules,
        registry
      )
    }).pipe(Effect.provide(platform.host))
  )
}
