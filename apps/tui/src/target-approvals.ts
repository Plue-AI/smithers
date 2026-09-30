/**
 * Build targets waiting for approval, for the TUI inbox.
 *
 * A target that declares `approval: "required"` leaves a pending
 * `system/target` plan in the workspace control database until an operator
 * approves or denies that revision. This module reads those plans through
 * `Control.list({ _tag: "plans" })` and decides one with its own plan
 * approval payload, the same calls `smthrs approvals` and the app make.
 */
import * as BunControl from "@smthrs/cli/BunControl"
import * as NodeControl from "@smthrs/cli/NodeControl"
import { Control, type ControlError, type ControlSchema } from "@smthrs/control"
import { Cause, Effect, Exit, Schema } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"

const NativeControl = process.versions.bun === undefined ? NodeControl : BunControl

/** One target revision waiting for a decision. */
export interface Row {
  /** Stable across refreshes: the plan's id. */
  readonly key: string
  readonly target: string
  readonly revision: string
  /** The plan approval `approve` and `deny` take, unchanged. */
  readonly approval: ControlSchema.ApprovalPayload
}

/** The row's one line: the target and its short revision. */
export const label = (row: Row): string => `${row.target} ${row.revision.slice(0, 12)}`

const TargetInput = Schema.Struct({ label: Schema.String, digest: Schema.String })
const isTargetInput = Schema.is(TargetInput)

/** Every pending target revision, oldest first, every page of it. */
export const pending = (control: Control.Service): Effect.Effect<ReadonlyArray<Row>, ControlError.ControlError> =>
  Effect.gen(function*() {
    const rows: Array<Row> = []
    let cursor: string | undefined
    do {
      const page = yield* control.list({
        _tag: "plans",
        filters: { flowId: "system/target", decision: "pending" },
        ...(cursor === undefined ? {} : { cursor })
      })
      if (page._tag !== "plans") return rows
      for (const item of page.items) {
        if (isTargetInput(item.input)) {
          rows.push({
            key: item.card.planId,
            target: item.input.label,
            revision: item.input.digest,
            approval: item.card.approval
          })
        }
      }
      cursor = page.items.length === 0 ? undefined : page.nextCursor
    } while (cursor !== undefined)
    return rows
  })

/** Approves or denies one row; a conflicting receipt is a failure. */
export const decide = (
  control: Control.Service,
  row: Row,
  decision: "approve" | "deny"
): Effect.Effect<ControlSchema.Receipt, ControlError.ControlError | Error> =>
  Effect.flatMap(
    decision === "approve" ? control.approve(row.approval) : control.deny(row.approval),
    (receipt) => receipt._tag === "Conflict" ? Effect.fail(new Error(receipt.message)) : Effect.succeed(receipt)
  )

/** What the TUI calls: reads and decisions over the workspace's own control database. */
export interface Port {
  readonly pending: () => Promise<ReadonlyArray<Row>>
  readonly decide: (row: Row, decision: "approve" | "deny") => Promise<ControlSchema.Receipt>
}

/**
 * A port over the workspace control database. Each call opens the control
 * plane without starting runs and closes it again; a workspace with no
 * database has nothing pending and is never given one by a read.
 */
export const make = (options: { readonly cwd: string; readonly stateRoot?: string | undefined }): Port => {
  const run = async <A>(use: (control: Control.Service) => Effect.Effect<A, unknown>): Promise<A> => {
    const exit = await Effect.runPromiseExit(
      Control.Control.pipe(
        Effect.flatMap(use),
        Effect.provide(NativeControl.layerControl({
          root: options.cwd,
          startsRuns: false,
          ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot })
        }))
      )
    )
    if (Exit.isSuccess(exit)) return exit.value
    throw Cause.squash(exit.cause)
  }
  return {
    pending: () =>
      existsSync(join(options.stateRoot ?? options.cwd, ".flows", "control.db"))
        ? run(pending)
        : Promise.resolve([]),
    decide: (row, decision) => run((control) => decide(control, row, decision))
  }
}
