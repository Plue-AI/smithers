/**
 * No new raw-text failure sites in @smthrs/targets (#2813).
 *
 * The build CLI prints a failure through `Diagnostic.present`: a tagged error,
 * or a plain `Error` built with a deliberate operator sentence, is printed as
 * written, and anything else becomes the generic unknown-failure sentence. So
 * every existing `new Error("...")` under `src` is either a designed sentence
 * or the `cause` of a tagged failure (as in `unreadable(code, path, cause)`),
 * and this package has no bare string handed to `Effect.fail` or `Effect.die` and
 * no thrown string, which would print as an unknown failure.
 *
 * The counts below are the reviewed sites per file (299 in all). A new
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
  ["src/AgentTarget.ts", 3],
  ["src/Attr.ts", 1],
  ["src/Cargo.ts", 5],
  ["src/CiToolchain.ts", 7],
  ["src/Compose.ts", 22],
  ["src/Config.ts", 8],
  ["src/DocsCheck.ts", 3],
  ["src/Exec.ts", 1],
  ["src/ExecSandbox.ts", 4],
  ["src/GeneratedFile.ts", 20],
  ["src/GithubCiGen.ts", 33],
  ["src/Input.ts", 15],
  ["src/Install.ts", 1],
  ["src/LlmLint.ts", 34],
  ["src/NewPackage.ts", 6],
  ["src/Nix.ts", 4],
  ["src/Owners.ts", 15],
  ["src/Package.ts", 1],
  ["src/PackageDefaults.ts", 1],
  ["src/PackageJson.ts", 32],
  ["src/PackageJsonTemplate.ts", 2],
  ["src/PackageManager.ts", 2],
  ["src/PnpmWorkspaceFile.ts", 2],
  ["src/Reference.ts", 1],
  ["src/RemoteCache.ts", 11],
  ["src/RepoTarget.ts", 3],
  ["src/Runtime.ts", 5],
  ["src/RustToolchain.ts", 3],
  ["src/SafeFs.ts", 27],
  ["src/Secret.ts", 2],
  ["src/SecretProxy.ts", 2],
  ["src/Shell.ts", 2],
  ["src/Target.ts", 2],
  ["src/WorkspaceDeclaration.ts", 3],
  ["src/internal/PrivateStore.ts", 6],
  ["src/internal/ReviewBatches.ts", 1],
  ["src/internal/ReviewModel.ts", 9]
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
