import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"

const roots: Array<string> = []
const pids: Array<number> = []
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause
    return false
  }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL")
  for (const root of roots.splice(0)) await Fs.rm(root, { recursive: true, force: true })
})

const fixture = async (body: string) => {
  const root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "smithers-m2-git-")))
  roots.push(root)
  await Fs.writeFile(join(root, "git"), `#!${process.execPath}\n${body}`, { mode: 0o755 })
  return { root, environment: { ...process.env, PATH: root } }
}

const responses = `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync("argv.jsonl", JSON.stringify(args) + "\\n");
if (args[0] === "rev-parse") process.stdout.write(args[3] === "topic^{commit}" ? "bbbb\\n" : "aaaa\\n");
else if (args[0] === "diff") process.stdout.write("z/file\\0a/é\\0z/file\\0");
else if (args[0] === "ls-files") process.stdout.write("new/file\\0a/é\\0");
else process.exit(99);
`

describe.skipIf(process.platform === "win32")("affected contained git", () => {
  it("resolves both revisions and passes the exact diff argv, preserving NUL paths", async () => {
    const { root, environment } = await fixture(responses)
    expect(await Affected.changedPaths(root, { base: "--untrusted", head: "topic", environment }))
      .toEqual(["a/é", "z/file"])
    expect((await Fs.readFile(join(root, "argv.jsonl"), "utf8")).trim().split("\n").map((row) => JSON.parse(row)))
      .toEqual([
        ["rev-parse", "--verify", "--end-of-options", "--untrusted^{commit}"],
        ["rev-parse", "--verify", "--end-of-options", "topic^{commit}"],
        ["diff", "--name-only", "--no-renames", "-z", "aaaa", "bbbb", "--"]
      ])
  })

  it("includes untracked paths with exact argv when head is absent", async () => {
    const { root, environment } = await fixture(responses)
    expect(await Affected.changedPaths(root, { base: "HEAD", environment })).toEqual(["a/é", "new/file", "z/file"])
    expect((await Fs.readFile(join(root, "argv.jsonl"), "utf8")).trim().split("\n").map((row) => JSON.parse(row)))
      .toEqual([
        ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
        ["diff", "--name-only", "--no-renames", "-z", "aaaa", "--"],
        ["ls-files", "--others", "--exclude-standard", "-z"]
      ])
  })

  it("reports a nonzero exit with typed details and stderr", async () => {
    const { root, environment } = await fixture("process.stderr.write(\"bad revision\"); process.exit(73)")
    await expect(Affected.changedPaths(root, { base: "bad", environment })).rejects.toMatchObject({
      _tag: "smithers-build/AffectedGitError",
      code: "nonzero_exit",
      args: ["rev-parse", "--verify", "--end-of-options", "bad^{commit}"],
      cause: { exitCode: 73, stderr: "bad revision" }
    })
  })

  it("times out an injected hung git and waits for its death", async () => {
    const { root, environment } = await fixture(`
require("node:fs").writeFileSync("pid", String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`)
    const pending = Affected.changedPaths(root, { base: "HEAD", environment, timeoutMs: 1000 })
    const assertion = expect(pending).rejects.toMatchObject({
      _tag: "smithers-build/AffectedGitError",
      code: "timed_out"
    })
    const pid = await waitPid(root)
    pids.push(pid)
    await assertion
    expect(alive(pid)).toBe(false)
  })

  it("cancels mid-run, preserves the reason, and launches no later git command", async () => {
    const { root, environment } = await fixture(`
require("node:fs").appendFileSync("pid", String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`)
    const controller = new AbortController()
    const reason = new Error("caller cancelled discovery")
    const pending = Affected.changedPaths(root, { base: "HEAD", environment, signal: controller.signal })
    const assertion = expect(pending).rejects.toMatchObject({
      _tag: "smithers-build/AffectedGitError",
      code: "cancelled",
      cause: { cause: reason }
    })
    const pid = await waitPid(root)
    pids.push(pid)
    controller.abort(reason)
    await assertion
    expect(alive(pid)).toBe(false)
    expect(await Fs.readFile(join(root, "pid"), "utf8")).toBe(String(pid))
  })

  it("retains a spawn failure as the typed error's cause", async () => {
    const { root } = await fixture("")
    await Fs.unlink(join(root, "git"))
    await expect(Affected.changedPaths(root, { base: "HEAD", environment: { PATH: root } })).rejects.toMatchObject({
      _tag: "smithers-build/AffectedGitError",
      code: "process_failed",
      cause: { cause: { _tag: "PlatformError" } }
    })
  })
})

const waitPid = async (root: string) => {
  for (let attempt = 0; attempt < 400; attempt++) {
    const text = await Fs.readFile(join(root, "pid"), "utf8").catch(() => "")
    if (text !== "") return Number(text)
    await delay(25)
  }
  throw new Error("git fixture did not start")
}

it("explicit files need no git process", async () => {
  expect(await Affected.changedPaths("/missing-workspace", { base: "HEAD", files: ["z", "a", "z"] }))
    .toEqual(["a", "z"])
})

it("refuses an already cancelled call before discovery", async () => {
  const reason = new Error("already cancelled")
  await expect(Affected.changedPaths("/missing-workspace", { base: "HEAD", signal: AbortSignal.abort(reason) }))
    .rejects.toMatchObject({ _tag: "smithers-build/AffectedGitError", code: "cancelled", cause: reason })
})

it.each([0, -1, 86_400_001, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
  "refuses invalid timeout %s",
  async (timeoutMs) => {
    await expect(Affected.changedPaths("/missing-workspace", { base: "HEAD", timeoutMs }))
      .rejects.toMatchObject({ _tag: "smithers-build/AffectedGitError", code: "invalid_timeout" })
  }
)

it.each([1, 2, 86_399_999, 86_400_000])("accepts timeout boundary %s", async (timeoutMs) => {
  await expect(Affected.changedPaths("/missing-workspace", { base: "HEAD", timeoutMs }))
    .rejects.toHaveProperty("code", expect.stringMatching(/^(process_failed|timed_out)$/))
})

it("passes an explicit default deadline, output ceiling and caller signal on every git invocation", async () => {
  const signal = new AbortController().signal
  const environment = { PATH: "/test/path" }
  const calls: Array<Parameters<typeof ContainedProcess.run>[0]> = []
  vi.spyOn(ContainedProcess, "run").mockImplementation(async (options) => {
    calls.push(options)
    options.stdout(options.args[0] === "rev-parse" ? "aaaa\n" : "a/file\0")
    return 0
  })
  expect(await Affected.changedPaths("/test/root", { base: "HEAD", signal, environment })).toEqual(["a/file"])
  expect(calls).toHaveLength(3)
  for (const call of calls) {
    expect(call).toMatchObject({
      command: "git",
      cwd: "/test/root",
      timeoutMs: 60_000,
      maxOutputBytes: 16_777_216,
      fatalUtf8: true
    })
    expect(call.signal).toBe(signal)
    expect(call.environment).toBe(environment)
  }
})
