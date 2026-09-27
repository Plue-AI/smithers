/**
 * Running one cell call against a pinned tree instead of the live one.
 *
 * `@smthrs/harness` decides *whether* a call may name a checkpoint: it mints
 * the handle, bounds how many a run may hold, refuses a mutating flow at one,
 * and folds the checkpoint into the call's key so a reading of the pinned tree
 * can never replay as a reading of the live one. Nothing in it knows what a
 * tree is. This is the other half — the decorator that takes a call carrying an
 * `at`, asks the store for that tree as a directory, points the call at it, and
 * gives the directory back when the call ends.
 *
 * It is a {@link FlowEngineLike.CallRunner} decorator rather than an option on
 * the runner, for the reason {@link FlowEngineLike.sandboxed} is one: it
 * composes with whatever else the host has wrapped its calls in.
 *
 * A composition that pins nothing is still wrapped, by {@link unpinned}. A call
 * carrying an `at` must never simply run there: it would read the live tree
 * while the cell believed it was reading a pinned one, and a fails-before proof
 * built on that reading would be a proof of nothing.
 *
 * A relocated call reaches the pinned tree and nothing else. That is not a
 * property of the flows being careful — it is a property of where they are
 * pointed: a shell call runs inside the detached worktree, so even a write it
 * never declared lands in the scratch checkout, which is removed when the call
 * ends; and a reader whose path climbs out of that checkout with `..` is
 * refused by {@link outside} rather than rewritten, because such a path is the
 * live tree under another name. The declared-write refusal in the controller is
 * the honest half of the same rule, stated where the model can read it.
 *
 * The one thing this cannot promise is a shell command that names an absolute
 * path or its own `..` inside the command text. A checkpoint is where a call
 * runs, not a sandbox, and `bash` may write anywhere the run can write with or
 * without one. Confinement is `WorkspaceSandbox`'s job and it composes
 * independently.
 *
 * Governing design: the "Checkpoints and worktree lanes" row of
 * The release policy, which defines an rc.0 checkpoint
 * as a pinned git tree per cell call, and the `@smthrs/std` `Checkpoints`
 * module that mints and stores those trees.
 *
 * @since 0.1.0
 */

import * as Cell from "@smthrs/harness/Cell"
import type { HarnessError } from "@smthrs/harness/HarnessError"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as FlowEngineLike from "./FlowEngineLike.ts"

/** A refusal the cell observes as an ordinary catchable failure. */
const refused = (code: Cell.CallFailureCode, message: string): Cell.CallResult =>
  new Cell.CallResult({ outcome: "failure", value: null, code, message })

/**
 * The refusal a flow that cannot be pointed at a tree answers with.
 *
 * It names the two flows that can, because a code without a next action costs
 * the run a frame working out what to do instead.
 *
 * @category constructors
 * @since 0.1.0
 */
export const unsupported = (flow: string): Cell.CallResult =>
  refused(
    "checkpoint_unsupported",
    `Flow ${flow} names what it touches rather than where it runs, so it cannot be pointed at a checkpoint. Nothing ran. Take the reading with a shell call at the same checkpoint, or drop at and read the live tree.`
  )

/**
 * The refusal an absolute path answers with.
 *
 * @category constructors
 * @since 0.1.0
 */
export const absolute = (flow: string, path: string): Cell.CallResult =>
  refused(
    "checkpoint_unsupported",
    `Flow ${flow} was given the absolute path ${path}, and a checkpoint is a tree rather than a place on this machine, so there is nothing to resolve it against. Nothing ran. Name the path relative to the repository root and call it again.`
  )

/**
 * The refusal a path that climbs out of the checkpoint answers with.
 *
 * Rewriting it would point the call back at the live tree while the cell
 * believed it was reading a pinned one — the one reading a checkpoint exists to
 * make impossible — so the call is refused instead of quietly relocated.
 *
 * @category constructors
 * @since 0.1.0
 */
export const outside = (flow: string, path: string): Cell.CallResult =>
  refused(
    "checkpoint_unsupported",
    `Flow ${flow} was given ${path}, which climbs back out of the checkpoint into the live tree, so nothing ran. A path taken at a checkpoint is relative to the repository root and stays inside it. Name it that way, or drop at to read the live tree on purpose.`
  )

