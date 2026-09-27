/**
 * Turning the script the model just ran into a saved flow, as two ordinary
 * flows.
 *
 * A run that solved something once solved it as a script: a few cells that read
 * the right things, called the right boundaries, and printed an answer. The
 * only thing standing between that script and a flow anyone can call again is
 * writing it down. These two bindings are that move, split where the model has
 * to think:
 *
 * - `flows/show-script` hands the model its own turn back — the source of every
 *   cell it executed, in order — together with the rules a saved flow has to
 *   follow and the file skeleton to fill in. It reads the
 *   {@link CellHistory.CellHistory} the controller records into, so a host that
 *   keeps no history simply reports an empty script.
 * - `flows/write-flow` takes the three files that come back and writes them
 *   through a {@link FlowStore.FlowStore}. When a `Registry` is in context it is
 *   refreshed afterwards. When that registry is also passed to `Agent.run`,
 *   a successful refresh makes the new model-invocable flow appear in
 *   `ctx.flows` on the next frame. Each frame journals its catalog for replay.
 *
 * The rules and the skeleton are the host's, because the file layout a saved
 * flow lands in is the host's. {@link bestPractices} and {@link flowTemplate}
 * are this repository's, and {@link Options} is how a host with its own
 * conventions teaches those instead.
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/core/Flow"
import * as CellHistory from "@smthrs/harness/CellHistory"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Registry from "@smthrs/registry/Registry"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as FlowStore from "./FlowStore.ts"

/**
 * What a saved flow has to get right, in the order it matters.
 *
 * This text is teaching, not documentation. The model reads it once and then
 * writes three files, so every line names a decision it is about to make.
 *
 * @category models
 * @since 0.1.0
 */
export const bestPractices = [
  "Inputs are idempotent. A saved flow runs again on an input, so every value the script read from this conversation becomes an input field. Nothing is hardcoded from this turn.",
  "No secrets in the source. Keys, tokens, and signed URLs come from the host, never from the flow file.",
  "One ctx.call per boundary. Each call is separately journaled and replayed, so do not batch two reads into one call and do not wrap a call in a retry loop the engine already owns.",
  "The output is typed. Declare the output schema and fill every field; a caller must never parse prose.",
  "The end-to-end test replays a fixture. Record the model once, save the recording beside the flow, and have the test replay it so it runs offline."
].join("\n")

/**
 * The `flow.ts` skeleton `flows/write-flow` expects back, filled in.
 *
 * @category models
 * @since 0.1.0
 */
export const flowTemplate = `"use server"

import { Flow } from "@smthrs/core"
import * as Schema from "effect/Schema"

export default Flow.make({
  name: "<the flow id, the same as its directory name>",
  description: "<one line naming what this flow produces>",
  input: Schema.Struct({ /* every value this script read from the conversation */ }),
  output: Schema.Struct({ /* typed fields, no prose blobs */ }),
  capabilities: [/* the narrowest patterns the calls below need */],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})
`

/**
 * Input for `flows/show-script`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ShowScriptInput = Schema.Struct({
  bestPractices: Schema.optionalKey(
    Schema.String.annotate({ description: "Extra guidance to append after the house rules" })
  )
})

/**
 * Output for `flows/show-script`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ShowScriptOutput = Schema.Struct({
  cells: Schema.Array(Schema.Struct({
    ordinal: Schema.Number.annotate({ description: "Zero-based execution order within this turn" }),
    source: Schema.String.annotate({ description: "The cell's JavaScript, as it ran" })
  })),
  bestPractices: Schema.String.annotate({ description: "The rules a saved flow has to follow" }),
  template: Schema.String.annotate({ description: "The flow file skeleton to fill in" })
})

/**
 * Input for `flows/write-flow`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const WriteFlowInput = Schema.Struct({
  id: Schema.String.annotate({
    description: "Flow id and directory name; lowercase letters, digits, and hyphens, starting with a letter"
  }),
  description: Schema.String.annotate({ description: "One line naming what the flow produces" }),
  flowSource: Schema.String.annotate({ description: "Complete flow.ts source" }),
  testSource: Schema.String.annotate({ description: "Complete flow.e2e.ts source" }),
  fixtureJson: Schema.String.annotate({ description: "The recorded fixture that test replays, as JSON text" })
})

/**
 * Output for `flows/write-flow`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const WriteFlowOutput = Schema.Struct({
  files: Schema.Array(Schema.String).annotate({ description: "The paths that were written, root-relative" })
})

/**
 * The `flows/show-script` declaration.
 *
 * @category flows
 * @since 0.1.0
 */
