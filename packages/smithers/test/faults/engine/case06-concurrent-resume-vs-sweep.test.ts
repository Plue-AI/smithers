/**
 * Case 6 — two hosts reach for the same abandoned run at once, and only one of
 * them drives it.
 *
 * This is the shape a stale-run sweep and an operator's resume produce together:
 * the run's owner is gone, its claim is free, and two processes decide
 * independently that they should pick it up. The engine's answer is
 * join-or-claim — one takes the claim and the other either joins the result or
 * loses the fence — and the invariant underneath it is that the step runs once
 * more, not twice.
 *
 * Both halves are here, because each can hold while the other breaks. The
 * first test is the engine's: two hosts drive the same parked run and the step
 * dispatches once, which is idempotence. The second is the control plane's:
 * two control planes ask to resume the same suspended run at the same instant
 * and exactly one is admitted, which is the fence. An engine whose attempt
 * rows deduplicate perfectly would pass the first test with no fence at all.
 */
import { killProcess } from "@smthrs/testing/Faults"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { persistedRun, raceForClaim, suspendedRun } from "./harness/claimRace.ts"
import { journalEventTypes, waitingRow } from "./harness/durableState.ts"
import { reapWaitChildren, spawnWaitChild } from "./harness/waitChild.ts"
import { preparedStep } from "./harness/waitFlows.ts"

const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-case06-"))
afterAll(async () => {
  // Reap first: a lingering host outlives an assertion that failed before its
  // kill, and must not be left running against a directory that is going away.
  await reapWaitChildren()
  rmSync(directory, { recursive: true, force: true })
})

const counterLines = (path: string): ReadonlyArray<string> =>
  readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter((line) => line.length > 0)

describe("case06 concurrent resume against a sweep", () => {
  it("admits exactly one driver and never re-runs the step twice", async () => {
    const filename = join(directory, "race.sqlite")
    const counterFile = join(directory, "counter.log")
    writeFileSync(counterFile, "")
    const executionId = "case06-run"
    const shared = { filename, counterFile, executionId, mode: "event" as const }

    const parking = spawnWaitChild({ ...shared, hostId: "case06-owner", phase: "linger" })
    expect(await parking.parked).toBe(executionId)
    expect(counterLines(counterFile)).toEqual([preparedStep])
    await killProcess(parking.process)
    expect((await waitingRow(filename, executionId))?.reason).toBe("event")

    // The wait is satisfied once, by a host that drives nothing, so the two
    // hosts below race for the claim rather than for the signal.
    const notifier = spawnWaitChild({ ...shared, hostId: "case06-notifier", phase: "notify" })
    expect(await notifier.exited).toBe(0)
    expect(counterLines(counterFile)).toEqual([preparedStep])
    expect((await waitingRow(filename, executionId))?.reason).toBe("event")

    // Two independent hosts, started together, each believing the run is theirs
    // to pick up.
    const left = spawnWaitChild({ ...shared, hostId: "case06-resume", phase: "settle" })
    const right = spawnWaitChild({ ...shared, hostId: "case06-sweep", phase: "settle" })

    const [leftCode, rightCode] = await Promise.all([left.exited, right.exited])
    const settlements = [
      leftCode === 0 ? await left.settled.catch(() => undefined) : undefined,
      rightCode === 0 ? await right.settled.catch(() => undefined) : undefined
    ].filter((value) => value !== undefined)

    // At least one host drove the run to a result, and every host that reported
    // one reported the same result.
    expect(settlements.length).toBeGreaterThanOrEqual(1)
    for (const settlement of settlements) expect(settlement).toBe("wait:signalled")

    // The invariant: the parked step ran once before the crash and at most once
    // after it. Two concurrent drivers must not both dispatch it.
    expect(counterLines(counterFile)).toEqual([preparedStep, preparedStep])
    expect(await waitingRow(filename, executionId)).toBeUndefined()

    const events = await journalEventTypes(filename, executionId)
    expect(events.filter((type) => type === "flows.engine.deferred-completed")).toHaveLength(1)
  }, 180_000)

  it("admits one control plane to the claim and refuses the other's claim and write with ClaimLost", async () => {
    const filename = join(directory, "fence.sqlite")
    const runId = await suspendedRun(filename)

    // Two planes, two identities, one row. The barrier releases them together,
    // so the winner is decided by the compare-and-swap and not by which
    // process finished booting first.
    const attempts = await raceForClaim(filename, runId, join(directory, "fence.go"), ["sweep", "operator"])

    const won = attempts.filter((attempt) => attempt.outcome.startsWith("won:"))
    const lost = attempts.filter((attempt) => attempt.outcome.startsWith("lost:"))
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    // The refusal is the typed fence error, not a transport failure or a
    // generic defect: a loser that crashed would also produce one winner.
    expect(lost[0]?.outcome).toBe("lost:/control/ClaimLost")
    expect(won[0]?.outcome).toBe("won:Accepted")

    // Each racer then makes the fenced write a driver makes. The winner's
    // lands; the loser's, presented with the fence its own identity carries,
    // is refused by the compare-and-swap and leaves the winner's claim intact.
    expect(won[0]?.writeOutcome).toBe("ok:running")
    expect(lost[0]?.writeOutcome).toBe("lost:/control/ClaimLost")
    expect(won[0]?.fence).toMatchObject({ hostId: won[0]?.hostId })
    expect(lost[0]?.fence).toMatchObject({ hostId: lost[0]?.hostId })
    expect(await persistedRun(filename, runId)).toEqual({ status: "running", owner: won[0]?.fence })
  }, 180_000)
})
