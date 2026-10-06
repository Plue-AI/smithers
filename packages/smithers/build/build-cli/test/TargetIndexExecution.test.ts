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
  await write(root, "scripts/notes.mjs", "process.stdout.write('')\n")
  await write(root, "docs/notes.md", "notes\n")
  return root
}

const indexOf = async (root: string): Promise<ReadonlyArray<TargetIndex.Row>> =>
  JSON.parse(await Fs.readFile(NodePath.join(root, ".smithers/target-index.json"), "utf8"))

describe("TargetIndex through the CLI", () => {
  it("rejects a renamed declared file through production lint with its target and source", async () => {
    const root = await fixture()
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    await Fs.rename(NodePath.join(root, "scripts/notes.mjs"), NodePath.join(root, "scripts/renamed.mjs"))
    const result = await serve(root, ["lint", "//:targetIndex"])
    expect(result.exitCode).toBe(1)
    expect(result.logs + result.output).toContain("scripts/notes.mjs")
    expect(result.logs + result.output).toContain("//:notes")
    expect(result.logs + result.output).toContain("PACKAGE.ts")
  })

  it("reds on the missing file, writes one row per target under --write, checks it, and reds after a declaration edit", async () => {
    const root = await fixture()

    const missing = await serve(root, ["lint", "//:targetIndex"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs + missing.output).toContain("missing declared input")

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

  it("preserves the declaring package boundary when expanding projected globs", async () => {
    const root = await fixture()
    await write(root, "child/PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { sources: S.Shell.Test({ shell: "true", data: [S.glob("src/**/*.ts")] }) } })
`)
    await write(root, "child/src/file.ts", "export const value = 1\n")
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    const valid = await serve(root, ["lint", "//:targetIndex"])
    expect(valid.exitCode, valid.logs + valid.output).toBe(0)
    await Fs.rename(NodePath.join(root, "child/src"), NodePath.join(root, "child/moved"))
    const missing = await serve(root, ["lint", "//:targetIndex"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs + missing.output).toContain("child/src/**/*.ts")
    expect(missing.logs + missing.output).toContain("//child:sources")
    expect(missing.logs + missing.output).toContain("child/PACKAGE.ts")
  })

  it("validates the declared Actionlint workflows rather than a directory listing", async () => {
    const root = await fixture()
    await write(root, ".github/workflows/generated.yml", "name: Generated\n")
    await write(root, ".github/workflows/declared.yml", "name: Declared\n")
    await write(root, ".github/workflows/extra.yml", "name: Extra\n")
    await write(
      root,
      "PACKAGE.ts",
      packageModule(`const later = S.GithubCiGen({
      output: ".github/workflows/generated.yml",
      jobs: [{ id: "lint", runsOn: "ubuntu-latest", toolchain: S.CiToolchain.Needs({
        workflowLint: S.CiToolchain.Actionlint({ release: "1.7.11", workflows: [".github/workflows/declared.yml"] })
      }), steps: [] }]
    })`)
    )
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    expect((await serve(root, ["lint", "//:targetIndex"])).exitCode).toBe(0)
    await Fs.rename(
      NodePath.join(root, ".github/workflows/declared.yml"),
      NodePath.join(root, ".github/workflows/renamed.yml")
    )
    const result = await serve(root, ["lint", "//:targetIndex"])
    expect(result.exitCode).toBe(1)
    expect(result.logs + result.output).toContain(".github/workflows/declared.yml")
    expect(result.logs + result.output).toContain("//:later")
  })

  it("preserves missing input semantics outside the index gate and validates glob exclusions and braces", async () => {
    const root = await fixture()
    expect(await Input.expandGlob(root, "", "absent/**/*.ts")).toEqual([])
    expect(await Input.digestFile(NodePath.join(root, "absent.ts"))).toBeUndefined()
    await write(root, "docs/extra.txt", "extra\n")
    await write(root, "docs/ignored.md", "ignored\n")
    await write(root, ".gitignore", "docs/ignored.md\n")
    await write(
      root,
      "PACKAGE.ts",
      packageModule().replace(
        "S.glob(\"docs/**/*.md\")",
        "S.glob(\"docs/**/*.{md,txt}\", { exclude: [\"docs/ignored.md\"] })"
      )
    )
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    expect((await serve(root, ["lint", "//:targetIndex"])).exitCode).toBe(0)
    await Fs.rm(NodePath.join(root, "docs/notes.md"))
    await Fs.rm(NodePath.join(root, "docs/extra.txt"))
    const result = await serve(root, ["lint", "//:targetIndex"])
    expect(result.exitCode).toBe(1)
    expect(result.logs + result.output).toContain("docs/**/*.{md,txt}")
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
