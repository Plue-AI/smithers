/** Shared package assembly. Resolve tools from the package being built. */
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import { buildPrivateEffectAdapters } from "./private-effect-adapters.mjs"

const files = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })

/** Input declarations are shipped beside generated declarations in every release. */
export const copyInputDeclarations = (source, destination) => {
  for (const file of files(source).filter((file) => file.endsWith(".d.ts"))) {
    const target = join(destination, relative(source, file))
    mkdirSync(dirname(target), { recursive: true })
    cpSync(file, target)
  }
}

/** Each runtime branch needs declarations with the corresponding module kind. */
export const copyCommonJsDeclarations = (packageRoot) => {
  const esm = join(packageRoot, "dist/esm")
  const cjs = join(packageRoot, "dist/cjs")
  for (const source of files(esm).filter((file) => /\.d\.ts(?:\.map)?$/.test(file))) {
    const target = join(cjs, relative(esm, source))
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target)
  }
  mkdirSync(cjs, { recursive: true })
  writeFileSync(join(cjs, "package.json"), "{\"type\":\"commonjs\"}\n")
}

export const buildLibrary = async (packageRoot, { esmOnly = [], declarationTimeoutMs = 90_000 } = {}) => {
  const require = createRequire(join(packageRoot, "package.json"))
  const { build } = require("esbuild")
  const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc")
  rmSync(join(packageRoot, "dist"), { recursive: true, force: true })
  const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.json"], {
    cwd: packageRoot,
    stdio: "inherit",
    timeout: declarationTimeoutMs,
    killSignal: "SIGKILL"
  })
  if (result.error) throw new Error(`package compiler failed: ${result.error.message}`, { cause: result.error })
  if (result.status !== 0) throw new Error(`package compiler exited ${result.status ?? result.signal}`)
  const src = join(packageRoot, "src")
  const cjs = join(packageRoot, "dist/cjs")
  copyInputDeclarations(src, join(packageRoot, "dist/esm"))
  const excluded = new Set(esmOnly.map((path) => resolve(src, path)))
  await build({
    entryPoints: files(src).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts") && !excluded.has(file)),
    outbase: src,
    outdir: cjs,
    format: "cjs",
    bundle: false,
    platform: "neutral",
    target: "es2022",
    sourcemap: true
  })
  for (const file of files(cjs).filter((file) => file.endsWith(".js"))) {
    writeFileSync(file, readFileSync(file, "utf8").replace(/(require\(["'](?:\.\.?\/)[^"']+)\.ts(["']\))/g, "$1.js$2"))
  }
  copyCommonJsDeclarations(packageRoot)
  await buildPrivateEffectAdapters(packageRoot)
}
