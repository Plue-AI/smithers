/**
 * The README's public-export table, checked against the barrel.
 *
 * `src/index.ts` claimed the table was generated from its list. Nothing
 * generated it, and nothing compared it either, so three exports added by the
 * commit that made the claim never reached the table. This is the comparison:
 * every module the barrel exports has a row, and every runtime export it
 * carries is named in that row. Types are not checked — they are erased before
 * a namespace object exists — so a row may name more than this file can see,
 * never less.
 *
 * The README's TypeScript example is checked the same way, against
 * `fixtures/readme-example.ts`. The fixture is inside `tsconfig.test.json`, so
 * the package typecheck compiles the published example and this file proves the
 * two have not drifted apart.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Cli from "../src/index.ts"

const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8")

/** The table's `| \`Module\` | \`a\`, \`b\` | description |` rows, by module. */
const rows = new Map(
  readme.split("\n")
    .filter((line) => /^\|\s*`/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .map(([module, exported]) =>
      [
        (module ?? "").replaceAll("`", ""),
        (exported ?? "").split(",").map((name) => name.trim().replaceAll("`", "")).filter((name) => name !== "")
      ] as const
    )
)

describe("the README public-export table", () => {
  it("has a row for every module the barrel exports", () => {
    const missing = Object.keys(Cli).filter((module) => !rows.has(module))

    expect(missing).toEqual([])
  })

  for (const [module, namespace] of Object.entries(Cli)) {
    it(`names every runtime export of ${module}`, () => {
      const listed = rows.get(module) ?? []
      const missing = Object.keys(namespace as Record<string, unknown>).filter((name) => !listed.includes(name))

      expect(missing).toEqual([])
    })
  }
})

/** The `ts` fenced blocks in the README, in order. */
const snippets = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? "")

/**
 * The compiled fixture, with its explanatory header and the export that keeps
 * `main` from being an unused local removed, so what remains is the example.
 */
const compiled = readFileSync(fileURLToPath(new URL("./fixtures/readme-example.ts", import.meta.url)), "utf8")
  .replace(/^\/\*\*[\s\S]*?\*\/\n/, "")
  .replace(/\n\nexport \{ main \}\n$/, "\n")

describe("the README example", () => {
  it("is the one the package typecheck compiles", () => {
    // A README example nothing compiles rots silently: this one called
    // `makeConfig` with one argument for as long as it took the signature to
    // grow two more parameters.
    expect(snippets).toHaveLength(1)
    expect(snippets[0]).toBe(compiled)
  })
})

describe("the CLI documentation contracts", () => {
  it("documents crash cleanup once", () => {
    const guide = readFileSync(new URL("../docs/guides/diagnose-a-run.md", import.meta.url), "utf8")

    expect(guide.match(/^## What happens to subprocesses after a crash\?$/gm)).toHaveLength(1)
  })

  it("describes the bin entry as the dispatcher between the Incur tree and the legacy tree", () => {
    const row = readme.split("\n").find((line) => line.startsWith("| `bin` / `smthrs`"))
    expect(row).toContain("`Cli.makeCli`")
    expect(row).toContain("`cli/LegacyBin`")
  })

  it("does not credit bin.ts with the reporting that moved to cli/LegacyBin.ts and cli/Entry.ts", () => {
    // `bin.ts` only picks an entry; the reporter, the exit status and the
    // `--help`/`--version` scan live in the two modules it loads.
    const stale = /`bin\.ts` (?:prints|hands|reads|answers)|through `bin\.ts`|rather than in `bin\.ts`/
    const files = ["CliError.ts", "Unsupported.ts", "Command.ts", "Providers.ts", "internal/Failure.ts"]
      .filter((file) => stale.test(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")))
    const tests = readFileSync(new URL("./Unsupported.test.ts", import.meta.url), "utf8")
    expect(files).toEqual([])
    expect(stale.test(tests)).toBe(false)
  })

  it("does not promise unimplemented legacy environment aliases", () => {
    expect(Cli.Environment.names.every(({ name }) => name.startsWith("SMITHERS_"))).toBe(true)
    expect(readme).not.toContain("FLOWS_*")
  })

  it("describes the manifest's direct Effect dependencies and sole SQLite peer", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    const introduction = readme.split("**Documentation:**")[0]!.replace(/\s+/g, " ")

    expect(manifest.dependencies.effect).toBe(manifest.dependencies["@effect/platform-node"])
    expect(Object.keys(manifest.peerDependencies)).toEqual(["@effect/sql-sqlite-node"])
    expect(introduction).toContain(
      `\`effect\` and \`@effect/platform-node\` as exact \`${manifest.dependencies.effect}\` direct dependencies`
    )
    expect(introduction).toContain(
      `\`@effect/sql-sqlite-node\` is the sole peer dependency, required at \`${
        manifest.peerDependencies["@effect/sql-sqlite-node"]
      }\``
    )
  })
})

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, string | null>
  sideEffects: ReadonlyArray<string>
}

/** Export-map subpaths with a literal target, minus the leading `./`. */
const subpaths = Object.entries(manifest.exports)
  .filter(([key, target]) => !key.includes("*") && target !== null && key !== "." && key !== "./package.json")
  .map(([key]) => key.slice(2))

/** The README's subpath-only list: `- \`@smthrs/cli/<dir>/<Module>\`` lines under its heading. */
const subpathOnly = ((readme.split("### Subpath-only modules\n")[1] ?? "").split("\n## ")[0] ?? "")
  .split("\n")
  .flatMap((line) => {
    const match = /^- `@smthrs\/cli\/([^`]+)`/.exec(line)
    return match === null ? [] : [match[1]!]
  })

describe("the export map", () => {
  it("makes every top-level subpath a barrel namespace, and every namespace a subpath", () => {
    // `bin` and `index` are the executable and the barrel itself, never namespaces.
    const topLevel = subpaths.filter((key) => !key.includes("/") && key !== "bin" && key !== "index")

    expect(topLevel.sort()).toEqual(Object.keys(Cli).sort())
  })

  it("lists every nested subpath in the README's subpath-only section, and nothing else", () => {
    // The barrel holds no namespace for these, so `Object.keys(Cli)` above
    // cannot see one that is added or dropped; this row-for-row comparison can.
    const nested = subpaths.filter((key) => key.includes("/"))

    expect(subpathOnly.sort()).toEqual(nested.sort())
  })

  it("declares every module that runs the CLI at import as a side effect", () => {
    // A bundler that honours `sideEffects` prunes an import whose bindings are
    // unused. `bin.ts` loads `cli/LegacyBin.ts` for its `NodeRuntime.runMain`
    // alone, so both must be listed as source and as each compiled output.
    const entries = subpaths.filter((key) =>
      /^NodeRuntime\.runMain\(/m.test(readFileSync(new URL(`../src/${key}.ts`, import.meta.url), "utf8"))
    )
    const missing = entries.flatMap((key) =>
      [`./src/${key}.ts`, `./dist/esm/${key}.js`, `./dist/cjs/${key}.js`].filter((path) =>
        !manifest.sideEffects.includes(path)
      )
    )

    expect(entries).toContain("cli/LegacyBin")
    expect(missing).toEqual([])
  })
})
