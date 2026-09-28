/**
 * The wire contract of every control failure, frozen.
 *
 * `_tag` selects the class a client decodes and `code` is the string a client
 * branches on. Neither had a single assertion in this package's tests, so both
 * were free to move under a rename or a copy-paste. They are the two strings
 * that must survive 1.0.0-rc.0 unchanged, so they are written here as literals
 * rather than derived from the source: a test that reads the value it checks
 * proves nothing.
 *
 * A new error class is a wire addition. It must be added to this table in the
 * same change that adds it to `ControlErrorSchema`, or the membership assertion
 * at the end fails.
 */
import { NotificationError } from "@smthrs/notifications/NotificationQueue"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { isControlError } from "../src/ControlClient.ts"
import * as ControlError from "../src/ControlError.ts"

/** One constructed instance per member of `ControlErrorSchema`, with its frozen strings. */
const table: ReadonlyArray<{
  readonly tag: string
  readonly code: string
  readonly error: ControlError.ControlError
}> = [
  { tag: "/control/RunNotFound", code: "run_not_found", error: new ControlError.RunNotFound({ runId: "run-1" }) },
  { tag: "/control/PlanNotFound", code: "plan_not_found", error: new ControlError.PlanNotFound({ planId: "plan-1" }) },
  { tag: "/control/PlanDenied", code: "plan_denied", error: new ControlError.PlanDenied({ planId: "plan-1" }) },
  { tag: "/control/FlowNotFound", code: "flow_not_found", error: new ControlError.FlowNotFound({ flowId: "flow-1" }) },
  {
    tag: "/control/PlanDigestMismatch",
    code: "plan_digest_mismatch",
    error: new ControlError.PlanDigestMismatch({ planId: "plan-1", expected: "a", actual: "b" })
  },
  {
    tag: "/control/CodeDrift",
    code: "code_drift",
    error: new ControlError.CodeDrift({ runId: "run-1", flowId: "flow-1", recorded: "a", current: "b" })
  },
  {
    tag: "/control/EnvelopeMismatch",
    code: "envelope_mismatch",
    error: new ControlError.EnvelopeMismatch({ planId: "plan-1", expected: "a", actual: "b" })
  },
  { tag: "/control/ClaimLost", code: "claim_lost", error: new ControlError.ClaimLost({ runId: "run-1" }) },
  {
    tag: "/control/AlreadyResolved",
    code: "already_resolved",
    error: new ControlError.AlreadyResolved({ requestId: "ask/run-1/digest" })
  },
  { tag: "/control/InvalidInput", code: "invalid_input", error: new ControlError.InvalidInput({ issue: "limit" }) },
  {
    tag: "/control/Unauthorized",
    code: "unauthorized",
    error: new ControlError.Unauthorized({ message: "no bearer" })
  },
  {
    tag: "/control/Unavailable",
    code: "unavailable",
    error: new ControlError.Unavailable({ feature: "watch", ticket: "control-watch" })
  },
  {
    tag: "/control/TransportError",
    code: "transport_error",
    error: new ControlError.TransportError({ message: "connection refused", retryable: true })
  },
  {
    tag: "/control/PersistenceError",
    code: "persistence_failed",
    error: new ControlError.PersistenceError({ operation: "read a run", message: "the row could not be read" })
  },
  {
    tag: "/control/LaunchFailed",
    code: "launch_failed",
    error: new ControlError.LaunchFailed({ runId: "run-1", message: "the executor refused" })
  },
  {
    tag: "/control/NoMatchingWait",
    code: "no_matching_wait",
    error: new ControlError.NoMatchingWait({ runId: "run-1", waitName: "approval" })
  },
  {
    tag: "/control/CredentialConflict",
    code: "credential_conflict",
    error: new ControlError.CredentialConflict({ id: "exa", expectedVersion: 2, actualVersion: 3 })
  },
  {
    tag: "/notifications/NotificationError",
    code: "notification_unavailable",
    error: new NotificationError({ code: "notification_unavailable", message: "notification unavailable" })
  }
]

describe("stable control error codes", () => {
  it.each(["notification_closed", "notification_full"] as const)(
    "round trips %s as a declared control refusal",
    (code) => {
      const error = new NotificationError({ code, message: "notification refused", notificationId: "notification-1" })
      const encoded = Schema.encodeSync(ControlError.ControlErrorSchema)(error)
      const decoded = Schema.decodeUnknownSync(ControlError.ControlErrorSchema)(JSON.parse(JSON.stringify(encoded)))
      expect(decoded).toBeInstanceOf(NotificationError)
      expect(decoded.code).toBe(code)
      expect(isControlError(decoded)).toBe(true)
    }
  )
  it.each(table)("$tag answers $code", ({ code, error, tag }) => {
    expect(error._tag).toBe(tag)
    expect(error.code).toBe(code)
  })

  it("gives every member a distinct code", () => {
    expect(new Set(table.map((entry) => entry.code)).size).toBe(table.length)
    expect(new Set(table.map((entry) => entry.tag)).size).toBe(table.length)
  })

  it("recognises every member as a control error", () => {
    for (const { error } of table) expect(isControlError(error)).toBe(true)
    expect(isControlError(new Error("not a control error"))).toBe(false)
    expect(isControlError({ _tag: "/control/RunNotFound" })).toBe(false)
  })

  it("keeps the code through an encode and decode round trip", () => {
    for (const { code, error, tag } of table) {
      const encoded = Schema.encodeSync(ControlError.ControlErrorSchema)(error)
      const decoded = Schema.decodeUnknownSync(ControlError.ControlErrorSchema)(
        JSON.parse(JSON.stringify(encoded))
      )
      expect(decoded._tag).toBe(tag)
      expect(decoded.code).toBe(code)
    }
  })

  it("enumerates exactly the union's membership", () => {
    // `ControlErrorSchema` is the single membership list. A class added there
    // without a row above is a new code nobody froze, and this pairing is what
    // catches it: every member must accept exactly one frozen instance, and
    // every frozen instance must be accepted by exactly one member.
    const members = ControlError.ControlErrorSchema.members
    expect(members).toHaveLength(table.length)
    const unmatched = members.filter((member) => !table.some((entry) => Schema.is(member)(entry.error)))
    expect(unmatched).toHaveLength(0)
    for (const { error, tag } of table) {
      const accepting = members.filter((member) => Schema.is(member)(error))
      expect({ tag, accepting: accepting.length }).toEqual({ tag, accepting: 1 })
    }
  })
})
