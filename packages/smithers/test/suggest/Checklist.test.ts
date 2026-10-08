/**
 * The suggestion checklist over in-memory repositories: the order, what each
 * check reads, and that the heavy suggestions are held back as follow-ups.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Checklist from "../../src/suggest/Checklist.ts"

const collect = async (repository: Checklist.Repository): Promise<ReadonlyArray<Checklist.Suggestion>> => {
  const items: Array<Checklist.Suggestion> = []
  for await (const suggestion of Checklist.scan(repository)) items.push(suggestion)
  return items
}

const full = Checklist.memoryRepository("/repo", {
  "package.json": JSON.stringify({
    name: "acme",
    packageManager: "pnpm@10.0.0",
    workspaces: ["packages/*"],
    scripts: { test: "vitest run", lint: "eslint .", release: "changeset publish" }
  }),
  "pnpm-lock.yaml": "",
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  "vitest.config.ts": "export default {}",
  "eslint.config.js": "export default []",
  "tsconfig.json": "{}",
  ".git/config": "[remote \"origin\"]\n\turl = git@github.com:acme/acme.git\n",
  ".github/workflows/ci.yml": "name: ci",
  "CHANGELOG.md": "# Changelog",
  "packages/core/package.json": "{}"
})

describe("Checklist.evidence", () => {
  it("reads the package manager, scripts, runner, lint, CI, remote, layout, and changelog", () => {
    const facts = Checklist.evidence(full)

    expect(facts).toEqual({
      machine: {
        detectorVersion: "smithers.toolchain-detect/v4",
        tools: { node: { version: "", file: "package.json" }, pnpm: { version: "10.0.0", file: "package.json" } },
        packageManager: "pnpm",
        installs: [{
          command: ["pnpm", "install", "--frozen-lockfile"],
          offline: ["pnpm", "install", "--offline", "--frozen-lockfile"],
          files: ["package.json", "pnpm-lock.yaml"],
          destinations: ["registry.npmjs.org", "registry.yarnpkg.com"]
        }],
        checks: [{ id: "test", argv: ["pnpm", "test"] }, { id: "lint", argv: ["pnpm", "lint"] }]
      },
      checks: [{ id: "test", argv: ["pnpm", "test"] }, { id: "lint", argv: ["pnpm", "lint"] }],
      packageManager: "pnpm",
      scripts: { test: "vitest run", lint: "eslint .", release: "changeset publish" },
      testRunner: "vitest",
      lint: ["eslint.config.js"],
      ci: [".github/workflows/ci.yml"],
      flows: [],
      packageFile: false,
      github: true,
      git: true,
      monorepo: ["pnpm-workspace.yaml", "package.json#workspaces", "packages"],
      agentsFile: undefined,
      changelog: "CHANGELOG.md",
      language: ["javascript", "typescript"]
    })
  })

  it("falls back to the lockfile for the package manager and to config files for the runner", () => {
    const facts = Checklist.evidence(Checklist.memoryRepository("/repo", {
      "package.json": JSON.stringify({ name: "x" }),
      "bun.lock": "",
      "jest.config.js": "",
      "AGENTS.md": "# Agents"
    }))

    expect(facts.packageManager).toBe("bun")
    expect(facts.testRunner).toBe("jest")
    expect(facts.agentsFile).toBe("AGENTS.md")
    expect(facts.git).toBe(false)
  })

  it("survives an unreadable manifest", () => {
    const facts = Checklist.evidence(Checklist.memoryRepository("/repo", { "package.json": "{not json" }))

    expect(facts.scripts).toEqual({})
    expect(facts.packageManager).toBe("npm")
  })
})

describe("Checklist.scan", () => {
  it("streams every match in the documented order, cheap first and the heavy ones as follow-ups", async () => {
    const items = await collect(full)

    expect(items.map((item) => item.id)).toEqual([
      "test-target",
      "lint-target",
      "agents-md",
      "release-notes",
      "pr-review",
      "repeated-script",
      "changelog",
      "build-graph",
      "sandboxed-review"
    ])
    expect(items.map((item) => item.followUp)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true
    ])
    expect(items.map((item) => item.effort)).toEqual([
      "small",
      "small",
      "small",
      "small",
      "medium",
      "medium",
      "small",
      "large",
      "large"
    ])
  })

  it("cites the files each check read", async () => {
    const byId = new Map((await collect(full)).map((item) => [item.id, item]))

    // Only the runner file this repository actually carries is cited: the
    // check reads the tree, so `vitest.config.mts` and the rest of the
    // vitest spellings are absent here because they are absent on disk.
    expect(byId.get("test-target")!.why).toBe(
      "vitest is the test runner (package.json, vitest.config.ts), so a target keyed on its inputs skips the tests whose inputs did not change"
    )
    expect(byId.get("test-target")!.files).toEqual(["package.json", "vitest.config.ts"])
    expect(byId.get("lint-target")!.files).toEqual(["eslint.config.js"])
    expect(byId.get("pr-review")!.files).toEqual([".git/config", ".github/workflows/ci.yml"])
    expect(byId.get("repeated-script")!.title).toBe("A flow for the repeated task `release` reveals")
    expect(byId.get("build-graph")!.why).toContain("no PACKAGE.ts")
    expect(byId.get("test-target")!.followUps.map((followUp) => followUp.id)).toEqual(["ci", "incremental"])
    expect(byId.get("agents-md")!.followUps.map((followUp) => followUp.id)).toEqual(["ci"])
  })

  it("matches nothing on an empty directory", async () => {
    expect(await collect(Checklist.memoryRepository("/repo", {}))).toEqual([])
  })

  it("skips agents-md when one exists, build-graph when PACKAGE.ts exists, and changelog without git", async () => {
    const items = await collect(Checklist.memoryRepository("/repo", {
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "CLAUDE.md": "# Claude",
      "PACKAGE.ts": "export const Package = {}",
      "pnpm-workspace.yaml": "",
      "CHANGELOG.md": "#"
    }))

    expect(items.map((item) => item.id)).toEqual(["test-target"])
    expect(items[0]!.why).toBe(
      "node --test is the test runner (package.json), so a target keyed on its inputs skips the tests whose inputs did not change"
    )
  })

  it("offers a review only for a GitHub remote, and release notes for any git repository", async () => {
    const items = await collect(Checklist.memoryRepository("/repo", {
      ".git/config": "[remote \"origin\"]\n\turl = https://gitlab.com/acme/acme.git\n"
    }))

    expect(items.map((item) => item.id)).toEqual(["release-notes"])
  })
})

describe("Checklist.repository", () => {
  let root: string | undefined

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  })

  it("reads a real directory the same way the memory reader does", async () => {
    root = mkdtempSync(join(tmpdir(), "smthrs-suggest-checklist-"))
    mkdirSync(join(root, "flows", "ship"), { recursive: true })
    writeFileSync(join(root, "flows", "ship", "flow.mdx"), "---\ndescription: x\n---\n")
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }))
    writeFileSync(join(root, "biome.json"), "{}")
    const reader = Checklist.repository(root)

    expect(reader.exists("flows")).toBe(true)
    expect(reader.list("flows")).toEqual(["ship"])
    expect(reader.list("package.json")).toEqual([])
    expect(reader.read("missing")).toBeUndefined()
    expect(Checklist.evidence(reader).flows).toEqual(["flows/ship/flow.mdx"])
    expect((await collect(reader)).map((item) => item.id)).toEqual(["test-target", "lint-target", "agents-md"])
  })
})
