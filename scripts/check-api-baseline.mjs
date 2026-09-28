/** Declaration drift is a review gate, not a semantic compatibility verdict. */
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { libraryPackages, repoRoot } from "./workspace-packages.mjs"

const declarations = (directory, prefix = "") => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const name = `${prefix}${entry.name}`
  return entry.isDirectory()
    ? declarations(join(directory, entry.name), `${name}/`)
    : entry.name.endsWith(".d.ts") ? [name] : []
})

/** Include private declarations too: public signatures can reference them. */
export const apiSurface = (root = repoRoot, declarationRoot = root) => Object.fromEntries(
  libraryPackages(root).filter(({ manifest }) => !manifest.private).map(({ name, dir, manifest }) => {
    const directory = join(declarationRoot, dir, "dist/esm")
    const names = declarations(directory).sort()
    if (names.length === 0) throw new Error(`${name}: no declarations; build the package before checking its API`)
    return [name, {
      exports: manifest.publishConfig.exports,
      declarations: Object.fromEntries(names.map((file) => {
        const contents = readFileSync(join(directory, file), "utf8").replace(/\r\n/g, "\n")
          .replace(/^\/\/# sourceMappingURL=.*$/gm, "").trim()
        return [file, createHash("sha256").update(contents).digest("hex")]
      }))
    }]
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
)

export const assertApiBaseline = (expected, actual) => {
  const changed = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter((name) =>
    JSON.stringify(expected[name]) !== JSON.stringify(actual[name]))
  if (changed.length > 0) throw new Error(
    `Declaration/API drift requires compatibility review:\n${changed.map((name) => `  ${name}`).join("\n")}\n` +
    "Review declaration diffs, consumer type tests and release notes before explicitly updating the baseline."
  )
}

/** Emit the same .d.ts surface as a release, without JS, packing or shared outputs. */
export const withDeclarationBuild = async (root, check) => {
  const ts = await import("typescript")
  const output = mkdtempSync(join(tmpdir(), "smithers-api-declarations-"))
  try {
    for (const { dir, name, manifest } of libraryPackages(root)) {
      if (manifest.private) continue
      const config = ts.getParsedCommandLineOfConfigFile(join(root, dir, "tsconfig.json"), {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        declarationMap: false,
        incremental: false,
        composite: false,
        outDir: join(output, dir, "dist/esm")
      }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
      } })
      if (config.errors.length > 0) {
        throw new Error(`${name}: ${ts.formatDiagnostics(config.errors, {
          getCanonicalFileName: (file) => file,
          getCurrentDirectory: () => root,
          getNewLine: () => "\n"
        })}`)
      }
      const program = ts.createProgram(config.fileNames, config.options)
      // Match tsc: checking before emit determines inferred union/member ordering.
      const diagnostics = ts.getPreEmitDiagnostics(program)
      const result = program.emit()
      const errors = [...diagnostics, ...result.diagnostics]
      if (result.emitSkipped || errors.length > 0) {
        throw new Error(`${name}: declaration emit failed: ${errors.map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n")}`)
      }
    }
    return await check(output)
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const option = process.argv[2]
  if (process.argv.length > 3 || ![undefined, "--update", "--build-declarations"].includes(option)) {
    throw new Error("usage: node scripts/check-api-baseline.mjs [--update|--build-declarations]")
  }
  const check = (declarationRoot = repoRoot) => {
    const path = join(repoRoot, "scripts/fixtures/public-api-baseline.json")
    const surface = apiSurface(repoRoot, declarationRoot)
    if (option === "--update") {
      writeFileSync(path, `${JSON.stringify({ format: 1, packages: surface }, null, 2)}\n`)
      console.log(`Recorded declarations for ${Object.keys(surface).length} public packages`)
    } else {
      const baseline = JSON.parse(readFileSync(path, "utf8"))
      if (baseline.format !== 1) throw new Error("unsupported API baseline format")
      assertApiBaseline(baseline.packages, surface)
      console.log(`Declaration baseline matches ${Object.keys(surface).length} public packages`)
    }
  }
  if (option === "--build-declarations") await withDeclarationBuild(repoRoot, check)
  else check()
}
