/** `runs verify` renders a consistent report and exits non-zero on a divergent one. */
import { Cli } from "incur"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, expect, it, vi } from "vitest"
import { appendHistoryCommands } from "../src/cli/HistoryCommands.ts"
import type * as Verify from "../src/history/Verify.ts"

const ports = vi.hoisted(() => ({ verify: vi.fn(), verifyAll: vi.fn() }))
vi.mock("../src/history/Verify.ts", async (load) => ({
  ...await load<typeof import("../src/history/Verify.ts")>(),
  verify: ports.verify,
  verifyAll: ports.verifyAll
}))

const directory = mkdtempSync(join(tmpdir(), "smithers-verify-dispatch-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
beforeEach(() => {
  ports.verify.mockReset()
  ports.verifyAll.mockReset()
})

const invoke = async (signal?: AbortSignal, argv: ReadonlyArray<string> = ["run-1"]) => {
  let stdout = ""
  const codes: Array<number> = []
  await appendHistoryCommands(Cli.create("runs"), { environment: {}, ...(signal === undefined ? {} : { signal }) })
    .serve(["verify", ...argv, "--root", directory, "--json"], {
      env: {},
      stdout: (text) => {
        stdout += text
      },
      exit: (code) => {
        codes.push(code)
      }
    })
  return { stdout, codes }
}

it("prints a consistent report and exits zero", async () => {
  const report: Verify.Report = {
    runId: "run-1",
    verdict: "consistent",
    replayed: [{ stepKeyDigest: "d1", action: "first" }],
    notReplayed: []
  }
  ports.verify.mockResolvedValue(report)
  const controller = new AbortController()
  const result = await invoke(controller.signal)
  expect(ports.verify).toHaveBeenCalledExactlyOnceWith(directory, "run-1", {}, controller.signal)
  expect(JSON.parse(result.stdout)).toEqual(report)
  expect(result.codes).toEqual([])
})

it("exits one with run_divergent when a recorded step would not replay", async () => {
  ports.verify.mockResolvedValue(
    {
      runId: "run-1",
      verdict: "divergent",
      replayed: [],
      executes: { stepKeyDigest: "d2", action: "second-renamed" },
      notReplayed: [{ stepKeyDigest: "d1", action: "second" }]
    } satisfies Verify.Report
  )
  const result = await invoke()
  expect(result.codes).toEqual([1])
  expect(result.stdout).toContain("run_divergent")
  expect(result.stdout).toContain("would execute second-renamed again; 1 recorded step(s) would not replay: second")
})

it("verifies one run in another store with --against", async () => {
  ports.verify.mockResolvedValue({ runId: "run-1", verdict: "consistent", replayed: [], notReplayed: [] })
  const result = await invoke(undefined, ["run-1", "--against", "/stores/engine.db"])
  expect(ports.verify).toHaveBeenCalledExactlyOnceWith(directory, "run-1", { against: "/stores/engine.db" }, undefined)
  expect(ports.verifyAll).not.toHaveBeenCalled()
  expect(result.codes).toEqual([])
})

it("verifies every stored run when no run is named, in the project's store or --against another", async () => {
  const summary: Verify.Summary = {
    verdict: "consistent",
    reports: [{ runId: "run-1", verdict: "consistent", replayed: [], notReplayed: [] }],
    settled: [{ runId: "run-0", status: "completed" }],
    unverified: [{ runId: "run-9", code: "ClaimLost", message: "Another host owns run-9" }]
  }
  ports.verifyAll.mockResolvedValue(summary)
  const controller = new AbortController()
  const project = await invoke(controller.signal, [])
  expect(ports.verifyAll).toHaveBeenCalledExactlyOnceWith(directory, {}, controller.signal)
  expect(JSON.parse(project.stdout)).toEqual(summary)
  expect(project.codes).toEqual([])
  const against = await invoke(undefined, ["--against", "/stores/engine.db"])
  expect(ports.verifyAll).toHaveBeenLastCalledWith(directory, { against: "/stores/engine.db" }, undefined)
  expect(against.codes).toEqual([])
  expect(ports.verify).not.toHaveBeenCalled()
})

it("exits one with run_divergent naming every divergent stored run", async () => {
  ports.verifyAll.mockResolvedValue(
    {
      verdict: "divergent",
      reports: [
        { runId: "run-1", verdict: "consistent", replayed: [], notReplayed: [] },
        {
          runId: "run-2",
          verdict: "divergent",
          replayed: [],
          executes: { stepKeyDigest: "d2", action: "second-renamed" },
          notReplayed: [{ stepKeyDigest: "d1", action: "second" }]
        }
      ],
      settled: [],
      unverified: []
    } satisfies Verify.Summary
  )
  const result = await invoke(undefined, ["--against", "/stores/engine.db"])
  expect(result.codes).toEqual([1])
  expect(result.stdout).toContain("run_divergent")
  expect(result.stdout).toContain("Resuming run-2 would execute second-renamed again")
  expect(result.stdout).not.toContain("Resuming run-1")
})
