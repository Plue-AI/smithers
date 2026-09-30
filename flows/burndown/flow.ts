/**
 * Burns down every open issue in the named repositories with coding agents on
 * subscription accounts, paced per usage window, landed through a merge queue.
 * The body hands off to the first round; `round.ts` is the loop.
 */
import { Flow, Interpreter, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Layer, Schema } from "effect"
import { layer as roundActions } from "./host.ts"
import { repository } from "./issues.ts"
import { Pace } from "./pace.ts"
import { Round, RoundError } from "./round.ts"
import { Ready, ReceiptRetry } from "./schema.ts"

export default Flow.make("burndown", {
  description: "Burns down every open issue in the named repositories with paced coding agents and a merge queue.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:*", "net:get:*", "net:post:*", "model:call:*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Schema.Struct({
    repos: Schema.Array(Schema.String),
    ready: Schema.optional(Schema.Array(Ready)),
    receiptRetries: Schema.optional(Schema.Array(ReceiptRetry)),
    resumeReceipts: Schema.optional(Schema.Array(Schema.String)),
    placement: Schema.optional(Schema.Literals(["local", "cloud"])),
    startAgents: Schema.optional(Schema.Number),
    maxAgents: Schema.optional(Schema.Number),
    tickMinutes: Schema.optional(Schema.Number)
  }).check(
    Schema.makeFilter(
      ({ repos, ready, receiptRetries, resumeReceipts }) =>
        [...(ready ?? []), ...(receiptRetries ?? []).map((item) => item.ready)].every((member) =>
          repos.map(repository).includes(member.assignment.repo)
        ) &&
        new Set((receiptRetries ?? []).map((retry) => retry.key)).size === (receiptRetries ?? []).length &&
        (receiptRetries ?? []).every((retry) => {
          const queued = ready?.find((member) => member.assignment.key === retry.key)
          return queued === undefined || JSON.stringify(queued) === JSON.stringify(retry.ready)
        }) && (resumeReceipts ?? []).every((key) =>
          receiptRetries?.some((retry) =>
            retry.key === key && retry.status === "parked"
          )
        ),
      {
        message: "READY assignment repository must be included in repos"
      }
    )
  ),
  success: Schema.String,
  error: RoundError,
  body: Node.capture(
    { version: "burndown/v6" },
    ({ maxAgents, placement, ready, receiptRetries, resumeReceipts, repos, startAgents, tickMinutes }: {
      readonly repos: ReadonlyArray<string>
      readonly ready?: ReadonlyArray<Ready> | undefined
      readonly receiptRetries?: ReadonlyArray<ReceiptRetry> | undefined
      readonly resumeReceipts?: ReadonlyArray<string> | undefined
      readonly placement?: "local" | "cloud" | undefined
      readonly startAgents?: number | undefined
      readonly maxAgents?: number | undefined
      readonly tickMinutes?: number | undefined
    }) =>
      Round.to({
        options: {
          repos,
          placement: placement ?? "local",
          maxAgents: maxAgents ?? 1024,
          tickMinutes: tickMinutes ?? 5,
          ...(resumeReceipts === undefined ? {} : { resumeReceipts })
        },
        round: 0,
        target: startAgents ?? 64,
        inFlight: [],
        quarantined: [],
        ready: [
          ...(ready ?? []),
          ...(receiptRetries ?? []).filter((retry) =>
            !(ready ?? []).some((member) => member.assignment.key === retry.key)
          ).map((retry) => retry.ready)
        ],
        receiptRetries: receiptRetries ?? [],
        readings: {},
        rates: {},
        history: {},
        landed: 0
      })
  )
})

/** The round lineage and its action implementations; `burndown/worker` registers itself. */
export const layer = Layer.mergeAll(Interpreter.layer(Round), roundActions, Pace.layer, Sleep.layer)
