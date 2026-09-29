import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const sandboxes: Array<string> = []

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => Fs.rm(sandbox, { recursive: true, force: true })))
})

const git = (root: string, ...args: ReadonlyArray<string>): void => {
  ChildProcess.execFileSync("git", ["-C", root, ...args], { stdio: "pipe" })
}

const workspace = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("agent-hardlink", {
  repository: "git+https://example.invalid/agent-hardlink.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  agents: S.Agents({ default: S.Agent.Codex({ model: "luna" }) })
})
`

const declaration = `import { Smithers as S } from "@smthrs/targets"
const lint = S.Agent.Lint({
  prompt: S.file("//prompt.md"),
  data: [S.gitDiff()],
  fixes: ["src/**"]
})
const diff = S.Agent.Diff({
  prompt: S.file("//prompt.md"),
  data: [S.file("//src/input.ts")],
  changes: ["src/**"],
  gates: [],
  maxRounds: 1
})
export const Package = S.Package({ targets: { lint, diff } })
`

const original = "export const protectedValue = 1\n"
const replacement = "export const protectedValue = 2\n"

const fixture = async (purpose: "fix" | "diff", contents: string | null) => {
  const sandbox = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-agent-hardlink-")))
  sandboxes.push(sandbox)
  const root = Path.join(sandbox, "workspace")
  await Fs.mkdir(root)
  await write(root, "WORKSPACE.ts", workspace)
  await write(root, "PACKAGE.ts", declaration)
  await write(root, "prompt.md", "Update src/protected.ts.\n")
  await write(root, "src/input.ts", "export const input = 1\n")
  await write(root, "src/protected.ts", original)
  git(root, "init", "-q")
  git(root, "config", "user.email", "test@example.invalid")
  git(root, "config", "user.name", "Test")
  git(root, "config", "commit.gpgsign", "false")
  git(root, "add", "-A")
  git(root, "commit", "-qm", "fixture")

  const outside = Path.join(sandbox, "outside.ts")
  await Fs.writeFile(outside, original)
  await Fs.chmod(outside, 0o640)
  const candidate = Path.join(root, "src/protected.ts")
  await Fs.unlink(candidate)
  await Fs.link(outside, candidate)
  if (purpose === "fix") await write(root, "src/input.ts", "export const input = 2\n")

  await write(
    root,
    "fake.json",
    JSON.stringify({
      identity: "hardlink-regression",
      responses: [{ purpose, edits: [{ path: "src/protected.ts", contents }] }]
    })
  )
  return { root, outside, candidate }
}

describe.each([
  { purpose: "fix" as const, args: ["//:lint", "--fix"] },
  { purpose: "diff" as const, args: ["//:diff"] }
])("Agent.$purpose CLI hardlink containment", ({ purpose, args }) => {
  it.each([
    { action: "replacement", contents: replacement },
    { action: "deletion", contents: null }
  ])("accepts $action without changing the external alias bytes or mode", async ({ contents }) => {
    const { root, outside, candidate } = await fixture(purpose, contents)
    const outsideBefore = await Fs.stat(outside)
    const result = await serve(root, args, { environment: { ...process.env, SMTHRS_AGENT_FAKE: "fake.json" } })

    expect(result.exitCode, result.logs).toBe(0)
    expect(result.logs).toContain(purpose === "fix" ? "wrote src/protected.ts" : "applied 1 file(s)")
    if (contents === null) {
      await expect(Fs.stat(candidate)).rejects.toMatchObject({ code: "ENOENT" })
    } else {
      expect(await Fs.readFile(candidate, "utf8")).toBe(replacement)
    }
    expect(await Fs.readFile(outside, "utf8")).toBe(original)
    const outsideAfter = await Fs.stat(outside)
    expect(outsideAfter.mode & 0o777).toBe(outsideBefore.mode & 0o777)
    expect(outsideAfter.ino).toBe(outsideBefore.ino)
    if (contents !== null) {
      const candidateAfter = await Fs.stat(candidate)
      expect(candidateAfter.mode & 0o777).toBe(outsideBefore.mode & 0o777)
      expect(candidateAfter.ino).not.toBe(outsideAfter.ino)
    }
  }, 120_000)
})
