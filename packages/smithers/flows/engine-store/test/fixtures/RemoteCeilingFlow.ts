/** The flow the two-process remote ceiling cases place on the serving engine (#2852). */
import { Flow } from "@smthrs/flow"
import * as Placement from "@smthrs/plan/Placement"
import * as Schema from "effect/Schema"
import { opaqueHandlerBody } from "./OpaqueHandlerBody.ts"

/**
 * Writes `name` under the serving engine's workspace through its guarded
 * `FileSystem`, after a durable `waitMs` hold when it is positive. It answers
 * `written`, or `denied:<tag>` naming the permission failure the host raised.
 */
export const RemoteWrite = Flow.make("remote-ceiling/write", {
  payload: { name: Schema.String, waitMs: Schema.Number },
  success: Schema.String,
  body: opaqueHandlerBody
}).annotate(Flow.Placement, Placement.remote({ target: "serving" }))
