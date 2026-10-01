/**
 * What `runs show` and `runs logs` tell an operator about a live run whose flow
 * spawned a child execution, through the real CLI and its separate stores.
 */
import * as Audience from "@smthrs/build-cli/Audience"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { createRunsCli } from "../src/cli/ControlCommands.ts"

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const preload = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url))
const source = `import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, FileSystem, Layer, Schema } from "effect"
const Hold = Action.make("parent/Hold", { payload: { marker: Schema.String }, success: Schema.String, error: Schema.Unknown })
const Child = Flow.make("parent/child", {
  payload: { marker: Schema.String }, success: Schema.String, error: Schema.Unknown,
  body: Node.capture({}, ({ marker }) => Hold.call({ marker }))
})
const Spawn = Action.make("parent/Spawn", { payload: { marker: Schema.String }, success: Schema.String, error: Schema.Unknown })
export const layer = Layer.mergeAll(
  Interpreter.layer(Child),
  Hold.toLayer(({ marker }) => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(marker, String(process.pid))
    return yield* Effect.never
  })),
  Spawn.toLayer(({ marker }) => Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance
    return yield* Child.execute({ marker }, { executionId: \`\${instance.executionId}/child\` })
  }))
)
export default Flow.make("parent", {
  description: "Spawn a child that holds until cancelled.",
  capabilities: ["fs:write:**"],
  effects: { reads: [], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { marker: Schema.String }, success: Schema.String, error: Schema.Unknown,
  body: Node.capture({}, ({ marker }) => Spawn.call({ marker }))
})`

type Result = { code: number | null; stdout: string; stderr: string }
const command = (root: string, args: ReadonlyArray<string>, format: ReadonlyArray<string> = ["--json"]) => {
  const child = spawn(
    process.execPath,
    ["--no-warnings", "--import", preload, bin, ...args, "--root", root, ...format],
    {
      cwd: root,
      env: { ...process.env, SMITHERS_REMOTE: "", SMITHERS_BACKEND: "sqlite", XDG_CONFIG_HOME: join(root, "config") }
    }
  )
  const finished = new Promise<Result>((resolve, reject) => {
    let stdout = "", stderr = ""
    child.stdout.on("data", (chunk) => stdout += chunk)
    child.stderr.on("data", (chunk) => stderr += chunk)
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, stdout, stderr }))
  })
  return { child, finished }
}
const controlRun = (root: string) => {
  if (!existsSync(join(root, ".flows", "control.db"))) return undefined
  const db = new DatabaseSync(join(root, ".flows", "control.db"), { readOnly: true, timeout: 1_000 })
  try {
    return db.prepare("SELECT run_id, status FROM flows_runs").get() as { run_id: string; status: string } | undefined
  } finally {
    db.close()
  }
}
const until = async <A>(read: () => A | undefined): Promise<A> => {
  for (let attempt = 0; attempt < 800; attempt++) {
    const result = read()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("The run did not reach its child")
}
/** `runs logs` as a person at a terminal reads it, through the command's own entry. */
const humanLogs = async (root: string, runId: string) => {
  let printed = ""
  let code = 0
  const terminal = (isTTY: boolean) => ({
    isTTY,
    columns: 160,
    write: (text: string) => {
      printed += text
    }
  })
  // The renderer writes to the invocation's stdout, which outside the root
  // CLI's presentation scope is the process's own.
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    printed += String(chunk)
    return true
  })
  await createRunsCli({
    stdout: terminal(true),
    stderr: terminal(false),
    environment: {},
    presentation: Audience.resolve({ audience: "human", env: {}, stdin: false, stdout: true, stderr: false })
  }).serve(
    ["logs", runId, "--root", root],
    {
      stdout: (text) => {
        printed += text
      },
      exit: (status) => {
        code = status
      }
    }
  ).finally(() => write.mockRestore())
  return { code, printed }
}
const show = async (root: string, runId: string) => {
  const shown = await command(root, ["runs", "show", runId]).finished
  expect(shown.code, shown.stdout + shown.stderr).toBe(0)
  return JSON.parse(shown.stdout)
}

describe("runs show and runs logs on a live parent run", { timeout: 180_000 }, () => {
  it("names the flow, lists the child, advances updatedAt, and prints recorded steps", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-run-observability-")))
    let runner: ReturnType<typeof command> | undefined
    try {
      const flow = join(root, "flows", "parent", "flow.ts")
      await mkdir(join(root, "flows", "parent"), { recursive: true })
      await symlink(nodeModules, join(root, "node_modules"), "dir")
      await writeFile(flow, source)
      const marker = join(root, "holding")
      runner = command(root, ["flow", "start", "parent", "--data", JSON.stringify({ marker }), "--wait"])
      const runId = await until(() => existsSync(marker) ? controlRun(root)?.run_id : undefined)

      const run = await show(root, runId)
      expect(run.status).toBe("running")
      expect(run.executionView.root.flowName).toBe("parent")
      expect(run.executionView.current.flowName).toBe("parent")
      expect(run.executions).toMatchObject([
        { executionId: runId, flowName: "parent", status: "running", parent: null, running: "parent/Spawn" },
        { flowName: "parent/child", status: "running", parent: runId, running: "parent/Hold" }
      ])
      expect(run.executions[1].executionId).toMatch(/\/child$/)
      expect(run.updatedAt).toBeGreaterThanOrEqual(run.executions[1].startedAtMs)
      expect(run.diagnosis.status).toBe("running")
      expect(run.diagnosis).not.toHaveProperty("endedAt")
      expect(run).not.toHaveProperty("codeDrift")

      const { code, printed } = await humanLogs(root, runId)
      expect(code, printed).toBe(0)
      expect(printed).toContain("Running parent/Spawn")
      expect(printed).toContain("Started parent/child")
      expect(printed).toContain("Running parent/Hold")
      expect(printed).toContain("End of recorded events")
      expect(printed).toContain(`smthrs runs logs '${runId}' --follow`)
      expect(printed).not.toContain("Stopped watching before settlement")

      await writeFile(flow, (await readFile(flow, "utf8")).replace("until cancelled.", "until cancelled!"))
      const changed = (await show(root, runId)).codeDrift
      expect(changed.recorded).toBe(run.executionDigest)
      expect(changed.current).toMatch(/^[0-9a-f]{64}$/)
      expect(changed.current).not.toBe(run.executionDigest)
      expect(changed.verdict).toBe("flow changed since the run started; resume needs --allow-code-drift")

      await unlink(flow)
      const gone = (await show(root, runId)).codeDrift
      expect(gone).toEqual({
        recorded: run.executionDigest,
        verdict: "flow is no longer on disk; the run cannot resume"
      })

      const cancelled = await command(root, ["runs", "cancel", runId]).finished
      expect(cancelled.code, cancelled.stdout + cancelled.stderr).toBe(0)
      await until(() => controlRun(root)?.status === "cancelled" ? true : undefined)
      await runner.finished
      const settled = await show(root, runId)
      expect(settled.status).toBe("cancelled")
      expect(settled.diagnosis.endedAt).toEqual(expect.any(Number))
      expect(settled.executions[0]).toMatchObject({ executionId: runId, status: "cancelled", running: null })
    } finally {
      runner?.child.kill("SIGKILL")
      await runner?.finished
      await rm(root, { recursive: true, force: true })
    }
  })
})
