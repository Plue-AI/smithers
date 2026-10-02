/** #3412: current native child cancellation is observable without forwarding
 * new lifecycle events into a released host's historical control journal. */
import { Control, type ControlSchema } from "@smthrs/control"
import { Action } from "@smthrs/flow"
import * as NativeRuntime from "@smthrs/flows/NodeRuntime"
import { Ownership } from "@smthrs/run-store"
import { Duration, Effect, Layer, Stream } from "effect"
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import * as RunActivity from "../src/cli/RunActivity.ts"
import * as NodeControl from "../src/NodeControl.ts"
import { Child, layer as fixtureLayer } from "./fixtures/run-activity-cancellation/flow.ts"

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const preload = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const fixture = fileURLToPath(new URL("./fixtures/run-activity-cancellation/flow.ts", import.meta.url))
const modules = fileURLToPath(new URL("../node_modules", import.meta.url))
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const command = (root: string, args: ReadonlyArray<string>) => {
  const child = spawn(
    process.execPath,
    ["--no-warnings", "--import", preload, bin, ...args, "--root", root, "--json"],
    {
      cwd: root,
      env: { ...process.env, SMITHERS_REMOTE: "", SMITHERS_BACKEND: "sqlite", XDG_CONFIG_HOME: join(root, "config") }
    }
  )
  let stdout = "", stderr = ""
  const finished = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.stdout.on("data", (chunk) => stdout += String(chunk))
    child.stderr.on("data", (chunk) => stderr += String(chunk))
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, stdout, stderr }))
  })
  return { child, finished, output: () => ({ stdout, stderr }) }
}
const jsonCommand = async (root: string, args: ReadonlyArray<string>, code = 0) => {
  const result = await command(root, args).finished
  expect(result.code, result.stdout + result.stderr).toBe(code)
  expect(result.stderr).toBe("")
  return JSON.parse(result.stdout)
}
const observe = (root: string, runId: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const events = yield* Stream.runCollect(control.watch({ runId, follow: false }))
      const executionIds = RunActivity.knownExecutionIds(events)
      const result = yield* control.list({ _tag: "executions", runId, executionIds })
      if (result._tag !== "executions") return yield* Effect.die("expected exact execution observations")
      return {
        events,
        batch: { source: result.source, revision: result.revision, snapshots: result.items },
        executionIds
      }
    }).pipe(Effect.provide(NodeControl.layerObserve({ root })), Effect.scoped)
  )

const publicDiagnostics = (root: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const runs = yield* control.list({ _tag: "runs" })
      if (runs._tag !== "runs") return yield* Effect.die("expected public run list")
      return yield* Effect.forEach(runs.items, (run) =>
        Effect.gen(function*() {
          const events = yield* Stream.runCollect(control.watch({ runId: run.runId, follow: false }))
          const executionIds = RunActivity.knownExecutionIds(events)
          const executions = yield* control.list({ _tag: "executions", runId: run.runId, executionIds })
          return { run, events, executions }
        }))
    }).pipe(
      Effect.provide(NodeControl.layerObserve({ root })),
      Effect.scoped,
      Effect.timeout("10 seconds")
    )
  )

