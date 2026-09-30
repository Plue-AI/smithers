/**
 * Every failure a child repository can produce reduces to data the parent
 * reports: refusals for queries, rejections for git state and execution.
 *
 * `node:child_process.spawn` is replaced by a scripted child so each exit
 * code, pipe payload, spawn error and abort is driven deterministically; the
 * real child CLI boundary is exercised end to end in MultiRepo.test.ts.
 */
import * as LocalRepository from "@smthrs/targets/LocalRepository"
import * as RepoTarget from "@smthrs/targets/RepoTarget"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"

interface Spawned {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> }
  readonly child: FakeChild
}

const spawned: Array<Spawned> = []
let nextPid: number | undefined

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = nextPid
  readonly signals: Array<string> = []
  kill(signal: string) {
    this.signals.push(signal)
  }
}

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: (command: string, args: ReadonlyArray<string>, options: Spawned["options"]) => {
    const child = new FakeChild()
    spawned.push({ command, args, options, child })
    return child
  }
}))

const RepoResolution = await import("../src/RepoResolution.ts")
type Resolution = import("../src/RepoResolution.ts").Resolution

afterEach(() => {
  spawned.length = 0
  nextPid = undefined
  vi.restoreAllMocks()
})

const index = {
  root: "/parent",
  workspace: { repos: { child: LocalRepository.make("repos/child") } }
} as unknown as import("../src/PackageIndex.ts").PackageIndex

const makeResolver = () => RepoResolution.Resolver.make(index, { KEEP: "1" })

/** Waits until the resolver has started child number `count`. */
const started = async (count: number): Promise<FakeChild> => {
  await vi.waitFor(() => expect(spawned.length).toBeGreaterThanOrEqual(count))
  return spawned[count - 1]!.child
}

/** Finishes one scripted child with the given pipes and exit code. */
const finish = (child: FakeChild, exitCode: number | null, output: { stdout?: string; stderr?: string } = {}) => {
  if (output.stdout !== undefined) child.stdout.emit("data", Buffer.from(output.stdout))
  if (output.stderr !== undefined) child.stderr.emit("data", Buffer.from(output.stderr))
  child.emit("close", exitCode)
}

const queried = async (
  output: { stdout?: string; stderr?: string },
  exitCode: number | null = 0,
  label = "//:test"
): Promise<Resolution> => {
  const count = spawned.length + 1
  const resolution = RepoResolution.resolve(makeResolver(), RepoTarget.Target("child", label))
  finish(await started(count), exitCode, output)
  return resolution
}

