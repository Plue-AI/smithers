/**
 * The reporter hooks inside the build-system executor: one `begin` naming
 * every planned node, a `targetStarted` for each node that actually enters
 * the scheduler and none for a node blocked by a failed dependency, one
 * `targetFinished` per node, and the summary last. A `log` sink alone still
 * receives the plain lines.
 *
 * The live view keeps its protections wherever it is written. A repository
 * child streams tool output to the parent process instead of this run's
 * reporter, and that route is redacted, terminal-injection stripped and line
 * bounded exactly like the reporter route.
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import type * as Reporter from "../src/Reporter.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

const fixture = async (goodCommand = "true"): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-exec-reporter-")))
  temporaryDirectories.push(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const good = S.Shell.Test({ shell: ${JSON.stringify(goodCommand)} })
const bad = S.Shell.Test({ shell: "false" })
const downstream = S.Shell.Test({ shell: "true", data: [bad] })
const all = S.Suite({ tests: [good, bad, downstream] })
export const Package = S.Package({ targets: { good, bad, downstream, all } })
`
  )
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  return root
}

/** Records every event in order. */
const recorder = (): Reporter.Reporter & { readonly events: Array<string> } => {
  const events: Array<string> = []
  return {
    events,
    renderer: "plain",
    begin: (run) => events.push(`begin ${run.verb} ${run.pattern} ${run.targets.map((t) => t.label).join(",")}`),
    targetStarted: (label) => events.push(`started ${label}`),
    targetFinished: (report) => events.push(`finished ${report.label} ${report.status}`),
    toolOutput: (label, stream, chunk) => events.push(`tool ${label} ${stream} ${chunk}`),
    note: (line) => events.push(`note ${line}`),
    warn: (line) => events.push(`warn ${line}`),
    summary: (summary) => events.push(`summary ${summary.results.length} ${summary.ok}`),
    close: () => events.push("close")
  }
}

/**
 * Collects what the run writes to the parent process pipes, so the
 * repository-child route can be read back as text.
 */
const captureStandardStreams = (): { readonly stdout: Array<string>; readonly stderr: Array<string> } => {
  const stdout: Array<string> = []
  const stderr: Array<string> = []
  const record = (sink: Array<string>) => (chunk: string | Uint8Array): boolean => {
    sink.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }
  vi.spyOn(process.stdout, "write").mockImplementation(record(stdout) as typeof process.stdout.write)
  vi.spyOn(process.stderr, "write").mockImplementation(record(stderr) as typeof process.stderr.write)
  return { stdout, stderr }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const openIndex = async (root: string): Promise<PackageIndex> =>
  PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)

