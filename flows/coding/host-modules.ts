/**
 * The modules a repository's file flows share with the packaged coding host.
 *
 * A file flow (`flows/<name>/flow.ts`) imports `effect` and `@smthrs/*`
 * packages, and the host decodes what that flow declared with its own copies.
 * Two physical copies disagree: Schema's private sentinels are compared by
 * identity, so a foreign `Schema.String` decodes a string as a symbol and the
 * run fails with `SchemaError: Expected string at ["exit"]["value"]` (#2197).
 * `@smthrs/plan` keeps each node's continuation in a module-level table, and
 * `instanceof` checks on errors the host builds fail across copies.
 *
 * `build.mjs` replaces this map in the packaged host with every public entry
 * point of `effect` and of the workspace `@smthrs` packages that the bundle
 * already contains (host-modules-build.mjs), and {@link share} makes a bare
 * import of one of them resolve there. That includes the coding package's own
 * step flows, `@smthrs/coding` (`steps.ts`): a repository's copy of the `todo`
 * composition imports its steps from there and runs the host's. Run from
 * source, the host and a flow already resolve one installation, so the map is
 * empty and nothing is registered.
 */
import { readFileSync } from "node:fs"
import * as NodeModule from "node:module"
import { dirname, join } from "node:path"

/** Bare specifier → the host's own module namespace for it. */
export const modules: ReadonlyMap<string, object> = new Map()

const scheme = "smithers-host:"
const registry = Symbol.for("smithers/coding-host-modules")

const owners = new Map<string, string | undefined>()

/** The name in the nearest package.json above a file, cached per directory. */
const owner = (file: string): string | undefined => {
  const directory = dirname(file)
  if (owners.has(directory)) return owners.get(directory)
  let name: unknown
  try {
    name = (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: unknown }).name
  } catch {
    name = undefined
  }
  if (typeof name !== "string") name = directory === dirname(directory) ? undefined : owner(directory)
  owners.set(directory, name as string | undefined)
  return name as string | undefined
}

const packageOf = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")

/**
 * Serves each shared bare specifier from `supplied`, for every module the
 * process imports after this call. A package the host shares serves only its
 * bundled entry points: any other entry point of it is refused rather than
 * loaded as a second copy. `package.json` is data, never shared.
 */
export const share = (supplied: ReadonlyMap<string, object> = modules): void => {
  if (supplied.size === 0) return
  const packages = new Set([...supplied.keys()].map(packageOf))
  const refusal = (specifier: string) =>
    new Error(`The coding host does not provide "${specifier}"; import one of its public entry points`)
  const shared = (specifier: string) => packages.has(packageOf(specifier)) && !specifier.endsWith("/package.json")
  const bun = (globalThis as { Bun?: { plugin: (plugin: BunPlugin) => void } }).Bun
  if (bun !== undefined) {
    bun.plugin({
      name: "smithers-host-modules",
      setup(build) {
        for (const [specifier, namespace] of supplied) {
          build.module(specifier, () => ({ exports: namespace as Record<string, unknown>, loader: "object" }))
        }
        // Bun hands plugins the resolved file, not the specifier, so a
        // shared package is recognized by the package.json above the file.
        build.onResolve({ filter: /.*/ }, ({ path }) => {
          const name = path.endsWith("package.json") ? undefined : owner(path)
          if (name !== undefined && packages.has(name)) throw refusal(name)
          return undefined
        })
      }
    })
    return
  }
  if (typeof NodeModule.registerHooks !== "function") {
    throw new Error("The packaged coding host needs node:module registerHooks (Node 22.15 or newer)")
  }
  ;(globalThis as Record<symbol, unknown>)[registry] = supplied
  NodeModule.registerHooks({
    resolve: (specifier, context, nextResolve) => {
      if (!shared(specifier)) return nextResolve(specifier, context)
      if (!supplied.has(specifier)) throw refusal(specifier)
      return { url: scheme + specifier, format: "module", shortCircuit: true }
    },
    load: (url, context, nextLoad) => {
      if (!url.startsWith(scheme)) return nextLoad(url, context)
      const specifier = url.slice(scheme.length)
      const names = Object.keys(supplied.get(specifier)!)
      const source = [
        `const ns = globalThis[Symbol.for(${JSON.stringify(registry.description)})].get(${JSON.stringify(specifier)})`,
        ...names.map((name, index) => `const e${index} = ns[${JSON.stringify(name)}]`),
        `export { ${names.map((name, index) => `e${index} as ${JSON.stringify(name)}`).join(", ")} }`
      ].join("\n")
      return { format: "module", source, shortCircuit: true }
    }
  })
}

/** The part of Bun's runtime plugin API this module uses. */
interface BunPlugin {
  readonly name: string
  readonly setup: (build: {
    readonly module: (
      specifier: string,
      load: () => { readonly exports: Record<string, unknown>; readonly loader: "object" }
    ) => void
    readonly onResolve: (
      options: { readonly filter: RegExp },
      resolve: (args: { readonly path: string }) => undefined
    ) => void
  }) => void
}
