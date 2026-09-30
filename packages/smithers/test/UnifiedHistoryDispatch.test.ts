import { Cli } from "incur"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type * as Bridge from "../src/cli/ControlBridge.ts"
import { appendHistoryCommands, prepareHistoryRun, reconcileHistory } from "../src/cli/HistoryCommands.ts"
import * as CliError from "../src/CliError.ts"

const ports = vi.hoisted(() => ({
  read: vi.fn(),
  mutate: vi.fn(),
  preview: vi.fn(),
  reconcile: vi.fn(),
  prepare: vi.fn()
}))
vi.mock("../src/history/History.ts", async (load) => ({
  ...await load<typeof import("../src/history/History.ts")>(),
  read: ports.read,
  mutate: ports.mutate,
  preview: ports.preview,
  reconcile: ports.reconcile,
  prepare: ports.prepare
}))

const directory = mkdtempSync(join(tmpdir(), "smithers-history-dispatch-"))
const relativeProject = relative(process.cwd(), directory)
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const projection = {
  runId: "run-1",
  position: { frame: { lineageId: "lineage/root", seq: 0 } },
  entryCount: 0,
  state: { durable: true }
}
const mutation = { runId: "child-1", auditId: "audit-1", workspace: "/fixture/child" }
const preview = { runId: "run-1", entriesToArchive: 3, affectedEffects: ["publish"] }

