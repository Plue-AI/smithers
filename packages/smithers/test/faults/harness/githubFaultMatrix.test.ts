import { expect, test } from "vitest"
import { requireReachedGoFaultMatrix } from "./durability.ts"
import {
  githubCrossings,
  githubPoints,
  githubRecoveryExpected,
  requireGitHubRecoveryObservations
} from "./githubFaultMatrix.ts"

const names = githubCrossings.map((crossing) => `TestGitHubOutboundKillProductionProposal/${crossing}/crossing`)
function transcript(omitted?: number): string {
  return names.flatMap((name, index) =>
    index === omitted ? [] : [
      {
        Action: "output",
        Test: name,
        Output: `    github_outbound_kill_test.go:477: CRASH-POINT ${
          githubPoints[index]
        } subject todo\n    github_outbound_kill_test.go:478: CRASH-POINT github-production-propose subject todo\n`
      },
      { Action: "pass", Test: name }
    ]
  ).map((event) => JSON.stringify(event)).join("\n")
}
test("requires all 39 C-DUR-03 crossings with their own markers", () => {
  expect(new Set(githubCrossings).size).toBe(39)
  expect(() => requireReachedGoFaultMatrix(transcript(), names, [...githubPoints, "github-production-propose"])).not
    .toThrow()
})
test.each(githubCrossings.map((crossing, index) => [crossing, index] as const))(
  "refuses a missing production crossing: %s",
  (_crossing, index) => {
    expect(() => requireReachedGoFaultMatrix(transcript(index), names, githubPoints)).toThrow(
      `required fault test did not pass: ${names[index]}`
    )
  }
)

function recoveryTranscript(): string {
  return transcript() + "\n" + githubCrossings.map((crossing, index) =>
    JSON.stringify({
      Action: "output",
      Test: names[index],
      Output: `    github_outbound_kill_test.go:900: CRASH-OBSERVATION ${
        JSON.stringify({
          point: githubPoints[index],
          subject: "todo",
          effectiveWrites: githubRecoveryExpected[crossing]![0],
          settlementFacts: githubRecoveryExpected[crossing]![1]
        })
      }\n`
    })
  ).join("\n")
}

test("qualifies literal recovery outcomes for the complete matrix", () => {
  expect(Object.keys(githubRecoveryExpected).sort()).toEqual([...githubCrossings].sort())
  expect(() => requireGitHubRecoveryObservations(recoveryTranscript())).not.toThrow()
})

test.each(githubCrossings.map((crossing, index) => [crossing, index] as const))(
  "requires the final outcome on its own crossing: %s",
  (crossing, index) => {
    const events = recoveryTranscript().split("\n").map((line) => JSON.parse(line))
    const observation = events.find((event) =>
      event.Test === names[index] && event.Output?.includes("CRASH-OBSERVATION")
    )
    observation.Test = "TestGitHubOutboundKillProductionProposal"
    expect(() => requireGitHubRecoveryObservations(events.map((event) => JSON.stringify(event)).join("\n")))
      .toThrow(`required one final recovery observation: ${crossing}`)
  }
)

test.each(["effectiveWrites", "settlementFacts", "point", "subject"])("refuses an incorrect literal %s", (field) => {
  const events = recoveryTranscript().split("\n").map((line) => JSON.parse(line))
  const event = events.find((event) => event.Output?.includes("CRASH-OBSERVATION"))
  const outcome = JSON.parse(event.Output.match(/CRASH-OBSERVATION (\{.*\})/)[1])
  outcome[field] = typeof outcome[field] === "number" ? outcome[field] + 1 : "wrong"
  event.Output = `CRASH-OBSERVATION ${JSON.stringify(outcome)}\n`
  expect(() => requireGitHubRecoveryObservations(events.map((event) => JSON.stringify(event)).join("\n")))
    .toThrow("literal recovery observation mismatch: push/before-send")
})

test("refuses duplicate outcomes and an unknown crossing without an oracle", () => {
  const log = recoveryTranscript()
  const observation = log.split("\n").find((line) => line.includes("CRASH-OBSERVATION"))!
  expect(() => requireGitHubRecoveryObservations(log + "\n" + observation)).toThrow(
    "required one final recovery observation"
  )
  const renamed = log.replaceAll("push/before-send", "unknown/before-send").replaceAll(
    "github-push-before-send",
    "github-unknown-before-send"
  )
  expect(() => requireGitHubRecoveryObservations(renamed, ["unknown/before-send"]))
    .toThrow("missing literal recovery oracle: unknown/before-send")
})
