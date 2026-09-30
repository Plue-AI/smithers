import type { Flow } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import type * as RunDriver from "../src/internal/RunDriver.ts"

/** Admit detached work, then explicitly observe its current drive for state assertions. */
export const executeAndDrain = (
  driver: Pick<RunDriver.Service, "execute">,
  flow: Flow.Any,
  options: Parameters<RunDriver.Service["execute"]>[1] & { readonly discard: true }
) =>
  Effect.gen(function*() {
    yield* driver.execute(flow, options)
    // Joining without a parent preserves the detached policy recorded at admission.
    yield* driver.execute(flow, {
      executionId: options.executionId,
      payload: options.payload,
      discard: false,
      follow: true,
      ...(options.round === undefined ? {} : { round: options.round })
    })
  })
