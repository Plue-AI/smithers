import { expect, test } from "bun:test"
import { ignoredJourneys, journeySpecs } from "../journeys"

test("ordinary real-E2E runs leave out every exclusive journey", () => {
  expect(ignoredJourneys({})).toEqual([...journeySpecs])
})

test("a journey target enables exactly its own spec", () => {
  expect(ignoredJourneys({ SMITHERS_JOURNEY: "todo-merge.spec.ts" })).toEqual(journeySpecs.filter((spec) => spec !== "todo-merge.spec.ts"))
  expect(ignoredJourneys({ SMITHERS_J1_ACTIVATION: "1" })).not.toContain("j1-activation.spec.ts")
  expect(ignoredJourneys({ SMITHERS_JOURNEY: "unknown.spec.ts" })).toEqual([...journeySpecs])
})
