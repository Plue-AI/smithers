import { expect, test } from "bun:test"
import { Schema } from "effect"
import { assembleArgs, draftFrom, formFieldsFor, publicFormPayload, submissionPayload } from "@smthrs/ui/flow-form"
import { writeOnlyGesture } from "./CommandGesture"

const input = Schema.Struct({ name: Schema.String, value: Schema.optional(Schema.String) })
const hints = { fields: { value: { kind: "write-only", required: true } } } as const
const secret = "opaque-fixture-value"

test("write-only fields never enter draft, given, named submission or display arguments", () => {
  const fields = formFieldsFor(input, hints)
  const given = { name: "KEY", value: secret }
  expect(draftFrom(fields, given)).toEqual({ name: "KEY" })
  expect(publicFormPayload(fields, given)).toEqual({ name: "KEY" })
  expect(submissionPayload(input, fields, given, given)).toEqual({ payload: { name: "KEY" } })
  expect(assembleArgs(fields, { ...hints, args: payload => JSON.stringify(payload) }, given)).not.toContain(secret)
  expect(publicFormPayload(fields, { flow: "sample", input: given }, "input")).toEqual({ flow: "sample", input: { name: "KEY" } })
  expect(publicFormPayload(fields, secret as unknown as Record<string, unknown>)).toEqual({})
  const ordinary = fields.filter(field => field.kind !== "write-only")
  expect(Object.is(publicFormPayload(ordinary, 7 as unknown as Record<string, unknown>), 7)).toBe(true)
})

test("the gesture releases an opaque value exactly once and cannot be serialized", () => {
  const gesture = writeOnlyGesture("example.save", { value: secret })
  expect(JSON.stringify(gesture)).not.toContain(secret)
  expect(gesture.hasWriteOnly?.("value")).toBe(true)
  expect(gesture.takeWriteOnly?.("value")).toBe(secret)
  expect(gesture.takeWriteOnly?.("value")).toBeUndefined()
  const canceled = writeOnlyGesture("example.save", { value: secret })
  canceled.release()
  expect(canceled.takeWriteOnly?.("value")).toBeUndefined()
})
