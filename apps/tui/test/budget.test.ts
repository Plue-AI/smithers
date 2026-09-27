import { expect, it } from "bun:test"
import * as Budget from "../src/budget.ts"

it("is unbounded unless a ceiling is set", () => {
  expect(Budget.policy({})).toBeUndefined()
  expect(Budget.policy({ [Budget.environmentKey]: "" })).toBeUndefined()
})

it("maps a ceiling to a failing token policy, the flag winning", () => {
  expect(Budget.policy({ [Budget.environmentKey]: "5000" })).toEqual({ tokens: { max: 5000, onExceeded: "fail" } })
  expect(Budget.policy({ [Budget.environmentKey]: "5000" }, "20")).toEqual({ tokens: { max: 20, onExceeded: "fail" } })
})

it("refuses a ceiling that is not a positive whole number", () => {
  for (const value of ["0", "-1", "1.5", "1e3", "ten", " ", "9007199254740993"]) {
    expect(Budget.policy({ [Budget.environmentKey]: value })).toEqual({
      error: `${Budget.environmentKey} must be a positive whole number`
    })
  }
  expect(Budget.policy({}, "x")).toEqual({ error: "--budget-tokens must be a positive whole number" })
})
