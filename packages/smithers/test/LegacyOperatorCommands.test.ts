import { NodeServices } from "@effect/platform-node"
import * as TestControl from "@smthrs/control/test/TestControl"
import { make as migrateError } from "@smthrs/migrate/MigrateError"
import { Cause, Effect, Exit, Layer } from "effect"
import { TestConsole } from "effect/testing"
import { Command } from "effect/unstable/cli"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Agents from "../src/Agents.ts"
import { cli } from "../src/Command.ts"
import { CommandStatus } from "../src/internal/CommandStatus.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"
import { packageVersion } from "../src/Version.ts"
import { invokeCanonical } from "./fixtures/invokeCanonical.ts"

const ports = vi.hoisted(() => ({
  migrate: vi.fn(),
  renderMigration: vi.fn(),
  suggest: vi.fn(),
  isDirectory: vi.fn(),
  addMcp: vi.fn()
}))
vi.mock("@smthrs/migrate/flow/Command", async (load) => ({
  ...await load<typeof import("@smthrs/migrate/flow/Command")>(),
  runNode: ports.migrate,
  render: ports.renderMigration
}))
vi.mock("../src/Suggest.ts", async (load) => ({
  ...await load<typeof import("../src/Suggest.ts")>(),
  run: ports.suggest,
  isDirectory: ports.isDirectory
}))
vi.mock("../src/Agents.ts", async (load) => ({
  ...await load<typeof import("../src/Agents.ts")>(),
  addMcp: ports.addMcp
}))

const runCommand = Command.runWith(cli, { version: packageVersion })
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "smithers-legacy-operator-"))
  ports.migrate.mockReset().mockReturnValue(Effect.succeed({ exitCode: 0 }))
  ports.renderMigration.mockReset().mockImplementation((_report, mode, directory) => `migration ${mode} ${directory}`)
  ports.suggest.mockReset().mockReturnValue(Effect.succeed({ status: "listed", implemented: [] }))
  ports.isDirectory.mockReset().mockReturnValue(true)
  ports.addMcp.mockReset().mockImplementation((agent) => ({
    agent: agent.id,
    path: `/fixture/${agent.id}`,
    status: "written"
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const invoke = async (args: Array<string>) => {
  if (args[0] === "suggest" || args[0] === "mcp") {
    const result = await invokeCanonical([...args, "--root", root, "--json"])
    const error = result.codes.some((code) => code !== 0 && code !== 130)
      ? JSON.parse(result.stdout) as { readonly message: string }
      : undefined
    return { ...result, exit: error === undefined ? Exit.void : Exit.fail(error), failure: error?.message }
  }
  const codes: Array<number> = []
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const exit = yield* Effect.exit(runCommand(args))
      const stdout = (yield* TestConsole.logLines).map(String).join("\n")
      const stderr = (yield* TestConsole.errorLines).map(String).join("\n")
      return { exit, stdout, stderr }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestControl.layer(), TestConsole.layer, Output.layer, NodeControl.layerMemoryRemote)
      ),
      Effect.provide(NodeServices.layer),
      Effect.provideService(Project.ProjectRoot, root),
      Effect.provideService(Project.MigrationRoot, root),
      Effect.provideService(CommandStatus, (code) => {
        codes.push(code)
      })
    )
  )
  return {
    ...result,
    codes,
    failure: Exit.isFailure(result.exit) ? String(Cause.squash(result.exit.cause)) : undefined
  }
}

