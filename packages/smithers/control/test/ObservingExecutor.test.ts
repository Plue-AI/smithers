/**
 * The executor a host composed to observe runs carries.
 *
 * `@smthrs/cli` builds one for a verb that lists, diagnoses, or reads a log:
 * those reach no completion, so that host needs no completion judge and opens
 * with no gateway key. This port is what stops that being a hole. A verb
 * misclassified as a read would otherwise admit a run into a host with no
 * judge and lose it at its first completion, which is exactly the outcome the
 * judge requirement exists to prevent, so the two methods that drive a run die
 * instead of quietly accepting work.
 */
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import type { RunId } from "@smthrs/control/ControlSchema"
import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"

const runId = "run-1" as RunId

const spied = () => {
  const calls: Array<string> = []
  const service = ControlExecutor.makeNoop({
    readExecution: () => {
      calls.push("readExecution")
      return Effect.succeed({ _tag: "Observed", status: "parked" } as const)
    },
    requestCancel: () => {
      calls.push("requestCancel")
      return Effect.succeed("recorded" as const)
    },
    deliverSignal: () => {
      calls.push("deliverSignal")
      return Effect.succeed("delivered" as const)
    },
    settleCancelledPark: () => {
      calls.push("settleCancelledPark")
      return Effect.void
    },
    launch: () => {
      calls.push("launch")
      return Effect.succeed("accepted" as const)
    },
    resumeRun: () => {
      calls.push("resumeRun")
      return Effect.succeed("resuming" as const)
    }
  })
  return { calls, observing: ControlExecutor.makeObserving(service) }
}

describe("makeObserving", () => {
  it("still reads the engine, records a cancel, and delivers a signal", async () => {
    const { calls, observing } = spied()
    // Observation is the reason the port stays: a run's current round, its
    // waiting reason and the human waits parked below it live in the engine's
    // database, so a listing that dropped this would answer about the control
    // plane's coordination copy alone.
    expect(await Effect.runPromise(observing.readExecution!(runId))).toEqual({ _tag: "Observed", status: "parked" })
    expect(await Effect.runPromise(observing.requestCancel({ runId }))).toBe("recorded")
    expect(await Effect.runPromise(observing.deliverSignal({ runId, signal: { name: "go", payload: null } }))).toBe(
      "delivered"
    )
    expect(await Effect.runPromise(observing.settleCancelledPark({ runId }))).toBeUndefined()
    expect(calls).toEqual(["readExecution", "requestCancel", "deliverSignal", "settleCancelledPark"])
  })

  it.each(
    [
      ["launch", (service: ControlExecutor.Service) => service.launch({ plan: {} as never, run: {} as never })],
      ["resumeRun", (service: ControlExecutor.Service) => service.resumeRun({ runId })]
    ] as const
  )("refuses %s as a defect and never reaches the executor", async (method, drive) => {
    const { calls, observing } = spied()
    const exit = await Effect.runPromiseExit(drive(observing) as Effect.Effect<unknown>)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain("This host observes runs and drives none")
    expect(String(exit)).toContain(`ControlExecutor.${method}`)
    expect(calls).toEqual([])
  })
})

describe("makeReadOnly", () => {
  it("reads the engine it was given and dies on everything else", async () => {
    const reader = ControlExecutor.makeReadOnly({
      readExecution: () => Effect.succeed({ _tag: "Observed", status: "parked" } as const)
    })
    expect(await Effect.runPromise(reader.readExecution!(runId))).toEqual({ _tag: "Observed", status: "parked" })
    const refused: Record<string, Effect.Effect<unknown, unknown>> = {
      launch: reader.launch({} as ControlExecutor.Launch),
      requestCancel: reader.requestCancel({ runId }),
      deliverSignal: reader.deliverSignal({ runId, signal: { name: "go", payload: null } }),
      resumeRun: reader.resumeRun({ runId }),
      settleCancelledPark: reader.settleCancelledPark({ runId })
    }
    for (const [method, effect] of Object.entries(refused)) {
      const exit = await Effect.runPromiseExit(effect)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain(`ControlExecutor.${method} is unreachable`)
      }
    }
  })

  it("reads batches independently or alongside a point reader", async () => {
    const batch = { source: null, revision: null, snapshots: [] }
    const readExecutions: NonNullable<ControlExecutor.Service["readExecutions"]> = () => Effect.succeed(batch)
    for (const options of [{ readExecutions }, { readExecutions, readExecution: spied().observing.readExecution }]) {
      const reader = ControlExecutor.makeReadOnly(options)
      expect(await Effect.runPromise(reader.readExecutions!({ runId, executionIds: [] }))).toEqual(batch)
      expect(reader.readExecution).toBe(options.readExecution)
    }
  })

  it("has no engine reader without an engine", () => {
    expect(ControlExecutor.makeReadOnly().readExecution).toBeUndefined()
    expect(ControlExecutor.makeReadOnly().readExecutions).toBeUndefined()
  })
})
