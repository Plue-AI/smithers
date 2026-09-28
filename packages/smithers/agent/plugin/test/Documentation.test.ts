import { Effect } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Resolve from "../src/Resolve.ts"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const read = (file: string) => readFileSync(join(packageRoot, file), "utf8")

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const refusal = async (input: unknown, options?: Resolve.Options) =>
  run(Resolve.resolve(input as never, options).pipe(Effect.flip))

/** Every published limit, as the reference table names it, and the input that violates it. */
const violations: Readonly<Record<string, () => Promise<{ readonly code: string }>>> = {
  maximumPlugins: () =>
    refusal(Array.from({ length: Resolve.maximumPlugins + 1 }, (_, index) => ({ name: `p-${index}` }))),
  maximumHandlers: () => {
    const names = Array.from({ length: 5 }, (_, index) => `h-${index}`)
    const hooks = Object.fromEntries(names.map((name) => [name, () => Effect.void]))
    const catalog = Object.fromEntries(names.map((name) => [name, "sequential" as const]))
    return refusal(
      Array.from({ length: Resolve.maximumPlugins }, (_, index) => ({ name: `p-${index}`, hooks })),
      { hooks: catalog } as never
    )
  },
  maximumPluginInputNodes: () => refusal(Array.from({ length: Resolve.maximumPluginInputNodes }, () => false)),
  maximumPluginDepth: () => {
    let nested: unknown = { name: "deep" }
    for (let index = 0; index <= Resolve.maximumPluginDepth; index++) nested = [nested]
    return refusal(nested)
  },
  maximumParallelConcurrency: () => refusal([], { parallelConcurrency: Resolve.maximumParallelConcurrency + 1 }),
  maximumPluginNameLength: () => refusal([{ name: "x".repeat(Resolve.maximumPluginNameLength + 1) }])
}

describe("reference documentation matches admission", () => {
  it("attributes every published limit to the code the kernel actually reports", async () => {
    const table = /### Limits\n\n((?:\|.*\n)+)/.exec(read("docs/api.md"))
    expect(table, "docs/api.md must publish a limits table").not.toBeNull()
    const rows = table![1]!.split("\n").slice(2).filter((row) => row.startsWith("|")).map((row) => {
      const [constant, value, refused] = row.split("|").slice(1, 4).map((cell) => cell.trim())
      return { constant: constant!.replaceAll("`", ""), value: Number(value!.replaceAll(",", "")), refused: refused! }
    })

    const constants = Object.entries(Resolve).filter(([, value]) => typeof value === "number").map(([name]) => name)
    expect(rows.map((row) => row.constant).sort()).toEqual([...constants].sort())

    for (const row of rows) {
      expect(row.value, row.constant).toBe(Resolve[row.constant as keyof typeof Resolve])
      const violate = violations[row.constant]
      if (violate === undefined) {
        // The one row that is a default rather than a bound: nothing can exceed it.
        expect(row.refused, row.constant).toBe("none, it is the default value")
        expect((await run(Resolve.resolve([]))).parallelConcurrency).toBe(row.value)
        continue
      }
      expect(`\`${(await violate()).code}\``, row.constant).toBe(row.refused)
    }
  })

  it("bounds the nested-preset promise by the depth resolution enforces", async () => {
    const jsdoc = /\/\*\*(?:[^*]|\*(?!\/))*\*\/(?=\s*export type PluginInput)/.exec(read("src/Plugin.ts"))
    expect(jsdoc?.[0]).toContain("maximumPluginDepth")
    for (const prose of [jsdoc?.[0] ?? "", read("docs/api.md"), read("docs/concepts/resolution.md")]) {
      expect(prose).not.toMatch(/arbitrarily nested|nested arrays flatten to any depth/i)
    }

    let nested: unknown = { name: "deep" }
    for (let index = 0; index <= Resolve.maximumPluginDepth; index++) nested = [nested]
    expect(await refusal(nested)).toMatchObject({ code: "resource_limit" })
  })

  it("describes error paths in the dollar-path notation the kernel emits", async () => {
    const key = "not an identifier"
    const bracket = await refusal([{ name: "p", hooks: { [key]: () => Effect.void } }])
    expect(bracket.path).toBe(`$[0].hooks[${JSON.stringify(key)}]`)
    const option = await refusal([], { parallelConcurrency: 0 })
    expect(option.path).toBe("$options.parallelConcurrency")

    for (const page of ["docs/api.md", "docs/troubleshooting.md"]) {
      const text = read(page)
      expect(text, page).toContain("dollar-path")
      expect(text, page).not.toMatch(/is a JSON pointer/i)
      expect(text, page).toContain(`[${JSON.stringify(key)}]`)
      expect(text, page).toContain(option.path)
    }
  })

  it("names exactly the runtime dependencies the sources import", () => {
    const manifest = JSON.parse(read("package.json")) as {
      readonly dependencies: Record<string, string>
      readonly peerDependencies: Record<string, string>
    }
    const imported = new Set<string>()
    for (const entry of readdirSync(join(packageRoot, "src"), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue
      const source = readFileSync(join(entry.parentPath, entry.name), "utf8")
      for (const match of source.matchAll(/(?:from|import\()\s*"([^"]+)"/g)) {
        const specifier = match[1]!
        if (specifier.startsWith(".") || specifier.startsWith("node:")) continue
        const name = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0]!
        if (name in manifest.peerDependencies) continue
        imported.add(name)
      }
    }

    const declared = Object.keys(manifest.dependencies)
    expect(declared.sort()).toEqual([...imported].sort())
    for (const page of ["docs/README.md", "docs/installation.md", "docs/api.md"]) {
      for (const dependency of declared) expect(read(page), page).toContain(dependency)
    }
  })
})
