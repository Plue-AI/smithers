import { expect, it } from "bun:test"
import * as Budget from "../src/budget.ts"

const unset = {
  tokens: { max: Budget.defaultRunTokens, onExceeded: "fail" as const },
  daily: { max: Budget.defaultDailyTokens }
}

it("applies the default per-run and per-day caps when nothing is set", () => {
  expect(Budget.policy({})).toEqual(unset)
  expect(Budget.policy({ [Budget.environmentKey]: "", [Budget.dailyEnvironmentKey]: "" })).toEqual(unset)
  expect(Budget.defaultDailyTokens).toBe(10 * Budget.defaultRunTokens)
})

it("maps an override to a failing token policy, the flag winning", () => {
  expect(Budget.policy({ [Budget.environmentKey]: "5000" })).toEqual({
    ...unset,
    tokens: { max: 5000, onExceeded: "fail" }
  })
  expect(Budget.policy({ [Budget.environmentKey]: "5000" }, { tokens: "20" })).toEqual({
    ...unset,
    tokens: { max: 20, onExceeded: "fail" }
  })
  expect(Budget.policy({ [Budget.dailyEnvironmentKey]: "70" }, { daily: "80" })).toEqual({
    ...unset,
    daily: { max: 80 }
  })
  expect(Budget.policy({ [Budget.dailyEnvironmentKey]: "70" })).toEqual({ ...unset, daily: { max: 70 } })
})

it("disables one cap with 0 or none, and both with none of them left", () => {
  for (const off of ["0", "none"]) {
    expect(Budget.policy({ [Budget.environmentKey]: off })).toEqual({ daily: unset.daily })
    expect(Budget.policy({}, { daily: off })).toEqual({ tokens: unset.tokens })
    expect(Budget.policy({ [Budget.environmentKey]: off }, { daily: off })).toBeUndefined()
  }
})

it("refuses a cap that is not a positive whole number, 0, or none", () => {
  for (const value of ["-1", "1.5", "1e3", "ten", " ", "9007199254740993"]) {
    expect(Budget.policy({ [Budget.environmentKey]: value })).toEqual({
      error: `${Budget.environmentKey} must be a positive whole number, 0, or none`
    })
    expect(Budget.policy({ [Budget.dailyEnvironmentKey]: value })).toEqual({
      error: `${Budget.dailyEnvironmentKey} must be a positive whole number, 0, or none`
    })
  }
  expect(Budget.policy({}, { tokens: "x" })).toEqual({
    error: "--budget-tokens must be a positive whole number, 0, or none"
  })
  expect(Budget.policy({}, { daily: "x" })).toEqual({
    error: "--budget-daily-tokens must be a positive whole number, 0, or none"
  })
})
