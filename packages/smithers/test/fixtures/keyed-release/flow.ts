import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const identity = (root: string) => JSON.stringify({ root, operation: "retained-work" })
const record = (root: string, operation: string, key: string) =>
  appendFileSync(join(root, "operations.jsonl"), JSON.stringify({ operation, key, host: process.pid }) + "\n")

const Work = Action.make("keyed-release/Work", {
  implementationVersion: "keyed-release/v1",
  payload: { root: Schema.String },
  success: Schema.String,
  error: Schema.Unknown,
  tier: "irreversible",
  idempotencyKey: ({ root }) => identity(root)
})

export const layer = Work.toLayer(({ root }) =>
  Effect.gen(function*() {
    const key = identity(root)
    const directory = join(root, `job-${createHash("sha256").update(key).digest("hex")}`)
    const created = yield* Effect.sync(() => {
      try {
        mkdirSync(directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        // Existing provider identity never creates another process. A missing
        // publication is waited for below, rather than guessed to be absent.
        record(root, "attach", key)
        return false
      }
      const worker = spawn(process.execPath, [join(root, "worker.mjs"), root, directory, key], {
        detached: true,
        stdio: "ignore"
      })
      // Record ownership before readiness polling and the owner-controlled
      // fault boundary, covering failure before the child's PID publication.
      writeFileSync(join(directory, "accepted-pid"), String(worker.pid))
      worker.unref()
      record(root, "start", key)
      return true
    })
    while (!existsSync(join(directory, "pid"))) yield* Effect.sleep("20 millis")
    if (created) {
      // The provider accepted its job; lose the still-pending start response
      // during a real graceful host release. No finalizer destroys the job.
      yield* Effect.sync(() => writeFileSync(join(root, "pending-start"), String(process.pid)))
      return yield* Effect.never
    }
    while (!existsSync(join(directory, "exit"))) yield* Effect.sleep("20 millis")
    return yield* Effect.sync(() => {
      const result = `retained/${readFileSync(join(directory, "pid"), "utf8")}/${
        readFileSync(join(directory, "work"), "utf8")
      }`
      try {
        // Exclusive creation claims collection once. This response-loss
        // fixture has one fenced collector; it does not claim that writeFile
        // atomically publishes complete contents to concurrent readers.
        writeFileSync(join(directory, "collected"), result, { flag: "wx" })
        record(root, "collect", key)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      return readFileSync(join(directory, "collected"), "utf8")
    })
  }), { implementationVersion: "keyed-release/v1" })

export default Flow.make("keyed-release", {
  description: "Rejoin one retained provider job after a keyed execution releases.",
  capabilities: ["proc:spawn:**", "fs:read:**", "fs:write:**"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { root: Schema.String },
  success: Schema.String,
  error: Schema.Unknown,
  body: Node.capture(
    { action: Work.name, implementationVersion: "keyed-release/v1" },
    ({ root }) => Work.call({ root })
  )
})
