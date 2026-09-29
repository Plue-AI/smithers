/**
 * Case 32 — a checkpoint outlives the process that took it, and a reading taken
 * at one sees the pinned tree rather than the live one.
 *
 * `ctx.checkpoint` is the authoring name for this: a call that names a
 * checkpoint reads the tree as it was, so a "fails before, passes after" claim
 * is about two trees and not about whatever the working copy happened to hold
 * when the check ran. The pin is a git object named in repository config, not
 * a handle in a process — which is what makes the kill below meaningful.
 *
 * The refusals are part of the same contract: a path that is absolute, or that
 * climbs out of the checkout with `..`, would silently read the live tree while
 * the caller believed it was reading a pinned one. Both are refused with a
 * typed reason and nothing runs.
 */
import { Checkpointed } from "@smthrs/agent"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import { Checkpoints } from "@smthrs/std"
import { isAlive, killProcess } from "@smthrs/testing/Faults"
import * as Effect from "effect/Effect"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

const runner = fileURLToPath(new URL("./fixtures/checkpointChild.ts", import.meta.url))
const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-case32-"))
const ledger = join(directory, "ledger.txt")
const checkpointId = "pinned"

beforeAll(() => {
  execFileSync("git", ["init", "-q", "-b", "main", directory])
  execFileSync("git", ["-C", directory, "config", "user.email", "e2e@local"])
  execFileSync("git", ["-C", directory, "config", "user.name", "e2e"])
  writeFileSync(ledger, "one\n")
  execFileSync("git", ["-C", directory, "add", "."])
  execFileSync("git", ["-C", directory, "commit", "-qm", "baseline"])
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

// Every child this file spawns, until it has exited. A capture that stalls, a
// marker that never arrives, or an assertion that fails before the deliberate
// kill would otherwise leave the child holding itself open on the machine.
const children = new Set<ChildProcess>()
const captureDeadlineMs = 60_000
const graceMs = 2_000

const exited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

const teardown = async (child: ChildProcess): Promise<void> => {
  if (!exited(child)) {
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.kill("SIGTERM")
    const escalate = setTimeout(() => child.kill("SIGKILL"), graceMs)
    await exit
    clearTimeout(escalate)
  }
  children.delete(child)
}

afterEach(async () => {
  await Promise.all([...children].map(teardown))
})

const captureInDoomedProcess = (
  args: ReadonlyArray<string> = [runner, directory, checkpointId],
  deadlineMs = captureDeadlineMs
): Promise<{ readonly ref: string; readonly pid: number }> => {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] })
  children.add(child)
  child.once("exit", () => children.delete(child))
  let out = ""
  let err = ""
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void teardown(child)
  }, deadlineMs)
  return new Promise<{ readonly ref: string; readonly pid: number }>((resolve, reject) => {
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      out += chunk
      const match = /CAPTURED=(.+)\n/.exec(out)
      if (match !== null) resolve({ ref: match[1] as string, pid: child.pid as number })
    })
    child.stderr.on("data", (chunk: string) => {
      err += chunk
    })
    child.once("error", reject)
    // A deadline rejects only once the child it killed has exited.
    child.once("exit", (code) =>
      reject(
        new Error(
          timedOut
            ? `checkpoint child printed no CAPTURED marker within ${deadlineMs}ms\nstdout:\n${out}\nstderr:\n${err}`
            : `checkpoint child exited with ${String(code)}\n${err}`
        )
      ))
  }).finally(() => clearTimeout(timer))
}

const readAtCheckpoint = (): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const checkpoints = yield* Checkpoints.Checkpoints
      return yield* checkpoints.materialize(checkpointId, (materialized) =>
        Effect.sync(() => readFileSync(join(materialized.host, "ledger.txt"), "utf8")))
    }).pipe(
      Effect.provide(Checkpoints.layerGit({ root: directory })),
      Effect.provide(NodeHost.layer),
      Effect.scoped,
      Effect.orDie
    )
  )

describe("case32 a checkpoint is a pinned tree", () => {
  it("survives the process that took it and still reads the tree it pinned", async () => {
    const captured = await captureInDoomedProcess()
    expect(captured.ref).toMatch(/\S/)

    // The process that pinned the tree is gone.
    await killProcess({ pid: captured.pid })
    expect(isAlive(captured.pid)).toBe(false)

    // And the live tree has moved on since.
    writeFileSync(ledger, "two\n")
    expect(readFileSync(ledger, "utf8")).toBe("two\n")

    // A reading taken at the checkpoint is of the pinned tree, through a
    // fresh store that learned nothing but the checkpoint's name.
    expect(await readAtCheckpoint()).toBe("one\n")
    // Materializing did not disturb the live tree.
    expect(readFileSync(ledger, "utf8")).toBe("two\n")
  }, 120_000)

  it("tears down a child that never prints the marker, within the capture deadline", async () => {
    const started = Date.now()
    const pids: Array<number> = []
    const capture = captureInDoomedProcess(
      ["-e", "process.stderr.write('stalled\\n'); setInterval(() => {}, 1_000)"],
      1_000
    )
    for (const child of children) if (child.pid !== undefined) pids.push(child.pid)
    await expect(capture).rejects.toThrow(/no CAPTURED marker within 1000ms[\s\S]*stalled/)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(pids).toHaveLength(1)
    expect(isAlive(pids[0] as number)).toBe(false)
  }, 20_000)

  it("refuses a path that would read the live tree while claiming the pinned one", () => {
    const materialized = {
      id: checkpointId,
      host: join(directory, ".flows-checkpoints", checkpointId),
      guest: join(directory, ".flows-checkpoints", checkpointId),
      root: directory,
      guestRoot: directory
    }

    expect(Checkpoints.relocate("read", { path: "/etc/hosts" }, materialized)).toMatchObject({
      _tag: "AbsolutePath"
    })
    expect(Checkpoints.relocate("read", { path: "../outside.txt" }, materialized)).toMatchObject({
      _tag: "OutsideTree"
    })
    // A flow whose input names no location cannot be pinned at all, and says so
    // rather than running against the live tree.
    expect(Checkpoints.relocate("memory", { note: "anything" }, materialized)).toMatchObject({
      _tag: "UnsupportedFlow"
    })
    // The decorated runner is the seam that turns those into refusals.
    expect(typeof Checkpointed.checkpointed).toBe("function")
  })
})
