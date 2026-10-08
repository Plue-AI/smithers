import { expect, test } from "vitest"
import { requireReachedGoFaultMatrix } from "./durability.ts"
import { githubCrossings, githubPoints } from "./githubFaultMatrix.ts"

const names = githubCrossings.map(crossing => `TestGitHubOutboundKillProductionProposal/${crossing}/crossing`)
function transcript(omitted?: number): string {
  return names.flatMap((name, index) => index === omitted ? [] : [
    { Action: "output", Test: name, Output: `    github_outbound_kill_test.go:477: CRASH-POINT ${githubPoints[index]} subject todo\n    github_outbound_kill_test.go:478: CRASH-POINT github-production-propose subject todo\n` },
    { Action: "pass", Test: name },
  ]).map(event => JSON.stringify(event)).join("\n")
}
test("requires all 39 C-DUR-03 crossings with their own markers", () => {
  expect(new Set(githubCrossings).size).toBe(39)
  expect(() => requireReachedGoFaultMatrix(transcript(), names, [...githubPoints, "github-production-propose"])).not.toThrow()
})
test.each(githubCrossings.map((crossing, index) => [crossing, index] as const))("refuses a missing production crossing: %s", (_crossing, index) => {
  expect(() => requireReachedGoFaultMatrix(transcript(index), names, githubPoints)).toThrow(`required fault test did not pass: ${names[index]}`)
})