describe("child repository queries", () => {
  it("resolves a declared repository by name or declaration and runs the child query with the scrubbed environment", async () => {
    const resolver = makeResolver()
    const target = RepoTarget.Target(LocalRepository.make("repos/child"), "//:test", { args: ["--x"] })
    const pending = RepoResolution.resolve(resolver, target)
    expect(RepoResolution.resolve(resolver, target)).toBe(pending)
    finish(await started(1), 0, {
      stdout: JSON.stringify({
        targets: [{ label: "//:other", kinds: ["build"] }, { label: "//:test", kinds: ["test"] }]
      })
    })
    expect(await pending).toEqual({
      repoName: "child",
      repoPath: "repos/child",
      absolutePath: "/parent/repos/child",
      label: "//:test",
      args: ["--x"],
      kinds: ["test"],
      refusal: undefined,
      externalLabel: "@child//:test"
    })
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.command).toBe(process.execPath)
    expect(spawned[0]!.args).toEqual([
      RepoResolution.buildCliPath,
      "query",
      "//:test",
      "--workspace",
      "/parent/repos/child",
      "--format",
      "json"
    ])
    expect(spawned[0]!.options).toMatchObject({ cwd: "/parent/repos/child", env: { KEEP: "1" } })
  })

  it("refuses an undeclared repository declaration by path without starting a child", async () => {
    const resolution = await RepoResolution.resolve(
      makeResolver(),
      RepoTarget.Target(LocalRepository.make("repos/elsewhere"), "//:test")
    )
    expect(resolution).toMatchObject({
      repoName: "unknown",
      repoPath: "repos/elsewhere",
      absolutePath: "/parent",
      kinds: [],
      refusal: "Repo.Target repository \"repos/elsewhere\" is not declared in Workspace repos",
      externalLabel: "@unknown//:test"
    })
    const bare = RepoResolution.Resolver.make(
      { root: "/parent", workspace: {} } as unknown as import("../src/PackageIndex.ts").PackageIndex,
      {}
    )
    for (const repo of ["child", LocalRepository.make("repos/child")]) {
      expect((await RepoResolution.resolve(bare, RepoTarget.Target(repo, "//:test"))).refusal)
        .toMatch(/is not declared in Workspace repos$/)
    }
    expect(spawned).toHaveLength(0)
  })

  it.each([
    ["stderr", { stderr: "  no such target\n", stdout: "ignored" }, "no such target"],
    ["stdout when stderr is blank", { stderr: "  \n", stdout: "from stdout\n" }, "from stdout"],
    ["the exit code when both pipes are empty", {}, "exit 3"]
  ])("refuses a failing child query with %s", async (_name, output, detail) => {
    const resolution = await queried(output, 3)
    expect(resolution.kinds).toEqual([])
    expect(resolution.refusal).toBe(`child repository @child refused //:test: ${detail}`)
  })

  it("reports a signalled child query as exit -1 and keeps only the diagnostic tail", async () => {
    const resolution = await queried({ stderr: `${"a".repeat(9000)}END` }, null)
    expect(resolution.refusal!.startsWith("child repository @child refused //:test: ")).toBe(true)
    expect(resolution.refusal!.endsWith("END")).toBe(true)
    expect(resolution.refusal!.length).toBe("child repository @child refused //:test: ".length + 8 * 1024)
    expect((await queried({}, null)).refusal).toBe("child repository @child refused //:test: exit -1")
  })

  it.each([
    ["a non-object answer", "[]"],
    ["an answer without targets", "{}"],
    ["non-array targets", JSON.stringify({ targets: {} })],
    ["no row for the label", JSON.stringify({ targets: [null, 1, { label: "//:other", kinds: ["test"] }] })],
    ["a row without kinds", JSON.stringify({ targets: [{ label: "//:test" }] })],
    ["an unknown kind", JSON.stringify({ targets: [{ label: "//:test", kinds: ["test", "deploy"] }] })],
    ["a non-string kind", JSON.stringify({ targets: [{ label: "//:test", kinds: [1] }] })]
  ])("refuses %s from the child query", async (_name, stdout) => {
    const resolution = await queried({ stdout })
    expect(resolution.kinds).toEqual([])
    expect(resolution.refusal).toBe("child repository @child query returned no valid target row for //:test")
  })

  it("refuses unparseable query output with the parser's reason", async () => {
    const resolution = await queried({ stdout: "not json" })
    expect(resolution.refusal).toMatch(/^child repository @child could not query \/\/:test: .*JSON/)
  })

  it("refuses a query whose child cannot be spawned", async () => {
    const pending = RepoResolution.resolve(makeResolver(), RepoTarget.Target("child", "//:test"))
    const child = await started(1)
    child.emit("error", Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }))
    child.emit("close", 0)
    expect((await pending).refusal).toBe("child repository @child could not query //:test: spawn node ENOENT")
  })

  it("kills and refuses a child query whose output exceeds 1 MiB", async () => {
    const pending = RepoResolution.resolve(makeResolver(), RepoTarget.Target("child", "//:test"))
    const child = await started(1)
    child.stdout.emit("data", Buffer.alloc(1024 * 1024, 0x61))
    child.stderr.emit("data", Buffer.from("x"))
    child.stdout.emit("data", Buffer.from("ignored after settling"))
    child.emit("close", 0)
    expect((await pending).refusal).toBe(
      "child repository @child could not query //:test: child CLI output exceeds 1048576 bytes"
    )
    expect(child.signals).toEqual(["SIGKILL"])
  })

  it("kills a child query when its signal aborts mid-run, and uses a default reason", async () => {
    const controller = new AbortController()
    const pending = RepoResolution.resolve(makeResolver(), RepoTarget.Target("child", "//:test"), controller.signal)
    const child = await started(1)
    controller.abort("stop")
    child.emit("close", 0)
    expect((await pending).refusal).toBe("child repository @child could not query //:test: stop")
    expect(child.signals).toEqual(["SIGKILL"])
    const undefinedReason = { aborted: true, reason: undefined, addEventListener() {}, removeEventListener() {} }
    const second = RepoResolution.resolve(
      makeResolver(),
      RepoTarget.Target("child", "//:test"),
      undefinedReason as unknown as AbortSignal
    )
    expect((await second).refusal).toBe("child repository @child could not query //:test: child process aborted")
  })

  it("reads effective kinds through a Repo.Target and returns an ordinary target's own kinds", async () => {
    const resolver = makeResolver()
    const target = RepoTarget.Target("child", "//:test")
    const pending = RepoResolution.effectiveKinds(resolver, target)
    finish(await started(1), 0, { stdout: JSON.stringify({ targets: [{ label: "//:test", kinds: ["test"] }] }) })
    expect(await pending).toEqual(["test"])
  })
})

const resolution: Resolution = {
  repoName: "child",
  repoPath: "repos/child",
  absolutePath: "/parent/repos/child",
  label: "//:test",
  args: ["--flag"],
  kinds: ["test"],
  refusal: undefined,
  externalLabel: "@child//:test"
}

