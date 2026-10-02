import { Action, ExternalJob, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { helper } from "./helper.ts"

const Job = ExternalJob.make("retained/Job", {
  payload: { root: Schema.String },
  handle: Schema.Struct({ root: Schema.String, directory: Schema.String }),
  success: Schema.String,
  error: Schema.Unknown,
  probe: { every: "15 seconds", max: "15 seconds" },
  timeout: "3 minutes",
  restarts: 0
})
const Finish = Action.make("retained/Finish", {
  payload: { root: Schema.String },
  success: Schema.String,
  error: Schema.Unknown,
  implementationVersion: "fault-3367/approved-layer",
  tier: "sealed",
  idempotencyKey: ({ root }) => ({ root, operation: "finish" })
})
export const layer = Layer.mergeAll(
  Job.toLayer({
    start: ({ root }, key) =>
      Effect.sync(() => {
        const directory = join(root, `job-${createHash("sha256").update(key).digest("hex")}`)
        try {
          mkdirSync(directory)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
          return { root, directory }
        }
        appendFileSync(join(root, "operations.jsonl"), JSON.stringify({ operation: "start", key }) + "\n")
        const worker = spawn(process.execPath, [join(root, "retained-worker.mjs"), root, directory, key], {
          detached: true,
          stdio: "ignore"
        })
        worker.unref()
        return { root, directory }
      }),
    status: ({ root, directory }, key) =>
      Effect.sync(() => {
        appendFileSync(
          join(root, "operations.jsonl"),
          JSON.stringify({ operation: "status", key, host: process.pid }) + "\n"
        )
        if (existsSync(join(directory, "exit"))) return { _tag: "Exited" as const, exitCode: 0 }
        if (existsSync(join(directory, "pid"))) {
          try {
            process.kill(Number(readFileSync(join(directory, "pid"), "utf8")), 0)
          } catch {
            return { _tag: "Lost" as const }
          }
        }
        return { _tag: "Running" as const }
      }),
    collect: ({ root, directory }, key) =>
      Effect.sync(() => {
        const result = `approved-layer/${helper}/${readFileSync(join(directory, "work"), "utf8")}`
        if (!existsSync(join(root, "collected"))) {
          appendFileSync(
            join(root, "operations.jsonl"),
            JSON.stringify({ operation: "collect", key, host: process.pid }) + "\n"
          )
          writeFileSync(join(root, "collected"), result)
        }
        return result
      }),
    cancel: ({ root }, key) =>
      Effect.sync(() => {
        appendFileSync(join(root, "operations.jsonl"), JSON.stringify({ operation: "cancel", key }) + "\n")
        writeFileSync(join(root, "release"), "cancel")
      })
  }),
  Finish.toLayer(({ root }) =>
    Effect.sync(() => {
      appendFileSync(join(root, "operations.jsonl"), JSON.stringify({ operation: "finish", host: process.pid }) + "\n")
      writeFileSync(join(root, "finished"), "approved-entry")
      return "approved-entry"
    }), { implementationVersion: "fault-3367/approved-layer" })
)
export default Flow.make("retained", {
  description: "Retained external job across a host replacement.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { root: Schema.String },
  success: Schema.String,
  error: Schema.Unknown,
  body: Node.capture({}, ({ root }) => Job.child({ root }).pipe(Node.andThen(Finish.call({ root }))))
})
