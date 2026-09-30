/**
 * One burndown round: observe, pace, launch, land, settle. Each round hands
 * off to the next with its state as data, so the loop survives any restart and
 * its width (in-flight workers, landing candidates) is discovered, not planned.
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow, Sleep } from "@smthrs/flow"
import { Node, type Planned } from "@smthrs/plan"
import { Schema } from "effect"
import { Pace } from "./pace.ts"
import { InFlight, LandReport, Observation, PacePlan, RoundState, Settlement } from "./schema.ts"

/** Reads issues, claims, worker results and live account usage. */
export const Observe = Action.make("burndown/observe", {
  implementationVersion: "burndown/observe/v6",
  payload: { state: RoundState },
  success: Observation,
  error: Schema.String,
  nondeterministic: true
})

/** Claims each paced launch and starts its worker as a detached execution. */
export const Launch = Action.make("burndown/launch", {
  implementationVersion: "burndown/launch/v3",
  payload: { state: RoundState, observation: Observation, plan: PacePlan },
  success: Schema.Array(InFlight),
  error: Schema.String,
  nondeterministic: true
})

/** Lands every ready worker through the merge queue. */
export const Land = Action.make("burndown/land", {
  implementationVersion: "burndown/land/v6",
  payload: { state: RoundState, observation: Observation },
  success: LandReport,
  error: Schema.String,
  nondeterministic: true
})

/** Computes the next round's state, when it wakes, and whether work remains. */
export const Settle = Action.make("burndown/settle", {
  implementationVersion: "burndown/settle/v7",
  payload: {
    state: RoundState,
    observation: Observation,
    plan: PacePlan,
    launched: Schema.Array(InFlight),
    landed: LandReport
  },
  success: Settlement,
  error: Schema.String,
  nondeterministic: true
})

/** A round launches only when a candidate exists, the target has room, and some account is usable. */
export const canLaunch = (observation: Observation): boolean =>
  observation.candidates.length > 0 && observation.inFlight.length < observation.target &&
  observation.capacity.some((c) => !c.hardStop && c.problem === null && c.slots > 0)

/** Bump when the round topology or a captured callback changes meaning. */
const identity = "burndown/round/v8"

export const RoundError = Schema.Union([Schema.String, AgentAction.AgentFailure, Sleep.SleepRequestInvalid])

type RoundFlow = Flow.Flow<
  "burndown/round",
  typeof RoundState,
  typeof Schema.String,
  typeof RoundError,
  | Action.Requirement<"burndown/observe">
  | Action.Requirement<"burndown/launch">
  | Action.Requirement<"burndown/land">
  | Action.Requirement<"burndown/settle">
  | Action.Requirement<"burndown/pace">
>

export const Round: RoundFlow = Flow.make("burndown/round", {
  description: "One burndown round: observe, pace, launch, land, then sleep and hand off.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:*", "net:get:*", "net:post:*", "model:call:*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: RoundState,
  success: Schema.String,
  error: RoundError,
  body: Node.capture({ version: identity }, (state: RoundState) => {
    const rest = (observation: Planned.Planned<Observation>, plan: Node.Node<PacePlan, any, any>) =>
      plan.pipe(
        Node.bindPlanned(Node.capture({ version: identity, state }, (paced: Planned.Planned<PacePlan>) =>
          Launch.call({ state, observation, plan: paced }).pipe(
            Node.bindPlanned(
              Node.capture({ version: identity, state }, (launched: Planned.Planned<ReadonlyArray<InFlight>>) =>
                Land.call({ state, observation }).pipe(
                  Node.bindPlanned(Node.capture({ version: identity, state }, (landed: Planned.Planned<LandReport>) =>
                    Settle.call({ state, observation, plan: paced, launched, landed }).pipe(
                      Node.branch({
                        if: Node.capture({ version: identity }, (settled: Settlement) =>
                          settled.done),
                        then: (settled) =>
                          Flow.done(settled.summary),
                        else: (settled) =>
                          Sleep.action.call({ until: settled.wakeAt }).pipe(Node.andThen(Round.to(settled.next)))
                      })
                    )))
                ))
            )
          )))
      )
    return Observe.call({ state }).pipe(
      Node.branch({
        if: Node.capture({ version: identity }, canLaunch),
        then: (observation) => rest(observation, Pace.call({ observation })),
        else: (observation) =>
          rest(
            observation,
            Node.succeed({ launches: [], nextTarget: -1, note: "no candidate, no room or no usable account" })
          )
      })
    )
  })
})
