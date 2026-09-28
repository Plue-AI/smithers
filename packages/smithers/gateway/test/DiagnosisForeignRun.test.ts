/**
 * A run's digest folds that run's verdicts only. A `control.run.*` verdict
 * stamped with another run's id (a child's, riding in the parent's events)
 * must not become the parent's failure cause.
 */
import type { ControlSchema } from "@smthrs/control"
import { describe, expect, it } from "vitest"
import * as Diagnosis from "../src/Diagnosis.ts"
import * as GatewayProjection from "../src/GatewayProjection.ts"

const at = (sequence: number, kind: string, runId: string | undefined, payload: unknown) =>
  ({
    sequence,
    kind,
    ...(runId === undefined ? {} : { runId }),
    occurredAt: sequence * 100,
    payload: payload as ControlSchema.ControlEvent["payload"]
  }) as ControlSchema.ControlEvent

const events = [
  at(1, "control.run.failed", "parent", { cause: "parent boom" }),
  at(2, "control.run.failed", "child", { cause: "child boom" })
]

describe("Diagnosis foreign run verdicts", () => {
  it("keeps a child's failure cause out of the parent's digest", () => {
    const digest = Diagnosis.digest(events, "parent")
    expect(digest.cause).toBe("parent boom")
    expect(digest.status).toBe("failed")
  })

  it("keeps a child's failure cause across evicted windows", () => {
    const carry = Diagnosis.combine(Diagnosis.digest([events[0]!], "parent"), Diagnosis.digest([events[1]!], "parent"))
    expect(carry.cause).toBe("parent boom")
  })

  it("keeps an unstamped verdict and the run's own", () => {
    expect(Diagnosis.digest([at(1, "control.run.failed", undefined, { cause: "legacy" })], "parent").cause).toBe(
      "legacy"
    )
  })

  it("renders the parent's cause in the run summary, not the child's", () => {
    const run: ControlSchema.RunSummary = {
      runId: "parent",
      flowId: "agent",
      status: "failed",
      createdAt: 0,
      updatedAt: 300
    }
    const row = GatewayProjection.runSummary(run, events)
    expect(row.diagnosis).toContain("parent boom")
    expect(row.diagnosis).not.toContain("child boom")
  })
})
