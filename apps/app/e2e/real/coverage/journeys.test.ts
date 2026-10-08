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

for (const spec of ["j1.spec.ts", "keyboard-journeys.spec.ts"] as const) test(`${spec} is exclusive and requires explicit selection`, () => {
  expect(journeySpecs).toContain(spec)
  expect(ignoredJourneys({})).toContain(spec)
  expect(ignoredJourneys({ SMITHERS_JOURNEY: spec })).toEqual(journeySpecs.filter(value => value !== spec))
  expect(ignoredJourneys({ SMITHERS_J1_ACTIVATION: "1" })).toContain(spec)
})

test("install and SSH qualification require explicit reference journey selection", () => {
  for (const spec of ["fresh-repository.spec.ts", "wiki-generated-refresh.spec.ts", "wiki-coedit.spec.ts", "ssh-branch.spec.ts", "file-gone.spec.ts", "file-intelligence.spec.ts"] as const) {
    expect(ignoredJourneys({})).toContain(spec)
    expect(ignoredJourneys({ SMITHERS_JOURNEY: spec })).not.toContain(spec)
    expect(ignoredJourneys({ SMITHERS_JOURNEY: spec })).toHaveLength(journeySpecs.length - 1)
  }
})
