/** The host wiring of `coding/verify` (verify/flow.ts). */
import { FlowRuntime, Interpreter } from "@smthrs/flow"
import { Effect, Layer } from "effect"
import { AdmitVerifySource, admitVerifySource } from "./verify-schema.ts"
import Verify from "./verify/flow.ts"

export { Verify }
export { VerifyInput, VerifyResult } from "./verify-schema.ts"

export const verifyRegistration = Layer.mergeAll(
  Interpreter.layer(Verify),
  AdmitVerifySource.toLayer(({ source, checks }) =>
    Effect.gen(function*() {
      const instance = yield* FlowRuntime.FlowInstance
      return yield* admitVerifySource(source, checks, instance.executionId)
    })
  )
)
