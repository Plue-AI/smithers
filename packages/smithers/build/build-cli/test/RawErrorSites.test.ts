/**
 * No new raw-text failure sites in @smthrs/build-cli (#2813).
 *
 * The build CLI prints a failure through `Diagnostic.present`: a tagged error,
 * or a plain `Error` built with a deliberate operator sentence, is printed as
 * written, and anything else becomes the generic unknown-failure sentence. So
 * every existing `new Error("...")` under `src` is either a designed sentence
 * or the `cause` of a tagged failure (as in `unreadable(code, path, cause)`),
 * and this package has no bare string handed to `Effect.fail` or `Effect.die` and
 * no thrown string, which would print as an unknown failure.
 *
 * The counts below are the reviewed sites per file (262 in all). A new
 * failure is a tagged error (`Schema.TaggedError` or `Data.TaggedError`), so a
 * count may only fall: a file that gains a site fails, and one that drops a
 * site fails until its count is lowered.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const packageRoot = join(import.meta.dirname, "..")
const sourceRoot = join(packageRoot, "src")

const plainError = /new Error\(/
const bareString = /Effect\.(?:fail|die)\(\s*["'`]|throw\s+["'`]/

/** Reviewed files and their `new Error` sites: designed sentences or causes of tagged failures. */
const reviewed: ReadonlyArray<readonly [file: string, count: number]> = [
  ["src/Affected.ts", 1],
  ["src/AgentFake.ts", 1],
  ["src/AgentSession.ts", 44],
  ["src/Audience.ts", 1],
  ["src/Cache.ts", 6],
  ["src/CacheAdmin.ts", 4],
  ["src/Cli.ts", 18],
  ["src/Diagnostic.ts", 1],
  ["src/Entry.ts", 1],
  ["src/Executor.ts", 23],
  ["src/FoundryExec.ts", 1],
  ["src/GoExec.ts", 3],
  ["src/Label.ts", 6],
  ["src/MarkdownCodeBlocks.ts", 2],
  ["src/MemoryBackend.ts", 3],
  ["src/OverlayExec.ts", 4],
  ["src/Owners.ts", 2],
  ["src/PackageTree.ts", 21],
  ["src/Planner.ts", 13],
  ["src/RepoResolution.ts", 5],
  ["src/Resolver.ts", 4],
  ["src/RspackRunner.ts", 4],
  ["src/ServiceSupervisor.ts", 20],
  ["src/StampExec.ts", 4],
  ["src/TrustedReview.ts", 15],
  ["src/Watch.ts", 1],
  ["src/Workspace.ts", 2],
  ["src/WorkspaceToolchain.ts", 5],
  ["src/engine.ts", 1],
  ["src/internal/DeclarationDependencies.ts", 2],
  ["src/internal/PackagePlanner.ts", 17],
  ["src/internal/PackageRunner.ts", 6],
  ["src/internal/ParseModule.ts", 1],
  ["src/internal/rules/DocsCheckRule.ts", 4],
  ["src/internal/rules/FetchExecutor.ts", 1],
  ["src/internal/rules/NativeArtifactOutput.ts", 5],
  ["src/internal/rules/NativeFileRule.ts", 3],
  ["src/internal/rules/NativeRules.ts", 3]
]

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })

const lines = sources(sourceRoot).map((path) => ({
  file: relative(packageRoot, path),
  lines: readFileSync(path, "utf8").split("\n")
}))

describe("raw failure sites under src", () => {
  it("hand no bare string to a failure", () => {
    const found = lines.flatMap(({ file, lines }) =>
      lines.flatMap((text, index) => bareString.test(text) ? [`${file}:${index + 1}: ${text.trim()}`] : [])
    )
    expect(found).toEqual([])
  })

  it("match the reviewed plain Error count in every file", () => {
    const counts = Object.fromEntries(
      lines
        .map(({ file, lines }) => [file, lines.filter((text) => plainError.test(text)).length] as const)
        .filter(([, count]) => count > 0)
        .sort(([a], [b]) => a.localeCompare(b))
    )
    expect(counts).toEqual(Object.fromEntries([...reviewed].sort(([a], [b]) => a.localeCompare(b))))
  })

  it("detects each raw shape", () => {
    expect(plainError.test(`throw new Error("x")`)).toBe(true)
    expect(bareString.test(`Effect.fail("x")`)).toBe(true)
    expect(bareString.test("Effect.die(`x`)")).toBe(true)
    expect(bareString.test(`throw "x"`)).toBe(true)
    expect(bareString.test(`Effect.fail(new PackageRefused({ code: "x" }))`)).toBe(false)
  })
})
