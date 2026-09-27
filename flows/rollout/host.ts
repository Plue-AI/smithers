import { Interpreter } from "@smthrs/flow"
import { Effect } from "effect"
import Rollout, { Execute } from "./flow.ts"
import { rollout, type RolloutHost } from "./runtime.ts"

/** Supply an exclusively leased host per run. The returned receipt is the existing run output. */
export const executionLayer = (host: RolloutHost) =>
  Interpreter.layerWithImplementations(
    Rollout,
    Execute.toLayer(() =>
      Effect.tryPromise({ try: () => rollout(host), catch: () => "Rollout receipt unavailable" }).pipe(
        Effect.flatMap((receipt) => receipt.status === "passed" ? Effect.succeed(receipt) : Effect.fail(receipt))
      ), {
      implementationVersion: "rollout/v2"
    })
  )
