/**
 * The scan surface's dependency boundary.
 *
 * A person who runs `scan` on a 0.x project is deciding whether to migrate at
 * all. Making that decision must not install the flow runtime. These tests read
 * the real source and the real manifest, so the boundary cannot drift.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import ts from "@typescript/typescript6"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const sourceRoot = join(packageRoot, "src")

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory).sort().flatMap((entry) => {
    const absolute = join(directory, entry)
    // `src/flow` is the migration flow, not the scan surface. It runs the 1.0
    // engine by definition — `Action.make`, `AgentAction.make`, the kernel's
    // guarded services — so the boundary this file pins is the scan surface's,
    // and `test/flow/Dependencies.test.ts` pins the other half: that the
    // package's root entry point still reaches none of it.
    if (statSync(absolute).isDirectory()) return entry === "flow" ? [] : sourceFiles(absolute)
    return entry.endsWith(".ts") ? [absolute] : []
  })

/** The module specifiers one file imports, split by how it imports them. */
const specifiers = (file: string, kind: "static" | "dynamic"): ReadonlyArray<string> => {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  const found: Array<string> = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (kind === "static") found.push(node.moduleSpecifier.text)
    }
    if (node.kind === ts.SyntaxKind.CallExpression) {
      const call = node as ts.CallExpression
      const first = call.arguments[0]
      if (
        kind === "dynamic" &&
        call.expression.kind === ts.SyntaxKind.ImportKeyword &&
        first !== undefined &&
        ts.isStringLiteral(first)
      ) {
        found.push(first.text)
      }
    }
    node.forEachChild(visit)
  }
  visit(source)
  return found
}

const packages = (specifier: string): string =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? specifier)

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
  optionalDependencies: Record<string, string>
}

describe("the scan surface's dependency boundary", () => {
  it("imports only effect, the node platform, typescript, and node built-ins", () => {
    const allowed = new Set(["effect", "@effect/platform-node", "typescript", "node:fs", "node:path"])
    const found = new Map<string, ReadonlyArray<string>>()
    for (const file of sourceFiles(sourceRoot)) {
      const outside = [...new Set(specifiers(file, "static"))]
        .filter((specifier) => !specifier.startsWith("."))
        .filter((specifier) => !allowed.has(packages(specifier)) && !specifier.startsWith("node:"))
      if (outside.length > 0) found.set(file.slice(packageRoot.length), outside)
    }

    // `Checks.discovery` is the one exception. It reaches the registry through
    // a dynamic import, so `import "@smthrs/migrate"` never loads the runtime,
    // and the next test pins that.
    expect([...found]).toEqual([])
  })

  it("loads the registry only when a check asks for it", () => {
    const text = readFileSync(join(sourceRoot, "Checks.ts"), "utf8")
    const registry = specifiers(join(sourceRoot, "Checks.ts"), "dynamic").filter((specifier) =>
      specifier.startsWith("@smthrs/")
    )

    expect(registry).toEqual(["@smthrs/registry/Discovery"])
    // A static `import ... from "@smthrs/registry/Discovery"` would load the
    // runtime for every consumer of the package's root entry point.
    expect(text).not.toMatch(/^import[^\n]*@smthrs\/registry/m)
    expect(text).toContain("import(\"@smthrs/registry/Discovery\")")
  })

  it("keeps the flow-lane packages out of the hard dependencies", () => {
    // The scanner declares the packages it imports directly, plus the Node
    // adapter's shared platform, which the adapter would otherwise take at
    // the newest release candidate its caret range allows (#2398).
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@effect/platform-node",
      "@effect/platform-node-shared",
      "effect",
      "typescript"
    ])
    expect(Object.keys(manifest.optionalDependencies).every((name) => name.startsWith("@smthrs/"))).toBe(true)
    expect(Object.keys(manifest.optionalDependencies)).toContain("@smthrs/registry")
  })

  it("pins the standalone scanner runtime to the consuming project's Effect family", async () => {
    const { EXPECTED_EFFECT_VERSION } = await import(
      new URL("../../../../scripts/check-single-effect-version.mjs", import.meta.url).href
    )
    // The scanner can run before a project installs the flow runtime. Its own
    // Effect, the Node adapter and its shared platform are hard dependencies
    // at the checked-in family pin. A peer-only shared platform let npm, pnpm
    // and Bun each resolve the adapter's own caret edge to a newer release
    // candidate beside the pinned Effect (#2398).
    for (const name of ["effect", "@effect/platform-node", "@effect/platform-node-shared"]) {
      expect(manifest.dependencies[name]).toBe(EXPECTED_EFFECT_VERSION)
      expect(manifest.devDependencies[name]).toBe(EXPECTED_EFFECT_VERSION)
    }
    expect(manifest.peerDependencies).toBeUndefined()
  })
})
