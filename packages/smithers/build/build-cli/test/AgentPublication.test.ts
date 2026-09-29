import * as AgentTarget from "@smthrs/targets/AgentTarget"
import * as Input from "@smthrs/targets/Input"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as AgentFake from "../src/AgentFake.ts"
import * as AgentSession from "../src/AgentSession.ts"
import { serve } from "./helpers/ServeCli.ts"

// The fault controls reject or cancel one publication rename after earlier
// files have been written through the real filesystem. Everything else is real IO.
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

let root: string
const path = (relative: string): string => NodePath.join(root, relative)
const contents = (relative: string): Promise<string> => Fs.readFile(path(relative), "utf8")
const mode = async (relative: string): Promise<number> => (await Fs.stat(path(relative))).mode & 0o7777
const originalRename = (await vi.importActual<typeof Fs>("node:fs/promises")).rename

const write = async (relative: string, text: string): Promise<void> => {
  await Fs.mkdir(NodePath.dirname(path(relative)), { recursive: true })
  await Fs.writeFile(path(relative), text)
}

const git = (...args: ReadonlyArray<string>): void => {
  execFileSync("git", ["-C", root, "-c", "user.email=test@test", "-c", "user.name=test", ...args], {
    stdio: "pipe"
  })
}

const script = async (edits: ReadonlyArray<AgentTarget.CandidateEdit>): Promise<void> => {
  await write(
    "fake.json",
    JSON.stringify({
      identity: "publication-test",
      responses: [{ purpose: "fix", findings: [], edits }]
    })
  )
}

const lintPayload: AgentTarget.LintPayload = {
  promptPath: "prompt.md",
  diffs: [Input.gitDiff({ base: "HEAD", paths: ["src/**"] })],
  fixes: ["src/**"],
  mode: "fix"
}

const runLint = (edits: ReadonlyArray<AgentTarget.CandidateEdit>) =>
  AgentSession.runAgentLint({
    workspaceRoot: root,
    sessions: AgentFake.makeScriptedSessionFactory({ responses: [{ purpose: "fix", findings: [], edits }] }),
    writeSets: AgentSession.makeLocalWriteSetApplier(root),
    gates: AgentSession.unavailableGateRunner,
    verdicts: AgentSession.makeMemoryVerdictStore()
  }, lintPayload)

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-agent-publish-")))
  await write(
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: S.file("//package.json"), lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  agents: S.Agents({ default: S.Agent.Codex({ model: "luna" }), luna: S.Agent.Codex({ model: "luna" }) })
})
`
  )
  await write(
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const lint = S.Agent.Lint({ agent: S.Agents.luna, prompt: S.file("//prompt.md"), data: [S.gitDiff()], fixes: ["src/**"] })
export const Package = S.Package({ targets: { lint } })
`
  )
  await write("prompt.md", "Fix the changed files.\n")
  await write("src/a.ts", "old a\n")
  await write("src/b.ts", "old b\n")
  await write("src/input.ts", "old input\n")
  git("init", "-q")
  git("add", "-A")
  git("commit", "-qm", "initial")
  await write("src/input.ts", "changed input\n")
})

