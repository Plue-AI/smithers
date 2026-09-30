/** `runs verify` renders a consistent report and exits non-zero on a divergent one. */
import { Cli } from "incur"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, expect, it, vi } from "vitest"
import { appendHistoryCommands } from "../src/cli/HistoryCommands.ts"
import type * as Verify from "../src/history/Verify.ts"

const ports = vi.hoisted(() => ({ verify: vi.fn() }))
vi.mock("../src/history/Verify.ts", async (load) => ({
  ...await load<typeof import("../src/history/Verify.ts")>(),
  verify: ports.verify
}))

const directory = mkdtempSync(join(tmpdir(), "smithers-verify-dispatch-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
beforeEach(() => ports.verify.mockReset())

const invoke = async (signal?: AbortSignal) => {
  let stdout = ""
  const codes: Array<number> = []
  await appendHistoryCommands(Cli.create("runs"), { environment: {}, ...(signal === undefined ? {} : { signal }) })
    .serve(["verify", "run-1", "--root", directory, "--json"], {
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
