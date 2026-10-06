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
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import * as Input from "@smthrs/targets/Input"
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
  await write(root, "docs/guide.md", "# Guide\n")
  return root
}

const indexOf = async (root: string): Promise<ReadonlyArray<TargetIndex.Row>> =>
  JSON.parse(await Fs.readFile(NodePath.join(root, ".smithers/target-index.json"), "utf8"))

describe("TargetIndex through the CLI", () => {
  it("reds on the missing file, writes one row per target under --write, checks it, and reds after a declaration edit", async () => {
    const root = await fixture()

    const missing = await serve(root, ["lint", "//:targetIndex"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs).toContain("the generated file is missing")

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

  it("validates an owning Filegroup across a package boundary and rejects its removed sources", async () => {
    const root = await fixture()
    await write(root, "crates/owned/src/lib.rs", "pub fn value() {}\n")
    await write(root, "crates/owned/PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  sources: S.Filegroup({ cwd: "crates/owned", srcs: [S.glob("src/**/*.rs")] })
} })
`)
    await write(root, "PACKAGE.ts", packageModule().replace(
      'const good =',
      'import { Package as owned } from "./crates/owned/PACKAGE.ts"\nconst native = S.Shell.Build({ shell: "true", data: [owned.sources], outDirs: ["out"] })\nconst good ='
    ).replace('all, good, notes, targetIndex', 'native, all, good, notes, targetIndex'))
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    const valid = await serve(root, ["lint", "//:targetIndex"])
    expect(valid.exitCode, valid.logs + valid.output).toBe(0)
    await Fs.rename(NodePath.join(root, "crates/owned/src/lib.rs"), NodePath.join(root, "crates/owned/src/lib.moved"))
    const missing = await serve(root, ["lint", "//:targetIndex"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs + missing.output).toContain('crates/owned/src/**/*.rs')
    expect(missing.logs + missing.output).toContain('//crates/owned:sources')
    expect(missing.logs + missing.output).toContain('crates/owned/PACKAGE.ts')
  })

  it("validates Markdown supplied by an owning Filegroup dependency of a Vitest target", async () => {
    const root = await fixture()
    await write(root, "infra/README.md", "# Infrastructure\n")
    await write(root, "infra/PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  docsFiles: S.Filegroup({ cwd: "infra", srcs: [S.glob("**/*.md")] })
} })
`)
    await write(root, "test/docs.test.ts", "export {}\n")
    await write(root, "PACKAGE.ts", packageModule().replace(
      "const good =",
      'import { Package as infra } from "./infra/PACKAGE.ts"\nconst docsTest = S.Vitest({ tests: [S.glob("test/**/*.test.ts")], sources: [], deps: [infra.docsFiles], config: null, environment: "node", passWithNoTests: false })\nconst good ='
    ).replace("all, good, notes, targetIndex", "docsTest, all, good, notes, targetIndex"))
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    const valid = await serve(root, ["lint", "//:targetIndex"])
    expect(valid.exitCode, valid.logs + valid.output).toBe(0)
    expect((await indexOf(root)).find((row) => row.label === "//:docsTest")?.dependencies).toContain("//infra:docsFiles")
    await Fs.rename(NodePath.join(root, "infra/README.md"), NodePath.join(root, "infra/README.moved"))
    const missing = await serve(root, ["lint", "//:targetIndex"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs + missing.output).toContain("infra/**/*.md")
    expect(missing.logs + missing.output).toContain("//infra:docsFiles")
    expect(missing.logs + missing.output).toContain("infra/PACKAGE.ts")
  })

  it("indexes README-only package documentation and refuses a removed README", async () => {
    const root = await fixture()
    await write(root, "agent/README.md", "# Agent\n")
    await write(root, "agent/package.json", '{ "name": "agent", "private": true }\n')
    await write(root, "agent/PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"
const docsFiles = S.Filegroup({ srcs: [S.file("README.md"), S.file("package.json")], cwd: "agent" })
export const Package = S.Package({ targets: { docsFiles } })
`)
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    const valid = await serve(root, ["lint", "//:targetIndex"])
    expect(valid.exitCode, valid.logs + valid.output).toBe(0)
    await Fs.rename(NodePath.join(root, "agent/README.md"), NodePath.join(root, "agent/README.moved"))
    const missing = await serve(root, ["lint", "//:targetIndex"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs + missing.output).toContain("agent/README.md")
    expect(missing.logs + missing.output).toContain("//agent:docsFiles")
    expect(missing.logs + missing.output).toContain("agent/PACKAGE.ts")
  })

  it("validates repository-wide NodeTest inputs through package-scoped groups", async () => {
    const root = await fixture()
    await write(root, "shared/PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {} })
`)
    await write(root, "shared/src/source.ts", "export const value = 1\n")
    await write(root, "PACKAGE.ts", packageModule().replace(
      'const good =',
      'const sharedInputs = S.Filegroup({ cwd: "shared", srcs: [S.glob("src/*.ts")] })\nconst checkoutInputs = S.Filegroup({ cwd: "//", srcs: [S.glob("**/*"), sharedInputs] })\nconst consumer = S.NodeTest({ runner: S.entrypoint(S.file("//scripts/notes.mjs")), srcs: [], deps: [checkoutInputs] })\nconst good ='
    ).replace("all, good, notes, targetIndex", "sharedInputs, checkoutInputs, consumer, all, good, notes, targetIndex"))
    expect((await serve(root, ["target", "//:targetIndex", "--write"])).exitCode).toBe(0)
    const valid = await serve(root, ["lint", "//:targetIndex"])
    expect(valid.exitCode, valid.logs + valid.output).toBe(0)
    expect((await indexOf(root)).find((row) => row.label === "//:consumer")?.dependencies).toEqual(["//:checkoutInputs"])
    await Fs.rename(NodePath.join(root, "shared/src/source.ts"), NodePath.join(root, "shared/src/source.moved"))
    const missing = await serve(root, ["lint", "//:targetIndex"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs + missing.output).toContain("shared/src/*.ts")
    expect(missing.logs + missing.output).toContain("//:sharedInputs")
    expect(missing.logs + missing.output).toContain("PACKAGE.ts")
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

/**
 * One declaration of each kind the existence gate resolves: a `Smithers.file()`,
 * a `paths` list with an exclusion, a glob, a brace expansion, a glob under
 * `.gitignore` rules, and a workflow an `Actionlint` requirement names.
 */
const declaredModule = `import { Smithers as S } from "@smthrs/targets"
const notes = S.Generate({
  script: S.file("//scripts/notes.mjs"),
  data: [
    ...S.glob(["lib/*.ts", "!lib/*.test.ts"]),
    S.glob("docs/**/*.md"),
    S.glob("config/{alpha,beta}.json"),
    S.glob("assets/**/*.txt")
  ],
  changes: ["NOTES.md"],
})
const ci = S.GithubCiGen({
  jobs: [{
    id: "lint",
    runsOn: "ubuntu-latest",
    toolchain: S.CiToolchain.Needs({
      workflowLint: S.CiToolchain.Actionlint({ release: "1.7.11", workflows: [".github/workflows/lint.yml"] })
    }),
    steps: [{ name: "Index", verb: S.Verb.Lint, pattern: "//:targetIndex" }]
  }]
})
const targetIndex = S.TargetIndex({ summary: "Index every target." })
export const Package = S.Package({ targets: { ci, notes, targetIndex } })
`

const declaredFixture = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-declared-inputs-")))
  temporaryDirectories.push(root)
  await write(root, "package.json", `{ "name": "indexed", "private": true }\n`)
  await write(root, "yarn.lock", "")
  await write(root, ".smithers/WORKSPACE.ts", workspaceModule)
  await write(root, "PACKAGE.ts", declaredModule)
  await write(root, ".gitignore", "assets/scratch/\n")
  await write(root, "scripts/notes.mjs", "process.stdout.write('')\n")
  await write(root, "lib/notes.ts", "export {}\n")
  await write(root, "lib/notes.test.ts", "export {}\n")
  await write(root, "docs/guide.md", "# Guide\n")
  await write(root, "config/alpha.json", "{}\n")
  await write(root, "assets/logo.txt", "logo\n")
  await write(root, ".github/workflows/lint.yml", "name: lint\n")
  return root
}

const rename = (root: string, from: string, to: string) =>
  Fs.mkdir(NodePath.dirname(NodePath.join(root, to)), { recursive: true }).then(() =>
    Fs.rename(NodePath.join(root, from), NodePath.join(root, to))
  )

describe("TargetIndex declared-input existence through the CLI", () => {
  it("passes valid declarations, then names each renamed input with its label and declaring file", async () => {
    const root = await declaredFixture()
    const written = await serve(root, ["target", "//:targetIndex", "--write"])
    expect(written.exitCode, written.logs).toBe(0)
    // `.github/workflows/ci.yml` is //:ci's own output: a missing generated
    // file is that generator's drift failure, so the index does not refuse it.
    const valid = await serve(root, ["lint", "//:targetIndex"])
    expect(valid.exitCode, valid.output + valid.logs).toBe(0)
    const ciRow = (await indexOf(root)).find((row) => row.label === "//:ci")
    expect(ciRow?.inputs).toEqual([
      { kind: "file", path: ".github/workflows/ci.yml" },
      { kind: "file", path: ".github/workflows/lint.yml" }
    ])

    const cases: ReadonlyArray<{ readonly from: string; readonly to: string; readonly line: string }> = [
      {
        from: "scripts/notes.mjs",
        to: "scripts/renamed.mjs",
        line: "  scripts/notes.mjs declared by //:notes in PACKAGE.ts"
      },
      { from: "lib", to: "library", line: "  lib/*.ts declared by //:notes in PACKAGE.ts" },
      { from: "docs", to: "documents", line: "  docs/**/*.md declared by //:notes in PACKAGE.ts" },
      {
        from: "config/alpha.json",
        to: "config/gamma.json",
        line: "  config/{alpha,beta}.json declared by //:notes in PACKAGE.ts"
      },
      {
        from: "assets/logo.txt",
        to: "assets/scratch/logo.txt",
        line: "  assets/**/*.txt declared by //:notes in PACKAGE.ts"
      },
      {
        from: ".github/workflows/lint.yml",
        to: ".github/workflows/lint.yaml",
        line: "  .github/workflows/lint.yml declared by //:ci in PACKAGE.ts"
      }
    ]
    for (const entry of cases) {
      await rename(root, entry.from, entry.to)
      const refused = await serve(root, ["lint", "//:targetIndex"])
      expect(refused.exitCode, entry.from).toBe(1)
      const text = refused.output + refused.logs
      expect(text).toContain("declared_input_missing: 1 declared input does not exist")
      expect(text).toContain(entry.line)
      await rename(root, entry.to, entry.from)
    }

    await rename(root, "scripts/notes.mjs", "scripts/renamed.mjs")
    await rename(root, "docs", "documents")
    const both = await serve(root, ["lint", "//:targetIndex"])
    expect(both.exitCode).toBe(1)
    expect(both.output + both.logs).toContain("declared_input_missing: 2 declared inputs do not exist")
  })

  it("keeps a glob whose static prefix exists present when it matches nothing today", async () => {
    const root = await declaredFixture()
    await rename(root, "docs/guide.md", "docs/guide.txt")
    await rename(root, "lib/notes.ts", "lib/notes.mts")
    const written = await serve(root, ["target", "//:targetIndex", "--write"])
    expect(written.exitCode, written.output + written.logs).toBe(0)
  })
})

describe("Input outside the TargetIndex check", () => {
  it("expands a missing static prefix to no files and digests a missing file as undefined", async () => {
    const root = await declaredFixture()
    expect(await Input.expandGlob(root, "", "absent/**/*.md")).toEqual([])
    expect(await Input.digestFile(NodePath.join(root, "absent.txt"), { workspaceRoot: root })).toBeUndefined()
  })
})
