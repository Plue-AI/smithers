import * as FailureCopy from "@smthrs/model/FailureCopy"
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

it("knows a run cap stop from the failure copy, and offers the cap or twice it", () => {
  const exceeded = (scope: string) => ({ _tag: "flows/agent/BudgetExceeded", scope, used: 10, max: 10 })
  expect(Budget.capped(FailureCopy.describe(exceeded("tokens")))).toBe(true)
  // The day's cap is shared by every run; the form never raises it.
  expect(Budget.capped(FailureCopy.describe(exceeded("daily")))).toBe(false)
  expect(Budget.capped(FailureCopy.describe(exceeded("latency")))).toBe(false)
  expect(Budget.capped(FailureCopy.describe(new Error("boom")))).toBe(false)
  expect(Budget.capped(undefined)).toBe(false)
  expect(Budget.offers.map((times) => Budget.offer(200_000_000 * times))).toEqual(["200M", "400M"])
})
