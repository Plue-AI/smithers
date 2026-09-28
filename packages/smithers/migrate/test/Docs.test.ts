/**
 * The reference page is part of the package's contract: an operator reads it
 * before deciding whether to run `apply`. These tests fail when the page
 * falls behind the code, so a new module or a new mapping row cannot land
 * undocumented.
 *
 * They read `docs/api.md`, the prose the package owns, and not the copy the
 * docs site is stitched from, which the site's own drift gate checks.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as Constructs from "../src/Constructs.ts"
import * as Mapping from "../src/Mapping.ts"

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")

const reference = read("../docs/api.md")
const index = read("../src/index.ts")
const readme = read("../README.md")
const flowSource = read("../src/flow/MigrateFlow.ts")
const manifest = JSON.parse(read("../package.json")) as {
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
}

/** Every namespace `src/index.ts` re-exports, in source order. */
const exportedModules = [...index.matchAll(/export \* as (\w+) from/g)].map((match) => match[1] as string)

/**
 * A Markdown pipe table with the column padding the formatter adds taken back
 * out.
 *
 * `docs/api.md` is package source, so `dprint` aligns every table in it, while
 * `Mapping.markdownTable` renders one cell per row with single spaces. Both
 * are right: the question these tests ask is whether the page carries the
 * table the code produces, not how wide its columns are printed.
 */
/**
 * Prose with its JSDoc gutter and its line wrapping taken out, so a sentence
 * can be looked for as the sentence it is rather than as the bytes one file
 * happens to have wrapped it into.
 */
const unwrapped = (text: string): string => text.replace(/^\s*\*\s?/gm, "").replace(/\s+/g, " ")

const unpadded = (text: string): string =>
  text
    .split("\n")
    .map((line) =>
      line.startsWith("|")
        ? line.replace(/-{3,}/g, "---").replace(/\s+\|/g, " |").replace(/\|\s+/g, "| ")
        : line
    )
    .join("\n")

describe("scanner installation guides", () => {
  it.each(["embed-the-scanners", "scan-a-project"])("%s keeps the native compiler installed", (guide) => {
    const page = read(`../docs/guides/${guide}.md`)
    expect(page).not.toMatch(/--no-optional|--omit[= ]optional|@smthrs\/migrate@next/)
    expect(page).toContain("native compiler")
    expect(page).toContain("(../installation.md)")
  })
})

describe("installation contract", () => {
  /** The Effect packages a manifest field declares, in the order it declares them. */
  const effectPackages = (field: Record<string, string>): ReadonlyArray<string> =>
    Object.keys(field).filter((name) => name === "effect" || name.startsWith("@effect/"))

  it("names each Effect package under the kind package.json declares it as", () => {
    // The README opened by calling all three peers while the manifest installs
    // two of them, so a reader following it would omit a hard dependency.
    const contract = unwrapped(readme).match(/This package declares (.+?)Keep the application/)?.[1]

    expect(contract).toBeDefined()
    const [hard, peer] = (contract as string).split(" dependencies and ")
    expect(peer).toBeDefined()

    for (const name of effectPackages(manifest.dependencies)) {
      expect(hard).toContain(`\`${name}\``)
      expect(peer).not.toContain(`\`${name}\``)
    }
    for (const name of effectPackages(manifest.peerDependencies)) {
      expect(peer).toContain(`\`${name}\``)
      expect(hard).not.toContain(`\`${name}\``)
    }
    for (const half of [hard, peer]) expect(half).toContain(`\`${manifest.dependencies["effect"]}\``)
  })
})

