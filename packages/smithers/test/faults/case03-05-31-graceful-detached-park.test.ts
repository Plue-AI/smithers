/**
 * Cases 3, 5, and 31: a graceful detached launcher exit leaves its admitted
 * run durable. This is a different fault from the engine `SIGKILL` cases: the
 * product binary reaches its own clean shutdown path after `up -d` admits the
 * run, and a later product binary reads and resumes the same row.
 *
 * The CLI host cannot execute a seatless module flow. That limitation supplies
 * a deterministic non-terminal boundary without a model credential: the run
 * waits at `accepted` for its external executor. The manual transcript beside
 * this case covers the stronger `waiting-approval` boundary with a real model
 * issuing an in-run ask.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"

const executable = fileURLToPath(new URL("../../src/bin.ts", import.meta.url))
const judge = new URL("../fixtures/scripted-native-host.ts", import.meta.url).href
const project = realpathSync(mkdtempSync(join(tmpdir(), "smithers-graceful-park-")))
const home = join(project, "isolated-home")

interface Invocation {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error: Error | undefined
}

const smithers = (...args: ReadonlyArray<string>): Invocation => {
  const result = spawnSync(process.execPath, ["--import", judge, "--no-warnings", executable, "--json", ...args], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, SMITHERS_HOME: home },
    timeout: 60_000
  })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  }
}

mkdirSync(join(project, "flows", "idle"), { recursive: true })
mkdirSync(join(project, ".flows"), { recursive: true })
mkdirSync(home, { recursive: true })
writeFileSync(
  join(project, "flows", "idle", "flow.ts"),
  [
    "import { Flow } from \"@smthrs/core\"",
    "import { Schema } from \"effect\"",
    "",
    "export default Flow.make({",
    // The registry name the path derives; `@smthrs/core` requires it.
    "  name: \"idle\",",
    "  description: \"Waits for an external executor.\",",
    "  input: Schema.Struct({ args: Schema.String }),",
    "  output: Schema.String",
    "})",
    ""
  ].join("\n"),
  "utf8"
)

afterAll(() => rmSync(project, { recursive: true, force: true }))

describe("graceful detached park", { timeout: 240_000 }, () => {
  it("survives launcher exit and answers a bounded resume", () => {
    const launched = smithers("up", "idle", "-d")
    expect(launched.error).toBeUndefined()
    expect({ status: launched.status, stderr: launched.stderr }).toMatchObject({ status: 0 })
    const receipt = JSON.parse(launched.stdout) as { readonly detached: boolean; readonly runId: string }
    expect(receipt).toMatchObject({ detached: true, runId: expect.stringMatching(/^run-/) })

    const parked = smithers("ps")
    expect(parked.error).toBeUndefined()
    expect(parked.status).toBe(0)
    const before = (JSON.parse(parked.stdout) as {
      readonly items: ReadonlyArray<{ readonly runId: string; readonly status: string; readonly ownerId?: string }>
    }).items.find((run) => run.runId === receipt.runId)
    expect(before?.status).toBe("accepted")
    // The child reached the executor's clean pending path and released its
    // claim. A child still alive or killed between writes leaves an owner.
    expect(before?.ownerId).toBeUndefined()

    const resumed = smithers("run", "--resume", receipt.runId)
    expect(resumed.error).toBeUndefined()
    expect(resumed.status).toBe(1)
    expect(resumed.stderr).toContain("accepted but no executor took it")

    const observed = smithers("ps")
    expect(observed.error).toBeUndefined()
    expect(observed.status).toBe(0)
    const after = (JSON.parse(observed.stdout) as {
      readonly items: ReadonlyArray<{ readonly runId: string; readonly status: string }>
    }).items.find((run) => run.runId === receipt.runId)
    expect(after?.status).toBe("accepted")
  })
})
