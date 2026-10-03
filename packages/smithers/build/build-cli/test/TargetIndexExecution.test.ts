/**
 * `TargetIndex` end to end: a temp workspace whose root PACKAGE.ts declares a
 * test, a suite over it, a generator, and the index target, driven through
 * the CLI verbs.
 *
 * `target --write` writes `.smithers/target-index.json` with one row per
 * labeled target, sorted by label, carrying only what the declarations state;
 * `lint` checks it, reds on a missing file, and reds again after a declaration
 * changes, because the planner-filled rows are key material; `index` prints
 * the same rows.
 */
import * as Input from "@smthrs/targets/Input"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type * as TargetIndex from "../src/TargetIndex.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const workspaceModule = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("indexed", {
  repository: "git+https://example.invalid/indexed.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`

const packageModule = (extra = "") =>
  `import { Smithers as S } from "@smthrs/targets"
const good = S.Shell.Test({ shell: "true" })
const all = S.Suite({ tests: [good] })
const notes = S.Generate({
  summary: "Regenerate NOTES.md.",
  featured: true,
  script: S.file("//scripts/notes.mjs"),
  data: [S.file("//package.json"), S.glob("docs/**/*.md")],
  changes: ["NOTES.md"],
})
const targetIndex = S.TargetIndex({ summary: "Index every target." })
${extra}
export const Package = S.Package({ targets: { all, good, notes, targetIndex${extra === "" ? "" : ", later"} } })
`

const fixture = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-target-index-")))
  temporaryDirectories.push(root)
  await write(root, "package.json", `{ "name": "indexed", "private": true }\n`)
  await write(root, "yarn.lock", "")
  await write(root, ".smithers/WORKSPACE.ts", workspaceModule)
  await write(root, "PACKAGE.ts", packageModule())
  await write(root, "docs/notes.md", "notes\n")
  await write(root, "scripts/notes.mjs", "process.stdout.write('')\n")
  return root
}

const indexOf = async (root: string): Promise<ReadonlyArray<TargetIndex.Row>> =>
  JSON.parse(await Fs.readFile(NodePath.join(root, ".smithers/target-index.json"), "utf8"))

