// Engine-layer proof: the external result is a durable fixture file, not a
// GitHub adapter or a machine shell. Installed C-DUR-01..03 remain separate.
import { killProcess, waitFor } from "@smthrs/testing/Faults"
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { journalEventTypes } from "./harness/durableState.ts"
import { probeEngineChild, spawnEngineChild } from "./harness/engineChild.ts"
import { killResumeFixture } from "./harness/killResumeCase.ts"
import { markers } from "./harness/killResumeFlow.ts"

const fixtures: Array<ReturnType<typeof killResumeFixture>> = []
afterAll(() => fixtures.forEach((fixture) => rmSync(fixture.directory, { recursive: true, force: true })))

describe("case39 crossing recovery after SIGKILL", () => {
  for (const crossing of ["keyed-write", "sealed-check", "keyless-shell"] as const) {
    it(`${crossing} preserves completed work and its recovery policy`, async () => {
      const fixture = killResumeFixture(`case39-${crossing}`, 60_000)
      fixtures.push(fixture)
      const options = { ...fixture, crossing }
      await probeEngineChild(options)
      const killed = spawnEngineChild({ ...options, mode: "execute" })
      try {
        await killed.handshake
        await waitFor(
          () => fixture.marker(markers.secondStarted) !== undefined,
          "remote effect before settlement",
          60_000
        )
        expect(fixture.counter()).toEqual(
          crossing === "keyed-write"
            ? ["first", "second", "lookup", "write"] :
            ["first", "second", "write"]
        )
        expect(fixture.marker(markers.secondDone)).toBeUndefined()
      } finally {
        await killProcess(killed.process)
      }
      await killed.exited
      const resumed = spawnEngineChild({ ...options, mode: "execute", secondSleepMs: 1 })
      const code = await resumed.exited
      if (crossing === "keyless-shell") {
        expect(code, resumed.stderr()).toBe(1)
        expect(resumed.stderr()).toContain("IrreversibleRetryRequiresIdempotencyKey")
        expect(fixture.counter()).toEqual(["first", "second", "write"])
        expect(fixture.marker(markers.secondDone)).toBeUndefined()
      } else {
        expect(code, resumed.stderr()).toBe(0)
        expect(resumed.stdout()).toContain("RESULT_STATUS=succeeded kill-resume:first-value:second-value")
        expect(fixture.counter()).toEqual(
          crossing === "keyed-write"
            ? ["first", "second", "lookup", "write", "second", "lookup"]
            : ["first", "second", "write", "second", "write"]
        )
        // A further restart replays both completed outcomes without any body dispatch.
        const settled = fixture.counter()
        const replay = spawnEngineChild({ ...options, mode: "execute", secondSleepMs: 1 })
        expect(await replay.exited, replay.stderr()).toBe(0)
        expect(fixture.counter()).toEqual(settled)
      }
      const events = await journalEventTypes(fixture.filename, fixture.executionId)
      expect(events.filter((type) => type === "flows.engine.attempt-started")).toHaveLength(3)
      expect(events.filter((type) => type === "flows.engine.attempt-finished")).toHaveLength(
        crossing === "keyless-shell" ? 2 : 3
      )
    }, 300_000)
  }
})
