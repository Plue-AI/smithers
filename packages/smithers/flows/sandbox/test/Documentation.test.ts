import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { expect, it } from "vitest"

const root = join(import.meta.dirname, "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")
const fences = (page: string) => Array.from(page.matchAll(/```ts[^\n]*\n([\s\S]*?)```/g), (match) => match[1]!)

it("typechecks the README lifecycle and supervision fences together", () => {
  const blocks = fences(read("README.md"))
  const lifecycle = blocks.find((block) => block.includes("ContainerSandbox.make"))
  const supervision = blocks.find((block) => block.includes("SandboxSupervision.layer"))
  expect(lifecycle).toBeDefined()
  expect(supervision).toBeDefined()
  checkFences([
    "declare const spawner: import(\"effect/unstable/process/ChildProcessSpawner\").ChildProcessSpawner[\"Service\"]",
    lifecycle!,
    supervision!
  ].join("\n"))
}, 60_000)

it("typechecks the guide's lifecycle-to-supervision example", () => {
  const block = fences(read("docs/guides/supervise-a-session.md"))
    .find((source) => source.includes("SandboxSupervision.layer"))
  expect(block).toBeDefined()
  checkFences(block!)
}, 60_000)

it("typechecks the guide's host-side lookup of a provider by name", () => {
  const block = fences(read("docs/guides/choose-a-provider.md"))
    .find((source) => source.includes("Record<string, Sandbox.Provider>"))
  expect(block).toBeDefined()
  checkFences([
    "declare const microVm: import(\"@smthrs/sandbox\").Sandbox.Provider",
    "declare const local: import(\"@smthrs/sandbox\").Sandbox.Provider",
    block!
  ].join("\n"))
}, 60_000)

it("typechecks the return-work guide's actions and resolver strategy", () => {
  const blocks = fences(read("docs/guides/return-work-from-a-sandbox.md"))
  const actions = blocks.find((block) => block.includes("SandboxMerge.apply"))
  const strategy = blocks.find((block) => block.includes("SandboxMerge.resolveWith"))
  expect(actions).toBeDefined()
  expect(strategy).toBeDefined()
  checkFences([
    actions!,
    "declare const provider: Sandbox.Provider",
    "declare const agent: (issue: number) => import(\"effect/Effect\").Effect<string, never, Sandbox.Host>",
    "declare const resolveInWorkspace: (change: string, path: string) =>",
    "  import(\"effect/Effect\").Effect<{ readonly change: string }>",
    strategy!
  ].join("\n"))
}, 60_000)

it("links README limits to the authored limits page without copying its table", () => {
  const limits = read("README.md").split("## Limits\n")[1]!
  expect(limits).toMatch(/\[Limits\]\(https:\/\/sandbox\.smithers\.sh\/limits\/\)/)
  expect(limits).not.toContain("| Path")
  expect(limits).not.toContain("Two things here are bounded")
})

it("describes authored documentation without the removed generator", () => {
  const changelog = read("CHANGELOG.md")
  expect(changelog).not.toContain("docs/Manifest.ts")
  expect(changelog).not.toContain("docs/pages/api/sandbox.md")
  expect(changelog).toMatch(/authored.*`docs\/`/)
})

function checkFences(source: string): void {
  const directory = mkdtempSync(join(root, "test", ".docs-fences-"))
  try {
    const file = join(directory, "example.ts")
    writeFileSync(file, source)
    const program = ts.createProgram([file], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      types: ["node"]
    })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    expect(ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n"
    })).toBe("")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
