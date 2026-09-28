import babel from "@babel/core"
import typescript from "@babel/plugin-transform-typescript"
import optionalChaining from "@babel/plugin-transform-optional-chaining"
import nullishCoalescing from "@babel/plugin-transform-nullish-coalescing-operator"
import logicalAssignment from "@babel/plugin-transform-logical-assignment-operators"
import instrumentLibrary from "istanbul-lib-instrument"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import { basename } from "node:path"

const require = createRequire(import.meta.url)
export const options = {
  typescript: { allowDeclareFields: true, onlyRemoveTypeImports: true },
  loose: false,
  compact: false,
  esModules: true,
  sourceMaps: true
}
const packages = ["@babel/core", "@babel/plugin-transform-typescript", "@babel/plugin-transform-optional-chaining",
  "@babel/plugin-transform-nullish-coalescing-operator", "@babel/plugin-transform-logical-assignment-operators",
  "istanbul-lib-instrument", "istanbul-lib-coverage", "istanbul-lib-source-maps", "istanbul-lib-report", "istanbul-reports"]
export const versions = Object.fromEntries(packages.map((name) => [name, require(`${name}/package.json`).version]))

// Object key order is irrelevant to a sealed manifest or source map.
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}
export function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(canonical(value))).digest("hex")
}
export function mapDigest(coverage) {
  return digest({ path: coverage.path, statementMap: coverage.statementMap, fnMap: coverage.fnMap,
    branchMap: coverage.branchMap, inputSourceMap: coverage.inputSourceMap ?? null })
}

export function instrument(source, path) {
  const isTSX = path.endsWith(".tsx")
  const isTypeScript = /\.(?:ts|tsx|mts|cts)$/.test(path)
  const lowered = babel.transformSync(source, {
    filename: path, sourceFileName: basename(path), configFile: false, babelrc: false, ast: true,
    sourceMaps: true, parserOpts: { plugins: isTypeScript ? ["typescript", "jsx"] : ["jsx"] },
    plugins: [...(isTypeScript ? [[typescript, { ...options.typescript, isTSX }]] : []),
      optionalChaining, logicalAssignment, nullishCoalescing],
    compact: false
  })
  for (const comment of lowered.ast.comments ?? []) {
    if (/\b(?:istanbul|c8|v8)\s+ignore\b/.test(comment.value)) {
      throw new Error(`Coverage ignore directive is forbidden: ${path}`)
    }
  }
  const instrumenter = instrumentLibrary.createInstrumenter({ esModules: true, parserPlugins: ["jsx"],
    produceSourceMap: true, compact: false })
  const code = instrumenter.instrumentSync(lowered.code, path, lowered.map)
  const zero = structuredClone(instrumenter.lastFileCoverage())
  return { code, zero, mapDigest: mapDigest(zero), loader: /\.(?:tsx|jsx)$/.test(path) ? "jsx" : "js" }
}
