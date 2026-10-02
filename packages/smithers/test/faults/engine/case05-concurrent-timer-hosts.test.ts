import { isAlive, killProcess } from "@smthrs/testing/Faults"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { pendingClocks, timerEvidence, waitingRow } from "./harness/durableState.ts"
import { reapWaitChildren, spawnWaitChild, type WaitChild, type WaitPhase } from "./harness/waitChild.ts"
import { timerFiredStep } from "./harness/waitFlows.ts"

it("arms two live hosts before one durable deadline and executes its continuation once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-timer-race-"))
  const filename = join(directory, "timer.sqlite")
  const counterFile = join(directory, "counter.log")
  const executionId = "timer-race-run"
  const millis = 15_000
  const children: Array<WaitChild> = []
  const launch = (phase: WaitPhase, hostId: string) => {
    const child = spawnWaitChild({ filename, counterFile, executionId, millis, mode: "timer", phase, hostId })
    children.push(child)
    return child
  }
  const bounded = async <A>(promise: Promise<A>): Promise<A> => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() =>
            reject(
              new Error(
                `timer race timed out\n${
                  children.map((child) => `${child.pid}\n${child.stdout()}\n${child.stderr()}`).join("\n")
                }`
              )
            ), 45_000)
        })
      ])
    } finally {
      clearTimeout(timeout)
    }
  }
  const counter = () => readFileSync(counterFile, "utf8").trim().split("\n").filter(Boolean)
  try {
    writeFileSync(counterFile, "")
    const arming = launch("linger", "timer-race-arming")
    expect(await bounded(arming.parked)).toBe(executionId)
    const clocks = await pendingClocks(filename, executionId)
    expect(clocks).toHaveLength(1)
    const clock = clocks[0]!
    expect(clock.completedAtMs).toBeNull()
    await killProcess(arming.process)
    expect(isAlive(arming.pid)).toBe(false)

    const racers = [launch("race-timer", "timer-race-a"), launch("race-timer", "timer-race-b")]
    expect(await bounded(Promise.all(racers.map((child) => child.parked)))).toEqual([executionId, executionId])
    // A late boot is not a timer race. Both processes must really be alive,
    // with the original pending deadline still in the future and no action run.
    expect(racers.every((child) => isAlive(child.pid))).toBe(true)
    expect(Date.now()).toBeLessThan(clock.dueAtMs)
    expect(await pendingClocks(filename, executionId)).toEqual(clocks)
    expect(counter()).toEqual([])

    expect(await bounded(Promise.all(racers.map((child) => child.settled)))).toEqual([null, null])
    expect(await bounded(Promise.all(racers.map((child) => child.exited)))).toEqual([0, 0])
    expect(counter()).toEqual([timerFiredStep])
    expect(await pendingClocks(filename, executionId)).toEqual([])
    expect(await waitingRow(filename, executionId)).toBeUndefined()
    const evidence = await timerEvidence(filename, clock)
    expect(evidence.clock).toEqual({ ...clock, completedAtMs: expect.any(Number) })
    expect(evidence.clock?.completedAtMs).toBeGreaterThanOrEqual(clock.dueAtMs)
    expect(evidence.deferred?.completedAtMs).toBeGreaterThanOrEqual(clock.dueAtMs)
    expect(evidence.deferred?.exit).toMatchObject({ _tag: "Success" })
    expect(evidence.deferred?.metadata).toEqual({
      clockName: clock.clockName,
      dueAtMs: clock.dueAtMs,
      completedAtMs: expect.any(Number)
    })
    // Scheduling records describe each host's re-arm, not separate durable
    // timers. All three hosts must report exactly the same persisted deadline.
    const schedules = evidence.entries.filter((entry) => entry.eventType === "flows.engine.clock-scheduled")
    expect(schedules).toHaveLength(3)
    for (const hostId of ["timer-race-arming", "timer-race-a", "timer-race-b"]) {
      const records = schedules.filter((entry) => entry.sourceId.startsWith(`${hostId}-engine:clock:`))
      expect(records).toHaveLength(1)
      expect(records[0]?.payload).toEqual({
        flowName: clock.flowName,
        executionId,
        clockName: clock.clockName,
        deferredName: clock.deferredName,
        dueAtMs: clock.dueAtMs
      })
    }
    const completions = evidence.entries.filter((entry) => entry.eventType === "flows.engine.deferred-completed")
    expect(completions.length).toBeGreaterThanOrEqual(1)
    expect(completions.length).toBeLessThanOrEqual(2)
    expect(new Set(completions.map((entry) => entry.sourceId)).size).toBe(completions.length)
    expect(evidence.digest).toBeDefined()
    for (const entry of completions) {
      expect(["timer-race-a", "timer-race-b"].some((hostId) => entry.sourceId.startsWith(`${hostId}-engine:deferred:`)))
        .toBe(true)
      expect(entry.payload).toEqual({
        flowName: clock.flowName,
        executionId,
        deferredName: clock.deferredName,
        completedAtMs: evidence.deferred?.completedAtMs,
        // Values remain in the durable row; the redacted journal carries the
        // digests of that row's exact persisted JSON bytes.
        exitDigest: evidence.digest?.exit,
        metadataDigest: evidence.digest?.metadata
      })
    }

    const replay = launch("settle", "timer-race-replay")
    expect(await bounded(replay.settled)).toBeNull()
    expect(await bounded(replay.exited)).toBe(0)
    expect(counter()).toEqual([timerFiredStep])
  } finally {
    await reapWaitChildren()
    rmSync(directory, { recursive: true, force: true })
  }
})
