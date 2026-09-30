import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"

describe("FlowBudget", () => {
  it.each([
    ["zero", 0],
    ["a negative number", -1],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["a fractional token", 1.5],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1]
  ])("rejects %s while decoding and encoding", (_label, value) => {
    for (const field of ["tokens", "milliseconds"] as const) {
      const candidate = { [field]: value }
      expect(() => Schema.decodeUnknownSync(Descriptor.FlowBudget)(candidate)).toThrow()
      expect(() => Schema.encodeUnknownSync(Descriptor.FlowBudget)(candidate)).toThrow()
    }
  })

  it("accepts positive safe-integer ceilings", () => {
    const budget = { tokens: 1, milliseconds: Number.MAX_SAFE_INTEGER }

    expect(Schema.decodeUnknownSync(Descriptor.FlowBudget)(budget)).toEqual(budget)
    expect(Schema.encodeUnknownSync(Descriptor.FlowBudget)(budget)).toEqual(budget)
  })

  it.each([
    ["zero", 0],
    ["a negative amount", -0.01],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY]
  ])("rejects a USD ceiling of %s while decoding and encoding", (_label, usd) => {
    expect(() => Schema.decodeUnknownSync(Descriptor.FlowBudget)({ usd })).toThrow()
    expect(() => Schema.encodeUnknownSync(Descriptor.FlowBudget)({ usd })).toThrow()
  })

  it("accepts a fractional USD ceiling beside the integer ones", () => {
    const budget = { tokens: 1, usd: 0.5, onExceeded: "park" as const }

    expect(Schema.decodeUnknownSync(Descriptor.FlowBudget)(budget)).toEqual(budget)
    expect(Schema.encodeUnknownSync(Descriptor.FlowBudget)(budget)).toEqual(budget)
  })

  it("keeps the shared unbounded budget immutable across descriptors", () => {
    const undeclared = {} as Descriptor.FlowDescriptor
    let mutationSucceeded = false
    let observedAfterMutation: Descriptor.FlowBudget = {}
    try {
      mutationSucceeded = Reflect.set(Descriptor.budgetUnbounded, "tokens", 7)
      observedAfterMutation = { ...Descriptor.budgetOf(undeclared) }
    } finally {
      Reflect.deleteProperty(Descriptor.budgetUnbounded, "tokens")
    }

    expect(Object.isFrozen(Descriptor.budgetUnbounded)).toBe(true)
    expect(mutationSucceeded).toBe(false)
    expect(observedAfterMutation).toEqual({})
    expect(Descriptor.budgetOf(undeclared)).toBe(Descriptor.budgetUnbounded)
  })

  it("returns an immutable declared budget", () => {
    const budget = Descriptor.budgetOf({ budget: { tokens: 7 } } as Descriptor.FlowDescriptor)

    expect(budget).toEqual({ tokens: 7 })
    expect(Object.isFrozen(budget)).toBe(true)
    expect(Reflect.set(budget, "tokens", 8)).toBe(false)
    expect(budget).toEqual({ tokens: 7 })
  })
})

describe("deadlineMillis", () => {
  it.each([
    ["a duration", "30 minutes", 1_800_000],
    ["a padded duration", "  2 hours ", 7_200_000],
    ["a number of milliseconds", 900_000, 900_000],
    ["a numeric string", "900000", 900_000],
    ["a padded numeric string", " 45 ", 45]
  ])("reads %s", (_label, value, milliseconds) => {
    expect(Descriptor.deadlineMillis(value)).toBe(milliseconds)
  })

  it.each([
    ["zero", 0],
    ["a negative duration", "-5 minutes"],
    ["a fraction of a millisecond", "1.5"],
    ["an infinite duration", "Infinity"],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["prose", "soon"],
    ["an empty string", ""],
    ["a list", [1]],
    ["null", null]
  ])("refuses %s", (_label, value) => {
    expect(Descriptor.deadlineMillis(value)).toBeUndefined()
  })

  it("accepts a deadline beside the ceilings and refuses one that is not a positive safe integer", () => {
    const decode = Schema.decodeUnknownSync(Descriptor.FlowBudget)
    expect(decode({ tokens: 5, deadline: 60_000 })).toEqual({ tokens: 5, deadline: 60_000 })
    for (const deadline of [0, -1, 1.5]) expect(() => decode({ deadline })).toThrow()
  })
})
