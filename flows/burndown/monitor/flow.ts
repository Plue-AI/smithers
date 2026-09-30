/** Watches a burndown run every few minutes and reports whether it is healthy. */
import { Flow, Interpreter, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Layer, Schema } from "effect"
import { join, resolve } from "node:path"
import { layer as monitorActions } from "./host.ts"
import { Loop, MonitorError } from "./loop.ts"

const currentHost = process.cwd()

export default Flow.make("burndown/monitor", {
  description: "Watches a burndown run on a schedule and reports whether it is healthy.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:*", "net:get:*", "net:post:*", "model:call:*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: {
    runId: Schema.String,
    hostRoot: Schema.optional(Schema.String),
    reportRoot: Schema.optional(Schema.String),
    seat: Schema.optional(Schema.String),
    everyMinutes: Schema.optional(Schema.Number)
  },
  success: Schema.String,
  error: MonitorError,
  body: Node.capture(
    { version: "burndown/monitor/v6", currentHost },
    ({ everyMinutes = 10, runId, seat, hostRoot, reportRoot }) => {
      if (!runId || runId.startsWith("-") || /[\s\p{Cc}]/u.test(runId)) {
        return Node.fail("Invalid run identity")
      }
      if (!Number.isFinite(everyMinutes) || everyMinutes <= 0 || everyMinutes * 60_000 > Number.MAX_SAFE_INTEGER) {
        return Node.fail("Invalid monitor interval")
      }
      return Loop.to({
        runId,
        hostRoot: resolve(currentHost, hostRoot ?? "."),
        reportRoot: resolve(currentHost, reportRoot ?? join(hostRoot ?? currentHost, ".smithers", "burndown")),
        seat: seat ?? "claude-code:sonnet",
        everyMinutes
      })
    }
  )
})

export const layer = Layer.mergeAll(
  Interpreter.layer(Loop, { callbackIdentity: "stable" }),
  monitorActions,
  Sleep.layer
)
