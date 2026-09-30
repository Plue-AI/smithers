/**
 * Burns down every open issue in the named repositories with coding agents on
 * subscription accounts, paced per usage window, landed through a merge queue.
 * The body hands off to the first round; `round.ts` is the loop.
 */
import { Flow, Interpreter, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Layer, Schema } from "effect"
import { layer as roundActions } from "./host.ts"
import { Pace } from "./pace.ts"
import { Round, RoundError } from "./round.ts"
import { Ready } from "./schema.ts"

export default Flow.make("burndown", {
  description: "Burns down every open issue in the named repositories with paced coding agents and a merge queue.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:*", "net:get:*", "net:post:*", "model:call:*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: {
    repos: Schema.Array(Schema.String),
    ready: Schema.optional(Schema.Array(Ready)),
    placement: Schema.optional(Schema.Literals(["local", "cloud"])),
    startAgents: Schema.optional(Schema.Number),
    maxAgents: Schema.optional(Schema.Number),
    tickMinutes: Schema.optional(Schema.Number)
  },
  success: Schema.String,
  error: RoundError,
  body: Node.capture({ version: "burndown/v2" }, ({ maxAgents, placement, ready, repos, startAgents, tickMinutes }: {
    readonly repos: ReadonlyArray<string>
    readonly ready?: ReadonlyArray<Ready> | undefined
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
        tickMinutes: tickMinutes ?? 5
      },
      round: 0,
      target: startAgents ?? 64,
      inFlight: [],
      quarantined: [],
      ready: ready ?? [],
      readings: {},
      rates: {},
      history: {},
      landed: 0
    }))
})

/** The round lineage and its action implementations; `burndown/worker` registers itself. */
export const layer = Layer.mergeAll(Interpreter.layer(Round), roundActions, Pace.layer, Sleep.layer)
