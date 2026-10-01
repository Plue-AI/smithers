/**
 * Bundles the Smithers TUI (`apps/tui/src/main.tsx`) into `dist/tui/main.js`
 * so `smthrs tui` can run it under Node or Bun, from a checkout or an
 * installation.
 *
 * Workspace `@smthrs/*` sources and pure JavaScript dependencies are inlined:
 * the checkout's TypeScript sources do not run on plain Node. Every package
 * the CLI declares as a dependency stays external so the installed copy is
 * the one that loads (effect and react must be single instances, and
 * `@opentui/core` carries native libraries). The build fails when the bundle
 * imports a package the CLI does not declare. Code splitting keeps Bun-only
 * modules that load through a dynamic `import()` out of the entry chunk.
 *
 * Only changed files are written, so `smthrs tui` can rebuild before every
 * checkout launch under Node without disturbing a TUI already running from
 * the same output. Chunk names carry a content hash, so a chunk never changes
 * under a running TUI.
 *
 * Run it alone with `node scripts/build-tui.mjs`.
 */
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildPrivateEffectAdapters,
  privateEffectAdapters
} from "../../repo-targets/scripts/private-effect-adapters.mjs"
import { verifyNativeArtifacts } from "../vendor/opentui-native/verify.mjs"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** The package name a bare specifier names: `@scope/name` or `name`. */
const packageName = (specifier) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")

export const buildTui = async () => {
  verifyNativeArtifacts()
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"))
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...privateEffectAdapters(manifest)
  ])
  const builtin = (specifier) =>
    specifier.startsWith("node:") || specifier.startsWith("bun:") || builtinModules.includes(specifier)
  const outdir = resolve(packageRoot, "dist/tui")
  const result = await build({
    entryPoints: { main: resolve(packageRoot, "../../apps/tui/src/main.tsx") },
    outdir,
    bundle: true,
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    format: "esm",
    platform: "node",
    target: "esnext",
    jsx: "automatic",
    jsxImportSource: "@opentui/react",
    // Inlined CommonJS dependencies `require` Node builtins at run time.
    banner: {
      js:
        "import { createRequire as __tuiRequire } from \"node:module\"; const require = __tuiRequire(import.meta.url);"
    },
    metafile: true,
    write: false,
    logLevel: "warning",
    plugins: [{
      name: "declared-dependencies-external",
      setup(context) {
        context.onResolve({ filter: /^[^./]/ }, ({ path }) => {
          if (builtin(path)) return { path, external: true }
          if (path === "@smthrs/cli/tui-native") return { path, external: true }
          const name = packageName(path)
          return !name.startsWith("@smthrs/") && declared.has(name) ? { path, external: true } : undefined
        })
      }
    }]
  })
  if (result.errors.length > 0) throw new Error("The TUI bundle failed to build")
  const undeclared = new Set()
  for (const output of Object.values(result.metafile.outputs)) {
    for (const { path, external } of output.imports) {
      if (
        external && path !== "@smthrs/cli/tui-native" && !builtin(path) && !path.startsWith(".") &&
        !declared.has(packageName(path))
      ) {
        undeclared.add(path)
      }
    }
  }
  if (undeclared.size > 0) {
    throw new Error(`The TUI bundle imports packages @smthrs/cli does not declare: ${[...undeclared].join(", ")}`)
  }
  for (const file of result.outputFiles) {
    let current
    try {
      current = readFileSync(file.path)
    } catch {
      current = undefined
    }
    if (current !== undefined && Buffer.compare(current, file.contents) === 0) continue
    mkdirSync(dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.contents)
  }
  await buildPrivateEffectAdapters(packageRoot)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildTui()
