/**
 * Behavioral projection contract checks for Home.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { HomeCardSchema } from "../../src/HomeCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Home.ts"

cardContract("Home", HomeCardSchema, fixtures)

describe("Home numeric boundaries", () => {
  test.each(["amendments"] as const)("%s is a nonnegative integer", (field) => {
    const base = HomeCardSchema.parse(fixtures.active)
    for (const value of [0, 1]) {
      const changed = structuredClone(base)
      changed.items[0]![field] = value
      expect(HomeCardSchema.safeParse(changed).success).toBe(true)
    }
    for (const value of [-1, 0.5, NaN, Infinity]) {
      const changed = structuredClone(base)
      changed.items[0]![field] = value
      expect(HomeCardSchema.safeParse(changed).success).toBe(false)
    }
  })
  test("state counts and machine use accept zero and reject negative or fractional counts", () => {
    const base = HomeCardSchema.parse(fixtures.fresh)
    expect(
      HomeCardSchema.safeParse({
        ...base,
        counts: { ...base.counts, queued: 0 },
        machines: { in_use: 0, capacity: 0, slots: [] }
      }).success
    ).toBe(true)
    for (const value of [-1, 0.5]) {
      expect(HomeCardSchema.safeParse({ ...base, counts: { ...base.counts, queued: value } }).success).toBe(false)
      expect(HomeCardSchema.safeParse({ ...base, machines: { ...base.machines, in_use: value } }).success).toBe(false)
      expect(HomeCardSchema.safeParse({ ...base, machines: { ...base.machines, capacity: value } }).success).toBe(false)
    }
  })
  test("elapsed time accepts zero and fractions but refuses negative and nonfinite values", () => {
    const base = HomeCardSchema.parse(fixtures.active)
    for (const value of [0, 0.25, -1, NaN, Infinity]) {
      const changed = structuredClone(base)
      changed.items[0]!.elapsed_s = value
      expect(HomeCardSchema.safeParse(changed).success).toBe(value === 0 || value === 0.25)
    }
  })
})

// Frozen §14.3 Home: queued/waiting background projections.
test.each(["queued", "waiting"])("background runs accept %s", (state) => {
  expect(
    HomeCardSchema.safeParse({ ...fixtures.fresh, background_runs: [{ id: "review", title: "Review", state }] }).success
  ).toBe(true)
})
