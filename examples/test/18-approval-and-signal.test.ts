import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/18-approval-and-signal.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

// `it.live` rather than `it.effect`: `main` polls the run list for each park on
// a schedule, and a test clock nobody advances would leave that poll asleep forever.
it.live("gates a launch on a plan approval and ends a durable wait with a signal", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "ship.sqlite"))

    // A pending plan parks the launch rather than starting it.
    expect(summary.plan.beforeApproval).toBe("Parked")
    expect(summary.plan.beforeApprovalStatus).toBe("waiting-approval")
    // The same call launches once the reviewed digest is approved.
    expect(summary.plan.afterApproval).toBe("Accepted")
    expect(summary.plan.decision).toBe("approved")
    expect(summary.plan.launches).toBe(1)
    // A denied plan refuses the launch instead of parking it.
    expect(summary.plan.deniedDecision).toBe("denied")
    expect(summary.plan.deniedLaunch).toBe("/control/PlanDenied")

    // The first drive parked INSIDE the run, on the token the clearance step
    // registered for itself. A park that a person has to answer reports
    // `waiting-approval`, not the bare `parked` of every other wait: the
    // human-wait rollup narrows the status to "this run owes somebody an
    // answer" so the approvals inbox filter and the summary it returns agree
    // (`ControlExecutor.ExecutionObservation.pendingWaits`). `waitingFor` says
    // the same thing one level down: a person, not a fact to arrive.
    expect(summary.run.firstPark).toBe("waiting-approval")
    expect(summary.run.firstWaitingFor).toBe("approval")

    // The step ran twice and read the token both times: unresolved on the
    // drive that parked, resolved on the drive after an operator decided. It
    // did not run a third time, because by then its result was recorded.
    expect(summary.run.clearanceReads).toEqual(["Pending", "Approved"])

    // The run parked again after the gate opened, this time on its signal. An
    // event wait is nobody's question, so the status stays the bare `parked`
    // the approval park above narrowed away from.
    expect(summary.run.parked).toBe("parked")
    expect(summary.run.waitingFor).toBe("event")

    // The in-run approval resolved exactly once and is durable.
    expect(summary.run.approvalReceipt).toBe("Accepted")
    expect(summary.run.approvalDecision).toBe("Approved")
    expect(summary.run.deniedClearanceReads).toEqual(["Pending", "Denied"])
    expect(summary.run.deniedFailure).toBe("/control/ApprovalDenied")
    expect(summary.run.approvals).toEqual(["Node"])

    // The signal is a recorded fact; the host is what turned it into a
    // completed wait point.
    expect(summary.run.signals).toEqual(["ship"])
    expect(summary.run.delivered).toEqual(["ship"])
    expect(summary.run.result).toEqual({ approved: true, by: "release-manager" })
  }), { timeout: 60_000 })
