/**
 * The other half of the package's dependency boundary.
 *
 * `test/Dependencies.test.ts` pins that the scan surface imports nothing but
 * effect, the Node platform, and TypeScript. This file pins the promise that
 * makes that worth having: `import "@smthrs/migrate"` reaches the scanners and
 * stops there, so a person deciding whether to migrate never installs the 1.0
 * runtime to find out. It also pins that the flow surface, which does run the
 * runtime, imports only packages the manifest declares.
 *
 * Both read the real source and the real manifest, so neither can drift.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as Cli from "@smthrs/migrate/flow/Cli"
import * as Report from "@smthrs/migrate/Report"
import ts from "@typescript/typescript6"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = fileURLToPath(new URL("../..", import.meta.url))
const sourceRoot = join(packageRoot, "src")

const specifiers = (file: string): ReadonlyArray<string> => {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  const found: Array<string> = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text)
    }
    node.forEachChild(visit)
  }
  visit(source)
  return found
}

const flowFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory).sort().flatMap((entry) => {
    const absolute = join(directory, entry)
    if (statSync(absolute).isDirectory()) return flowFiles(absolute)
    return entry.endsWith(".ts") ? [absolute] : []
  })

const packageOf = (specifier: string): string =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? specifier)

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  version: string
  dependencies: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies: Record<string, string>
  devDependencies: Record<string, string>
  exports: Record<string, unknown>
  publishConfig: { exports: Record<string, unknown> }
  sideEffects: ReadonlyArray<string>
}

/** Every module the root entry point reaches by following relative imports. */
const reachable = (entry: string): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    for (const specifier of specifiers(file)) {
      if (!specifier.startsWith(".")) continue
      queue.push(resolve(dirname(file), specifier))
    }
  }
  return [...seen].sort()
}

describe("the package's entry point", () => {
  it("reaches no runtime package by following its own imports", () => {
    const modules = reachable(join(sourceRoot, "index.ts"))
    const runtime = modules.flatMap((file) =>
      specifiers(file)
        .filter((specifier) => specifier.startsWith("@smthrs/"))
        .map((specifier) => `${file.slice(packageRoot.length)} -> ${specifier}`)
    )

    expect(runtime).toEqual([])
    // The exports map is what makes the flow surface reachable anyway, so the
    // promise costs nobody a feature: `@smthrs/migrate/flow/Command` resolves
    // to `src/flow/Command.ts`.
    expect(modules).toContain(join(sourceRoot, "Scan.ts"))
    // Three flow modules are exported from the root because they cost nothing
    // to load: the contract is text, the gate is a decision, and the options
    // are a schema. Everything that runs the engine is subpath only.
    expect(
      modules.filter((file) => file.startsWith(`${join(sourceRoot, "flow")}${sep}`))
        .map((file) => relative(sourceRoot, file).split(sep).join("/"))
    ).toEqual(["flow/Contract.ts", "flow/Gate.ts", "flow/Options.ts"])
  })

  it("keeps every @smthrs dependency optional, so an npx scan installs none of them", () => {
    expect(Object.keys(manifest.dependencies).some((name) => name.startsWith("@smthrs/"))).toBe(false)
    expect(Object.keys(manifest.optionalDependencies).length).toBeGreaterThan(0)
  })
})

describe("the flow surface's dependency boundary", () => {
  it("imports only packages the manifest declares", () => {
    const declared = new Set([
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies)
    ])
    const undeclared = new Map<string, ReadonlyArray<string>>()
    for (const file of flowFiles(join(sourceRoot, "flow"))) {
      const outside = [...new Set(specifiers(file))]
        .filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"))
        .map(packageOf)
        .filter((name) => !declared.has(name))
      if (outside.length > 0) undeclared.set(file.slice(packageRoot.length), [...new Set(outside)])
    }

    expect([...undeclared]).toEqual([])
  })

  it("keeps every internal module, nested ones included, out of the export map", () => {
    // `./*` matches nested paths, so a null for `./internal/*` alone left
    // `@smthrs/migrate/flow/internal/Exec` importable: the process runner was
    // public API by accident. Node's own resolver is the authority here.
    const require = createRequire(import.meta.url)
    expect(require.resolve("@smthrs/migrate/flow/Verify")).toContain(join("src", "flow", "Verify.ts"))
    for (const internal of ["@smthrs/migrate/internal/Fs", "@smthrs/migrate/flow/internal/Exec"]) {
      expect(() => require.resolve(internal)).toThrow(/not defined by "exports"|ERR_PACKAGE_PATH_NOT_EXPORTED/)
    }
    const exportsMap = manifest.exports
    const published = manifest.publishConfig.exports
    for (const map of [exportsMap, published]) {
      expect(map["./internal/*"]).toBeNull()
      expect(map["./flow/internal/*"]).toBeNull()
    }
  })

  it("reports the package's own version, in the report and at --version", () => {
    // The manifest is the release version; two literals in source repeat it
    // because a report and a `--version` flag cannot read a manifest at run
    // time from a packed install. `scripts/set-release-version.mjs` rewrites
    // both on a bump, and this pins them until it does.
    expect(Report.tool.version).toBe(manifest.version)
    expect(Cli.version).toBe(manifest.version)
    expect(manifest.version).toMatch(/^1\.0\.0-rc\.\d+$/)
  })

  it("declares the executable as the side effect it is", () => {
    // `bin.ts` runs `NodeRuntime.runMain` when it is evaluated. A manifest
    // that calls the whole package side-effect free entitles a bundler to
    // drop it.
    expect(manifest.sideEffects).toEqual(["./src/flow/bin.ts", "./dist/esm/flow/bin.js", "./dist/cjs/flow/bin.js"])
  })

  it("reaches capability values through @smthrs/kernel, which declares them", () => {
    // `@smthrs/capability` is not a dependency of this package, and adding one
    // for two class constructors would widen the manifest for nothing:
    // `@smthrs/kernel` re-exports `Capability` and `Permission` as namespaces
    // and is already declared. The grant rules are built from those.
    const layers = readFileSync(join(sourceRoot, "flow", "Layers.ts"), "utf8")

    expect(layers).toContain("from \"@smthrs/kernel\"")
    expect(layers).not.toContain("@smthrs/capability")
  })
})