afterEach(async () => {
  vi.mocked(Fs.rename).mockReset().mockImplementation(originalRename)
  await Fs.rm(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === "win32")("agent publication", () => {
  for (
    const [before, after] of [
      [0o600, 0o600],
      [0o640, 0o640],
      [0o755, 0o755],
      [0o4755, 0o755],
      [0o2755, 0o755],
      [0o1755, 0o755],
      [0o7755, 0o755]
    ] as const
  ) {
    it(`publishes mode ${before.toString(8)} as ${after.toString(8)} through runAgentLint`, async (context) => {
      await Fs.chmod(path("src/a.ts"), before)
      const actual = await mode("src/a.ts")
      if ((before & 0o7000) !== 0 && actual !== before) {
        context.skip()
        return
      }
      expect(actual).toBe(before)
      const report = await Effect.runPromise(runLint([{ path: "src/a.ts", contents: "fixed a\n" }]))
      expect(report.fixed).toEqual(["src/a.ts"])
      expect(await contents("src/a.ts")).toBe("fixed a\n")
      expect(await mode("src/a.ts")).toBe(after)
      expect((await Fs.readdir(path("src"))).sort()).toEqual(["a.ts", "b.ts", "input.ts"])
    })
  }

  it("rolls back earlier publications after a later file fails through package execution", async () => {
    const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-agent-alias-"))
    try {
      const alias = NodePath.join(outside, "alias.ts")
      await Fs.writeFile(alias, "old a\n")
      await Fs.chmod(alias, 0o600)
      await Fs.unlink(path("src/a.ts"))
      await Fs.link(alias, path("src/a.ts"))
      await Fs.chmod(path("src/b.ts"), 0o640)
      await script([
        { path: "src/a.ts", contents: "fixed a\n" },
        { path: "src/b.ts", contents: "fixed b\n" }
      ])
      let firstPublished = false
      vi.mocked(Fs.rename).mockImplementation(async (from, to) => {
        if (String(to) === path("src/b.ts") && String(from).includes(".tmp-")) {
          expect(firstPublished).toBe(true)
          throw new Error("injected later publication failure")
        }
        await originalRename(from, to)
        if (String(to) === path("src/a.ts") && String(from).includes(".tmp-")) firstPublished = true
      })
      const result = await serve(root, ["//:lint", "--fix"], {
        environment: { ...process.env, SMTHRS_AGENT_FAKE: "fake.json" }
      })
      expect(firstPublished).toBe(true)
      expect(result.exitCode).toBe(1)
      expect(result.logs).toContain("injected later publication failure")
      expect(await contents("src/a.ts")).toBe("old a\n")
      expect(await mode("src/a.ts")).toBe(0o600)
      expect(await contents("src/b.ts")).toBe("old b\n")
      expect(await mode("src/b.ts")).toBe(0o640)
      expect(await contents("src/input.ts")).toBe("changed input\n")
      expect(await Fs.readFile(alias, "utf8")).toBe("old a\n")
      expect((await Fs.stat(alias)).mode & 0o7777).toBe(0o600)
      expect((await Fs.readdir(path("src"))).sort()).toEqual(["a.ts", "b.ts", "input.ts"])
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })

  for (
    const [before, published] of [
      [0o4644, 0o644],
      [0o4755, 0o755]
    ] as const
  ) {
    it(`restores tracked mode ${before.toString(8)} after same-bytes publication and a later failure`, async (context) => {
      await Fs.chmod(path("src/a.ts"), before)
      const actual = await mode("src/a.ts")
      if (actual !== before) {
        context.skip()
        return
      }
      expect(actual).toBe(before)
      await script([
        { path: "src/a.ts", contents: "old a\n" },
        { path: "src/b.ts", contents: "fixed b\n" }
      ])
      let firstPublished = false
      vi.mocked(Fs.rename).mockImplementation(async (from, to) => {
        if (String(to) === path("src/b.ts") && String(from).includes(".tmp-")) {
          expect(firstPublished).toBe(true)
          throw new Error("injected later publication failure")
        }
        await originalRename(from, to)
        if (String(to) === path("src/a.ts") && String(from).includes(".tmp-")) {
          firstPublished = true
          expect(await mode("src/a.ts")).toBe(published)
          expect(await contents("src/a.ts")).toBe("old a\n")
        }
      })
      const result = await serve(root, ["//:lint", "--fix"], {
        environment: { ...process.env, SMTHRS_AGENT_FAKE: "fake.json" }
      })
      expect(firstPublished).toBe(true)
      expect(result.exitCode).toBe(1)
      expect(await contents("src/a.ts")).toBe("old a\n")
      expect(await mode("src/a.ts")).toBe(before)
      expect(await contents("src/b.ts")).toBe("old b\n")
      expect((await Fs.readdir(path("src"))).sort()).toEqual(["a.ts", "b.ts", "input.ts"])
    })
  }

  it("settles a cancellation during publication with the original tree restored", async () => {
    const controller = new AbortController()
    await Fs.chmod(path("src/a.ts"), 0o600)
    await Fs.chmod(path("src/b.ts"), 0o640)
    await script([
      { path: "src/a.ts", contents: "fixed a\n" },
      { path: "src/b.ts", contents: "fixed b\n" }
    ])
    let firstPublished = false
    let secondPublished = false
    let activeRenames = 0
    vi.mocked(Fs.rename).mockImplementation(async (from, to) => {
      activeRenames += 1
      try {
        await originalRename(from, to)
        if (!firstPublished && String(to) === path("src/a.ts") && String(from).includes(".tmp-")) {
          firstPublished = true
          controller.abort()
        }
        if (String(to) === path("src/b.ts") && String(from).includes(".tmp-")) {
          secondPublished = await contents("src/b.ts") === "fixed b\n"
        }
      } finally {
        activeRenames -= 1
      }
    })
    const result = await serve(root, ["//:lint", "--fix"], {
      signal: controller.signal,
      environment: { ...process.env, SMTHRS_AGENT_FAKE: "fake.json" }
    })
    expect(firstPublished).toBe(true)
    expect(secondPublished).toBe(true)
    expect(activeRenames).toBe(0)
    expect(result.exitCode).toBe(1)
    expect(await contents("src/a.ts")).toBe("old a\n")
    expect(await mode("src/a.ts")).toBe(0o600)
    expect(await contents("src/b.ts")).toBe("old b\n")
    expect(await mode("src/b.ts")).toBe(0o640)
    expect(await contents("src/input.ts")).toBe("changed input\n")
    expect((await Fs.readdir(path("src"))).sort()).toEqual(["a.ts", "b.ts", "input.ts"])
  })
})
