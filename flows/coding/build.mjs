/** Private deployment artifact; the existing Plue provisioner stages one executable. */
import { build } from "esbuild"
import { chmod, mkdir, writeFile, readFile, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { policySources } from "../wiki/reuse.ts"
import { hostModulesSource } from "./host-modules-build.mjs"
import { wikiPolicyIdentity } from "./wiki-policy.ts"

/** Used to build the same runtime acceptance entry with the deployment bundler; not a package export. */
export const bundle = async (entryPoint, outfile) => {
  // Resolve workspace packages from this checkout even when node_modules is
  // shared with another worktree. Otherwise a release silently bundles old code.
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
  const alias = {}, roots = {}
  for (const pattern of manifest.workspaces) {
    const paths = pattern.endsWith("/*")
      ? (await readdir(resolve(root, pattern.slice(0, -2)), { withFileTypes: true }))
        .filter(entry => entry.isDirectory()).map(entry => resolve(root, pattern.slice(0, -2), entry.name))
      : [resolve(root, pattern)]
    for (const path of paths) {
      try {
        const pkg = JSON.parse(await readFile(resolve(path, "package.json"), "utf8"))
        if (pkg.name) {
          roots[pkg.name] = path
          for (const [key, target] of Object.entries(pkg.exports ?? {})) {
            if (typeof target !== "string" || key.includes("*")) continue
            alias[pkg.name + (key === "." ? "" : key.slice(1))] = resolve(path, target)
          }
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
    }
  }
  const options = {
    alias, absWorkingDir: root,
    entryPoints: [entryPoint], outfile, write: false, bundle: true, platform: "node", format: "esm", target: "node26.4",
    banner: { js: "#!/usr/bin/env node\nimport {createRequire as __smithersCreateRequire} from 'node:module'; const require=__smithersCreateRequire(import.meta.url);" }
  }
  const lazyBunSqlite = {
    name: "lazy-bun-sqlite",
    setup(build) {
      // esbuild hoists static external imports from dynamically loaded ESM
      // modules. Keep Bun's existing builtin behind that same lazy boundary,
      // so a Node launch never attempts to resolve bun:sqlite.
      build.onResolve({ filter: /^bun:sqlite$/ }, args => args.namespace === "lazy-bun-sqlite"
        ? { path: args.path, external: true }
        : { path: args.path, namespace: "lazy-bun-sqlite" })
      build.onLoad({ filter: /.*/, namespace: "lazy-bun-sqlite" }, () => ({
        contents: 'const native = await import("bun:sqlite"); export const Database = native.Database;', loader: "js"
      }))
    }
  }
  // A repository's file flows share the host's own modules (host-modules.ts).
  // The probe learns which modules the host runs; the build then serves
  // exactly those, so sharing adds no module of its own.
  const probe = await build({ ...options, metafile: true, plugins: [lazyBunSqlite] })
  // Only modules the host evaluates at start: sharing a module the host only
  // imports dynamically (Bun's platform layers) would evaluate it eagerly.
  const graph = probe.metafile.inputs, inputs = new Set()
  const pending = Object.keys(graph).filter(path => resolve(root, path) === resolve(entryPoint))
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (path.includes(":") || inputs.has(resolve(root, path))) continue
    inputs.add(resolve(root, path))
    for (const edge of graph[path]?.imports ?? []) if (!edge.external && edge.kind !== "dynamic-import") pending.push(edge.path)
  }
  const result = await build({
    ...options,
    plugins: [{
      name: "host-modules",
      setup(build) {
        build.onLoad({ filter: /[\\/]flows[\\/]coding[\\/]host-modules\.ts$/ }, async ({ path }) => ({
          contents: await hostModulesSource(await readFile(path, "utf8"), inputs, alias, roots), loader: "ts"
        }))
      }
    }, lazyBunSqlite]
  })
  if (result.outputFiles.length !== 1) throw new Error("Coding host must be one immutable executable")
  // The built-in prompt bodies travel with the executable.
  //
  // They are `.mdx` files in this repository and the deployment carries no
  // repository tree, so the host would have nothing to install on a workspace.
  // They go in BEFORE the artifact is hashed, so the policy digest a workspace
  // records covers the exact prompts it will run: editing one respins the
  // host, as it should.
  const packRoot = fileURLToPath(new URL("../create-flow/", import.meta.url))
  const pack = {}
  for (const name of ["", "clarify", "provision", "design", "scaffold", "fix", "document"]) {
    const file = resolve(packRoot, name, "flow.mdx")
    pack[name === "" ? "create-flow" : `create-flow/${name}`] = await readFile(file, "utf8")
  }
  for (const name of ["issue/repro", "issue/poc", "pr-triage", "review/change"]) {
    pack[name] = await readFile(resolve(root, "flows", name, "flow.mdx"), "utf8")
  }
  // The wiki review task's identity, from the same policy files the source
  // host reads. Review reuse keys on it, so a host build that leaves the
  // review task alone keeps prior reviews (#1971).
  const policyTexts = new Map()
  for (const source of policySources) policyTexts.set(source, await readFile(resolve(root, source), "utf8"))
  // The built-in TODO composition's source: the version a TODO pins when
  // main has none (flows/repository/builtin-flows.ts).
  const builtinFlows = { todo: await readFile(resolve(root, "flows/todo/flow.ts"), "utf8") }
  const compiled = result.outputFiles[0].text.replace(/^(#![^\n]*\n)/,
    `$1const __SMITHERS_CREATE_FLOW_PACK__ = ${JSON.stringify(pack)};\nconst __SMITHERS_CODING_WIKI_POLICY__ = ${JSON.stringify(wikiPolicyIdentity(policyTexts))};\nconst __SMITHERS_BUILTIN_FLOWS__ = ${JSON.stringify(builtinFlows)};\n`)
  if (compiled === result.outputFiles[0].text) throw new Error("Coding artifact has no executable banner")
  const digest = createHash("sha256").update(compiled).digest("hex")
  // Hash the exact compiled artifact before inserting its own identity. This
  // includes its complete bundled dependency graph, with no dependency on files
  // vendored in the target repository.
  const output = compiled.replace(/^(#![^\n]*\n)/,
    `$1const __SMITHERS_CODING_ARTIFACT_DIGEST__ = ${JSON.stringify(digest)};\n`)
  if (output === compiled) throw new Error("Coding artifact has no executable banner")
  await mkdir(dirname(resolve(outfile)), { recursive: true })
  await writeFile(outfile, output)
  await chmod(outfile, 0o755)
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const outfile = resolve(process.argv[2] ?? "dist/coding-host/smithers.mjs")
  await bundle(fileURLToPath(new URL("./serve.ts", import.meta.url)), outfile)
  process.stdout.write(`${outfile}\n`)
}
