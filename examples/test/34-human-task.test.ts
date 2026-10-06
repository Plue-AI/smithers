import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/34-human-task.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

// `it.live` rather than `it.effect`: `main` polls for each new wait point on a
// schedule, and a test clock nobody advances would leave that poll asleep forever.
it.live("re-asks on a new wait point and resumes the question across restarts", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "release.sqlite"))

    expect(summary.result).toBe(true)
    // Both entries are the attempt the ENGINE'S waiting row named: the question
    // moved to a second wait point because the first one already held an
    // answer, and the process that decided that had died before phase three ran.
    expect(summary.parkedOn).toEqual([1, 2])
    // The judgment that moved it is in durable state too, under the attempt it
    // judged.
    expect(summary.refusals).toEqual([
      { task: "release", attempt: 1, reason: "The answer must be a boolean." }
    ])
  }), { timeout: 60_000 })
