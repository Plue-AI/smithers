/**
 * The known-red list: parsing, judging an execution against it, and the
 * `--known-red` flag driven through the real CLI.
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import type * as Executor from "../src/Executor.ts"
import * as KnownRed from "../src/KnownRed.ts"
import type * as Reporter from "../src/Reporter.ts"
import { write } from "./helpers/WriteFile.ts"

const entry = (label: string, extra: Partial<KnownRed.Entry> = {}): KnownRed.Entry => ({
  label,
  owner: "will",
  reason: "red since the fixture was written",
  issue: "https://github.com/smithersai/smithers/issues/1",
  expires: "2026-10-09",
  ...extra
})

const summary = (rows: ReadonlyArray<readonly [string, Executor.TargetReport["status"]]>): Executor.Summary => ({
  verb: "ci",
  pattern: "//...",
  jobs: 1,
  durationMs: 1,
  counts: {
    hit: rows.filter(([, status]) => status === "hit").length,
    ran: rows.filter(([, status]) => status === "ran").length,
    failed: rows.filter(([, status]) => status === "failed").length,
    skipped: rows.filter(([, status]) => status === "skipped").length
  },
  ok: rows.every(([, status]) => status !== "failed"),
  results: rows.map(([label, status]) => ({ label, target: label, status, durationMs: 1, key: label }))
})

describe("KnownRed.parse", () => {
  it("accepts a complete list and keeps optional fields only when present", () => {
    const entries = KnownRed.parse(
      "list.json",
      JSON.stringify({
        entries: [
          { label: "//a:test", owner: "o", reason: "r", expires: "2026-10-09", issue: "#1" },
          { label: "//b:test", owner: "o", reason: "r", expires: "2026-10-09", platforms: ["win32"], issue: "#1" }
        ]
      })
    )
    expect(entries).toEqual([
      { label: "//a:test", owner: "o", reason: "r", expires: "2026-10-09", issue: "#1" },
      { label: "//b:test", owner: "o", reason: "r", expires: "2026-10-09", platforms: ["win32"], issue: "#1" }
    ])
  })

  it.each([
    ["{", /not JSON/],
    ["null", /"entries" must be an array/],
    [JSON.stringify({ entries: {} }), /"entries" must be an array/],
    [JSON.stringify({ entries: [1] }), /must be an object/],
    [JSON.stringify({ entries: [null] }), /must be an object/],
    [JSON.stringify({ entries: [{ label: "" }] }), /"label" must be a non-empty string/],
    [JSON.stringify({ entries: [{ label: "pkg:test" }] }), /must be a target label/],
    [JSON.stringify({ entries: [{ label: "//a:t", expires: "soon" }] }), /YYYY-MM-DD/],
    [JSON.stringify({ entries: [{ label: "//a:t", expires: "2026-13-45" }] }), /YYYY-MM-DD/],
    [JSON.stringify({ entries: [{ label: "//a:t", expires: "2026-10-09", platforms: [] }] }), /non-empty array/],
    [JSON.stringify({ entries: [{ label: "//a:t", expires: "2026-10-09", platforms: "linux" }] }), /non-empty array/],
    [JSON.stringify({ entries: [{ label: "//a:t", expires: "2026-10-09", platforms: [1] }] }), /platforms\[0\]/],
    [JSON.stringify({ entries: [{ label: "//a:t", expires: "2026-10-09", reason: "r", issue: "#1" }] }), /"owner"/],
    [JSON.stringify({ entries: [{ label: "//a:t", expires: "2026-10-09", owner: "o" }] }), /"reason"/],
    [
      JSON.stringify({ entries: [{ label: "//a:t", expires: "2026-10-09", owner: "o", reason: "r", issue: 7 }] }),
      /"issue"/
    ],
    [
      JSON.stringify({
        entries: [
          {
            label: "//a:t",
            expires: "2026-10-09",
            owner: "o",
            reason: "r",
            platforms: ["linux", "win32"],
            issue: "#1"
          },
          { label: "//a:t", expires: "2026-10-10", owner: "o", reason: "r", platforms: ["win32", "linux"], issue: "#1" }
        ]
      }),
      /duplicate entry for \/\/a:t/
    ]
  ])("rejects %s", (content, message) => {
    expect(() => KnownRed.parse("list.json", content)).toThrow(message)
  })

  it("rejects an entry without an issue", () => {
    const content = JSON.stringify({
      entries: [{ label: "//a:t", owner: "o", reason: "r", expires: "2026-10-09" }]
    })
    expect(() => KnownRed.parse("list.json", content)).toThrow(
      "list.json entries[0]: \"issue\" must be a non-empty string"
    )
  })

  it("allows the same label once per distinct platform set", () => {
    const entries = KnownRed.parse(
      "list.json",
      JSON.stringify({
        entries: [
          { label: "//a:t", expires: "2026-10-09", owner: "o", reason: "r", platforms: ["win32"], issue: "#1" },
          { label: "//a:t", expires: "2026-10-09", owner: "o", reason: "r", issue: "#1" }
        ]
      })
    )
    expect(entries).toHaveLength(2)
  })
})

describe("KnownRed.judge", () => {
  const context = { platform: "linux", today: "2026-09-26" }

  it("passes when every failure is known, and names recovered entries", () => {
    const judged = KnownRed.judge(
      summary([["//a:test", "failed"], ["//b:test", "ran"], ["//c:test", "hit"], ["//d:test", "skipped"]]),
      { source: "list.json", entries: [entry("//a:test"), entry("//b:test"), entry("//c:test")] },
      context
    )
    expect(judged.ok).toBe(true)
    expect(judged.knownRed).toEqual({
      source: "list.json",
      known: ["//a:test"],
      newlyRed: [],
      unrun: [],
      expired: [],
      recovered: ["//b:test", "//c:test"]
    })
  })

  it("fails on a failure the list does not name", () => {
    const judged = KnownRed.judge(
      summary([["//a:test", "failed"], ["//new:test", "failed"]]),
      { source: "list.json", entries: [entry("//a:test")] },
      context
    )
    expect(judged.ok).toBe(false)
    expect(judged.knownRed.newlyRed).toEqual(["//new:test"])
  })

  it("fails when a listed target keeps an unlisted consumer from running", () => {
    const rows = summary([["//a:build", "failed"], ["//a:test", "skipped"], ["//a:lint", "skipped"]])
    const blocked: Executor.Summary = {
      ...rows,
      results: rows.results.map((row) => row.status === "skipped" ? { ...row, blockedBy: "//a:build" } : row)
    }
    const judged = KnownRed.judge(blocked, { source: "list.json", entries: [entry("//a:build")] }, context)
    expect(judged.ok).toBe(false)
    expect(judged.knownRed.unrun).toEqual(["//a:test", "//a:lint"])
    // Listing the consumer too is how an owner accepts that it cannot run.
    const both = KnownRed.judge(
      blocked,
      { source: "list.json", entries: [entry("//a:build"), entry("//a:test"), entry("//a:lint")] },
      context
    )
    expect(both.ok).toBe(true)
  })

  it("stops excusing an entry after its expiry day", () => {
    const list = { source: "list.json", entries: [entry("//a:test", { expires: "2026-09-26" })] }
    expect(KnownRed.judge(summary([["//a:test", "failed"]]), list, context).ok).toBe(true)
    const later = KnownRed.judge(summary([["//a:test", "failed"]]), list, { ...context, today: "2026-09-27" })
    expect(later.ok).toBe(false)
    expect(later.knownRed.expired).toEqual(["//a:test"])
    expect(later.knownRed.newlyRed).toEqual(["//a:test"])
  })

  it("applies a platform-scoped entry only on that platform", () => {
    const list = { source: "list.json", entries: [entry("//a:test", { platforms: ["win32"] })] }
    expect(KnownRed.judge(summary([["//a:test", "failed"]]), list, context).ok).toBe(false)
    expect(KnownRed.judge(summary([["//a:test", "failed"]]), list, { ...context, platform: "win32" }).ok).toBe(true)
  })

  it("describes every finding on its own line", () => {
    expect(KnownRed.describe({
      source: "l.json",
      known: ["//k:t"],
      newlyRed: ["//n:t"],
      unrun: ["//u:t"],
      expired: ["//e:t"],
      recovered: ["//r:t"]
    })).toEqual([
      "known red (l.json): //k:t",
      "newly red, not in l.json: //n:t",
      "not run, a dependency is red: //u:t",
      "expired entry in l.json, no longer excused: //e:t",
      "green again, remove from l.json: //r:t"
    ])
  })

  it("states today as a UTC date", () => {
    expect(KnownRed.today(new Date("2026-09-26T23:59:59Z"))).toBe("2026-09-26")
    expect(KnownRed.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

describe("KnownRed.read", () => {
  it("reads a list relative to a directory and refuses a missing file", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-known-red-read-")))
    temporaryDirectories.push(root)
    await write(root, "ci/list.json", JSON.stringify({ entries: [entry("//a:test")] }))
    await expect(KnownRed.read(root, "ci/list.json")).resolves.toEqual({
      source: "ci/list.json",
      entries: [entry("//a:test")]
    })
    await expect(KnownRed.read(root, "missing.json")).rejects.toThrow(/cannot read the known-red list/)
  })
})

describe("smthrs ci --known-red", () => {
  const git = (root: string, ...args: ReadonlyArray<string>): string =>
    NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

  const fixture = async (): Promise<string> => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-known-red-cli-")))
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
const good = S.Shell.Test({ shell: "true" })
const bad = S.Shell.Test({ shell: "false" })
const worse = S.Shell.Test({ shell: "false" })
const consumer = S.Shell.Test({ shell: "true", data: [bad] })
export const Package = S.Package({ targets: { good, bad, worse, consumer } })
`
    )
    await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
    await write(root, "yarn.lock", "# yarn lockfile v1\n")
    await write(
      root,
      "known-red.json",
      JSON.stringify({
        entries: [entry("//:bad", { expires: "2999-01-01" }), entry("//:good", { expires: "2999-01-01" })]
      })
    )
    git(root, "init", "-q")
    git(root, "add", "-A")
    git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
    return root
  }

  const serve = async (root: string, args: ReadonlyArray<string>) => {
    let err = ""
    const stderr: Reporter.Terminal = {
      write: (text) => {
        err += text
      },
      isTTY: false,
      columns: 100
    }
    let exitCode = 0
    let envelope = ""
    await makeCli({
      environment: { ...process.env, SMITHERS_AUDIENCE: "agent", NO_COLOR: "1", CI: undefined },
      stdout: { write: () => undefined, isTTY: false, columns: 100 },
      stderr
    }).serve([...normalizeArgv(args), "--workspace", root], {
      exit: (code) => {
        exitCode = code
      },
      stdout: (text) => {
        envelope += text
      }
    })
    return { exitCode, stderr: err, envelope }
  }

  it("passes when only listed targets fail and names the entries that went green", async () => {
    const root = await fixture()
    const served = await serve(root, ["test", "//:bad", "--known-red", "known-red.json"])
    expect(served.exitCode).toBe(0)
    expect(served.stderr).toContain("known red (known-red.json): //:bad")
    const green = await serve(root, ["test", "//:good", "--known-red", "known-red.json"])
    expect(green.exitCode).toBe(0)
    expect(green.stderr).toContain("green again, remove from known-red.json: //:good")
  })

  it("fails on a newly red target and says how many are unlisted", async () => {
    const root = await fixture()
    const served = await serve(root, ["test", "//:worse", "--known-red", "known-red.json"])
    expect(served.exitCode).toBe(1)
    expect(served.stderr).toContain("newly red, not in known-red.json: //:worse")
    expect(served.envelope).toContain("1 not on the known-red list")
  })

  it("fails when a listed target keeps its consumer from running", async () => {
    const root = await fixture()
    const served = await serve(root, ["test", "//:consumer", "--known-red", "known-red.json"])
    expect(served.exitCode).toBe(1)
    expect(served.stderr).toContain("known red (known-red.json): //:bad")
    expect(served.stderr).toContain("not run, a dependency is red: //:consumer")
  })

  it("refuses a list it cannot read", async () => {
    const root = await fixture()
    const served = await serve(root, ["test", "//:good", "--known-red", "absent.json"])
    expect(served.exitCode).toBe(1)
    expect(served.envelope).toContain("cannot read the known-red list")
  })

  it("leaves a plan untouched", async () => {
    const root = await fixture()
    const served = await serve(root, ["test", "//:worse", "--plan", "--known-red", "absent.json"])
    expect(served.exitCode).toBe(0)
  })
})