describe("PackageExec reporter hooks", () => {
  it("streams redacted child output before the target settles", async () => {
    const root = await fixture("printf 'hello private-value\\n'; printf 'error detail\\n' >&2")
    const reporter = recorder()
    const summary = await PackageExec.run({
      index: await openIndex(root),
      cacheDirectory: ".flows",
      verb: "auto",
      patterns: ["//:good"],
      readCache: false,
      reporter,
      environment: { ...process.env, API_TOKEN: "private-value" }
    })
    expect(summary.ok).toBe(true)
    const { events } = reporter
    const stdout = events.findIndex((event) => event.startsWith("tool //:good stdout"))
    const stderr = events.findIndex((event) => event.startsWith("tool //:good stderr"))
    const finished = events.indexOf("finished //:good ran")
    expect(stdout).toBeGreaterThan(-1)
    expect(stderr).toBeGreaterThan(-1)
    expect(stdout).toBeLessThan(finished)
    expect(stderr).toBeLessThan(finished)
    expect(events.join("\n")).toContain("hello [REDACTED]")
    expect(events.join("\n")).not.toContain("private-value")
  })

  it("redacts and strips the child view a repository child writes to the parent process", async () => {
    const root = await fixture(
      "printf 'hello private-value\\n'; printf 'ansi \\033[2Jprivate-value\\n'; printf 'error private-value\\n' >&2"
    )
    const reporter = recorder()
    const captured = captureStandardStreams()
    const summary = await PackageExec.run({
      index: await openIndex(root),
      cacheDirectory: ".flows",
      verb: "auto",
      patterns: ["//:good"],
      readCache: false,
      reporter,
      environment: { ...process.env, API_TOKEN: "private-value", SMTHRS_REPO_CHILD: "1" }
    })
    expect(summary.ok).toBe(true)
    const stdout = captured.stdout.join("")
    const stderr = captured.stderr.join("")
    expect(stdout).toContain("hello [REDACTED]")
    expect(stderr).toContain("error [REDACTED]")
    expect(stdout + stderr).not.toContain("private-value")
    expect(stdout).not.toContain("\u001b")
    expect(reporter.events.some((event) => event.startsWith("tool "))).toBe(false)
  })

  it("bounds the live lines a repository child writes to the parent process", async () => {
    const root = await fixture("i=0; while [ $i -lt 250 ]; do echo \"line$i\"; i=$((i+1)); done")
    const reporter = recorder()
    const captured = captureStandardStreams()
    const summary = await PackageExec.run({
      index: await openIndex(root),
      cacheDirectory: ".flows",
      verb: "auto",
      patterns: ["//:good"],
      readCache: false,
      reporter,
      environment: { ...process.env, SMTHRS_REPO_CHILD: "1" }
    })
    expect(summary.ok).toBe(true)
    const stdout = captured.stdout.join("")
    expect(stdout).toContain("… live output limit reached")
    expect(stdout).not.toContain("line249")
    expect(stdout.split("\n").length).toBeLessThan(210)
  })

  it("reads the repository-child marker from the injected environment, not the ambient one", async () => {
    const root = await fixture("printf 'hello private-value\\n'")
    vi.stubEnv("SMTHRS_REPO_CHILD", "1")
    const { SMTHRS_REPO_CHILD: _child, ...ambient } = process.env
    const reporter = recorder()
    const captured = captureStandardStreams()
    const summary = await PackageExec.run({
      index: await openIndex(root),
      cacheDirectory: ".flows",
      verb: "auto",
      patterns: ["//:good"],
      readCache: false,
      reporter,
      environment: { ...ambient, API_TOKEN: "private-value" }
    })
    expect(summary.ok).toBe(true)
    expect(reporter.events.join("\n")).toContain("tool //:good stdout hello [REDACTED]")
    expect(captured.stdout.join("") + captured.stderr.join("")).toBe("")
  })

  it("reports begin, starts, finishes, and the summary in order and never starts a blocked node", async () => {
    const root = await fixture()
    const reporter = recorder()
    const summary = await PackageExec.run({
      index: await openIndex(root),
      cacheDirectory: ".flows",
      verb: "auto",
      patterns: ["//:all"],
      readCache: false,
      jobs: 1,
      reporter
    })
    expect(summary.ok).toBe(false)
    const { events } = reporter
    expect(events[0]).toMatch(/^begin auto \/\/:all /)
    expect(events[0]).toContain("//:all")
    expect(events[0]).toContain("//:downstream")
    expect(events.at(-1)).toMatch(/^summary 4 false$/)
    expect(events).toContain("started //:good")
    expect(events).toContain("started //:bad")
    expect(events).toContain("finished //:good ran")
    expect(events).toContain("finished //:bad failed")
    expect(events).toContain("finished //:downstream skipped")
    expect(events).not.toContain("started //:downstream")
    expect(events.indexOf("started //:bad")).toBeLessThan(events.indexOf("finished //:bad failed"))
    expect(events.filter((event) => event.startsWith("finished "))).toHaveLength(4)
    expect(events).not.toContain("close")
  })

  it("still feeds a bare log sink with the plain lines when no reporter is given", async () => {
    const root = await fixture()
    const lines: Array<string> = []
    const summary = await PackageExec.run({
      index: await openIndex(root),
      cacheDirectory: ".flows",
      verb: "test",
      patterns: ["//:good"],
      readCache: false,
      log: (line) => lines.push(line)
    })
    expect(summary.ok).toBe(true)
    expect(lines.some((line) => /^\/\/:good {2}ran {2}\d+(?:\.\d)?m?s$/.test(line))).toBe(true)
    expect(lines.at(-1)).toMatch(/^1 targets: 0 hit, 1 ran, 0 failed, 0 skipped \(/)
  })

  it("answers the second run from the cache and reports it as a hit", async () => {
    const root = await fixture()
    const index = await openIndex(root)
    const first = recorder()
    await PackageExec.run({ index, cacheDirectory: ".flows", verb: "test", patterns: ["//:good"], reporter: first })
    const second = recorder()
    await PackageExec.run({ index, cacheDirectory: ".flows", verb: "test", patterns: ["//:good"], reporter: second })
    expect(first.events).toContain("finished //:good ran")
    expect(second.events).toContain("started //:good")
    expect(second.events).toContain("finished //:good hit")
  })
})