beforeEach(() => {
  for (const port of Object.values(ports)) port.mockReset()
  ports.read.mockResolvedValue(projection)
  ports.mutate.mockResolvedValue(mutation)
  ports.preview.mockResolvedValue(preview)
  ports.prepare.mockReturnValue({ executionRoot: "/fixture/child" })
  vi.stubEnv("SMITHERS_REMOTE", undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const invoke = async (args: Array<string>, runtime?: Bridge.Runtime) => {
  let stdout = ""
  const codes: Array<number> = []
  await appendHistoryCommands(Cli.create("runs"), runtime).serve([...args, "--json"], {
    env: runtime?.environment ?? process.env,
    stdout: (text) => {
      stdout += text
    },
    exit: (code) => {
      codes.push(code)
    }
  })
  return { stdout, codes }
}

describe("unified historical command dispatch", () => {
  it.each(["inspect", "replay"])(
    "passes the exact historical address and cancellation signal through %s",
    async (command) => {
      const controller = new AbortController()
      const result = await invoke([
        command,
        "run-1",
        "--root",
        directory,
        "--at",
        "0",
        "--lineage",
        "lineage/root",
        "--limit",
        "1"
      ], { environment: {}, signal: controller.signal })
      expect(ports.read).toHaveBeenCalledExactlyOnceWith(
        directory,
        "run-1",
        {
          root: directory,
          quiet: false,
          at: 0,
          lineage: "lineage/root",
          limit: 1,
          sequence: 0
        },
        command === "replay",
        controller.signal
      )
      expect(JSON.parse(result.stdout)).toEqual(projection)
      expect(result.codes).toEqual([])
      expect(ports.mutate).not.toHaveBeenCalled()
      expect(ports.preview).not.toHaveBeenCalled()
    }
  )

  it.each(["inspect", "replay"])("keeps the latest-frame default and read budget for %s", async (command) => {
    const result = await invoke([command, "run-1", "--root", relativeProject])
    expect(ports.read).toHaveBeenCalledExactlyOnceWith(
      resolve(relativeProject),
      "run-1",
      {
        root: relativeProject,
        quiet: false,
        limit: 10_000,
        sequence: undefined
      },
      command === "replay",
      undefined
    )
    expect(JSON.parse(result.stdout)).toEqual(projection)
  })

  it("forks from sequence zero without dropping the exact lineage or caller signal", async () => {
    const controller = new AbortController()
    const result = await invoke([
      "fork",
      "run-1",
      "--root",
      directory,
      "--at",
      "0",
      "--lineage",
      "lineage/root",
      "--limit",
      "12"
    ], { environment: {}, signal: controller.signal })
    expect(ports.mutate).toHaveBeenCalledExactlyOnceWith(
      directory,
      "run-1",
      {
        root: directory,
        quiet: false,
        at: 0,
        lineage: "lineage/root",
        limit: 12,
        sequence: 0
      },
      "fork",
      controller.signal
    )
    expect(JSON.parse(result.stdout)).toEqual(mutation)
    expect(result.codes).toEqual([])
  })

  it("confirms rewind explicitly and preserves the mutation's audit receipt", async () => {
    const controller = new AbortController()
    const result = await invoke(["rewind", "run-1", "--root", directory, "--at", "7", "--yes"], {
      environment: {},
      signal: controller.signal
    })
    expect(ports.mutate).toHaveBeenCalledExactlyOnceWith(
      directory,
      "run-1",
      {
        root: directory,
        quiet: false,
        at: 7,
        limit: 10_000,
        sequence: 7,
        preview: false,
        yes: true,
        wholeRepo: false
      },
      "rewind",
      controller.signal
    )
    expect(JSON.parse(result.stdout)).toEqual(mutation)
    expect(ports.preview).not.toHaveBeenCalled()
  })

  it("forwards --whole-repo to the rewind mutation", async () => {
    const controller = new AbortController()
    await invoke(["rewind", "run-1", "--root", directory, "--at", "7", "--yes", "--whole-repo"], {
      environment: {},
      signal: controller.signal
    })
    expect(ports.mutate).toHaveBeenCalledExactlyOnceWith(
      directory,
      "run-1",
      expect.objectContaining({ sequence: 7, yes: true, wholeRepo: true }),
      "rewind",
      controller.signal
    )
  })

  it.each([false, true])("keeps preview read-only even when confirmation is also present (%s)", async (yes) => {
    const controller = new AbortController()
    const result = await invoke([
      "rewind",
      "run-1",
      "--root",
      directory,
      "--at",
      "7",
      "--preview",
      ...(yes ? ["--yes"] : [])
    ], { environment: {}, signal: controller.signal })
    expect(ports.preview).toHaveBeenCalledExactlyOnceWith(directory, "run-1", {
      root: directory,
      quiet: false,
      at: 7,
      limit: 10_000,
      sequence: 7,
      preview: true,
      yes,
      wholeRepo: false
    }, controller.signal)
    expect(JSON.parse(result.stdout)).toEqual(preview)
    expect(ports.mutate).not.toHaveBeenCalled()
  })

  it("requires confirmation before resolving or changing any history", async () => {
    const result = await invoke(["rewind", "run-1", "--root", directory, "--at", "7"])
    expect(result.codes).toEqual([2])
    expect(JSON.parse(result.stdout)).toEqual({
      code: "confirmation_required",
      message: "Use --preview to inspect the rewind, then --yes to apply it"
    })
    for (const port of Object.values(ports)) expect(port).not.toHaveBeenCalled()
  })

  it.each([
    ["inspect", []],
    ["replay", []],
    ["fork", ["--at", "0"]],
    ["rewind", ["--at", "0", "--yes"]],
    ["rewind", ["--at", "0", "--preview"]]
  ])("renders failures from %s %j without successful partial results", async (command, flags) => {
    for (const port of [ports.read, ports.mutate, ports.preview]) {
      port.mockRejectedValue(new Error("Authorization: Bearer private-fixture"))
    }
    const result = await invoke([command, "run-1", "--root", directory, ...flags], { environment: {} })
    expect(result.codes).toEqual([1])
    expect(JSON.parse(result.stdout)).toEqual({
      code: "history_failed",
      message: "Authorization: Bearer [REDACTED_TOKEN]"
    })
    expect(result.stdout).toContain("[REDACTED_TOKEN]")
    expect(result.stdout).not.toContain("private-fixture")
    expect(result.stdout).not.toContain("auditId")
  })

  it("exits 2 for a usage error, like every other guarded command", async () => {
    ports.read.mockRejectedValue(new CliError.UsageError({ message: "The path must be a directory" }))
    const result = await invoke(["inspect", "run-1", "--root", directory], { environment: {} })
    expect(result.codes).toEqual([2])
    expect(JSON.parse(result.stdout)).toEqual({ code: "history_failed", message: "The path must be a directory" })
  })

  it("renders non-Error rejections through the same failure contract", async () => {
    ports.read.mockRejectedValue("Authorization: Bearer private-fixture")
    const result = await invoke(["inspect", "run-1", "--root", directory])
    expect(result.codes).toEqual([1])
    expect(result.stdout).toContain("history_failed")
    expect(result.stdout).toContain("[REDACTED_TOKEN]")
    expect(result.stdout).not.toContain("private-fixture")
  })

  it("forks with one step result edited from inline JSON or a file", async () => {
    const file = join(directory, "result.json")
    writeFileSync(file, JSON.stringify({ text: "from file" }))
    for (const [result, expected] of [["\"inline\"", "inline"], [`@${file}`, { text: "from file" }]] as const) {
      ports.mutate.mockClear()
      const run = await invoke(
        ["fork", "run-1", "--root", directory, "--at", "4", "--step", "d1", "--result", result],
        {
          environment: {}
        }
      )
      expect(run.codes).toEqual([])
      expect(ports.mutate).toHaveBeenCalledExactlyOnceWith(
        directory,
        "run-1",
        {
          root: directory,
          quiet: false,
          at: 4,
          limit: 10_000,
          sequence: 4,
          override: { stepKeyDigest: "d1", result: expected }
        },
        "fork",
        undefined
      )
    }
  })

  it.each([
    [["--step", "d1"], "--step and --result edit a step together"],
    [["--result", "1"], "--step and --result edit a step together"],
    [["--step", "d1", "--result", "{not json"], "--result must be JSON"]
  ])("refuses an incomplete or malformed step edit %j before forking", async (flags, message) => {
    const result = await invoke(["fork", "run-1", "--root", directory, "--at", "4", ...flags], { environment: {} })
    expect(result.codes).toEqual([2])
    expect(result.stdout).toContain(message)
    expect(ports.mutate).not.toHaveBeenCalled()
  })

  it.each(["fork", "rewind"])(
    "honors the host's remote selection for %s without a runtime override",
    async (command) => {
      vi.stubEnv("SMITHERS_REMOTE", "https://control.invalid")
      const result = await invoke([command, "run-1", "--at", "0", ...(command === "rewind" ? ["--yes"] : [])])
      expect(result.codes).toEqual([1])
      expect(result.stdout).toContain("--remote is not supported")
      expect(ports.mutate).not.toHaveBeenCalled()
    }
  )

  it.each([
    ["flag", ["--remote", "https://control.invalid"], {}],
    ["environment", [], { SMITHERS_REMOTE: "https://control.invalid" }]
  ])("refuses all remote history commands before local work (%s)", async (_source, connection, environment) => {
    for (
      const [command, flags] of [["inspect", []], ["replay", []], ["fork", ["--at", "0"]], ["rewind", [
        "--at",
        "0",
        "--yes"
      ]]] as const
    ) {
      const result = await invoke([command, "run-1", ...connection, ...flags], { environment })
      expect(result.codes).toEqual([1])
      expect(result.stdout).toContain("--remote is not supported")
    }
    for (const port of Object.values(ports)) expect(port).not.toHaveBeenCalled()
  })

  it.each([
    ["fork", []],
    ["rewind", ["--yes"]],
    ["inspect", ["--at=-1"]],
    ["replay", ["--at=1.5"]],
    ["inspect", ["--limit=0"]],
    ["replay", ["--limit=1.5"]]
  ])("validates the historical address before %s %j", async (command, flags) => {
    const result = await invoke([command, "run-1", ...flags])
    expect(result.codes.some((code) => code !== 0)).toBe(true)
    for (const port of Object.values(ports)) expect(port).not.toHaveBeenCalled()
  })
})

describe("normal run history routing", async () => {
  it("uses the host environment when called without runtime options", async () => {
    await reconcileHistory({ root: directory, quiet: false })
    expect(ports.reconcile).toHaveBeenCalledExactlyOnceWith(directory)
    expect(await prepareHistoryRun("child", { root: directory, quiet: false })).toEqual({
      executionRoot: "/fixture/child"
    })
    expect(ports.prepare).toHaveBeenCalledExactlyOnceWith(directory, "child")
  })

  it("honors the host's remote environment when no runtime override is provided", async () => {
    vi.stubEnv("SMITHERS_REMOTE", "https://control.invalid")
    await reconcileHistory({ root: directory, quiet: false })
    expect(await prepareHistoryRun("child", { root: directory, quiet: false })).toEqual({})
    expect(ports.reconcile).not.toHaveBeenCalled()
    expect(ports.prepare).not.toHaveBeenCalled()
  })

  it("uses an explicit local environment instead of inheriting the host's remote target", async () => {
    vi.stubEnv("SMITHERS_REMOTE", "https://control.invalid")
    await reconcileHistory({ root: directory, quiet: false }, { environment: {} })
    expect(await prepareHistoryRun("child", { root: directory, quiet: false }, { environment: {} })).toEqual({
      executionRoot: "/fixture/child"
    })
    expect(ports.reconcile).toHaveBeenCalledExactlyOnceWith(directory)
    expect(ports.prepare).toHaveBeenCalledExactlyOnceWith(directory, "child")
  })

  it("treats an empty remote environment variable as absent", async () => {
    await reconcileHistory({ root: directory, quiet: false }, { environment: { SMITHERS_REMOTE: "" } })
    expect(
      await prepareHistoryRun("child", { root: directory, quiet: false }, { environment: { SMITHERS_REMOTE: "" } })
    )
      .toEqual({ executionRoot: "/fixture/child" })
    expect(ports.reconcile).toHaveBeenCalledExactlyOnceWith(directory)
    expect(ports.prepare).toHaveBeenCalledExactlyOnceWith(directory, "child")
  })

  it("does not query or resume when local reconciliation or worktree resolution fails", async () => {
    ports.reconcile.mockImplementation(() => {
      throw new Error("unreconciled audit")
    })
    ports.prepare.mockImplementation(() => {
      throw new Error("unlinked child")
    })
    await expect(reconcileHistory({ root: directory, quiet: false }, { environment: {} })).rejects.toThrow(
      "unreconciled audit"
    )
    await expect(prepareHistoryRun("child", { root: directory, quiet: false }, { environment: {} })).rejects.toThrow(
      "unlinked child"
    )
  })
})
