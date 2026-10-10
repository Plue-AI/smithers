/**
 * The settlement vocabulary a launching verb reports its run with, pinned at
 * the module that now owns it instead of only through `Command.cli`.
 */
import { Control, ControlError } from "@smthrs/control"
import type { ControlSchema } from "@smthrs/control"
import { Effect, Stream } from "effect"
import { spawnSync } from "node:child_process"
import { hostname } from "node:os"
import { describe, expect, it } from "vitest"
import * as Settlement from "../src/commands/Settlement.ts"
import * as ExecutorOwnership from "../src/ExecutorOwnership.ts"

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

describe("settlement ownership", () => {
  const receipt = { _tag: "Accepted", receiptId: "approve-1", runId: "run-1" } as const
  const service = async (overrides: Partial<Control.Service>) =>
    Control.make({
      ...await Effect.runPromise(Control.Control.pipe(Effect.provide(Control.layerNoop))),
      ...overrides
    })
  const owner = (hostId: string, pid: number) => JSON.stringify({ hostId, pid, nonce: "owner-fence" })
  // A pid that names no process: a child that has already exited and been
  // reaped by spawnSync. The parent is a live process on this host that is
  // not this one.
  const exited = spawnSync(process.execPath, ["-e", ""]).pid

  it.each([
    { label: "another process", ownerId: owner(hostname(), process.pid + 1), waits: false },
    { label: "another host with the same PID", ownerId: owner(`${hostname()}-other`, process.pid), waits: false },
    { label: "a live peer's parked run", parkedBy: owner(hostname(), process.ppid), waits: false },
    { label: "another host's parked run", parkedBy: owner(`${hostname()}-other`, process.pid + 1), waits: false },
    // The parker exited, so the decision this process recorded is what
    // restarted the run, on this process's executor (case03): returning
    // would end the process and interrupt that driver.
    { label: "an exited peer's parked run", parkedBy: owner(hostname(), exited), waits: true },
    { label: "this process", ownerId: owner(hostname(), process.pid), waits: true },
    { label: "this process's park", parkedBy: owner(hostname(), process.pid), waits: true },
    { label: "an ownerless admission", waits: true },
    { label: "a legacy opaque owner", ownerId: "memory-owner", waits: true },
    { label: "malformed ownership", ownerId: "{", waits: true }
  ])("$label", async ({ ownerId, parkedBy, waits }) => {
    let watched = 0
    const control = await service({
      list: () =>
        Effect.succeed({
          _tag: "runs",
          items: [{ runId: "run-1", flowId: "idle", status: "running", createdAt: 0, updatedAt: 0, ownerId, parkedBy }]
        }),
      watch: () => {
        watched += 1
        return Stream.make({
          runId: "run-1",
          sequence: 1,
          occurredAt: 0,
          kind: "control.run.completed",
          payload: {}
        })
      }
    })
    const settled = await Effect.runPromise(
      Settlement.awaitOwnedRun(control, receipt, undefined, true).pipe(
        Effect.provide(ExecutorOwnership.layer(true)),
        Effect.timeout("1 second")
      )
    )
    expect(watched).toBe(waits ? 1 : 0)
    expect(settled).toEqual(waits ? { kind: "control.run.completed" } : undefined)
  })

  it("does not read or wait when the receipt explicitly hands work to another host", async () => {
    const settled = await Effect.runPromise(
      Settlement.awaitOwnedRun(
        await service({}),
        {
          ...receipt,
          handedTo: { hostId: hostname(), pid: process.pid + 1 }
        },
        undefined,
        true
      ).pipe(Effect.provide(ExecutorOwnership.layer(true)))
    )
    expect(settled).toBeUndefined()
  })

  it("preserves an ownership read failure instead of pretending the decision settled", async () => {
    const failure = new ControlError.TransportError({ message: "ownership read failed", retryable: true })
    const control = await service({ list: () => Effect.fail(failure) })
    const observed = await Effect.runPromise(
      Settlement.awaitOwnedRun(control, receipt, undefined, true).pipe(
        Effect.provide(ExecutorOwnership.layer(true)),
        Effect.flip
      )
    )
    expect(observed).toBe(failure)
  })
})