it(
  "shows an actually cancelled native child after its host releases, keeping the recorded lifecycle intact",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-native-activity-cancel-")))
    let runner: ReturnType<typeof command> | undefined
    let phase = "admission"
    try {
      // Keep public API reads on the CLI fixture's real SQLite stores even
      // when the developer has configured an ambient PostgreSQL URL.
      vi.stubEnv("SMITHERS_BACKEND", "sqlite")
      await mkdir(join(root, "flows", "cancel-activity"), { recursive: true })
      await symlink(modules, join(root, "node_modules"), "dir")
      await copyFile(fixture, join(root, "flows", "cancel-activity", "flow.ts"))
      await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
      const marker = join(root, "entered")
      runner = command(root, ["flow", "start", "cancel-activity", "--data", JSON.stringify({ marker }), "--wait"])
      const deadline = Date.now() + 30_000
      while (!existsSync(marker)) {
        if (runner.child.exitCode !== null || runner.child.signalCode !== null) {
          const failed = await runner.finished
          throw Error(failed.stdout + failed.stderr)
        }
        if (Date.now() >= deadline) throw Error("Native child never reached its holding action")
        await delay(25)
      }
      const entered = readFileSync(marker, "utf8")
      expect(entered).toBe(`${runner.child.pid}\n`)
      const page = await jsonCommand(root, ["runs", "list"])
      expect(page.items).toHaveLength(1)
      const runId: string = page.items[0].runId
      const running = await jsonCommand(root, ["runs", "show", runId])
      const child = running.executions.find((row: RunActivity.Execution) => row.flowName === "cancel-activity/child")
      expect(child).toMatchObject({ status: "running", running: "cancel-activity/Hold" })
      expect(child.executionId).not.toBe(runId)

      // Real graceful release; ownership timestamps are never forged in SQL.
      phase = "release"
      runner.child.kill("SIGTERM")
      const releasedHost = await runner.finished
      expect(releasedHost.code, releasedHost.stdout + releasedHost.stderr).toBe(143)
      const released = await observe(root, runId)
      expect(released.batch.snapshots.find((row) => row.executionId === child.executionId)).toMatchObject({
        _tag: "Observed",
        observation: { status: "suspended" }
      })
      const historical = RunActivity.fold(released.events, { runId, flowId: "cancel-activity" })
      expect(historical.executions.find((row) => row.executionId === child.executionId)?.status).not.toBe("cancelled")
      const releasedRoot = released.batch.snapshots.find((row) => row.executionId === runId)
      expect(releasedRoot).toMatchObject({ _tag: "Observed", observation: { status: "suspended" } })

      // The peer waits through the actual stale lease before native cleanup.
      phase = "stale lease"
      await delay(Duration.toMillis(Ownership.heartbeatStaleAfter) + 1_000)
      phase = "cancellation"
      // An ordinary public library host settles the native child after the
      // control projection host exits. It has no Control journal subscriber.
      const settled = await Effect.runPromise(
        Effect.gen(function*() {
          yield* Child.interrupt(child.executionId)
          yield* Child.resume(child.executionId)
          let current = yield* Effect.promise(() => observe(root, runId))
          while (
            !current.batch.snapshots.some((row) =>
              row.executionId === child.executionId && row._tag === "Observed" && row.observation.status === "cancelled"
            )
          ) {
            yield* Effect.sleep("25 millis")
            current = yield* Effect.promise(() => observe(root, runId))
          }
          return current
        }).pipe(
          Effect.provide(NativeRuntime.layerHost({
            filename: NodeControl.executionDatabasePath(root),
            workspaceRoot: root,
            owner: { hostId: "native-activity-cancellation" },
            signals: [],
            canExecute: (row) => Effect.succeed(row.runId === child.executionId && row.cancelRequestedAtMs !== null),
            canActivate: (row) => Effect.succeed(row.runId === child.executionId && row.cancelRequestedAtMs !== null)
          }, fixtureLayer.pipe(Layer.provideMerge(Action.layerImplementations)))),
          Effect.scoped,
          Effect.timeout("30 seconds")
        )
      )
      expect(settled.batch.snapshots.find((row) => row.executionId === runId)).toEqual(releasedRoot)
      const nonChildren = settled.batch.snapshots.filter((row) => row.executionId !== child.executionId)
      expect(nonChildren).toEqual(released.batch.snapshots.filter((row) => row.executionId !== child.executionId))
      expect(nonChildren).toHaveLength(2)
      for (const row of nonChildren) {
        expect(row).toMatchObject({ _tag: "Observed", observation: { status: "suspended" } })
      }
      const exactChild = settled.batch.snapshots.find((row) => row.executionId === child.executionId)
      expect(exactChild).toMatchObject({ _tag: "Observed", observation: { status: "cancelled" } })
      if (exactChild?._tag !== "Observed") throw Error("Native child observation unavailable")
      expect(exactChild.observation.finishedAtMs).toEqual(expect.any(Number))
      expect(exactChild.observation.cancelRequestedAtMs).toEqual(expect.any(Number))
      // All retained engine envelopes remain byte-for-byte the old journal.
      const engineEvents = (events: ReadonlyArray<ControlSchema.ControlEvent>) =>
        events.filter((event) => event.kind === "control.engine.event")
      expect(engineEvents(settled.events)).toEqual(engineEvents(released.events))
      const recordedChild = RunActivity.fold(settled.events, { runId, flowId: "cancel-activity" }).executions.find((
        row
      ) => row.executionId === child.executionId)
      expect(recordedChild?.status).toBe(
        historical.executions.find((row) => row.executionId === child.executionId)?.status
      )
      expect(recordedChild?.status).not.toBe("cancelled")

      const shown = await jsonCommand(root, ["runs", "show", runId])
      expect(shown.status).toBe("parked")
      expect(shown.executions.find((row: RunActivity.Execution) => row.executionId === runId))
        .toMatchObject({ status: "suspended", finishedAtMs: null })
      expect(shown.executions.find((row: RunActivity.Execution) => row.executionId === child.executionId))
        .toMatchObject({
          status: "cancelled",
          running: null,
          finishedAtMs: exactChild.observation.finishedAtMs
        })
      expect(shown.executionSnapshots.flatMap((batch: ControlSchema.ExecutionBatch) => batch.snapshots)).toEqual(
        settled.batch.snapshots
      )
      expect(readFileSync(marker, "utf8")).toBe(entered)
      expect(() => process.kill(runner!.child.pid!, 0)).toThrow()
      console.log(
        "NATIVE_ACTIVITY_CANCELLATION_RECEIPT",
        JSON.stringify({
          runId,
          childId: child.executionId,
          historical: recordedChild?.status,
          observed: exactChild.observation.status,
          root: releasedRoot?._tag === "Observed" ? releasedRoot.observation.status : null,
          historicalEngineEnvelopes: engineEvents(settled.events).length,
          handlerEntries: 1,
          source: settled.batch.source,
          revision: settled.batch.revision
        })
      )
    } catch (error) {
      const diagnostics = await publicDiagnostics(root).catch((cause: unknown) => ({ error: String(cause) }))
      console.log(
        "NATIVE_ACTIVITY_CANCELLATION_FAILURE",
        JSON.stringify({ phase, error: String(error), host: runner?.output(), diagnostics })
      )
      throw error
    } finally {
      vi.unstubAllEnvs()
      runner?.child.kill("SIGKILL")
      await runner?.finished
      await rm(root, { recursive: true, force: true })
    }
  },
  180_000
)
