/** Refuses adoption of persisted module roots by an unconfigured executor.
 * @since 1.0.0
 */

import type { ControlRuntime } from "@smthrs/control"
import * as RunState from "@smthrs/engine-store/RunState"
import * as Descriptor from "@smthrs/registry/Descriptor"
import type * as Executable from "@smthrs/registry/Executable"
import type * as Registry from "@smthrs/registry/Registry"
import type { RunStore } from "@smthrs/run-store"
import { Cause, Effect, Schema } from "effect"

/** Uses existing native state, approved plans and the host's frozen catalog. */
interface Options {
  readonly runs: RunStore.Service
  readonly control: ControlRuntime.Service
  readonly registry: Registry.Registry
  readonly catalog: Executable.Catalog | undefined
}

/** This is admission before claiming, so refusals leave work for its owning host.
 * @since 1.0.0
 * @private
 */
export const make = ({ runs, control, registry, catalog }: Options) => (runId: string): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    const row = yield* runs.get(runId)
    const state = yield* Schema.decodeUnknownEffect(RunState.RunState)(JSON.parse(row.stateJson))
    if (state.flowName !== "agent/run") return true
    const payload = state.payload as { readonly planId?: unknown } | null
    const run = yield* control.getRun(runId).pipe(
      Effect.catchTag("/control/RunNotFound", () => Effect.succeed(undefined))
    )
    // Legacy native rows without a control association retain their existing
    // recovery path. They cannot authorize a configured module handler.
    if (run === undefined) return true
    if (run.planId === undefined) return true
    const plan = yield* control.getPlan(run.planId)
    const card = plan.card
    const descriptor = yield* registry.get(card.flowId).pipe(
      Effect.catch((error) => error.code === "not_found" ? Effect.succeed(undefined) : Effect.fail(error))
    )
    // Preserve the existing explicit approved-source failure for Prompt runs
    // and removed entries. This guard routes intact native module definitions;
    // it must not turn an invalid approved plan into a silently parked run.
    if (descriptor === undefined || descriptor.body._tag !== "Module") return true
    if (
      payload?.planId !== run.planId || state.parentExecutionId !== undefined ||
      run.planDigest !== plan.card.digest || plan.decision !== "approved"
    ) return false
    if (card.executionDigest === undefined || Descriptor.executionDigest(descriptor) !== card.executionDigest) {
      return true
    }
    const body = yield* Effect.result(registry.loadBody(card.flowId, card.executionDigest))
    if (body._tag === "Failure") {
      if (["not_found", "body_unavailable", "execution_changed"].includes(body.failure.code)) return true
      return yield* Effect.fail(body.failure)
    }
    const executable = catalog?.executables.find((entry) => entry.descriptor.name === card.flowId)
    if (
      executable === undefined ||
      Descriptor.executionDigest(executable.descriptor) !== card.executionDigest ||
      // A delegate is a flow the HOST registered under a name; nothing in the
      // descriptor measures its code, so the approved envelope has to name it.
      // A module that IS its own flow has no delegate: the `executionDigest`
      // compared above covers its entry bytes and the digest of every module
      // that entry imports from beside itself, and the loader re-measures that
      // closure before importing. Packages it imports are the host's own
      // installed code and are not measured.
      (executable.delegate !== undefined && !card.envelope.flows.includes(executable.delegate))
    ) return false
    return true
  }).pipe(Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning("Module admission refused while reading persisted approval state").pipe(Effect.as(false))
  ))
