import { test, expect } from "bun:test"
import { assertRestartRecovery, type RecoveryEvent } from "./restart-recovery"

const before: RecoveryEvent[] = [
  { seq: 1, eventType: "flows.engine.attempt-started", payload: { stepKeyDigest: "plan", attempt: 0 } },
  { seq: 2, eventType: "flows.engine.attempt-finished", payload: { stepKeyDigest: "plan", attempt: 0, state: "succeeded" } }
]
const recovery: RecoveryEvent = { seq: 3, eventType: "flows.engine.run-decision", payload: { decision: "stolen-and-activated", evidence: "same-host-pid-dead" } }
test("restart retains the completed prefix and permits a new unfinished step", () => {
  const after = [...before, recovery, { seq: 4, eventType: "flows.engine.attempt-started", payload: { stepKeyDigest: "implement", attempt: 1 } }]
  expect(assertRestartRecovery(before, after)).toEqual({ completed: ["plan"], recovery })
})
test("a recovered activation claim is recovery evidence", () => {
  const claimed = { ...recovery, payload: { decision: "claimed-and-activated", recoveredClaim: { claimant: "dead-owner", claimedAtMs: 1 } } }
  expect(assertRestartRecovery(before, [...before, claimed]).recovery).toEqual(claimed)
})
for (const [name, after, message] of [
  ["no new evidence", before, "no retained prefix"],
  ["rewritten prefix", [{ ...before[0]!, payload: {} }, before[1]!, recovery], "changed"],
  ["repeated sequence", [...before, { ...recovery, seq: 2 }], "unordered"],
  ["rerun completed step", [...before, recovery, { seq: 4, eventType: "flows.engine.attempt-started", payload: { stepKeyDigest: "plan", attempt: 1 } }], "re-ran"],
  ["ordinary activation", [...before, { ...recovery, payload: { decision: "claimed-and-activated" } }], "no owner-loss"],
  ["expired lease alone", [...before, { ...recovery, payload: { decision: "stolen-and-activated", evidence: "lease-expired" } }], "no owner-loss"],
  ["null claim", [...before, { ...recovery, payload: { decision: "claimed-and-activated", recoveredClaim: null } }], "no owner-loss"]
] as const) test(`restart refuses ${name}`, () => {
  expect(() => assertRestartRecovery(before, after)).toThrow(message)
})
test("failed or anonymous steps cannot prove completed work", () => {
  const failed = [{ ...before[1]!, payload: { stepKeyDigest: "plan", state: "failed" } }]
  expect(() => assertRestartRecovery(failed, [...failed, recovery])).toThrow("identifiable")
  const anonymous = [{ ...before[1]!, payload: { state: "succeeded" } }]
  expect(() => assertRestartRecovery(anonymous, [...anonymous, recovery])).toThrow("identifiable")
})

test("JSON field order does not change a retained event", () => {
  const reordered = [{ payload: { attempt: 0, stepKeyDigest: "plan" }, eventType: before[0]!.eventType, seq: 1 }, before[1]!, recovery]
  expect(assertRestartRecovery(before, reordered).completed).toEqual(["plan"])
})
test("empty, reversed and malformed prefix receipts refuse recovery", () => {
  expect(() => assertRestartRecovery([], [recovery])).toThrow("no retained prefix")
  expect(() => assertRestartRecovery([...before].reverse(), [...before, recovery])).toThrow("unordered")
  const malformed = [{ ...before[1]!, seq: Number.NaN }]
  expect(() => assertRestartRecovery(malformed, [...malformed, recovery])).toThrow("unordered")
})
