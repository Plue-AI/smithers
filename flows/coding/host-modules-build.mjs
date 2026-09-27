/**
 * Build-time half of host-modules.ts: which modules the packaged coding host
 * shares with a repository's file flows, and the module map that serves them.
 *
 * A shared entry point is a public specifier of `effect` or of a workspace
 * package whose file is already in the bundle, so sharing adds no module the
 * host does not run. A barrel (an index of re-exports) is composed from its
 * bundled members instead of imported whole: importing `effect`'s index as a
 * namespace would pull every module it names into the executable.
 */
import { readdir, readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, relative, resolve, sep } from "node:path"

const declaration = "export const modules: ReadonlyMap<string, object> = new Map()"

/** The one `effect` installation the bundle uses; two would be two runtimes. */
const effectRoot = (inputs) => {
  const roots = new Set()
  for (const file of inputs) {
    const match = /^(.*[\\/]effect)[\\/]dist[\\/]/.exec(file)
    if (match) roots.add(match[1])
  }
  if (roots.size !== 1) throw new Error(`The coding host must bundle one effect installation; found ${roots.size}`)
  return [...roots][0]
}

/** Every public specifier of the bundled effect installation, checked against its export map. */
const effectEntries = async (inputs) => {
  const root = effectRoot(inputs), dist = resolve(root, "dist")
  const self = createRequire(resolve(root, "package.json"))
  const entries = new Map()
  for (const found of (await readdir(dist, { recursive: true })).sort()) {
    const path = found.split(sep).join("/")
    if (!path.endsWith(".js")) continue
    const file = resolve(dist, found), name = path.slice(0, -3)
    const candidates = name === "index" ? ["effect"]
      : name.endsWith("/index") ? [`effect/${name.slice(0, -6)}`, `effect/${name}`]
      : [`effect/${name}`]
    for (const specifier of candidates) {
      try {
        if (self.resolve(specifier) === file) entries.set(specifier, file)
      } catch {
        // The export map keeps private implementation files private.
      }
    }
  }
  return entries
}

const statement =
  /^\s*export\s+(?:(type\s+)?\*\s+(?:as\s+([\w$]+)\s+)?from\s+["']([^"']+)["']|(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["'])\s*;?\s*$/

/** A barrel's re-exports, or undefined when the module has any code of its own. */
const barrel = (text) => {
  const body = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const parts = []
  for (const line of body.split(/;|\n/).map(value => value.trim()).filter(value => value !== "")) {
    const match = statement.exec(line)
    if (!match) return undefined
    const [, starType, alias, starFrom, listType, list, listFrom] = match
    if (starType || listType) continue
    // A re-export of another package is that package's own entry point.
    if (!/^\.\.?\//.test(starFrom ?? listFrom)) return undefined
    if (starFrom !== undefined) {
      parts.push(alias === undefined ? { kind: "star", from: starFrom } : { kind: "as", name: alias, from: starFrom })
      continue
    }
    for (const item of list.split(",").map(value => value.trim()).filter(value => value !== "" && !value.startsWith("type "))) {
      const [name, exported = name] = item.split(/\s+as\s+/)
      parts.push({ kind: "pick", name, exported, from: listFrom })
    }
  }
  return parts
}

/**
 * Replaces host-modules.ts's empty map with the bundle's shared entry points.
 * `inputs` are the absolute files of a probe build of the same entry;
 * `alias` maps each workspace package specifier to its source file and
 * `roots` each workspace package name to its directory. A package is shared
 * when the bundle runs any of its files; an entry point is served when its
 * module is bundled, or when it is a barrel over bundled modules.
 */
export const hostModulesSource = async (source, inputs, alias, roots) => {
  if (!source.includes(declaration)) throw new Error("host-modules.ts no longer declares its module map")
  const entries = await effectEntries(inputs)
  const bundled = (name) => [...inputs].some(file => file.startsWith(roots[name] + sep))
  for (const [specifier, file] of Object.entries(alias)) {
    const name = specifier.split("/").slice(0, 2).join("/")
    if (name.startsWith("@smthrs/") && !specifier.endsWith("/package.json") && bundled(name)) entries.set(specifier, file)
  }
  const lines = [], names = new Map()
  // Emits one module, a barrel after its members, and names it once. A
  // module the bundle does not run is not served.
  const emit = async (file) => {
    if (names.has(file)) return names.get(file)
    names.set(file, undefined)
    const parts = barrel(await readFile(file, "utf8"))
    if (parts === undefined) {
      if (!inputs.has(file)) return undefined
      const name = `shared${lines.length}`
      lines.push(`import * as ${name} from ${JSON.stringify(file)}`)
      names.set(file, name)
      return name
    }
    const members = []
    for (const part of parts) {
      const member = await emit(resolve(dirname(file), part.from))
      if (member === undefined) continue
      members.push(part.kind === "star" ? `...star(${member})`
        : part.kind === "as" ? `${JSON.stringify(part.name)}: ${member}`
        : `${JSON.stringify(part.exported)}: ${member}[${JSON.stringify(part.name)}]`)
    }
    if (members.length === 0) return undefined
    const name = `shared${lines.length}`
    lines.push(`const ${name} = Object.freeze({ ${members.join(", ")} })`)
    names.set(file, name)
    return name
  }
  const served = []
  for (const [specifier, file] of [...entries].sort(([left], [right]) => left < right ? -1 : 1)) {
    const name = await emit(file)
    if (name !== undefined) served.push(`[${JSON.stringify(specifier)}, ${name}]`)
  }
  // Imports hoist, so the declarations above read fully evaluated modules.
  return source.replace(declaration, [
    "const star = (namespace: object) => Object.fromEntries(Object.entries(namespace).filter(([key]) => key !== \"default\"))",
    ...lines,
    `export const modules: ReadonlyMap<string, object> = new Map<string, object>([${served.join(", ")}])`
  ].join("\n"))
}
