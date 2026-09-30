import { Permission } from "@smthrs/kernel"
import { Model } from "@smthrs/model"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import * as Cell from "../../src/Cell.ts"
import * as EngineLike from "../../src/EngineLike.ts"
import { HarnessError } from "../../src/HarnessError.ts"
import * as Plan from "../../src/Plan.ts"

/**
 * One scripted response to `EngineLike.call`.
 *
 * @category fixtures
 * @since 0.1.0
 */
export type CallStep =
  | {
    readonly _tag: "Success"
    readonly value: Schema.Json
    /**
     * The workspace this call leaves behind, when it changes one.
     *
     * Stated separately from the call's declared effects on purpose: this is
     * how a shell command behaves. It writes a tracked file, its input names
     * no write set, and the only way anything finds out is by measuring the
     * tree afterwards.
     */
    readonly tree?: string | undefined
  }
  | { readonly _tag: "Failure"; readonly message: string }
  | { readonly _tag: "PermissionRequired"; readonly request: Permission.PermissionRequired }
  | { readonly _tag: "Interrupt" }

/**
 * Calls observed at the engine boundary.
 *
 * @category fixtures
 * @since 0.1.0
 */
export interface Recorder {
  readonly sealStep: Array<EngineLike.SealedModelStep>
  /** Every batch handed to `splice`, which the cell-first controller never uses. */
  readonly splice: Array<Plan.Batch>
  readonly calls: Array<Cell.Call>
  readonly records: Array<EngineLike.RecordBoundary<unknown>>
  /** What each executed boundary's recorded value says it paid a model for. */
  readonly paid: Array<{ readonly name: string; readonly usage: ReadonlyArray<EngineLike.Paid> | undefined }>
  /** Every checkpoint the run asked this host to pin, with the tree it held. */
  readonly captures: Array<{ readonly id: string; readonly tree: string | undefined }>
  readonly suspend: Array<EngineLike.SuspendReason>
  /** Every actual request to walk the workspace. */
  readonly walks: Array<string | undefined>
}

/**
 * A scripted engine together with its layer and recorder.
 *
 * @category fixtures
 * @since 0.1.0
 */
export interface Fixture {
  readonly engine: EngineLike.EngineLike
  readonly layer: Layer.Layer<EngineLike.EngineLike>
  readonly recorder: Recorder
  /**
   * The workspace the engine measures, as one string.
   *
   * `undefined` is a host that cannot measure its tree at all, which is what
   * an engine constructed without an initial tree reports — so every case
   * written before observation existed keeps the declared-writes basis.
   *
   * `complete` is a host whose walk covered the whole tree. False is the
   * bounded walk a large checkout produces, which the controller sets aside.
   */
  readonly workspace: { value: string | undefined; complete: boolean }
}

/**
 * Constructs an engine recorder. Sealed model steps delegate to the supplied
 * network-free model; flow calls settle from `callScript` in order.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  model: Model.Model,
  callScript: ReadonlyArray<CallStep> = [],
  tree?: string,
  treeComplete = true,
  /**
   * Whether this host has anywhere to pin a tree.
   *
   * `false` is the honest answer for a composition that bound no store, which
   * the controller turns into a catchable `checkpoint_unavailable`. Defaults to
   * a host that pins, because that is what a production composition does.
   */
  pins = true
): Fixture => {
  const workspace: { value: string | undefined; complete: boolean } = { value: tree, complete: treeComplete }
  const recorder: Recorder = {
    sealStep: [],
    splice: [],
    calls: [],
    records: [],
    paid: [],
    captures: [],
    suspend: [],
    walks: []
  }
  let callIndex = 0
  const engine = EngineLike.make({
    capture: (request) =>
      Effect.sync(() => {
        recorder.captures.push({ id: request.id, tree: workspace.value })
        return pins
          ? Option.some(new EngineLike.Snapshot({ id: request.id, ref: `test/${request.id}` }))
          : Option.none()
      }),
    sealStep: (step) => {
      recorder.sealStep.push(step)
      return model.stream(step.request)
    },
    splice: (batch) => {
      recorder.splice.push(batch)
      return Stream.empty
    },
    call: (request) => {
      recorder.calls.push(request)
      const step = callScript[callIndex++] ?? { _tag: "Success", value: null }
      switch (step._tag) {
        case "Success":
          if (step.tree !== undefined) workspace.value = step.tree
          return Effect.succeed(new Cell.CallResult({ outcome: "success", value: step.value }))
        case "Failure":
          return Effect.succeed(
            new Cell.CallResult({ outcome: "failure", value: null, message: step.message })
          )
        case "PermissionRequired":
          return Effect.fail(
            new HarnessError({
              code: "engine_failed",
              message: "Permission required",
              cause: step.request
            })
          )
        case "Interrupt":
          return Effect.interrupt
      }
    },
    // The fixture keeps no journal: single-pass tests execute the boundary,
    // and replay behaviour is proven against the real engine in
    // `@smthrs/agent`.
    record: (boundary) => {
      recorder.records.push(boundary)
      // Read the way a budgeted engine reads it: off the recorded value.
      return Effect.tap(boundary.execute, (value) =>
        Effect.sync(() => {
          recorder.paid.push({ name: boundary.name, usage: boundary.usage?.(value) })
        }))
    },
    observe: Effect.suspend(() => {
      recorder.walks.push(workspace.value)
      return Effect.succeed(
        workspace.value === undefined
          ? Option.none()
          : Option.some(
            new EngineLike.Observation({ digest: workspace.value, paths: 1, complete: workspace.complete })
          )
      )
    }),
    suspend: (reason) => {
      recorder.suspend.push(reason)
      return Effect.fail(
        new HarnessError({
          code: "suspended",
          message: reason.message,
          cause: reason
        })
      )
    }
  })
  return {
    engine,
    layer: EngineLike.layer(engine),
    recorder,
    workspace
  }
}
