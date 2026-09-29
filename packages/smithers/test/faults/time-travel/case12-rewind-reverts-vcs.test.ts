/**
 * Case 12 — a rewind puts the workspace back and writes down that it did.
 *
 * The run below writes a line into a jj-tracked file through a compensable
 * action, so the engine takes a pre-image of the tree before the write, and
 * then parks. Rewinding to a frame before the write has to do three things at
 * once: restore the workspace, archive and truncate the journal suffix, and
 * leave an audit row an operator can find afterwards. The file on disk is the
 * assertion that matters — a rewind that only edited rows would leave the
 * workspace lying.
 */
import { EventTypes } from "@smthrs/engine-store"
import { Jj } from "@smthrs/jj"
import { Journal, type JournalEvent } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import { TimeTravel } from "@smthrs/time-travel"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Schedule from "effect/Schedule"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { layer, ledgerFile, lineageOf, makeWorkspace, parkLedger } from "./harness/timeTravelRun.ts"

const jjInstalled = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

// A missing binary is a hard failure on CI and a quiet skip locally. It is a
// module-level throw rather than a guard suite so that a runner WITH jj emits
// no skipped test: a skip and a pass read the same in a suite summary, and a
// case that has silently skipped for months is indistinguishable from one that
// never ran.
if (!jjInstalled && Boolean(process.env.CI)) {
  throw new Error(
    "jj is not installed on this runner, so this case would silently skip. Install jj in the e2e-faults CI job."
  )
}

describe.skipIf(!jjInstalled)("case12 rewind reverts the workspace with an audit", () => {
  const workspace = makeWorkspace("case12")
  beforeAll(() => workspace.enter())
  afterAll(() => {
    workspace.leave()
    rmSync(workspace.root, { recursive: true, force: true })
  })
  const executionId = "case12-run"

  it("restores the tree, truncates the suffix, and records the audit", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        yield* parkLedger(executionId)

        const journal = yield* Journal.Journal
        yield* journal.flush
        const before = yield* journal.entries({ runId: executionId as JournalEvent.RunId, limit: 500 })
        const ledgerBefore = readFileSync(join(workspace.root, ledgerFile), "utf8")

        // A rewind is a writer: it refuses a run that still has an owner. The
        // park releases the claim, but the release lands after `execute`
        // returns, so wait for the durable row to say so rather than racing it.
        const runs = yield* RunStore.RunStore
        yield* Effect.retry(
          Effect.gen(function*() {
            const row = yield* runs.get(executionId)
            if (row.owner !== null || row.claim !== null || (row.status !== "pending" && row.status !== "suspended")) {
              return yield* Effect.fail(
                new Error(`run is still ${row.status} owner=${String(row.owner)} claim=${String(row.claim)}`)
              )
            }
            return row
          }),
          { times: 200, schedule: Schedule.spaced("50 millis") }
        )

        // The last frame the run's own workspace pre-image anchors, which is
        // the middle of what it recorded: the compensable write records
        // `snapshot-identified` before it runs, and that pointer is the tree
        // the rewind restores. Taking the midpoint INDEX instead named an
        // anchored frame only while a stray follow-loop round padded the
        // journal; with the executor parked, the midpoint lands below the
        // pre-image and the rewind is refused `irreversible` for a frame with
        // nowhere honest to restore to.
        const anchors = before.entries.filter((entry) => entry.eventType === EventTypes.snapshotIdentified)
        const seq = anchors.at(-1)!.seq
        const timeTravel = yield* TimeTravel
        const result = yield* timeTravel.rewind({
          runId: executionId,
          frame: { lineageId: lineageOf(executionId), seq }
        })

        const after = yield* journal.entries({ runId: executionId as JournalEvent.RunId, limit: 500 })
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const audits = yield* sql<{ readonly status: string }>`
          SELECT status FROM flows_time_travel_audits WHERE id = ${result.auditId}
        `
        return {
          totalBefore: before.entries.length,
          totalAfter: after.entries.length,
          archived: result.archive.archived,
          auditStatus: audits[0]?.status ?? "missing",
          ledgerBefore,
          ledgerAfter: readFileSync(join(workspace.root, ledgerFile), "utf8")
        }
      }).pipe(
        Effect.provide(layer(workspace.root, workspace.filename, "case12-host")),
        Effect.scoped,
        Effect.orDie
      )
    )

    // The run really wrote into the workspace before the rewind.
    expect(observed.ledgerBefore).toContain("posted")
    // The suffix was archived and truncated, not dropped silently.
    expect(observed.archived).toBeGreaterThan(0)
    expect(observed.totalAfter).toBeLessThan(observed.totalBefore)
    // The audit is durable and finished.
    expect(observed.auditStatus).toBe("completed")
    // And the workspace is back to what the frame says it was.
    expect(observed.ledgerAfter).not.toContain("posted")
    expect(observed.ledgerAfter).toContain("baseline")
  }, 180_000)

  it("denies every capability beyond the two jj grants rewind needs", async () => {
    const outside = mkdtempSync(join(tmpdir(), "smithers-e2e-case12-outside-"))
    try {
      const observed = await Effect.runPromise(
        Effect.gen(function*() {
          const jj = yield* Jj
          const fileSystem = yield* FileSystem.FileSystem
          const workspaceAdd = yield* Effect.exit(jj.workspaceAdd("case12-lane", join(workspace.root, "case12-lane")))
          const write = yield* Effect.exit(fileSystem.writeFileString(join(outside, "escaped.txt"), "escaped"))
          return { workspaceAdd, write }
        }).pipe(
          Effect.provide(layer(workspace.root, workspace.filename, "case12-denial-host")),
          Effect.scoped,
          Effect.orDie
        )
      )

      expect(Exit.isFailure(observed.workspaceAdd)).toBe(true)
      expect(String(Cause.squash((observed.workspaceAdd as Exit.Failure<unknown, unknown>).cause))).toMatch(
        /Permission/
      )
      expect(Exit.isFailure(observed.write)).toBe(true)
      expect(existsSync(join(outside, "escaped.txt"))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  }, 60_000)
})
