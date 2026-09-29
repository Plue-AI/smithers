import { describe, expect, it } from "vitest"
import * as Core from "../src/internal/CoreRuleSelection.ts"

describe("core rule contract boundary", () => {
  it("requires an executable at cardinalities zero, one, and two", () => {
    expect(Core.argvOf(undefined)).toBeUndefined()
    expect(Core.argvOf([])).toBeUndefined()
    expect(Core.argvOf(["node"])).toEqual(["node"])
    expect(Core.argvOf(["node", "test.mjs"])).toEqual(["node", "test.mjs"])
  })

  it.each(
    [
      ["process", ["Shell.Build", "Shell.Test", "Shell.Run", "Shell.Diff"]],
      ["language", [
        "Go.Binary",
        "Go.ModDownload",
        "Go.Test",
        "Go.Fuzz",
        "Go.Lint",
        "Go.Generate",
        "Foundry.Build",
        "Foundry.Test",
        "Foundry.Fmt"
      ]],
      ["container", ["Docker.Build", "Docker.Bake"]]
    ] as const
  )("requires resolved argv for %s rules", (family, rules) => {
    for (const rule of rules) {
      expect(Core.select(rule, undefined)).toBeUndefined()
      expect(Core.select(rule, [])).toBeUndefined()
      expect(Core.select(rule, ["tool", "--flag"])).toEqual({ family, rule, lane: undefined, argv: ["tool", "--flag"] })
    }
  })

  it.each(
    [
      ["generated", ["Generate", "Owners.Codeowners", "Owners.Tree"]],
      ["value", ["Filegroup", "Cargo.AppSet", "Go.Packages", "Suite", "Alias", "Materialize", "Clean", "Install"]]
    ] as const
  )("admits %s rules without a command", (family, rules) => {
    for (const rule of rules) expect(Core.select(rule, undefined)).toEqual({ family, rule, lane: undefined })
  })

  it.each([
    "Fetch",
    "Shell.Serve",
    "Docker.Serve",
    "Docker.Service",
    "Docker.Push",
    "Anvil.Fork",
    "ImportClosure",
    "Test",
    "Bundler.Rspack.resolve",
    "Bundler.Rspack.build",
    "Agent.Lint",
    "Agent.Diff",
    "Agent.Pr",
    "Docs.Page",
    "Docs.Check",
    "Git.Commit",
    "Github.CiGen",
    "Github.Setup",
    "Github.Workflow",
    "Github.Pr",
    "Npm.Pack",
    "Copy",
    "Literal",
    "Git.Submodules",
    "Git.Submodule",
    "Changesets.Version",
    "Size.Budgets",
    "Markdown.CodeBlocks",
    "Npm.Published",
    "Api.Compat",
    "Overlay",
    "Cron",
    "Npm.Downstream",
    "Npm.Publish",
    "Changesets.Publish",
    "Github.Release",
    "Github.Pages",
    "Git.Pr",
    "Memory.Retain",
    "Cargo.Fetch",
    "Cargo.Build",
    "Cargo.Test",
    "Cargo.Nextest",
    "Cargo.Clippy",
    "Cargo.Deny",
    "Cargo.Fmt",
    "Cargo.Doc",
    "Repo.Target"
  ])("refuses %s when its native payload was not planned", (rule) => {
    expect(() => Core.select(rule, ["tool"])).toThrow(new TypeError(`${rule} requires its native planned payload`))
  })

  it("admits custom declaration names only through the explicit body boundary", () => {
    expect(Core.select("Fixture.Custom", undefined)).toEqual({
      family: "body",
      rule: "Fixture.Custom",
      lane: undefined
    })
    expect(Core.select("toString", undefined)).toEqual({ family: "body", rule: "toString", lane: undefined })
  })
})
