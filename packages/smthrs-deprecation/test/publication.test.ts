import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as ts from "typescript"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fences, notice } from "./golden.ts"

const url = (path: string): URL => new URL(path, import.meta.url)
const manifest = JSON.parse(readFileSync(url("../package.json"), "utf8")) as {
  readonly bin?: unknown
  readonly version?: string
  readonly dependencies?: unknown
  readonly engines?: { readonly node?: string }
  readonly exports?: unknown
  readonly sideEffects?: unknown
  readonly publishConfig?: { readonly access?: string; readonly exports?: unknown; readonly tag?: string }
}

describe("the published manifest", () => {
  it("ships the smthrs command and its smithers alias, so `npx smthrs <verb>` runs the CLI", () => {
    // The bin runs @smthrs/cli's own executable, so the two `smthrs` bins are
    // one program. `smithers-build` stays collision-free: no bin here takes it.
    expect(manifest.bin).toEqual({ smithers: "./bin/smthrs.mjs", smthrs: "./bin/smthrs.mjs" })
  })

  it("depends on the CLI alone, at the synchronized release version", () => {
    expect(manifest.dependencies).toEqual({ "@smthrs/cli": manifest.version })
  })

  it("runs the CLI from its bin", () => {
    const result = spawnSync(process.execPath, [fileURLToPath(url("../bin/smthrs.mjs")), "--version"], {
      encoding: "utf8"
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(manifest.version)
  })

  it("keeps the side effect that is the whole package", () => {
    // A bundler told this module is side-effect free may drop the import, and
    // dropping the import drops the notice.
    expect(manifest.sideEffects).toBe(true)
  })

  it("exports the root and nothing else", () => {
    // Contract sections 3.3 and 3.5: `smthrs` exports `.` only.
    expect(manifest.exports).toEqual({ ".": "./src/index.ts" })
  })

  it("publishes publicly under the next dist-tag, so it never becomes an accidental install", () => {
    expect(manifest.publishConfig?.access).toBe("public")
    expect(manifest.publishConfig?.tag).toBe("next")
  })

  it("is the manifest the notice page's publication table describes", () => {
    // A reader decides what `npm install smthrs` runs and puts on PATH from
    // this table, so it must name every bin and every dependency the manifest
    // ships, and never claim the package has none.
    const page = readFileSync(url("../docs/notice.md"), "utf8")
    const rows = page.split("\n").filter((line) => line.startsWith("| "))
    const bins = Object.keys(manifest.bin as Record<string, string>)
    const dependencies = Object.keys(manifest.dependencies as Record<string, string>)

    // Anchor on the row that states the manifest's `bin` field, not any row
    // that happens to mention the names, so a row saying the executables come
    // from elsewhere cannot satisfy this.
    const binRow = rows.find((row) => /^\| `bin` is /.test(row))
    expect(binRow).toBeDefined()
    for (const bin of bins) expect(binRow).toContain(`\`${bin}\``)
    // npm never replaces another package's global bin without --force, so the
    // row must not claim a plain global install overwrites it.
    expect(binRow).not.toMatch(/replaces any other package/)
    expect(binRow).toMatch(/EEXIST/)
    expect(rows.find((row) => dependencies.every((name) => row.includes(`\`${name}\``)) && row.includes("exact")))
      .toBeDefined()
    expect(page).not.toMatch(/No `bin`|No dependencies|ships no `bin`/)
    expect(readFileSync(url("../docs/troubleshooting.md"), "utf8")).not.toMatch(/ships no `bin`/)
  })

  it("declares the repository's supported Node versions", () => {
    // This command runs the CLI directly, so the compatibility entry must
    // carry the CLI's supported versions, including its Node 26.4 floor.
    expect(manifest.engines?.node).toBe(">=26.4.0")
  })
})

/**
 * Every file `publishConfig.exports` resolves to, plus the `type: commonjs`
 * marker that makes the CJS entry loadable, relative to the package root.
 */
const publishedEntries = [
  "dist/esm/index.js",
  "dist/esm/index.d.ts",
  "dist/cjs/index.js",
  "dist/cjs/package.json"
] as const

const missingEntries = (): ReadonlyArray<string> =>
  publishedEntries.filter((entry) => !existsSync(fileURLToPath(url(`../${entry}`))))

const builtCjs = fileURLToPath(url("../dist/cjs/index.js"))

// The published entries are built artifacts, not `src/index.ts`, so this suite
// needs a build to have happened. `//packages/smthrs-deprecation:test` declares
// `//packages/smthrs-deprecation:lib` as a dependency
// (`packages/repo-targets/src/BuildAndCheckTypeScriptPackage.ts`), so a build-graph run always
// arrives here with a complete `dist/` and nothing else writes to that
// directory while the suite runs. The two runners that reach vitest directly do
// not: a fresh checkout running `pnpm test` has no `dist/` at all, and
// `pnpm check` runs `tsc -b`, which emits `dist/esm` and never the CJS entry.
// Skipping on either would drop the only assertions about what npm actually
// publishes, and a partial build would report a module-resolution error rather
// than a missing notice, so build what is missing instead of deciding not to
// look.
beforeAll(() => {
  if (missingEntries().length === 0) return
  const build = spawnSync(process.execPath, [fileURLToPath(url("../scripts/build.mjs"))], {
    cwd: fileURLToPath(url("../")),
    encoding: "utf8"
  })
  if (build.status !== 0) {
    throw new Error(`building the published entries failed\n${build.stdout ?? ""}${build.stderr ?? ""}`)
  }
})

/** The names one exported statement introduces. */
const boundNames = (statement: ts.Statement): ReadonlyArray<string> => {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((declared) => declared.name.getText())
  }
  if (
    ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
    || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)
  ) {
    return [statement.name.getText()]
  }
  if (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) {
    return [statement.name?.text ?? "default"]
  }
  return ["default"]
}