export const showScriptFlow = Flow.make({
  name: "flows/show-script",
  description:
    "Return the source of every cell this turn has executed, plus the rules and the file skeleton a saved flow uses. Call it before flows/write-flow.",
  input: ShowScriptInput,
  output: ShowScriptOutput,
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})

/**
 * The `flows/write-flow` declaration.
 *
 * @category flows
 * @since 0.1.0
 */
export const writeFlowFlow = Flow.make({
  name: "flows/write-flow",
  description:
    "Save a flow: writes flow.ts, flow.e2e.ts, and its fixture under flows/<id>/. The id must be lowercase letters, digits, and hyphens.",
  input: WriteFlowInput,
  output: WriteFlowOutput,
  effects: { reads: [], writes: ["flows/**"], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})

/**
 * The host's own rules and skeleton, when they differ from this repository's.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** Replaces {@link bestPractices} as the rules a saved flow has to follow. */
  readonly bestPractices?: string | undefined
  /** Replaces {@link flowTemplate} as the file skeleton the model fills in. */
  readonly template?: string | undefined
}

/** The three files one saved flow is written as. */
const filesFor = (input: typeof WriteFlowInput.Type): Record<string, string> => ({
  [`flows/${input.id}/flow.ts`]: input.flowSource,
  [`flows/${input.id}/flow.e2e.ts`]: input.testSource,
  [`flows/${input.id}/fixtures/${input.id}.json`]: input.fixtureJson
})

/**
 * Promotion, as two ordinary flows.
 *
 * @category constructors
 * @since 0.1.0
 */
export const source = (
  services: Context.Context<CellHistory.CellHistory | FlowStore.FlowStore>,
  options: Options = {}
): FlowBinding.Source =>
  FlowBinding.source("flows", [
    FlowBinding.provide(
      FlowBinding.make({
        flow: showScriptFlow,
        handler: (input) =>
          Effect.gen(function*() {
            const history = yield* CellHistory.CellHistory
            const cells = yield* history.cells()
            const rules = options.bestPractices ?? bestPractices
            return {
              cells: cells.map((cell) => ({ ordinal: cell.ordinal, source: cell.source })),
              bestPractices: input.bestPractices === undefined ? rules : `${rules}\n${input.bestPractices}`,
              template: options.template ?? flowTemplate
            }
          })
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: writeFlowFlow,
        publicError: (error: FlowStore.FlowStoreError) => error.message,
        handler: (input) =>
          Effect.gen(function*() {
            yield* Effect.annotateCurrentSpan({ flow: input.id, description: input.description })
            // Checked here as well as in the store, because a store that keeps
            // nothing would otherwise answer a bad id with "nowhere to save"
            // and send the model off to fix the wrong thing.
            yield* FlowStore.validateId(input.id)
            const store = yield* FlowStore.FlowStore
            const written = yield* store.write(input.id, filesFor(input))
            // The registry is optional and its rescan is best effort: the files
            // are already saved, so a rescan that failed makes the flow appear
            // one refresh later rather than making the save a lie.
            const registry = yield* Effect.serviceOption(Registry.Registry)
            yield* Option.match(registry, {
              onNone: () => Effect.void,
              onSome: (found) => Effect.ignore(found.refresh())
            })
            return { files: written.files }
          })
      }),
      services
    )
  ])
