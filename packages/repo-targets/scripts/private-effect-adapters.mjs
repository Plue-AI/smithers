/** Private pinned platform adapters for distributions; Effect remains external. */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import ts from "typescript"

const names = new Set(["@effect/platform-node", "@effect/platform-node-shared", "@effect/platform-bun"])
const files = async (directory) => {
  const entries = new Map((await readdir(directory, { withFileTypes: true })).map((entry) => [entry.name, entry]))
  return (await Promise.all(
    [...entries.keys()].sort().map((name) =>
      entries.get(name).isDirectory()
        ? files(join(directory, name)) :
        [join(directory, name)]
    )
  )).flat()
}
const inside = (root, path) => {
  const part = relative(root, path)
  return part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part)
}
const specifier = (from, to) => {
  const path = relative(dirname(from), to).split(sep).join("/")
  return path.startsWith(".") ? path : "./" + path
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")

/** Returns the declared private adapter build inputs, never inferred runtime edges. */
export const privateEffectAdapters = (manifest) => {
  const declared = manifest.smthrs?.privateEffectAdapters
  if (declared === undefined) return []
  if (
    !Array.isArray(declared) || declared.some((name) => !names.has(name)) || new Set(declared).size !== declared.length
  ) {
    throw new Error("Invalid private Effect adapter declaration")
  }
  if (declared.length === 0) return []
  const version = manifest.dependencies?.effect ?? manifest.peerDependencies?.effect
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new Error("Private adapters require exact Effect identity")
  }
  if (!declared.includes("@effect/platform-node-shared")) {
    throw new Error("Private adapters require the pinned shared adapter")
  }
  for (const name of declared) {
    if (manifest.devDependencies?.[name] !== version) {
      throw new Error(`Private adapter build input must equal Effect: ${name}`)
    }
    for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      if (manifest[section]?.[name] !== undefined) {
        throw new Error(`Private adapter retains a published resolver edge: ${name}`)
      }
    }
  }
  return declared
}

const rewrite = (ts, text, transform) => {
  const source = ts.createSourceFile("module.ts", text, ts.ScriptTarget.Latest, true)
  const replacements = []
  const visit = (node) => {
    let literal
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal = node.argument.literal
    else if (ts.isCallExpression(node)) {
      const owner = node.expression.getText(source)
      if (
        owner === "import" || owner === "require" || owner === "import.meta.resolve" || owner === "require.resolve" ||
        owner === "__smthrsResolve"
      ) literal = node.arguments[0]
      else if (owner === "loadedModuleRoot") literal = node.arguments[1]
    }
    if (literal && ts.isStringLiteral(literal)) {
      const value = transform(literal.text, node)
      if (value !== literal.text) replacements.push([literal.getStart(source), literal.end, JSON.stringify(value)])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const [start, end, value] of replacements.sort((a, b) => b[0] - a[0])) {
    text = text.slice(0, start) + value + text.slice(end)
  }
  return text
}

const targetFor = (vendor, adapters, name, suffix) =>
  suffix === undefined
    ? join(vendor, name.slice("@effect/".length) + ".js")
    : join(vendor, adapters.get(name).key, suffix + ".js")

/** Relinks emitted JavaScript and declarations, leaving source-first imports intact. */
export const relocatePrivateAdapterImports = async (
  packageRoot,
  { distRoot = join(packageRoot, "dist"), directory = distRoot } = {}
) => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  const declared = privateEffectAdapters(manifest)
  if (declared.length === 0) return
  const vendor = join(distRoot, "vendor")
  const adapters = new Map(declared.map((name) => [name, { key: name.slice("@effect/platform-".length) }]))
  for (const file of await files(directory)) {
    if (inside(vendor, file) || !/\.(?:js|d\.ts)$/.test(file)) continue
    const text = await readFile(file, "utf8")
    const rewritten = rewrite(ts, text, (value, node) => {
      const name = declared.find((name) => value === name || value.startsWith(name + "/"))
      if (!name) return value
      const suffix = value === name ? undefined : value.slice(name.length + 1)
      const sourceRoot = ts.isCallExpression(node) && node.expression.getText() === "loadedModuleRoot"
      const branch = inside(join(distRoot, "cjs"), file) && !sourceRoot ? join(vendor, "cjs") : vendor
      const target = targetFor(branch, adapters, name, suffix)
      if (!inside(vendor, target) || suffix?.startsWith("internal/") || suffix === "index" || !existsSync(target)) {
        throw new Error(`Invalid private adapter module: ${value}`)
      }
      return specifier(file, target)
    })
    if (text !== rewritten) await writeFile(file, rewritten)
  }
}