describe("legacy operator command contracts", () => {
  it.each(["run-state-blocked", "unsafe-blocked", "apply-in-progress"] as const)(
    "preserves parked status for migration refusal %s",
    async (code) => {
      ports.migrate.mockReturnValue(Effect.fail(migrateError(code, "Operator decision required", "specific remedy")))
      const result = await invoke(["migrate", "--json"])
      expect(Exit.isSuccess(result.exit)).toBe(true)
      expect(result.codes).toEqual([3])
      expect(JSON.parse(result.stdout)).toEqual({
        code,
        message: "Operator decision required",
        details: "specific remedy",
        root
      })
    }
  )

  it("renders a human migration gate without inventing absent details", async () => {
    ports.migrate.mockReturnValue(Effect.fail(migrateError("unsafe-blocked", "Review the unsafe constructs")))
    const result = await invoke(["migrate"])
    expect(Exit.isSuccess(result.exit)).toBe(true)
    expect(result.codes).toEqual([3])
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("smthrs migrate: Review the unsafe constructs")
  })

  it("preserves failure diagnostics for migration execution errors", async () => {
    ports.migrate.mockReturnValue(Effect.fail(migrateError("io", "Could not read input", "disk unavailable")))
    const result = await invoke(["migrate", "--json"])
    expect(result.failure).toContain("smthrs migrate: Could not read input\ndisk unavailable")
    expect(result.codes).toEqual([])
    expect(result.stdout).toBe("")
  })

  it("passes the complete migration command policy to its executor", async () => {
    const target = join(root, "project")
    const result = await invoke([
      "migrate",
      target,
      "--apply",
      "--seat",
      "openai:test",
      "--allow-unsafe",
      "all",
      "--acknowledge-run-state",
      "--allow-no-vcs",
      "--keep-old-sources",
      "--unit",
      "a,b",
      "--max-repair-rounds",
      "2",
      "--report-dir",
      "report",
      "--flows-dir",
      "workflows",
      "--verify-install",
      "install",
      "--verify-format",
      "format",
      "--verify-typecheck",
      "types",
      "--verify-test",
      "test",
      "--json"
    ])
    expect(result.failure).toBeUndefined()
    expect(ports.migrate.mock.calls).toHaveLength(1)
    expect(ports.migrate.mock.calls[0]![0]).toMatchObject({
      root: target,
      mode: "apply",
      seat: "openai:test",
      allowUnsafe: "all",
      acknowledgeRunState: true,
      allowNoVcs: true,
      keepOldSources: true,
      units: ["a", "b"],
      maxRepairRounds: 2,
      reportDir: "report",
      layout: { flowsDir: "workflows" },
      commands: { install: "install", format: "format", typecheck: ["types"], test: "test" }
    })
    expect(result.stdout).toBe(`migration json ${target}/report`)
    expect(result.codes).toEqual([0])
  })

  it("retains a successful migration's nonzero report status even under quiet output", async () => {
    ports.migrate.mockReturnValue(Effect.succeed({ exitCode: 1 }))
    const result = await invoke(["migrate", "--scan", "--quiet"])
    expect(result.failure).toBeUndefined()
    expect(ports.migrate.mock.calls[0]![0]).toMatchObject({ root, mode: "scan" })
    expect(ports.renderMigration).toHaveBeenCalledExactlyOnceWith(
      { exitCode: 1 },
      "human",
      join(root, ".smithers-migrate")
    )
    expect(result.stdout).toBe(`migration human ${join(root, ".smithers-migrate")}`)
    expect(result.codes).toEqual([1])
  })

  it.each([undefined, "relative-project"])("selects the suggestion directory for %s", async (path) => {
    const result = await invoke([
      "suggest",
      ...(path === undefined ? [] : [path]),
      "--seat",
      "openai:test",
      "--list",
      "--json"
    ])
    expect(result.failure).toBeUndefined()
    expect(ports.suggest.mock.calls[0]![0]).toMatchObject({
      root: path === undefined ? root : resolve(path),
      seat: "openai:test",
      list: true,
      json: true
    })
    expect(result.codes).toEqual([0])
  })

  it("refuses a non-directory before asking a suggestion provider", async () => {
    ports.isDirectory.mockReturnValue(false)
    const result = await invoke(["suggest"])
    expect(result.failure).toContain("must be a directory")
    expect(ports.suggest).not.toHaveBeenCalled()
  })

  it("preserves suggestion cancellation as status 130", async () => {
    ports.suggest.mockReturnValue(Effect.succeed({ status: "cancelled", implemented: [] }))
    expect((await invoke(["suggest"])).codes).toEqual([130])
  })

  it.each([new Error("offline"), "offline"])(
    "turns update transport failure into an actionable error: %s",
    async (cause) => {
      const fetch = vi.fn().mockRejectedValue(cause)
      vi.stubGlobal("fetch", fetch)
      const result = await invoke(["update", "--json"])
      expect(result.failure).toContain(
        "Could not reach the npm registry. Check your network and run `smthrs update` again."
      )
      expect(result.failure).not.toContain("offline")
      expect(Exit.isFailure(result.exit) && Cause.squash(result.exit.cause)).toMatchObject({
        _tag: "/cli/Refused",
        fault: "dependency",
        code: "registry_unreachable"
      })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(result.stdout).toBe("")
    }
  )

  it("registers only the named agent and renders the complete result", async () => {
    const agent = Agents.agents[0]!
    const result = await invoke(["mcp", "add", "--agent", agent.id, "--json"])
    expect(result.failure).toBeUndefined()
    expect(ports.addMcp).toHaveBeenCalledExactlyOnceWith(agent, undefined)
    expect(JSON.parse(result.stdout)).toEqual([{ agent: agent.id, path: `/fixture/${agent.id}`, status: "written" }])
  })

  it("prints manual MCP setup guidance when every registration fails", async () => {
    ports.addMcp.mockImplementation((agent) => ({
      agent: agent.id,
      path: `/fixture/${agent.id}`,
      status: "failed",
      reason: "locked"
    }))
    const result = await invoke(["mcp", "add", "--json"])
    expect(ports.addMcp).toHaveBeenCalledTimes(Agents.agents.length)
    expect(result.failure).toContain("Could not register the MCP server")
    expect(result.stderr).toBe(`${Agents.manualInstructions(Agents.agents.map((agent) => agent.id))}\n`)
    expect(JSON.parse(result.stdout)).toEqual({
      code: "UnsupportedError",
      message: "Could not register the MCP server"
    })
  })
})