/**
 * Every name a declaration file offers an importer, in source order.
 *
 * The contract is that `smthrs` declares nothing, and matching text cannot
 * state that contract. `export interface Workflow {}` and
 * `export type Workflow = string` are exported names that carry neither an
 * `export declare` prefix nor an `export {` clause, so a pattern written
 * against those two spellings accepts both. Parsing states the contract
 * directly: a module exports a name three ways, through an `export` modifier,
 * an export clause, or an export assignment, and this reads all three off the
 * syntax tree. It also reads only the syntax tree, so an export spelled inside
 * a comment stays what it is, prose.
 */
const declaredExports = (declaration: string): ReadonlyArray<string> => {
  const parsed = ts.createSourceFile("index.d.ts", declaration, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  return parsed.statements.flatMap((statement) => {
    if (ts.isExportAssignment(statement)) return [statement.isExportEquals === true ? "export =" : "default"]
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      if (clause === undefined) return ["*"]
      return ts.isNamespaceExport(clause) ? [clause.name.text] : clause.elements.map((element) => element.name.text)
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
    return exported ? boundNames(statement) : []
  })
}

describe("the built entries a consumer actually loads", () => {
  it("ships every file publishConfig.exports resolves to", () => {
    expect(missingEntries()).toEqual([])
  })

  it("throws the notice through the ESM entry", async () => {
    const failure = await import(url("../dist/esm/index.js").href).then(
      () => undefined,
      (error: unknown) => error as Error
    )

    expect(failure?.message).toBe(notice)
  })

  it("throws the notice through the CJS entry", () => {
    const require_ = createRequire(import.meta.url)

    expect(() => require_(builtCjs)).toThrow(notice)
  })

  it("marks the CJS directory commonjs, which is what lets require resolve the entry", () => {
    // The package is `type: module`, so without this file Node reads
    // `dist/cjs/index.js` as ESM: the `require` condition would stop resolving
    // to CommonJS, which is a broken publication even on the Node versions
    // whose `require(esm)` support hides it by still throwing the notice.
    // `scripts/build.mjs` writes the marker, and `files` publishes it.
    const marker = readFileSync(url("../dist/cjs/package.json"), "utf8")

    expect(JSON.parse(marker)).toEqual({ type: "commonjs" })
  })

  it("declares no importable type surface, because no import can ever resolve one", () => {
    // A declared export type-checks and then throws at run time, which is the
    // type-versus-runtime drift the umbrella used to be guarded against.
    const types = readFileSync(url("../dist/esm/index.d.ts"), "utf8")

    expect(declaredExports(types)).toEqual([])
  })
})

/**
 * A declaration this package must never emit, and the names it would hand an
 * importer. Every case is a one line edit to `src/index.ts` away, and the
 * empty-surface assertion is worth only what it rejects, so the reader runs
 * against each of them here.
 */
const mutations = [
  {
    case: "an exported interface",
    declaration: "export interface LegacyWorkflow { readonly id: string }",
    exports: ["LegacyWorkflow"]
  },
  {
    case: "an exported type alias",
    declaration: "export type LegacyWorkflow = { readonly id: string }",
    exports: ["LegacyWorkflow"]
  },
  {
    case: "a named re-export written without spaces inside the braces",
    declaration: "export {LegacyWorkflow} from \"./legacy.js\"",
    exports: ["LegacyWorkflow"]
  },
  {
    case: "a type-only re-export",
    declaration: "export type { LegacyWorkflow } from \"./legacy.js\"",
    exports: ["LegacyWorkflow"]
  },
  {
    case: "a star re-export",
    declaration: "export * from \"./legacy.js\"",
    exports: ["*"]
  },
  {
    case: "a namespace re-export",
    declaration: "export * as legacy from \"./legacy.js\"",
    exports: ["legacy"]
  },
  {
    case: "an exported declare const, which is what the old pattern did catch",
    declaration: "export declare const notice: string",
    exports: ["notice"]
  },
  {
    case: "an exported declare function",
    declaration: "export declare function run(): void",
    exports: ["run"]
  },
  {
    case: "a default export",
    declaration: "declare const notice: string\nexport default notice",
    exports: ["default"]
  },
  {
    case: "an export assignment, the CJS spelling",
    declaration: "declare const notice: string\nexport = notice",
    exports: ["export ="]
  },
  {
    case: "the empty-module marker tsc emits for a module with no exports",
    declaration: "export {}",
    exports: []
  },
  {
    case: "an unexported declaration, which no import can name",
    declaration: "declare const notice: string",
    exports: []
  },
  {
    case: "a comment that spells an export, which is prose and not a declaration",
    declaration: "/** Removed in 1.0: `export interface LegacyWorkflow {}`. */\nexport {}",
    exports: []
  }
] as const

describe("the reader the empty type surface assertion is made of", () => {
  for (const mutation of mutations) {
    it(`reports ${mutation.case}`, () => {
      expect(declaredExports(mutation.declaration)).toEqual(mutation.exports)
    })
  }
})

/**
 * A 0.x project's `node_modules/smthrs`, laid out the way npm lays out the
 * published package: `publishConfig.exports` over `dist/`. The fixtures import
 * the bare specifier, so what they print is what a project sees, specifier
 * included. The `dist` link may dangle until the build hook above runs; Node
 * resolves it when a fixture loads.
 */
const consumerRoot = mkdtempSync(join(tmpdir(), "smthrs-consumer-"))

beforeAll(() => {
  const installed = join(consumerRoot, "node_modules", "smthrs")
  mkdirSync(installed, { recursive: true })
  writeFileSync(
    join(installed, "package.json"),
    JSON.stringify({ name: "smthrs", type: "module", exports: manifest.publishConfig?.exports })
  )
  symlinkSync(fileURLToPath(url("../dist")), join(installed, "dist"))
})

afterAll(() => {
  rmSync(consumerRoot, { recursive: true, force: true })
})

/** Runs one consumer file under Node and returns its exit status and stderr. */
const runConsumer = (file: string, source: string): { readonly status: number | null; readonly stderr: string } => {
  const path = join(consumerRoot, file)
  writeFileSync(path, source)
  const result = spawnSync(process.execPath, [path], { cwd: consumerRoot, encoding: "utf8" })
  return { status: result.status, stderr: result.stderr.replace(/\r\n/g, "\n") }
}

/** The line Node prints when a static import names an export this module never declares. */
const missingExport = (name: string): string =>
  `SyntaxError: The requested module 'smthrs' does not provide an export named '${name}'`

/**
 * Every way a 0.x project spells an import of `smthrs`, and whether the
 * notice reaches it. A static named or default import is rejected while the
 * module graph links, before the module body evaluates, so nothing this
 * package does can put the notice in that error. The docs promise the notice
 * only for the imports that reach evaluation, and this table is what keeps
 * that promise honest.
 */
const consumers = [
  {
    case: "a static named import of a 0.x export",
    file: "named.mjs",
    source: "import { Workflow } from \"smthrs\"\nconsole.log(Workflow)\n",
    error: missingExport("Workflow"),
    printsNotice: false
  },
  {
    case: "a static default import",
    file: "default.mjs",
    source: "import smthrs from \"smthrs\"\nconsole.log(smthrs)\n",
    error: missingExport("default"),
    printsNotice: false
  },
  {
    case: "a bare side-effect import",
    file: "bare.mjs",
    source: "import \"smthrs\"\n",
    error: `Error: ${notice.split("\n")[0]}`,
    printsNotice: true
  },
  {
    case: "a namespace import",
    file: "namespace.mjs",
    source: "import * as smthrs from \"smthrs\"\nconsole.log(smthrs)\n",
    error: `Error: ${notice.split("\n")[0]}`,
    printsNotice: true
  },
  {
    case: "a dynamic import",
    file: "dynamic.mjs",
    source: "await import(\"smthrs\")\n",
    error: `Error: ${notice.split("\n")[0]}`,
    printsNotice: true
  },
  {
    case: "a CommonJS require",
    file: "require.cjs",
    source: "require(\"smthrs\")\n",
    error: `Error: ${notice.split("\n")[0]}`,
    printsNotice: true
  }
] as const

describe("what a 0.x project sees at its own import statement", () => {
  for (const consumer of consumers) {
    it(`${consumer.case} exits 1 ${consumer.printsNotice ? "with" : "without"} the notice`, () => {
      const result = runConsumer(consumer.file, consumer.source)

      expect(result.status).toBe(1)
      expect(result.stderr.split("\n")).toContain(consumer.error)
      expect(result.stderr.includes(notice)).toBe(consumer.printsNotice)
    })
  }

  it("is the missing-export error the troubleshooting page quotes, specifier included", () => {
    // The page can only tell a reader to recognize the error it actually
    // prints. A rewording on either side, Node's or ours, surfaces here.
    expect(fences(readFileSync(url("../docs/troubleshooting.md"), "utf8"))).toContain(missingExport("Workflow"))
  })
})
