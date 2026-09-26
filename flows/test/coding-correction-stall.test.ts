import { Stall } from "@smthrs/flow"
import { Effect, Exit, Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Cursor, defaultStall, finishRound, observeRound, roundSignals } from "../coding/correction.ts"
import type { Receipt, Result, Revision } from "../coding/schema.ts"

const revision = (tree: string): Revision => ({
  changeId: "jj-a",
  commitId: `commit-${tree}`,
  treeId: tree,
  operationId: "op",
  parentCommitIds: []
})
const receipt = (checkId: string, status: Receipt["status"]): Receipt => ({
  checkId,
  target: "t",
  tier: "fast",
  change: "a",
  commitId: "c",
  treeId: "t",
  inputDigest: "d",
  status,
  evidence: "",
  findings: []
})
const result = (tree: string, failing: ReadonlyArray<string>, finding: string): Result => ({
  status: "changes-requested",
  changes: [{
    implementation: {
      change: "a",
      parent: revision("base"),
      atoms: [revision(tree)],
      head: revision(tree),
      reads: [],
      writes: []
    },
    receipts: [receipt("lint", "passed"), ...failing.map((id) => receipt(id, "failed"))]
  }],
  findings: [{ owner: "a", message: finding, sourceCommitId: "c" }]
})

const planFixture = {
  prompt: "p",
  memoryRevision: "m",
  base: revision("base"),
  changes: [{
    id: "a",
    title: "a",
    intent: "a",
    implementation: "i",
    implementationDigest: "0".repeat(64),
    atoms: [{ changeId: null, message: "m", intent: "a", reads: [], writes: [] }],
    checks: []
  }]
}

/** Folds passes the way successive correction rounds do, returning each outcome. */
const rounds = (stall: Stall.Policy, passes: ReadonlyArray<Result>) => {
  let streaks = Stall.initial
  return passes.map((pass, index) => {
    const outcome = observeRound({ stall, streaks, round: index + 1, maxRounds: 8 }, `pass-${index}`, {
      result: pass,
      blocked: null
    })
    streaks = outcome.streaks
    return outcome
  })
}

test("the default parks a correction whose repair left every tree unchanged", () => {
  assert.deepEqual(defaultStall, { rounds: 2, on: "park" })
  const [first, second] = rounds(defaultStall, [result("t1", ["unit"], "x"), result("t1", ["types"], "y")])
  assert.equal(first!.stalled, null)
  assert.deepEqual(second!.stalled, { _tag: "Stalled", signal: "tree", rounds: 2, on: "park" })
  assert.deepEqual(second!.blocked, {
    executionId: "pass-1",
    message: "Correction stalled: the same tree for 2 rounds"
  })
  const finished = Effect.runSync(finishRound({ round: 2, previous: null }, second!))
  assert.equal(finished.status, "blocked")
  assert.deepEqual(finished.stalled, second!.stalled)
})

test("the same failing checks stop the correction as changes-requested", () => {
  const outcomes = rounds({ rounds: 2, on: "stop" }, [
    result("t1", ["unit", "e2e"], "x"),
    result("t2", ["e2e", "unit"], "y")
  ])
  assert.equal(outcomes[1]!.stalled?.signal, "checks")
  assert.equal(outcomes[1]!.blocked, null)
  const finished = Effect.runSync(finishRound({ round: 2, previous: null }, outcomes[1]!))
  assert.equal(finished.status, "changes-requested")
  assert.equal(finished.stalled?.on, "stop")
})

test("identical findings escalate as a typed stalled failure", () => {
  const outcomes = rounds({ rounds: 3, on: "escalate" }, [
    result("t1", [], "same"),
    result("t2", ["a"], "same"),
    result("t3", ["b"], "same")
  ])
  assert.deepEqual(outcomes.map((outcome) => outcome.stalled?.signal ?? null), [null, null, "output"])
  const exit = Effect.runSyncExit(finishRound({ round: 3, previous: null }, outcomes[2]!))
  assert.ok(Exit.isFailure(exit))
  assert.match(JSON.stringify(exit.cause), /"code":"stalled"/)
})

test("a moving, validated or blocked round never stalls", () => {
  const moving = rounds({ rounds: 2, on: "stop" }, [
    result("t1", ["a"], "x"),
    result("t2", ["b"], "y"),
    result("t3", ["c"], "z")
  ])
  assert.ok(moving.every((outcome) => outcome.stalled === null))
  const validated = { ...result("t1", [], "x"), status: "validated" as const }
  const stall: Stall.Policy = { rounds: 2, on: "stop" }
  const cursor = { stall, streaks: Stall.initial, round: 1, maxRounds: 8 }
  const primed = observeRound(cursor, "p", { result: validated, blocked: null }).streaks
  assert.equal(observeRound({ ...cursor, streaks: primed }, "p", { result: validated, blocked: null }).stalled, null)
  assert.equal(
    observeRound({ ...cursor, streaks: primed }, "p", { result: null, blocked: { executionId: "p", message: "m" } })
      .stalled,
    null
  )
  assert.deepEqual(roundSignals(result("t1", ["unit"], "x")).checks, [JSON.stringify(["a", "unit", []])])
  // Findings with no failing check never stall on checks, and the last round settles on its bound.
  assert.ok(rounds(stall, [result("t1", [], "x"), result("t2", [], "y")]).every((outcome) => outcome.stalled === null))
  const last = observeRound(
    {
      stall,
      streaks: observeRound(cursor, "p", { result: result("t1", [], "x"), blocked: null }).streaks,
      round: 8,
      maxRounds: 8
    },
    "p",
    { result: result("t1", [], "x"), blocked: null }
  )
  assert.equal(last.stalled, null)
  // A cursor recorded before the stall fields decodes with the default policy.
  const legacy = Schema.decodeUnknownSync(Cursor)({ plan: planFixture, maxRounds: 3, round: 1, previous: null })
  assert.deepEqual([legacy.stall, legacy.streaks], [defaultStall, Stall.initial])
  const plain = Effect.runSync(finishRound({ round: 1, previous: null }, moving[0]!))
  assert.equal("stalled" in plain, false)
})