/**
 * Runs one cell call against the checkpoint it names, or against the live tree
 * when it names none.
 *
 * @category constructors
 * @since 0.1.0
 */
export const checkpointed = (
  store: Checkpoints.Checkpoints,
  runner: FlowEngineLike.CallRunner
): FlowEngineLike.CallRunner => ({
  ...(runner.authorize === undefined ? {} : { authorize: runner.authorize }),
  run: (call: Cell.Call): Effect.Effect<Cell.CallResult, HarnessError> => {
    const at = call.at
    if (at === undefined) return runner.run(call)
    return store.materialize(at, (materialized) => {
      const relocated = Checkpoints.relocate(call.flowName, call.input, materialized)
      if (relocated._tag === "UnsupportedFlow") return Effect.succeed(unsupported(call.flowName))
      if (relocated._tag === "AbsolutePath") return Effect.succeed(absolute(call.flowName, relocated.path))
      if (relocated._tag === "OutsideTree") return Effect.succeed(outside(call.flowName, relocated.path))
      // The journaled call keeps the input the cell wrote and the `at` that
      // says which tree; only the input handed to the flow is rewritten. A
      // reader of the journal sees the question, not the scratch path this
      // process happened to check it out at.
      return runner.run(
        new Cell.Call({
          flowName: call.flowName,
          input: relocated.input,
          capabilities: call.capabilities,
          effects: call.effects,
          placement: call.placement,
          identity: call.identity,
          at
        })
      )
    }).pipe(
      // A store that cannot hand the tree back is a refusal the cell can act
      // on, not a failed run: the reading it wanted is still available on the
      // live tree, and every other call this cell has paid for survives.
      Effect.catchTag("@smthrs/std/StdError", (error) =>
        Effect.succeed(
          refused(
            "checkpoint_unavailable",
            `Checkpoint ${at} could not be checked out, so nothing ran: ${error.message}`
          )
        ))
    )
  }
})

/**
 * What a run on a host that pins no trees is told before its first frame.
 *
 * The cell contract teaches a baseline taken with `{ at: ctx.base }` after the
 * edit, because a host with a store makes that free. A host without one
 * refuses it, and workers in the TUI copied the example anyway: eleven
 * refused baselines across nine worker runs on 2026-09-23. This names the
 * refusal before the model writes it and gives the ordering that still works.
 *
 * @category constants
 * @since 1.0.0
 */
export const unpinnedFact =
  "This host pins no trees: ctx.base, ctx.checkpoint() and every call with at are refused and run nothing. For a baseline, run the check in the same cell before your edit, then run it again after."

/**
 * Refuses any call that names a tree, for a composition that pins none.
 *
 * A call carrying an `at` on a host with no store must never simply run: it
 * would read the live tree while the cell believed it was reading a pinned one,
 * and a fails-before proof built on that reading would be a proof of nothing.
 * Silence is the one answer this seam may not give.
 *
 * @category constructors
 * @since 0.1.0
 */
export const unpinned = (
  runner: FlowEngineLike.CallRunner
): FlowEngineLike.CallRunner => ({
  ...(runner.authorize === undefined ? {} : { authorize: runner.authorize }),
  run: (call) =>
    call.at === undefined ? runner.run(call) : Effect.succeed(
      refused(
        "checkpoint_unavailable",
        `This host pins no trees, so there is no ${call.at} to run ${call.flowName} against and nothing ran. Drop at. For a baseline, run the check before your edit, then again after it.`
      )
    )
})

/**
 * Wraps a runner with checkpoint materialization when the composition has a
 * store, and with the refusal above when it does not.
 *
 * @category constructors
 * @since 0.1.0
 */
export const decorate = (
  runner: FlowEngineLike.CallRunner
): Effect.Effect<FlowEngineLike.CallRunner> =>
  Effect.map(
    Effect.serviceOption(Checkpoints.Checkpoints),
    Option.match({
      onNone: () => unpinned(runner),
      onSome: (store) => checkpointed(store, runner)
    })
  )
