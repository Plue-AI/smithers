/**
 * The person-facing `query` rendering: a listing as aligned columns, a
 * `deps()` answer as a root and its closure, and no escape sequences with
 * the default palette.
 */
import { describe, expect, it } from "vitest"
import * as Ansi from "../src/Ansi.ts"
import * as Query from "../src/Query.ts"

const listing: Query.Listing = {
  query: "//...",
  targets: [
    { label: "//src:build", target: "Rspack.Build", kinds: ["build"] },
    { label: "//src:lint", target: "Biome.Lint", kinds: ["lint"] },
    { label: "//src/Server:test", target: "Jest.Test", kinds: ["test"] }
  ]
}

describe("Query.text", () => {
  it("aligns a listing into LABEL, TARGET, and KINDS columns", () => {
    expect(Query.text(listing)).toBe([
      "LABEL              TARGET        KINDS",
      "//src:build        Rspack.Build  build",
      "//src:lint         Biome.Lint    lint",
      "//src/Server:test  Jest.Test     test"
    ].join("\n"))
  })

  it("colours kinds and dims the rule without changing the text", () => {
    const styled = Query.text(listing, Ansi.colors)
    expect(Ansi.strip(styled)).toBe(Query.text(listing))
    expect(styled).toContain("\u001b[34mbuild\u001b[39m")
    expect(styled).toContain("\u001b[33mlint\u001b[39m")
    expect(styled).toContain("\u001b[32mtest\u001b[39m")
  })

  it("renders a package refusal in plain and coloured listings", () => {
    const refused: Query.Listing = {
      query: "//src:missing",
      targets: [{
        label: "//src:missing",
        target: "Repo.Target",
        kinds: ["build"],
        refusal: "repository unavailable"
      }]
    }
    const plain = [
      "LABEL          TARGET       KINDS",
      "//src:missing  Repo.Target  build  (refused: repository unavailable)"
    ].join("\n")

    expect(Query.text(refused)).toBe(plain)
    expect(Ansi.strip(Query.text(refused, Ansi.colors))).toBe(plain)
  })

  it("names an empty listing", () => {
    expect(Query.text({ query: "//nope", targets: [] })).toBe("no targets match //nope")
  })

  it.each(
    [
      [[], "//:root is depended on by 0 targets"],
      [["//:one"], "//:root is depended on by 1 target\n  //:one"],
      [["//:second", "//:first"], "//:root is depended on by 2 targets\n  //:second\n  //:first"]
    ] as const
  )("renders reverse dependencies %j without changing their order", (dependents, expected) => {
    const result: Query.Dependents = { query: "rdeps(//:root)", root: "//:root", dependents }
    const before = structuredClone(result)
    expect(Query.text(result)).toBe(expected)
    expect(Ansi.strip(Query.text(result, Ansi.colors))).toBe(expected)
    expect(result).toEqual(before)
  })

  it.each(
    [
      [[], [], "//app agents: inherit\n  no owners"],
      [[], ["//core", "//ui"], "//app agents: inherit\n  no owners\ndepends on //core //ui"],
      [
        [{ owner: "alice", role: "maintainer", reasons: ["declared", "parent"] }],
        [],
        "//app agents: inherit\n  alice                     maintainer  declared, parent"
      ],
      [
        [
          { owner: "alice", role: "maintainer", reasons: ["declared", "parent"] },
          { owner: "an-owner-name-beyond-width", role: "reviewer", reasons: [] }
        ],
        ["//core"],
        "//app agents: inherit\n  alice                     maintainer  declared, parent\n  an-owner-name-beyond-width  reviewer  \ndepends on //core"
      ]
    ] as const
  )("renders owners %j and upstream %j", (owners, upstream, expected) => {
    const result: Query.PackageOwners = {
      query: "owners(//app:build)",
      package: "//app",
      agentPolicy: "inherit",
      owners,
      upstream
    }
    const before = structuredClone(result)
    expect(Query.text(result)).toBe(expected)
    expect(Ansi.strip(Query.text(result, Ansi.colors))).toBe(expected)
    expect(result).toEqual(before)
  })

  it("applies the selected palette to ownership headings, reasons and upstream", () => {
    const style: Ansi.Palette = {
      ...Ansi.none,
      bold: (value) => `<bold>${value}</bold>`,
      dim: (value) => `<dim>${value}</dim>`
    }
    expect(Query.text({
      query: "owners(//app:build)",
      package: "//app",
      owners: [{ owner: "alice", role: "maintainer", reasons: ["declared"] }],
      agentPolicy: "restricted",
      upstream: ["//core"]
    }, style)).toBe([
      "<bold>//app</bold> <dim>agents: restricted</dim>",
      "  alice                     maintainer  <dim>declared</dim>",
      "<dim>depends on //core</dim>"
    ].join("\n"))
  })

  it("renders deps() as the root over its closure", () => {
    const rendered = Query.text({
      query: "deps(//src:build)",
      root: "//src:build",
      dependencies: ["//src:assets", "//src:lib"],
      edges: [{ from: "//src:lib", to: "//src:build" }]
    })
    expect(rendered).toBe("//src:build depends on 2 targets\n  //src:assets\n  //src:lib")
    expect(Query.text({ query: "deps(//:x)", root: "//:x", dependencies: ["//:y"], edges: [] }))
      .toBe("//:x depends on 1 target\n  //:y")
  })
})

describe("Query.text with an unknown kind", () => {
  it("prints a kind it has no colour for as plain text", () => {
    const styled = Query.text({
      query: "//:x",
      targets: [{ label: "//:x", target: "Custom", kinds: ["custom" as never] }]
    }, Ansi.colors)
    expect(Ansi.strip(styled)).toContain("//:x   Custom  custom")
    expect(styled.endsWith("  custom")).toBe(true)
  })
})
