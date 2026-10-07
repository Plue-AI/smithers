/** Native cancellation converges the actual CLI's separate durable stores. */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Ownership } from "@smthrs/run-store"
import { Duration, Effect } from "effect"
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"
import { commitCancelBeforeCleanup } from "./fixtures/cancel-before-cleanup.ts"

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const preload = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url))
const source = `import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, FileSystem, Schema } from "effect"
const Hold = Action.make("hold/Wait", { payload: { marker: Schema.String }, success: Schema.String, error: Schema.Unknown, implementationVersion: "3412/cli/v1", nondeterministic: true, tier: "irreversible" })
export const layer = Hold.toLayer(({ marker }) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString(marker, String(process.pid) + "\\n", { flag: "a" })
  return yield* Effect.never
}), { implementationVersion: "3412/cli/v1" })
export default Flow.make("hold", {
  description: "Wait for cancellation.",
  capabilities: ["fs:write:**"],
  effects: { reads: [], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { marker: Schema.String }, success: Schema.String, error: Schema.Unknown,
  body: Node.capture({}, ({ marker }) => Hold.call({ marker }))
})`

type Result = { code: number | null; stdout: string; stderr: string }
const command = (root: string, args: ReadonlyArray<string>) => {
  const environment = { ...process.env }
  delete environment.SMITHERS_POSTGRES_TEST_BIN
  delete environment.SMITHERS_TEST_PG_URL
  const child = spawn(
    process.execPath,
    ["--no-warnings", "--import", preload, bin, ...args, "--root", root, "--json"],
    {
      cwd: root,
      env: { ...environment, SMITHERS_REMOTE: "", SMITHERS_BACKEND: "sqlite", XDG_CONFIG_HOME: join(root, "config") }
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
const rows = (root: string, kind: "control" | "engine") => {
  const db = new DatabaseSync(join(root, ".flows", `${kind}.db`), { readOnly: true, timeout: 1_000 })
  try {
    return db.prepare(
      "SELECT run_id, status, state_json, heartbeat_at_ms, cancel_requested_at_ms FROM flows_runs ORDER BY run_id"
    ).all() as Array<{
      run_id: string
      status: string
      state_json: string
      heartbeat_at_ms: number | null
      cancel_requested_at_ms: number | null
    }>
  } finally {
    db.close()
  }
}
const until = async <A>(read: () => A | undefined): Promise<A> => {
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = read()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Native cancellation did not converge")
}

describe("native CLI cancellation", { timeout: 120_000 }, () => {
  beforeEach(() => vi.stubEnv("SMITHERS_BACKEND", "sqlite"))
  afterEach(() => vi.unstubAllEnvs())
  it.each(["driving", "external", "released", "released committed request"] as const)(
    "converges after a %s cancellation",
    async (mode) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-native-cancel-")))
      let runner: ReturnType<typeof command> | undefined
      let qualified = false
      try {
        await mkdir(join(root, "flows", "hold"), { recursive: true })
        await symlink(nodeModules, join(root, "node_modules"), "dir")
        await writeFile(join(root, "flows", "hold", "flow.ts"), source)
        const marker = join(root, "executing")
        runner = command(root, ["flow", "start", "hold", "--data", JSON.stringify({ marker }), "--wait"])
        const runId = await until(() => {
          if (!existsSync(marker)) return undefined
          const control = rows(root, "control")[0]
          return control?.status === "running" ? control.run_id : undefined
        })
        expect(rows(root, "engine").some((row) => row.status === "running")).toBe(true)
        const entered = readFileSync(marker, "utf8")
        if (mode.startsWith("released")) {
          runner.child.kill("SIGTERM")
          const released = await runner.finished
          expect(released.code, released.stdout + released.stderr).toBe(143)
          expect(rows(root, "engine").every((row) => row.status === "suspended")).toBe(true)
          expect(() => process.kill(runner!.child.pid!, 0)).toThrow()
          if (mode === "released committed request") {
            // The exited host's fresh control lease still fences a takeover.
            const heartbeat = rows(root, "control")[0]!.heartbeat_at_ms!
            const staleAt = heartbeat + Duration.toMillis(Ownership.heartbeatStaleAfter) + 1
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, staleAt - Date.now())))
            await commitCancelBeforeCleanup(root, runId)
            expect(rows(root, "control")[0]?.status).toBe("cancelled")
            expect(rows(root, "engine").every((row) => row.status === "suspended")).toBe(true)
            expect(rows(root, "engine").find((row) => row.run_id === runId)?.cancel_requested_at_ms).not.toBeNull()
          }
        }
        if (mode === "driving") {
          await Effect.runPromise(
            Effect.gen(function*() {
              const control = yield* Control.Control
              yield* control.cancel({ runId, idempotencyKey: "driving-cancel" })
            }).pipe(
              Effect.provide(NodeControl.layer({ root, startsRuns: true, evaluator: ScriptedJudge.layer })),
              Effect.scoped
            )
          )
        } else {
          const cancelled = await command(root, ["runs", "cancel", runId]).finished
          // An accepted cancel exits 0 and the attached execution reports the
          // cancelled settlement below; a cancel whose own receipt is Terminal
          // (the released committed request) reports the interrupt status, 130.
          expect(cancelled.code, cancelled.stdout + cancelled.stderr).toBe(
            mode === "released committed request" ? 130 : 0
          )
          expect(cancelled.stderr).toBe("")
          if (mode === "released") {
            const receipt = JSON.parse(cancelled.stdout)
            expect(receipt._tag).toBe("Accepted")
            const fresh = rows(root, "control")[0]!
            expect(fresh.status).toBe("running")
            expect(fresh.heartbeat_at_ms).not.toBeNull()
            expect(rows(root, "engine").every((row) => row.status === "suspended")).toBe(true)
            expect(rows(root, "engine").find((row) => row.run_id === runId)?.cancel_requested_at_ms).not.toBeNull()
            // Respect the recorded control lease. A fresh owner cannot be taken
            // over even after its process exits; a later public cancel owns cleanup.
            const staleAt = fresh.heartbeat_at_ms! + Duration.toMillis(Ownership.heartbeatStaleAfter) + 1
            expect(Date.now()).toBeLessThan(staleAt)
            await new Promise((resolve) => setTimeout(resolve, staleAt - Date.now()))
            const settled = await command(root, ["runs", "cancel", runId]).finished
            expect(settled.code, settled.stdout + settled.stderr).toBe(130)
            expect(JSON.parse(settled.stdout)).toMatchObject({ _tag: "Terminal", status: "cancelled" })
          }
          if (mode.startsWith("released")) {
            process.stdout.write(
              JSON.stringify({
                mode,
                receipt: JSON.parse(cancelled.stdout),
                control: rows(root, "control"),
                native: rows(root, "engine")
              }) + "\n"
            )
          }
        }
        await until(() => rows(root, "control")[0]?.status === "cancelled" ? true : undefined)
        const exit = await runner.finished
        expect(exit.code, exit.stdout + exit.stderr).toBe(mode.startsWith("released") ? 143 : 130)
        const control = rows(root, "control")
        expect(control).toHaveLength(1)
        expect(control[0]?.status).toBe("cancelled")
        expect(JSON.parse(control[0]!.state_json).status).toBe("cancelled")
        const engine = rows(root, "engine")
        expect(engine.length).toBeGreaterThanOrEqual(2)
        expect(engine.every((row) => row.status === "cancelled")).toBe(true)
        expect(readFileSync(marker, "utf8")).toBe(entered)
        const shown = await command(root, ["status", runId]).finished
        expect(shown.code, shown.stdout + shown.stderr).toBe(0)
        expect(JSON.parse(shown.stdout)).toMatchObject({
          _tag: "runs",
          items: [{ runId, status: "cancelled" }]
        })
        expect(JSON.parse(shown.stdout).items).toHaveLength(1)
        const listed = await command(root, ["ps"]).finished
        expect(listed.code, listed.stdout + listed.stderr).toBe(0)
        expect(JSON.parse(listed.stdout).items).toMatchObject([{ runId, status: "cancelled" }])
        const replay = await command(root, ["runs", "cancel", runId]).finished
        // The stable request can replay Accepted; the durable state stays terminal.
        // Its exit follows the receipt it replays, like any cancel: a Terminal
        // cancelled receipt is an interruption (130), an Accepted one is 0 (#3071 RC4).
        const replayed = JSON.parse(replay.stdout)
        expect(replay.code, replay.stdout + replay.stderr).toBe(replayed._tag === "Terminal" ? 130 : 0)
        if (replayed._tag === "Terminal") expect(replayed.status).toBe("cancelled")
        expect(replayed.runId).toBe(runId)
        expect(rows(root, "control")).toEqual(control)
        expect(rows(root, "engine")).toEqual(engine)
        expect(readFileSync(marker, "utf8")).toBe(entered)
        expect(() => process.kill(runner!.child.pid!, 0)).toThrow()
        qualified = true
      } finally {
        runner?.child.kill("SIGKILL")
        const last = await runner?.finished
        if (!qualified) process.stdout.write(JSON.stringify({ mode, phase: "failed host", last }) + "\n")
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
