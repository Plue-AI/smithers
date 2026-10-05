import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/03-crash-and-resume.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

// `it.live` rather than `it.effect`: `main` polls for the durable park on a
// schedule, and a test clock nobody advances would leave that poll asleep forever.
it.live("resumes a suspended run without re-dispatching completed work", () =>
  Effect.gen(function*() {
    const summary = yield* (main(join(directory, "review.sqlite")))
    expect(summary.result).toBe("rfc:draft body:approved")
    expect(summary.stepEntries).toBeGreaterThan(1)
    expect(summary.readDispatches).toBe(1)
  }))