/** Builds the exact adapter closure once per owner with shared ESM chunks. */
export const buildPrivateEffectAdapters = async (packageRoot, { distRoot = join(packageRoot, "dist") } = {}) => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  const declared = privateEffectAdapters(manifest)
  if (declared.length === 0) return
  const require = createRequire(join(packageRoot, "package.json")),
    { build } = require("esbuild")
  const vendor = join(distRoot, "vendor"), version = manifest.dependencies?.effect ?? manifest.peerDependencies.effect
  const adapters = new Map(), entryPoints = {}, inputs = [], notices = [], ordinary = new Map()
  for (const name of declared) {
    const path = await realpath(require.resolve(name + "/package.json")), root = dirname(path)
    const installed = JSON.parse(await readFile(path, "utf8"))
    if (installed.name !== name || installed.version !== version) {
      throw new Error(`Private adapter identity differs: ${name}`)
    }
    const key = name.slice("@effect/platform-".length), dist = join(root, "dist"), sources = await files(dist)
    adapters.set(name, { key, root, dist, sources })
    for (const file of [path, ...sources]) {
      inputs.push({ name, file, path: relative(root, file).split(sep).join("/"), sha256: digest(await readFile(file)) })
    }
    for (const file of sources.filter((file) => file.endsWith(".js"))) {
      entryPoints[key + "/" + relative(dist, file).slice(0, -3).split(sep).join("/")] = file
    }
    entryPoints[name.slice("@effect/".length)] = join(dist, "index.js")
    const own = createRequire(path)
    for (const dependency of Object.keys({ ...installed.dependencies, ...installed.peerDependencies })) {
      if (
        declared.includes(dependency) || dependency === "effect" ||
        installed.peerDependenciesMeta?.[dependency]?.optional
      ) continue
      if (dependency.startsWith("@effect/")) throw new Error(`Uncaptured adapter dependency: ${dependency}`)
      const selected = own(dependency + "/package.json")
      if (
        manifest.dependencies?.[dependency] !== selected.version ||
        require(dependency + "/package.json").version !== selected.version
      ) {
        throw new Error(`Private adapter external dependency is not exact: ${dependency}`)
      }
      ordinary.set(dependency, selected.version)
    }
    for (const name of await readdir(root)) {
      if (/license|notice|copyright/i.test(name)) {
        const source = join(root, name)
        notices.push({ source, target: join(vendor, key, name) })
        inputs.push({ name: installed.name, file: source, path: name, sha256: digest(await readFile(source)) })
      }
    }
  }
  await mkdir(vendor, { recursive: true })
  const result = await build({
    entryPoints,
    outdir: vendor,
    format: "esm",
    splitting: true,
    bundle: true,
    platform: "node",
    target: "node26",
    metafile: true,
    external: ["effect", "effect/*", ...ordinary.keys(), "bun", "bun:*"],
    logLevel: "silent"
  })
  for (const path of Object.keys(result.metafile.inputs)) {
    const real = await realpath(resolve(path))
    if (![...adapters.values()].some(({ dist }) => inside(dist, real))) {
      throw new Error(`Uncaptured private adapter code: ${path}`)
    }
  }
  for (const input of inputs) {
    if (digest(await readFile(input.file)) !== input.sha256) {
      throw new Error(`Private adapter changed during build: ${input.name}/${input.path}`)
    }
  }
  for (const [name, adapter] of adapters) {
    for (const file of adapter.sources.filter((file) => file.endsWith(".d.ts"))) {
      for (const branch of [vendor, join(vendor, "cjs")]) {
        const targets = [join(branch, adapter.key, relative(adapter.dist, file))]
        if (file === join(adapter.dist, "index.d.ts")) {
          targets.push(join(branch, name.slice("@effect/".length) + ".d.ts"))
        }
        for (const target of targets) {
          const text = rewrite(ts, await readFile(file, "utf8"), (value) => {
            const named = declared.find((name) => value === name || value.startsWith(name + "/"))
            if (named) {
              return specifier(
                target,
                targetFor(branch, adapters, named, value === named ? undefined : value.slice(named.length + 1))
              )
            }
            if (!value.startsWith(".")) return value
            const original = resolve(dirname(file), value)
            if (!inside(adapter.dist, original)) throw new Error(`Escaping private declaration: ${value}`)
            return specifier(target, join(branch, adapter.key, relative(adapter.dist, original)))
          })
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, text)
        }
      }
    }
  }
  await mkdir(join(vendor, "cjs"), { recursive: true })
  await writeFile(join(vendor, "cjs/package.json"), "{\"type\":\"commonjs\"}\n")
  for (const entry of Object.keys(entryPoints)) {
    const target = join(vendor, "cjs", entry + ".js")
    await mkdir(dirname(target), { recursive: true })
    await writeFile(
      target,
      `module.exports = require(${JSON.stringify(specifier(target, join(vendor, entry + ".js")))})\n`
    )
  }
  for (const { source, target } of notices) {
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target)
  }
  const identities = inputs.map(({ name, path, sha256 }) => ({ name, path, sha256 }))
  for (const input of inputs) {
    if (digest(await readFile(input.file)) !== input.sha256) {
      throw new Error(`Private adapter changed during declaration copying: ${input.name}/${input.path}`)
    }
  }
  const outputIdentities = await Promise.all(
    (await files(vendor)).filter((file) => file !== join(vendor, "adapters.json")).map(async (file) => ({
      path: relative(vendor, file).split(sep).join("/"),
      sha256: digest(await readFile(file))
    }))
  )
  await writeFile(
    join(vendor, "adapters.json"),
    JSON.stringify(
      { version, inputs: identities, ordinary: Object.fromEntries(ordinary), outputs: outputIdentities },
      null,
      2
    ) + "\n"
  )
  await relocatePrivateAdapterImports(packageRoot, { distRoot })
}
