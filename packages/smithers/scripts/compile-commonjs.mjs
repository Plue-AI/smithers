/** Builds the CommonJS half of a package's dual-module distribution. */
import { build } from "esbuild"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import ts from "typescript"
import { copyCommonJsDeclarations } from "../../repo-targets/scripts/build-library.mjs"
import { buildPrivateEffectAdapters } from "../../repo-targets/scripts/private-effect-adapters.mjs"

const files = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })

const hasTopLevelAwait = (file) => {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  const visit = (node) => {
    if (ts.isFunctionLike(node)) return false
    if (ts.isAwaitExpression(node) || ts.isForOfStatement(node) && node.awaitModifier) return true
    return ts.forEachChild(node, visit) ?? false
  }
  return visit(source)
}

/** Keeps executable-only top-level-await modules as thin ESM delegates. */
export const compileCommonJs = async (src, cjs, esm) => {
  const sourceFiles = files(src)
  const tsFiles = sourceFiles.filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
  const jsFiles = sourceFiles.filter((file) => file.endsWith(".js") && !existsSync(file.replace(/\.js$/, ".ts")))
  const executableEntries = [...tsFiles, ...jsFiles].filter(hasTopLevelAwait)
  await build({
    entryPoints: [...tsFiles, ...jsFiles].filter((file) => !executableEntries.includes(file)),
    outbase: src,
    outdir: cjs,
    format: "cjs",
    bundle: false,
    platform: "node",
    target: "node26",
    sourcemap: true,
    define: {
      "import.meta.url": "__smthrsImportMetaUrl",
      "import.meta.dirname": "__dirname",
      "import.meta.resolve": "__smthrsResolve"
    },
    banner: {
      js:
        "const __smthrsImportMetaUrl = require(\"node:url\").pathToFileURL(__filename).href; const __smthrsResolve = (id) => require(\"node:url\").pathToFileURL(require.resolve(id)).href;"
    }
  })
  for (const file of files(cjs).filter((file) => file.endsWith(".js"))) {
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(/((?:require|import)\(["'](?:\.\.?\/)[^"']+)\.ts(["']\))/g, "$1.js$2")
    )
  }
  mkdirSync(cjs, { recursive: true })
  writeFileSync(join(cjs, "package.json"), "{\"type\":\"commonjs\"}\n")
  for (const file of executableEntries) {
    const target = join(cjs, relative(src, file).replace(/\.(?:ts|js)$/, ".js"))
    const executable = join(esm, relative(src, file).replace(/\.(?:ts|js)$/, ".js"))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(
      target,
      `void import(${
        JSON.stringify(relative(dirname(target), executable))
      }).catch((error) => { console.error(error); process.exitCode = 1 })\n`
    )
  }
  copyCommonJsDeclarations(dirname(src))
  await buildPrivateEffectAdapters(dirname(src))
}
