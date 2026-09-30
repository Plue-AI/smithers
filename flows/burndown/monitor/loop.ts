/** The monitor loop: inspect, diagnose, report, sleep, hand off. */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow, Sleep } from "@smthrs/flow"
import { Node, Planned } from "@smthrs/plan"
import { Schema } from "effect"

export const Snapshot = Schema.Struct({
  healthy: Schema.Boolean,
  now: Schema.Number,
  evidence: Schema.String
})

export type Snapshot = typeof Snapshot.Type

export const Verdict = Schema.Struct({
  healthy: Schema.Boolean,
  findings: Schema.Array(Schema.String),
  actions: Schema.Array(Schema.String)
})

export type Verdict = typeof Verdict.Type

interface MonitorInput {
  readonly hostRoot: string
  readonly reportRoot: string
  readonly runId: string
  readonly seat: string
  readonly everyMinutes: number
}

/** Bump when the loop topology or a captured callback changes meaning. */
const version = "burndown/monitor/v3"

/** Reads the run, its workers, the status line and account notices. */
export const Inspect = Action.make("burndown/monitor/inspect", {
  implementationVersion: "burndown/monitor/inspect/v3",
  payload: { hostRoot: Schema.String, reportRoot: Schema.String, runId: Schema.String },
  success: Snapshot,
  error: Schema.String,
  nondeterministic: true
})

export const Diagnose = AgentAction.make("burndown/monitor/diagnose", {
  payload: { snapshot: Snapshot, seat: Schema.String },
  output: Verdict,
  seat: ({ seat }) => seat,
  system: [
    "You monitor a long-running issue burndown run of coding agents.",
    "Healthy means: the run is not failed or cancelled; rounds advance on schedule; workers finish with ready or closed more often than failed; landings succeed; no account is rate limited mid-task; no two dispatchers run at once.",
    "Missing, failed or unknown inspection evidence is unhealthy. Never infer liveness from absent evidence.",
    "Report concrete findings with the evidence line that shows each, and the one action that fixes each. Say healthy only when nothing needs a person or an agent."
  ],
  prompt: ({ snapshot }) => `Evidence at ${new Date(snapshot.now).toISOString()}:\n\n${snapshot.evidence}`,
  corrections: 2
})

/** Appends the verdict to the monitor log and raises a notification when unhealthy. */
export const Report = Action.make("burndown/monitor/report", {
  implementationVersion: "burndown/monitor/report/v3",
  payload: {
    hostRoot: Schema.String,
    reportRoot: Schema.String,
    runId: Schema.String,
    inspectedHealthy: Schema.Boolean,
    verdict: Verdict
  },
  success: Schema.Boolean,
  error: Schema.String,
  nondeterministic: true
})

export const MonitorError = Schema.Union([Schema.String, AgentAction.AgentFailure, Sleep.SleepRequestInvalid])

type MonitorFlow = Flow.Flow<
  "burndown/monitor/loop",
  Schema.Struct<
    {
      hostRoot: typeof Schema.String
      reportRoot: typeof Schema.String
      runId: typeof Schema.String
      seat: typeof Schema.String
      everyMinutes: typeof Schema.Number
    }
  >,
  typeof Schema.String,
  typeof MonitorError,
  | Action.Requirement<"burndown/monitor/inspect">
  | Action.Requirement<"burndown/monitor/diagnose">
  | Action.Requirement<"burndown/monitor/report">
>

export const Loop: MonitorFlow = Flow.make("burndown/monitor/loop", {
  modelInvocable: false,
  description: "Watches a burndown run on a schedule and reports whether it is healthy.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:*", "net:get:*", "net:post:*", "model:call:*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: {
    hostRoot: Schema.String,
    reportRoot: Schema.String,
    runId: Schema.String,
    seat: Schema.String,
    everyMinutes: Schema.Number
  },
  success: Schema.String,
  error: MonitorError,
  body: Node.capture(
    { version },
    ({ everyMinutes, runId, seat, hostRoot, reportRoot }: MonitorInput) =>
      Inspect.call({ runId, hostRoot, reportRoot }).pipe(
        Node.catch({
          onFailure: Node.capture(
            { version },
            () => Node.succeed<Snapshot>({ healthy: false, now: 0, evidence: "Monitor inspection failed" })
          )
        }),
        Node.bindPlanned(
          Node.capture(
            { version, seat, runId, hostRoot, reportRoot, everyMinutes },
            (snapshot: Planned.Planned<Snapshot>) => {
              const snapshotNode = Planned.reference(snapshot)!.node
              return Diagnose.call({ snapshot, seat }).pipe(
                Node.catch({
                  onFailure: Node.capture({ version }, () =>
                    Node.succeed<Verdict>({
                      healthy: false,
                      findings: ["Monitor diagnosis failed"],
                      actions: ["Retry diagnosis on the next round"]
                    }))
                }),
                Node.bindPlanned(
                  Node.capture(
                    { version, runId, seat, everyMinutes, hostRoot, reportRoot, snapshotNode },
                    (verdict: Planned.Planned<Verdict>) =>
                      Report.call({
                        runId,
                        verdict,
                        hostRoot,
                        reportRoot,
                        inspectedHealthy: Planned.make<Snapshot>(snapshotNode).healthy
                      }).pipe(
                        Node.branch({
                          if: Node.capture({ version }, (running: boolean) => running),
                          then: Node.capture(
                            { version, runId, seat, everyMinutes, hostRoot, reportRoot },
                            () =>
                              Sleep.action.call({ millis: everyMinutes * 60_000 }).pipe(
                                Node.andThen(Loop.to({ runId, seat, everyMinutes, hostRoot, reportRoot }))
                              )
                          ),
                          else: Node.capture({ version, runId }, () => Flow.done(`burndown run ${runId} settled`))
                        })
                      )
                  )
                )
              )
            }
          )
        )
      )
  )
})
