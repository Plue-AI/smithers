/**
 * `FactoryProjection` end to end: a temp workspace whose `.smithers/FACTORY.ts`
 * features one flow with `Smithers.Flow`, declares a Dispatcher table and a
 * home pane, driven through the CLI verbs.
 *
 * `target --write` renders `.smithers/factory.json` from the registry's
 * discovery joined with the declarations, and `.smithers/home.json` from the
 * home export; `lint` and `ci` check both and red on drift; a declaration
 * naming a flow discovery does not find fails the write with the id in the
 * message; a workspace without a factory, or a factory importing a
 * PACKAGE.ts, is refused by name.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const workspaceModule = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("factory", {
  repository: "git+https://example.invalid/factory.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`

const packageModule = `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({
  targets: {
    factoryProjection: S.FactoryProjection({}),
  },
})
`

const factoryModule = (options: { readonly featured?: string; readonly text?: string; readonly home?: boolean } = {}) =>
  `import { Smithers as S } from "@smthrs/targets"
import { Workspace } from "./WORKSPACE.js"
export const review = S.Flow({ flow: ${
    JSON.stringify(options.featured ?? "review")
  }, summary: "Review the change.", featured: true })
export const lint = S.Flow({ flow: "lint", summary: "Lint the named files." })
export const factory = S.Factory({
  summary: "How " + Workspace.name + " develops itself.",
  flows: [review, lint],
  on: {
    "issue.opened": { flow: "issue", description: "Triage every new issue" },
    "change.landed": ["wiki", "history.fold"],
  },
  github: S.Github.Policy({ mirror: "push", issues: "two-way", changes: "land" }),
})
${
    options.home === false ? "" : `export const home = S.Factory.Home({
  blocks: [
    S.Home.Text({ text: ${JSON.stringify(options.text ?? "Builds itself.")} }),
    S.Home.Flows({ title: "Try first" }),
    S.Home.Markdown({ path: "README.md" }),
  ],
})
`
  }`

const reviewFlow = `---
description: Reviews the uncommitted change and returns a verdict.
capabilities: ["fs:read:**", "proc:spawn:git *"]
model: [openai:gpt-6-sol, anthropic:claude-opus-5-5]
---

# Review the change
`

const fixture = async (
  options: { readonly featured?: string; readonly text?: string; readonly home?: boolean; readonly factory?: string } =
    {}
): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-factory-projection-")))
  temporaryDirectories.push(root)
  await write(root, "package.json", `{ "name": "factory", "private": true }\n`)
  await write(root, "yarn.lock", "")
  await write(root, ".smithers/WORKSPACE.ts", workspaceModule)
  await write(root, ".smithers/FACTORY.ts", options.factory ?? factoryModule(options))
  await write(root, "PACKAGE.ts", packageModule)
  await write(root, "flows/review/flow.mdx", reviewFlow)
  await write(
    root,
    "flows/lint/flow.mdx",
    "---\ndescription: Lints the named files.\ncapabilities: [\"fs:read:**\"]\ndisable-model-invocation: true\n---\n\n# Lint\n"
  )
  await write(
    root,
    "flows/ops/deploy/SKILL.md",
    "---\nname: deploy\ndescription: Deploys the service.\n---\n\n# Deploy\n"
  )
  return root
}

const readJson = async (root: string, relative: string) =>
  JSON.parse(await Fs.readFile(NodePath.join(root, relative), "utf8")) as Record<string, unknown>
const projectionOf = (root: string) =>
  readJson(root, ".smithers/factory.json") as Promise<{
    readonly summary: string
    readonly flows: ReadonlyArray<Record<string, unknown>>
    readonly on: ReadonlyArray<Record<string, unknown>>
    readonly github: Record<string, unknown>
  }>
const homeOf = (root: string) =>
  readJson(root, ".smithers/home.json") as Promise<{ readonly blocks: ReadonlyArray<Record<string, unknown>> }>
const absent = (root: string, relative: string) => expect(Fs.access(NodePath.join(root, relative))).rejects.toThrow()

describe("FactoryProjection through the CLI", () => {
  it("reports the missing projection, writes both files under --write, then checks them and reds on drift", async () => {
    const root = await fixture()

    const missing = await serve(root, ["lint", "//:factoryProjection"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs).toContain("the generated file is missing")

    const written = await serve(root, ["target", "//:factoryProjection", "--write"])
    expect(written.exitCode, written.logs).toBe(0)
    const projection = await projectionOf(root)
    expect(projection.summary).toBe("How factory develops itself.")
    expect(projection.flows.map((row) => [row["id"], row["featured"], row["summary"]])).toEqual([
      ["review", true, "Review the change."],
      ["lint", false, "Lint the named files."],
      ["ops/deploy", false, null]
    ])
    expect(projection.flows[0]).toEqual({
      id: "review",
      description: "Reviews the uncommitted change and returns a verdict.",
      summary: "Review the change.",
      featured: true,
      kind: "mdx",
      path: "flows/review/flow.mdx",
      capabilities: ["fs:read:**", "proc:spawn:git *"],
      flows: [],
      model: ["openai:gpt-6-sol", "anthropic:claude-opus-5-5"],
      modelInvocable: true,
      inputSchema: expect.objectContaining({
        schema: expect.objectContaining({ properties: { args: { type: "string" } } })
      })
    })
    expect(projection.flows[1]).toMatchObject({ modelInvocable: false, model: null })
    expect(projection.flows[2]).toMatchObject({ kind: "skill", path: "flows/ops/deploy/SKILL.md" })
    expect(projection.on).toEqual([
      { event: "issue.opened", flow: "issue", description: "Triage every new issue" },
      { event: "change.landed", flow: ["wiki", "history.fold"] }
    ])
    expect(projection.github).toEqual({ mirror: "push", issues: "two-way", changes: "land" })
    expect(await homeOf(root)).toEqual({
      blocks: [
        { type: "text", text: "Builds itself." },
        { type: "flows", title: "Try first" },
        { type: "markdown", path: "README.md" }
      ]
    })

    const fresh = await serve(root, ["lint", "//:factoryProjection"])
    expect(fresh.exitCode, fresh.logs).toBe(0)
    const ci = await serve(root, ["ci", "//:factoryProjection"])
    expect(ci.exitCode, ci.logs).toBe(0)
    expect(await projectionOf(root)).toEqual(projection)

    await write(root, "flows/review/flow.mdx", reviewFlow.replace("returns a verdict", "returns two verdicts"))
    const drifted = await serve(root, ["ci", "//:factoryProjection"])
    expect(drifted.exitCode).toBe(1)
    expect(drifted.logs).toContain("drifted from its generated form")
    expect(await projectionOf(root)).toEqual(projection)

    const rewritten = await serve(root, ["target", "//:factoryProjection", "--write"])
    expect(rewritten.exitCode, rewritten.logs).toBe(0)
    expect((await projectionOf(root)).flows[0]!["description"]).toBe(
      "Reviews the uncommitted change and returns two verdicts."
    )

    await write(root, ".smithers/home.json", JSON.stringify({ blocks: [{ type: "flows" }] }, null, 2) + "\n")
    const homeDrifted = await serve(root, ["ci", "//:factoryProjection"])
    expect(homeDrifted.exitCode).toBe(1)
    expect(homeDrifted.logs).toContain("drifted from its generated form")
    const homeRewritten = await serve(root, ["target", "//:factoryProjection", "--write"])
    expect(homeRewritten.exitCode, homeRewritten.logs).toBe(0)
    expect((await homeOf(root)).blocks).toHaveLength(3)
  })

  it("re-keys the check when FACTORY.ts changes", async () => {
    const root = await fixture()
    expect((await serve(root, ["target", "//:factoryProjection", "--write"])).exitCode).toBe(0)
    expect((await serve(root, ["ci", "//:factoryProjection"])).exitCode).toBe(0)
    await write(root, ".smithers/FACTORY.ts", factoryModule({ text: "Builds itself, twice." }))
    const drifted = await serve(root, ["ci", "//:factoryProjection"])
    expect(drifted.exitCode).toBe(1)
    expect(drifted.logs).toContain("drifted from its generated form")
  })

  it("fails the write by id when a declaration names a flow discovery does not find", async () => {
    const root = await fixture({ featured: "reveiw" })
    const result = await serve(root, ["target", "//:factoryProjection", "--write"])
    expect(result.exitCode).toBe(1)
    expect(result.logs).toContain("discovery did not find: \"reveiw\"")
    await absent(root, ".smithers/factory.json")
    await absent(root, ".smithers/home.json")
  })

  it("names the flows directory when it does not exist", async () => {
    const root = await fixture()
    await Fs.rm(NodePath.join(root, "flows"), { recursive: true })
    const result = await serve(root, ["target", "//:factoryProjection", "--write"])
    expect(result.exitCode).toBe(1)
    expect(result.logs).toContain("could not discover the flows under flows")
  })

  it("names the missing FACTORY.ts when the workspace declares no factory", async () => {
    const root = await fixture()
    await Fs.rm(NodePath.join(root, ".smithers", "FACTORY.ts"))
    const result = await serve(root, ["target", "//:factoryProjection", "--write"])
    expect(result.exitCode).toBe(1)
    expect(result.logs).toContain("the workspace declares no factory: create .smithers/FACTORY.ts")
    await absent(root, ".smithers/factory.json")
  })

  it("refuses a FACTORY.ts that imports a PACKAGE.ts", async () => {
    const root = await fixture({
      factory: `import { Smithers as S } from "@smthrs/targets"
import { Package } from "../PACKAGE.js"
export const factory = S.Factory({ summary: String(typeof Package) })
`
    })
    const result = await serve(root, ["target", "//:factoryProjection", "--write"])
    expect(result.exitCode).toBe(1)
    expect(`${result.output}${result.logs}`).toContain("factory_imports_package")
    await absent(root, ".smithers/factory.json")
  })

  it("projects every declared budget ceiling, the USD ceiling and onExceeded included, and reds when one changes", async () => {
    const root = await fixture()
    const budgeted = (usd: string) =>
      reviewFlow.replace(
        "---\n\n#",
        `budget:\n  tokens: 500\n  milliseconds: 60000\n  usd: ${usd}\n  onExceeded: park\n---\n\n#`
      )
    await write(root, "flows/review/flow.mdx", budgeted("2.5"))
    const written = await serve(root, ["target", "//:factoryProjection", "--write"])
    expect(written.exitCode, written.logs).toBe(0)
    const projection = await projectionOf(root)
    expect(projection.flows[0]!["budget"]).toEqual({ tokens: 500, milliseconds: 60000, usd: 2.5, onExceeded: "park" })
    expect(projection.flows[1]).not.toHaveProperty("budget")
    expect((await serve(root, ["lint", "//:factoryProjection"])).exitCode).toBe(0)

    await write(root, "flows/review/flow.mdx", budgeted("3"))
    const drifted = await serve(root, ["ci", "//:factoryProjection"])
    expect(drifted.exitCode).toBe(1)
    expect(drifted.logs).toContain("drifted from its generated form")
  })

  it("writes no home pane for a factory that exports none, and refuses a stale one until --write removes it", async () => {
    const root = await fixture({ home: false })
    expect((await serve(root, ["target", "//:factoryProjection", "--write"])).exitCode).toBe(0)
    await absent(root, ".smithers/home.json")
    expect((await serve(root, ["ci", "//:factoryProjection"])).exitCode).toBe(0)

    await write(root, ".smithers/home.json", JSON.stringify({ blocks: [{ type: "flows" }] }, null, 2) + "\n")
    const stale = await serve(root, ["ci", "//:factoryProjection"])
    expect(stale.exitCode).toBe(1)
    expect(stale.logs).toContain("FACTORY.ts exports no home")
    expect((await serve(root, ["target", "//:factoryProjection", "--write"])).exitCode).toBe(0)
    await absent(root, ".smithers/home.json")
  })

  it("refuses a home declaration that carries raw HTML and writes nothing", async () => {
    const root = await fixture({ text: "<h1>Hello</h1>" })
    const result = await serve(root, ["target", "//:factoryProjection", "--write"])
    expect(result.exitCode).toBe(1)
    expect(`${result.output}${result.logs}`).toContain("must not contain HTML")
    await absent(root, ".smithers/factory.json")
    await absent(root, ".smithers/home.json")
  })
})