describe("reference page", () => {
  it("documents every module the package exports", () => {
    expect(exportedModules.length).toBeGreaterThan(0)

    const undocumented = exportedModules.filter((name) => !reference.includes(`\n## ${name}\n`))

    expect(undocumented).toEqual([])
  })

  it("heads its module sections in the order src/index.ts exports them", () => {
    const headings = [...reference.matchAll(/^## (\w+)$/gm)]
      .map((match) => match[1] as string)
      .filter((heading) => exportedModules.includes(heading))

    expect(headings).toEqual(exportedModules)
  })

  it("embeds the mapping table verbatim from Mapping.rows", () => {
    expect(unpadded(reference)).toContain(unpadded(Mapping.markdownTable()))
  })

  it("names every catalog construct in the mapping table", () => {
    const table = Mapping.markdownTable()
    const missing = Constructs.constructs.filter((construct) => !table.includes(`\`${construct.name}\``))

    expect(missing.map((construct) => construct.name)).toEqual([])
  })

  it("states the product rule the tool is built around, in the barrel header", () => {
    // The generator projects the barrel's module JSDoc onto the page above
    // this prose, so the rule belongs there and `docs/api.md` must not say it
    // a second time: the page carried both wordings, one after the other.
    // Both sources wrap their prose, so the comparison is on the unwrapped
    // text rather than on the bytes.
    expect(unwrapped(index)).toContain("not a compatibility library")
    expect(unwrapped(index)).toContain("never rewrites or resumes 0.x run state")
    expect(unwrapped(reference)).not.toContain("not a compatibility library")
    expect(unwrapped(reference)).not.toContain("never rewrites or resumes 0.x run state")
  })

  it("scopes each manifest postcondition to the unit kinds the flow runs it for", () => {
    // The page put the legacy-dependency check on the dependencies unit too,
    // where the flow deliberately skips it: the units after it still import
    // the 0.x facade.
    const shared = flowSource.indexOf(`check("every manifest the unit owns still exists"`)
    const legacy = flowSource.indexOf(`check("no manifest declares a 0.x package"`)
    const pin = flowSource.indexOf(`check("effect is pinned to the version this release ships"`)

    expect(shared).toBeGreaterThan(0)
    expect(legacy).toBeGreaterThan(shared)
    expect(pin).toBeGreaterThan(legacy)
    expect(flowSource.slice(shared, legacy)).toContain(`if (outline.kind === "project") {`)
    expect(flowSource.slice(legacy, pin)).not.toContain("outline.kind ===")

    const clauses = (unwrapped(reference).match(/There is one set per kind[\s\S]*?facade\./)?.[0] ?? "").split("; ")
    const legacyClause = clauses.filter((clause) => clause.includes("0.x package"))
    const pinClause = clauses.find((clause) => clause.includes("pin `effect`"))

    expect(legacyClause).toHaveLength(1)
    expect(legacyClause[0]).toContain("a project unit's manifests")
    expect(legacyClause[0]).not.toContain("a dependencies or project unit")
    expect(pinClause).toBeDefined()
    expect(pinClause).toContain("a dependencies or project unit")
  })

  it("documents the three modes and the three exit codes", () => {
    for (const mode of ["`scan`", "`plan`", "`apply`"]) expect(reference).toContain(mode)
    for (const line of ["| 0 |", "| 1 |", "| 3 |"]) expect(unpadded(reference)).toContain(line)
  })
})

describe("mapping table rendering", () => {
  it("renders one row per mapping row plus a header and a separator", () => {
    const lines = Mapping.markdownTable().split("\n")

    expect(lines).toHaveLength(Mapping.rows.length + 2)
    expect(lines[0]).toBe("| Old construct | New target | Module | Class |")
    expect(lines[1]).toBe("| --- | --- | --- | --- |")
  })

  it("is deterministic across renders", () => {
    expect(Mapping.markdownTable()).toBe(Mapping.markdownTable())
  })

  it("writes `none` for a construct with no target, never an empty cell", () => {
    const table = Mapping.markdownTable()
    const withoutTarget = Mapping.rows.filter((row) => row.target === null)

    expect(withoutTarget.length).toBeGreaterThan(0)
    for (const row of withoutTarget) {
      expect(table).toContain(`| \`${row.construct}\` | none | none | ${row.class} |`)
    }
    expect(table).not.toContain("|  |")
  })
})

/**
 * Pages that describe what `--apply` executes and what the report keeps. An
 * operator commits `report.json` and runs `--apply` on the strength of these
 * sentences, so they must match `src/flow/Verify.ts`.
 */
describe("security claims", () => {
  const pages = ["api.md", "quickstart.md", "concepts/report.md", "guides/set-verification-commands.md"]

  it.each(pages)("%s never says verification output goes unredacted", (page) => {
    const text = unwrapped(read(`../docs/${page}`))
    expect(text).not.toMatch(/nothing redacts/i)
    expect(text).not.toMatch(/captured verbatim/i)
  })

  it("keeps the redaction the pages describe in Verify.ts", () => {
    const verify = read("../src/flow/Verify.ts")
    expect(verify).toContain("stdoutTail: redact(")
    expect(verify).toContain("stderrTail: redact(")
  })

  it.each(["quickstart.md", "guides/set-verification-commands.md"])(
    "%s warns that --apply runs the project's own commands",
    (page) => {
      const text = unwrapped(read(`../docs/${page}`))
      expect(text).toContain("runs the project's own install, format, typecheck, and test commands")
      expect(text).toMatch(/trusted checkout or inside a sandbox/)
    }
  )
})
