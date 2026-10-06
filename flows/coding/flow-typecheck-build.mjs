/** Type inputs shipped with the coding host, measured as part of its artifact. */
import ts from "typescript"
import { readFile, readdir } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"

export const typecheckInputs = async (root, aliases) => {
  const require = createRequire(join(root, "flows/package.json"))
  const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, strict: true, skipLibCheck: true,
    noEmit: true, types: ["node"],
    paths: Object.fromEntries(Object.entries(aliases).map(([key, value]) => [key, [value]]))
  }
  const compiler = dirname(require.resolve("typescript"))
  const nodeTypes = dirname(require.resolve("@types/node/package.json"))
  options.typeRoots = [dirname(nodeTypes)]
  const roots = [...Object.values(aliases), join(nodeTypes, "index.d.ts")]
  const program = ts.createProgram(roots, options)
  const files = {}, resolvedEntries = { ...aliases }
  const virtual = path => {
    const local = relative(root, resolve(path)).split("\\").join("/")
    if (local === ".." || local.startsWith("../")) throw new Error(`Flow type input is outside the build checkout: ${path}`)
    return "/__smithers_types__/" + local
  }
  // These sources are read as types, never evaluated. Including the complete
  // compiler-reached graph preserves generic inference across package seams.
  for (const source of program.getSourceFiles()) {
    files[virtual(source.fileName)] = source.text
    for (const imported of ts.preProcessFile(source.text).importedFiles) {
      const specifier = imported.fileName
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue
      const target = ts.resolveModuleName(specifier, source.fileName, options, ts.sys).resolvedModule
      if (target) resolvedEntries[specifier] = target.resolvedFileName
    }
  }
  for (const name of await readdir(compiler)) {
    if (name.startsWith("lib.") && name.endsWith(".d.ts")) {
      files[virtual(join(compiler, name))] = await readFile(join(compiler, name), "utf8")
    }
  }
  // Package metadata is needed for ordinary dependency resolution in the
  // trusted type graph. It is install data, never the repository's package.
  const visited = new Set()
  for (const filename of Object.keys(files)) {
    for (let parent = dirname(resolve(root, filename.slice("/__smithers_types__/".length))); parent !== dirname(root); parent = dirname(parent)) {
      const name = join(parent, "package.json"), key = virtual(name)
      if (visited.has(key)) continue
      visited.add(key)
      try { files[key] = await readFile(name, "utf8") } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
    }
  }
  const entries = Object.fromEntries(Object.entries(resolvedEntries).map(([key, value]) => [key, virtual(value)]))
  return { files, entries, lib: virtual(join(compiler, "lib.es2024.full.d.ts")), node: virtual(join(nodeTypes, "index.d.ts")) }
}
