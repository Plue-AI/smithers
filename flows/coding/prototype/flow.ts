/** Explicit disposable experiment. It can neither enter correction nor land. */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { Poc, PocResult } from "../poc.ts"
import { PrepareRequest } from "../preparation.ts"
import { RequestInput } from "../schema.ts"
import { AdmitSource } from "../source-admission.ts"

export default Flow.make("coding/Prototype", {
  description: "Create and retain a disposable source prototype without implementing or landing it.",
  capabilities: ["*"],
  payload: RequestInput,
  success: PocResult,
  error: Schema.Union([PrepareRequest.errorSchema, Poc.errorSchema]),
  body: (input) =>
    PrepareRequest.child({ prompt: input.prompt, feedback: input.feedback ?? "" }).pipe(
      Node.bindPlanned((plan) => AdmitSource.call({ plan })),
      Node.bindPlanned((plan) =>
        Poc.child({ plan, source: plan.observedHead }).pipe(
          Node.bindPlanned((result) =>
            Node.succeed(result).pipe(Node.andThen(AdmitSource.call({ plan })), Node.andThen(Node.succeed(result)))
          )
        )
      )
    )
})
