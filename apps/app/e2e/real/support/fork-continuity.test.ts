import { expect, test } from "bun:test"
import { counterIdentity, maximumTickGap, observedTickInterval } from "./fork-continuity"

const stat = (name: string, state = "S", started = "987") => `42 (${name}) ${state} ${Array(18).fill("0").join(" ")} ${started} 0 0\n`

test("source identity preserves start time despite spaces and parentheses in comm", () => {
  expect(counterIdentity(stat("tick loop ) worker"), "42")).toBe("42 (tick loop ) worker) 987")
  expect(counterIdentity(stat("tick", "R", "988"), "42")).not.toBe(counterIdentity(stat("tick"), "42"))
  expect(counterIdentity(stat("tick", "R"), "42")).toBe(counterIdentity(stat("tick"), "42"))
})

test("missing, reused, truncated and dead counters cannot prove continuity", () => {
  for (const value of ["", "42 (tick) S 0", stat("tick", "Z"), stat("tick", "X"), stat("tick", "x"), stat("tick", "S", "invalid")]) {
    expect(() => counterIdentity(value, "42")).toThrow()
  }
  expect(() => counterIdentity(stat("tick"), "43")).toThrow()
})

test("timing retains subsecond and over-one-second gaps and refuses invalid observations", () => {
  expect(maximumTickGap([100, 100.25, 101.25])).toBe(1)
  expect(maximumTickGap([100, 100, 101])).toBe(1)
  expect(maximumTickGap([100, 100.25, 101.251])).toBeGreaterThan(1)
  for (const ticks of [[], [100], [100, NaN], [100, Infinity], [100, 100], [100, 99]]) {
    expect(() => maximumTickGap(ticks)).toThrow()
  }
})

test("source interval retains the observation boundary and rejects rewritten counter history", () => {
  expect(observedTickInterval([100, 100.5], [100, 100.5, 100.5, 101])).toEqual([100.5, 100.5, 101])
  expect(maximumTickGap(observedTickInterval([100, 100.5], [100, 100.5, 102]))).toBe(1.5)
  for (const after of [[100, 100.5], [100.5, 101, 101.5], [100, 100.6, 101], [100, 100.5, NaN], [100, 100.5, 100.5]]) {
    expect(() => observedTickInterval([100, 100.5], after)).toThrow()
  }
})
