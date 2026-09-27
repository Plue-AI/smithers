/**
 * The settlement vocabulary a launching verb reports its run with, pinned at
 * the module that now owns it instead of only through `Command.cli`.
 */
import { ControlError } from "@smthrs/control"
import type { ControlSchema } from "@smthrs/control"
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Settlement from "../src/commands/Settlement.ts"

describe("Settlement", () => {
  it("settles on a park, a declined launch, and every terminal status", () => {
    expect(
      [
        "control.run.waiting-approval",
        "control.run.pending",
        "control.run.completed",
        "control.run.failed",
        "control.run.cancelled",
        "control.run.started",
        "control.node.completed"
      ].filter(Settlement.settled)
    ).toEqual([
      "control.run.waiting-approval",
      "control.run.pending",
      "control.run.completed",
      "control.run.failed",
      "control.run.cancelled"
    ])
  })

  it("reports the launch contract's exit status for each settlement", () => {
    expect(Settlement.status({ kind: "control.run.completed" })).toBe(0)
    expect(Settlement.status({ kind: "control.run.failed" })).toBe(1)
    expect(Settlement.status({ kind: "control.run.cancelled" })).toBe(130)
    expect(Settlement.status({ kind: "control.run.waiting-approval" })).toBe(3)
    expect(Settlement.status({ kind: "control.run.pending" })).toBeUndefined()
    expect(Settlement.status(undefined)).toBeUndefined()
  })

  it("treats only a pending settlement as a declined launch", () => {
    expect(Settlement.wasDeclined({ kind: "control.run.pending" })).toBe(true)
    expect(Settlement.wasDeclined({ kind: "control.run.failed" })).toBe(false)
    expect(Settlement.wasDeclined(undefined)).toBe(false)
  })

  it("keeps the receipt and adds the failure verdict", () => {
    const receipt = { _tag: "Accepted", runId: "run-1" } as unknown as ControlSchema.Receipt

    expect(Settlement.receiptDocument(receipt, { kind: "control.run.completed" })).toBe(receipt)
    expect(Settlement.receiptDocument(receipt, { kind: "control.run.failed" })).toEqual({
      ...receipt,
      status: "failed",
      cause: "no cause recorded in the journal"
    })
  })

  it("keeps a transport failure's own retryability when it wraps one", () => {
    // A watch that failed because the transport said so is retryable exactly
    // as that transport said; anything else is retryable by default.
    expect(
      Settlement.watchFailure(
        new ControlError.TransportError({ message: "gone", retryable: false }),
        "run-1",
        "settlement"
      ).retryable
    ).toBe(false)
    expect(Settlement.watchFailure(new Error("socket reset"), "run-1", "settlement").retryable).toBe(true)
  })

  it("keeps the highest sequence a stream carries, whatever order it arrives in", async () => {
    const sequences = (numbers: ReadonlyArray<number>) =>
      Effect.runPromise(Settlement.latestSequence(Stream.fromArray(numbers.map((sequence) => ({ sequence })))))

    expect(await sequences([])).toBeUndefined()
    expect(await sequences([7])).toBe(7)
    expect(await sequences([7, 9])).toBe(9)
    // A replay out of order must not lower the park a resume keys on.
    expect(await sequences([9, 7])).toBe(9)
  })

  it("names the run and the next commands when no executor took it", () => {
    const error = Settlement.declined("run-1", undefined)

    expect(error.message).toContain("Run run-1 was accepted but no executor took it: it is accepted")
    expect(error.message).toContain("smthrs runs cancel run-1")
  })
})
