/**
 * Changesets status and version operations.
 *
 * This module also declares the irreversible exec action shared by the
 * release targets that mutate external or working-tree state.
 *
 * @since 0.1.0
 */

import { Action, type FlowRuntime } from "@smthrs/flow"
import type * as Layer from "effect/Layer"
import * as Exec from "./Exec.ts"

/**
 * The irreversible variant of the shared exec action.
 *
 * It carries the same payload, result, and error as {@link Exec.Exec} but is
 * declared at the `irreversible` tier, so the engine refuses to retry it
 * blindly and no verification, replay, or cache-population path may execute
 * it. Release targets use it for every run that mutates manifests or external
 * registries.
 *
 * @category actions
 * @since 0.1.0
 */
export const ExecIrreversible = Action.make("smithers-build/exec-irreversible", {
  payload: Exec.Payload,
  success: Exec.Result,
  error: Exec.ExecError,
  tier: "irreversible"
})

/**
 * Implements {@link ExecIrreversible} with `node:child_process` spawn.
 *
 * It delegates to the shared confined exec runner, so environment scrubbing,
 * bounded output capture, and process-group interruption match sealed execs.
 *
 * @category layers
 * @since 0.1.0
 */
export const ExecIrreversibleLive = (options: {
  readonly workspaceRoot: string
}): Layer.Layer<Action.Requirement<"smithers-build/exec-irreversible">, never, FlowRuntime.FlowRuntime> =>
  ExecIrreversible.toLayer((payload) => Exec.run(options, payload))