describe("child repository git state", () => {
  it("reads HEAD and porcelain status as the execution key", async () => {
    const pending = RepoResolution.gitState(makeResolver(), resolution)
    finish(await started(1), 0, { stdout: "abc123\n" })
    finish(await started(2), 0, { stdout: " M file\n" })
    expect(await pending).toEqual({ head: "abc123", dirty: true, status: " M file\n" })
    expect(spawned.map((row) => row.args)).toEqual([
      ["-C", "/parent/repos/child", "rev-parse", "HEAD"],
      ["-C", "/parent/repos/child", "status", "--porcelain"]
    ])
  })

  it("reads a clean status as not dirty", async () => {
    const pending = RepoResolution.gitState(makeResolver(), resolution)
    finish(await started(1), 0, { stdout: "abc123\n" })
    finish(await started(2), 0, {})
    expect(await pending).toEqual({ head: "abc123", dirty: false, status: "" })
  })

  it.each([
    ["stderr", { stderr: "fatal: not a git repository" }, "fatal: not a git repository"],
    ["stdout", { stdout: "odd" }, "odd"]
  ])("rejects a failed HEAD read with its %s", async (_name, output, detail) => {
    const pending = RepoResolution.gitState(makeResolver(), resolution)
    finish(await started(1), 128, output)
    await expect(pending).rejects.toThrow(`could not read child repository HEAD: ${detail}`)
    expect(spawned).toHaveLength(1)
  })

  it.each([
    ["stderr", { stderr: "fatal: index locked" }, "fatal: index locked"],
    ["stdout", { stdout: "odd" }, "odd"]
  ])("rejects a failed status read with its %s", async (_name, output, detail) => {
    const pending = RepoResolution.gitState(makeResolver(), resolution)
    finish(await started(1), 0, { stdout: "abc\n" })
    finish(await started(2), 1, output)
    await expect(pending).rejects.toThrow(`could not read child repository status: ${detail}`)
  })
})

describe("child repository execution", () => {
  it("passes write, plan and target arguments to a detached child and resolves on exit 0", async () => {
    const seen: Array<string> = []
    const pending = RepoResolution.execute(makeResolver(), resolution, {
      write: true,
      plan: true,
      output: (stream, text) => seen.push(`${stream}:${text}`)
    })
    const child = await started(1)
    child.stdout.emit("data", Buffer.from("ok\n"))
    child.emit("close", 0)
    await pending
    expect(seen).toEqual(["stdout:ok\n"])
    expect(spawned[0]!.args).toEqual([
      RepoResolution.buildCliPath,
      "//:test",
      "--workspace",
      "/parent/repos/child",
      "--write",
      "--plan",
      "--flag"
    ])
    expect(spawned[0]!.options).toMatchObject({ detached: true, env: { KEEP: "1", SMTHRS_REPO_CHILD: "1" } })
  })

  it("streams to the parent process by default and fails with the exit code and stderr tail", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const pending = RepoResolution.execute(makeResolver(), resolution)
    const child = await started(1)
    child.stdout.emit("data", Buffer.from("out\n"))
    child.stderr.emit("data", Buffer.from("boom\npartial"))
    child.emit("close", 2)
    const failure = await pending.then(() => undefined, (cause: unknown) => cause)
    expect(failure).toBeInstanceOf(RepoResolution.ExecutionError)
    expect(failure).toMatchObject({
      code: "repo_target_failed",
      exitCode: 2,
      stderrTail: "boom\npartial",
      message: "child target @child//:test failed with exit 2\nboom\npartial"
    })
    expect(stdout).toHaveBeenCalledWith("out\n")
    expect(stderr).toHaveBeenCalledWith("boom\n")
  })

  it("fails a signalled child as exit -1 without a stderr tail", async () => {
    const pending = RepoResolution.execute(makeResolver(), resolution, { output: () => {} })
    ;(await started(1)).emit("close", null)
    await expect(pending).rejects.toMatchObject({
      exitCode: -1,
      stderrTail: "",
      message: "child target @child//:test failed with exit -1"
    })
  })

  it("rejects a child that cannot be spawned", async () => {
    const pending = RepoResolution.execute(makeResolver(), resolution, { output: () => {} })
    const cause = new Error("spawn EACCES")
    ;(await started(1)).emit("error", cause)
    await expect(pending).rejects.toBe(cause)
  })

  it("kills the child's process group on abort and falls back to the child when the group is gone", async () => {
    nextPid = 424242
    const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => true)
    const controller = new AbortController()
    const pending = RepoResolution.execute(makeResolver(), resolution, { signal: controller.signal, output: () => {} })
    const child = await started(1)
    controller.abort(new Error("cancelled"))
    await expect(pending).rejects.toThrow("cancelled")
    expect(kill).toHaveBeenCalledWith(-424242, "SIGKILL")
    expect(child.signals).toEqual([])
    child.emit("close", 0)

    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" })
    })
    const second = new AbortController()
    const next = RepoResolution.execute(makeResolver(), resolution, { signal: second.signal, output: () => {} })
    const other = await started(2)
    second.abort()
    await expect(next).rejects.toMatchObject({ name: "AbortError" })
    expect(other.signals).toEqual(["SIGKILL"])
  })

  it("rejects a pre-aborted execution with a default reason and signals a child without a pid", async () => {
    const signal = { aborted: true, reason: undefined, addEventListener() {}, removeEventListener() {} }
    const pending = RepoResolution.execute(makeResolver(), resolution, {
      signal: signal as unknown as AbortSignal,
      output: () => {}
    })
    await expect(pending).rejects.toThrow("child target aborted")
    expect(spawned[0]!.child.signals).toEqual(["SIGKILL"])
  })
})
