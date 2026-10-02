/**
 * Case 31 — a killed host leaves a real orphan, and host recovery durably
 * retires its exact process identity after the process group is gone.
 *
 * SIGKILL skips finalizers. The test observes the live group reparented to
 * init before replacement. A containment supervisor may subsequently finish
 * the group before the next host's reaper reaches it; recovery must then
 * record process-gone, rather than claiming it performed a second kill.
 * The separate owning-reaper integration suite checks actual group signals.
 */
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import {
  isAlive,
  isGroupAlive,
  killGroup,
  killProcess,
  parentPid,
  waitFor,
  waitForReparent
} from "@smthrs/testing/Faults"
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { basename, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { journalEntries } from "./harness/durableState.ts"
import { probeEngineChild, spawnEngineChild } from "./harness/engineChild.ts"
import { killResumeFixture } from "./harness/killResumeCase.ts"
import { firstStep, markers, secondStep } from "./harness/killResumeFlow.ts"

const fixture = killResumeFixture("case31", 60_000)
afterAll(() => {
  const receipts = process.env.FAULT_3367_RECEIPTS
  if (receipts !== undefined) {
    mkdirSync(receipts, { recursive: true })
    cpSync(fixture.directory, join(receipts, basename(fixture.directory)), { recursive: true })
  }
  rmSync(fixture.directory, { recursive: true, force: true })
})

describe("case31 real engine kill and resume", () => {
  it("reparents the orphan to init and durably retires it after host recovery", async () => {
    await probeEngineChild({ ...fixture })

    const engine = spawnEngineChild({ ...fixture, mode: "execute" })
    await engine.handshake
    await waitFor(() => fixture.marker(markers.spawnedPid) !== undefined, "the contained spawn", 60_000)

    const orphan = Number(fixture.marker(markers.spawnedPid))
    expect(Number.isFinite(orphan)).toBe(true)
    expect(parentPid(orphan)).toBe(engine.pid)

    try {
      await killProcess(engine.process)
      expect(isAlive(engine.pid)).toBe(false)

      // The fault was really injected: the spawned tree outlived its host and
      // now belongs to init.
      const reparented = await waitForReparent(orphan, engine.pid, 15_000)
      expect(reparented).toBe(1)
      expect(isGroupAlive(orphan)).toBe(true)

      // The next incarnation of the same host reads the ledger, kills the group,
      // and journals the decision.
      const resumed = spawnEngineChild({ ...fixture, mode: "execute", secondSleepMs: 10 })
      expect(await resumed.exited).toBe(0)
      expect(resumed.stdout()).toContain("RESULT_STATUS=succeeded")

      await waitFor(() => !isGroupAlive(orphan), "the orphaned process group to be reaped", 30_000)
    } finally {
      killGroup(orphan)
    }

    // The durability claim, from the append-only counter the killed process
    // could not rewrite: the committed action was replayed, the interrupted one
    // re-ran.
    expect(fixture.counter()).toEqual([firstStep, secondStep, secondStep])
    expect(fixture.marker(markers.secondDone)).toBeDefined()

    // A supervisor can finish the group after its owner dies but before the
    // replacement host sweeps it. Both paths must retire this exact orphan,
    // after its spawn, and a skipped retirement must prove it was already gone.
    const hostEvents = await journalEntries(fixture.filename, ProcessLedger.hostRunId(fixture.hostId))
    const spawned = hostEvents.filter((entry) =>
      entry.eventType === "flows.host.process-spawned.v1" &&
      (entry.payload as { pid?: number }).pid === orphan
    )
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.payload).toMatchObject({ pid: orphan, pgid: orphan, ownerPid: engine.pid })
    const retired = hostEvents.filter((entry) =>
      ["flows.host.process-reaped.v1", "flows.host.process-reap-skipped.v1"].includes(entry.eventType) &&
      (entry.payload as { pid?: number }).pid === orphan
    )
    expect(retired).toHaveLength(1)
    expect(retired[0]!.seq).toBeGreaterThan(spawned[0]!.seq)
    expect(retired[0]!.payload).toEqual({
      ...(spawned[0]!.payload as Record<string, unknown>),
      ...(retired[0]!.eventType === "flows.host.process-reap-skipped.v1" ? { reason: "process-gone" } : {})
    })
  }, 300_000)
})