describe("TargetIndex through the CLI", () => {
  it("reds on the missing file, writes one row per target under --write, checks it, and reds after a declaration edit", async () => {
    const root = await fixture()

    const missing = await serve(root, ["lint", "//:targetIndex"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs + missing.output).toContain(".smithers/target-index.json")

    const written = await serve(root, ["target", "//:targetIndex", "--write"])
    expect(written.exitCode, written.logs).toBe(0)
    const raw = await Fs.readFile(NodePath.join(root, ".smithers/target-index.json"), "utf8")
    expect(raw.endsWith("]\n")).toBe(true)
    expect(raw).not.toContain(root)
    const rows = await indexOf(root)
    expect(rows.map((row) => row.label)).toEqual(["//:all", "//:good", "//:notes", "//:targetIndex"])
    expect(rows.find((row) => row.label === "//:notes")).toEqual({
      label: "//:notes",
      package: "",
      name: "notes",
      rule: "Generate",
      kinds: ["run", "lint"],
      summary: "Regenerate NOTES.md.",
      featured: true,
      mode: "write",
      cacheable: false,
      inputs: [
        { kind: "file", path: "scripts/notes.mjs" },
        { kind: "file", path: "package.json" },
        { kind: "glob", pattern: "docs/**/*.md", exclude: [] }
      ],
      outputs: ["NOTES.md"],
      dependencies: [],
      source: { file: "PACKAGE.ts" }
    })
    expect(rows.find((row) => row.label === "//:all")).toMatchObject({
      rule: "Suite",
      kinds: ["test"],
      dependencies: ["//:good"],
      outputs: []
    })
    expect(rows.find((row) => row.label === "//:targetIndex")).toMatchObject({
      rule: "TargetIndex",
      kinds: ["build", "lint"],
      mode: "check",
      inputs: [{ kind: "file", path: ".smithers/target-index.json" }],
      outputs: [".smithers/target-index.json"]
    })
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("key")
      expect(Object.keys(row)).not.toContain("digest")
      for (const input of row.inputs) expect(Object.keys(input)).not.toContain("_tag")
    }

    const fresh = await serve(root, ["lint", "//:targetIndex"])
    expect(fresh.exitCode, fresh.logs).toBe(0)
    expect(await indexOf(root)).toEqual(rows)

    await write(root, "PACKAGE.ts", packageModule(`const later = S.Shell.Test({ shell: "true" })`))
    const drifted = await serve(root, ["lint", "//:targetIndex"])
    expect(drifted.exitCode).toBe(1)
    expect(drifted.logs).toContain("drifted")
    expect(await indexOf(root)).toEqual(rows)

    const rewritten = await serve(root, ["target", "//:targetIndex", "--write"])
    expect(rewritten.exitCode, rewritten.logs).toBe(0)
    expect((await indexOf(root)).map((row) => row.label)).toEqual([
      "//:all",
      "//:good",
      "//:later",
      "//:notes",
      "//:targetIndex"
    ])
  })

  it("refuses a renamed declared file with its path, label and source file", async () => {
    // T-PRC-01 / spec §21.2: literal diagnostics, no source line required.
    const root = await fixture()
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    await Fs.rename(NodePath.join(root, "scripts/notes.mjs"), NodePath.join(root, "scripts/renamed.mjs"))
    const refused = await serve(root, ["lint", "//:targetIndex"])
    expect(refused.exitCode).toBe(1)
    expect(refused.logs + refused.output).toContain("scripts/notes.mjs")
    expect(refused.logs + refused.output).toContain("//:notes")
    expect(refused.logs + refused.output).toContain("PACKAGE.ts")
  })

  it("fails only the index row and still executes an independent lint row", async () => {
    // T-PRC-01: missing declarations fail the check executor, not planning.
    const root = await fixture()
    await write(root, "PACKAGE.ts", packageModule("const later = S.Shell.Diff({ shell: \"true\", changes: [] })"))
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    await Fs.rm(NodePath.join(root, "scripts/notes.mjs"))
    const result = await serve(root, ["lint", "//:targetIndex", "//:later"])
    expect(result.exitCode).toBe(1)
    expect(result.logs + result.output).toContain("//:targetIndex")
    expect(result.logs + result.output).toContain("//:later")
    expect(result.logs + result.output).toContain("Missing declared input scripts/notes.mjs for //:notes (")
    expect(result.logs + result.output).toMatch(/\/\/:later\s+ran/)
  })

  it("preserves package boundaries for declared globs", async () => {
    // CONTRIBUTING / T-PRC-01: a parent glob cannot consume a nested package.
    const root = await fixture()
    await write(
      root,
      "pkg/PACKAGE.ts",
      "import {Smithers as S} from \"@smthrs/targets\"; export const Package = S.Package({targets:{files:S.Filegroup({srcs:[S.glob(\"**/*.txt\")]})}})"
    )
    await write(
      root,
      "pkg/nested/PACKAGE.ts",
      "import {Smithers as S} from \"@smthrs/targets\"; export const Package = S.Package({targets:{}})"
    )
    await write(root, "pkg/nested/only.txt", "nested")
    expect(await Input.expandGlob(root, "pkg", "**/*.txt")).toEqual([])
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    const result = await serve(root, ["lint", "//:targetIndex"])
    expect(result.exitCode).toBe(1)
    expect(result.logs + result.output).toContain("pkg/**/*.txt")
    expect(result.logs + result.output).toContain("//pkg:files")
  })

  it("resolves runner strings from their execution cwd across declaring packages", async () => {
    // NodeTest contract: suite paths are cwd-relative, not package-relative.
    const root = await fixture()
    await write(root, "other/check.test.mjs", "")
    await write(
      root,
      "pkg/PACKAGE.ts",
      "import {Smithers as S} from \"@smthrs/targets\"; export const Package = S.Package({targets:{suite:S.NodeTest({cwd:\"other\",runner:S.testSuite([\"check.test.mjs\"]),srcs:[],deps:[]})}})"
    )
    const indexed = await serve(root, ["target", "//:targetIndex", "--write"])
    expect(indexed.exitCode, indexed.logs + indexed.output).toBe(0)
    const valid = await serve(root, ["lint", "//:targetIndex"])
    expect(valid.exitCode, valid.logs + valid.output).toBe(0)
    await Fs.rm(NodePath.join(root, "other/check.test.mjs"))
    const result = await serve(root, ["lint", "//:targetIndex"])
    expect(result.exitCode).toBe(1)
    expect(result.logs + result.output).toContain("other/check.test.mjs")
  })

  it("keeps the committed index stable when unrelated files are added or renamed", async () => {
    // Cache contracts: a dynamic hygiene inventory is not a static input set.
    const root = await fixture()
    await write(root, ".gitignore", "")
    await write(root, "scripts/check.mjs", "")
    await write(
      root,
      "PACKAGE.ts",
      packageModule(
        "const later = S.Shell.Diff({shell:\"true\",data:[S.file(\"//scripts/check.mjs\"),S.file(\"//.gitignore\")],changes:[]})"
      )
    )
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    const bytes = await Fs.readFile(NodePath.join(root, ".smithers/target-index.json"), "utf8")
    expect((await indexOf(root)).find((row) => row.label === "//:later")?.cacheable).toBe(false)
    await write(root, "scratch.txt", "unrelated")
    expect((await serve(root, ["lint", "//:targetIndex"])).exitCode).toBe(0)
    await Fs.rename(NodePath.join(root, "scratch.txt"), NodePath.join(root, "renamed.txt"))
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, ".smithers/target-index.json"), "utf8")).toBe(bytes)
  })

  it.each([
    "const later = S.Clean({paths:[\"dist\"]})",
    "const later = S.Filegroup({srcs:[S.gitDiff({base:\"HEAD\",paths:[\"dist/**\"]})]})"
  ])("does not treat output or diff selection paths as source inputs: %s", async (declaration) => {
    // T-PRC-01 validates input fields by their owning rule, not key spelling.
    const root = await fixture()
    await write(root, "PACKAGE.ts", packageModule("const later = S.Clean({paths:[\"dist\"]})"))
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    expect((await serve(root, ["lint", "//:targetIndex"])).exitCode).toBe(0)
  })

  it("preserves the resolver's missing-input results outside the index check", async () => {
    // C-PRC-01: these literal values are the pre-existing Input contract.
    const root = await fixture()
    expect(await Input.expandGlob(root, "", "missing/**/*.ts")).toEqual([])
    expect(await Input.digestFile(NodePath.join(root, "missing.ts"))).toBeUndefined()
  })

  it.each(["missing/**/*.md", "docs/{absent,missing}.md"])("refuses an unmatched declared glob %s", async (pattern) => {
    // Spec §21.2: supported glob and brace expansion, no new syntax.
    const root = await fixture()
    await write(root, "PACKAGE.ts", packageModule().replace("docs/**/*.md", pattern))
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    const result = await serve(root, ["lint", "//:targetIndex"])
    expect(result.exitCode).toBe(1)
    expect(result.logs + result.output).toContain(pattern)
    expect(result.logs + result.output).toContain("//:notes")
  })

  it("keeps brace expansion and explicit exclusions while validating existing declarations", async () => {
    const root = await fixture()
    await write(root, "docs/a.md", "a")
    await write(root, "docs/b.md", "b")
    await write(
      root,
      "PACKAGE.ts",
      packageModule().replace("S.glob(\"docs/**/*.md\")", "S.glob(\"docs/{a,b}.md\", { exclude: [\"docs/b.md\"] })")
    )
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    expect((await serve(root, ["lint", "//:targetIndex"])).exitCode).toBe(0)
  })

  it("accepts a valid glob whose matches are all explicitly excluded", async () => {
    // Spec §21.2 preserves exclusions; exclusions do not invent a missing input.
    const root = await fixture()
    await write(
      root,
      "PACKAGE.ts",
      packageModule().replace("S.glob(\"docs/**/*.md\")", "S.glob(\"docs/**/*.md\", { exclude: [\"docs/**\"] })")
    )
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    expect((await serve(root, ["lint", "//:targetIndex"])).exitCode).toBe(0)
  })

  it("validates literal runner paths", async () => {
    const root = await fixture()
    await write(
      root,
      "PACKAGE.ts",
      packageModule("const later = S.NodeTest({ runner: S.testSuite([\"scripts/notes.mjs\"]), srcs: [], deps: [] })")
    )
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    expect((await serve(root, ["lint", "//:targetIndex"])).exitCode).toBe(0)
    await Fs.rm(NodePath.join(root, "scripts/notes.mjs"))
    const result = await serve(root, ["lint", "//:targetIndex"])
    expect(result.exitCode).toBe(1)
    expect(result.logs + result.output).toContain("//:later")
    expect(result.logs + result.output).toContain("scripts/notes.mjs")
  })

  it("validates the declared Actionlint workflow list", async () => {
    const root = await fixture()
    await write(root, ".github/workflows/verify.yml", "name: verify\n")
    await write(
      root,
      "PACKAGE.ts",
      packageModule(`const later = S.GithubCiGen({
      mode: "write",
      jobs: [{ id: "verify", runsOn: "ubuntu-latest", toolchain: S.CiToolchain.Needs({
        workflowLint: S.CiToolchain.Actionlint({ release: "1.7.11", workflows: [".github/workflows/verify.yml"] })
      }), steps: [] }]
    })`)
    )
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    expect((await serve(root, ["lint", "//:targetIndex"])).exitCode).toBe(0)
    await Fs.rm(NodePath.join(root, ".github/workflows/verify.yml"))
    const result = await serve(root, ["lint", "//:targetIndex"])
    expect(result.exitCode).toBe(1)
    expect(result.logs + result.output).toContain(".github/workflows/verify.yml")
    expect(result.logs + result.output).toContain("//:later")
  })

  it("refuses a declared file link outside the workspace", async () => {
    // Preserve Input.digestFile's existing workspace confinement in the new gate.
    const root = await fixture()
    const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "prc01-outside-"))
    temporaryDirectories.push(outside)
    await write(outside, "private.mjs", "private fixture bytes")
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    await Fs.rm(NodePath.join(root, "scripts/notes.mjs"))
    await Fs.symlink(NodePath.join(outside, "private.mjs"), NodePath.join(root, "scripts/notes.mjs"))
    expect((await serve(root, ["lint", "//:targetIndex"])).exitCode).toBe(1)
  })

  it("does not count runtime-cache files as declared source matches", async () => {
    const root = await fixture()
    await Fs.rm(NodePath.join(root, "docs/notes.md"))
    await write(
      root,
      ".smithers/WORKSPACE.ts",
      workspaceModule.replace("directory: \".flows\"", "directory: \"docs/cache\"")
    )
    await write(root, "docs/cache/private.md", "runtime state")
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    expect((await serve(root, ["lint", "//:targetIndex"])).exitCode).toBe(1)
  })

  it("honors gitignore while validating glob files", async () => {
    const root = await fixture()
    const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "prc01-ignored-"))
    temporaryDirectories.push(outside)
    await write(outside, "private.md", "private fixture bytes")
    await write(root, ".gitignore", "docs/ignored.md\n")
    await Fs.symlink(NodePath.join(outside, "private.md"), NodePath.join(root, "docs/ignored.md"))
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    expect((await serve(root, ["lint", "//:targetIndex"])).exitCode).toBe(0)
  })

  it("writes the same bytes from two independent runs in two different directories", async () => {
    // The file is committed, so a generator that varied by host, by absolute
    // path, or by hash-map iteration order would make every checkout report
    // drift it cannot fix. Two fixtures with identical declarations under
    // different temporary roots prove the rows carry no host fact and sort
    // stably; rewriting the first one proves a write over an existing file is
    // the same write.
    const first = await fixture()
    const second = await fixture()
    for (const root of [first, second]) {
      const written = await serve(root, ["target", "//:targetIndex", "--write"])
      expect(written.exitCode, written.logs).toBe(0)
    }
    const bytes = await Fs.readFile(NodePath.join(first, ".smithers/target-index.json"), "utf8")
    expect(await Fs.readFile(NodePath.join(second, ".smithers/target-index.json"), "utf8")).toBe(bytes)

    // And a write always writes. The rule declares itself cacheable only
    // outside write mode, but the planner flips the mode after the rule has
    // answered, so a second `--write` used to replay the first one's verdict
    // and touch nothing: the repair silently no-opped on every machine that
    // had run it once, which is how a stale index survives a lane that did
    // remember to regenerate it.
    await Fs.writeFile(NodePath.join(first, ".smithers/target-index.json"), "[]\n")
    const again = await serve(first, ["target", "//:targetIndex", "--write"])
    expect(again.exitCode, again.logs).toBe(0)
    expect(await Fs.readFile(NodePath.join(first, ".smithers/target-index.json"), "utf8")).toBe(bytes)
  })

  it("prints the same rows through the index verb", async () => {
    const root = await fixture()
    const listed = await serve(root, ["index", "//..."])
    expect(listed.exitCode, listed.logs).toBe(0)
    expect(listed.output).toContain("//:notes")
    expect(listed.output).toContain("NOTES.md")
    expect(listed.output).toContain("//:targetIndex")
    expect(listed.output).not.toContain(root)
  })
})
