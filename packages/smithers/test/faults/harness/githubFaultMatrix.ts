// C-DUR-03's literal acceptance case identities. Keep the supplemental fault
// cases mandatory in the runner as well as in the production Go harness.
const stages = ["before-send", "potentially-sent", "remote-success"] as const
export const githubCrossings = [
  ...["push", "open", "body", "merge", "close"].flatMap(kind => stages.map(stage => `${kind}/${stage}`)),
  "open-drop/remote-success",
  "body-order/remote-success",
  ...stages.map(stage => `push-foreign/${stage}`),
  "close-reopen/remote-success",
  ...["revoked", "stale-head", "missing-approval", "competing-fence"].flatMap(refusal => stages.map(stage => `merge-${refusal}/${stage}`)),
  ...["person", "other-app", "canonical"].flatMap(identity => [
    `close-${identity}-event/potentially-sent`,
    `close-${identity}-marker/potentially-sent`,
  ]),
]
export const githubPoints = githubCrossings.map(crossing => `github-${crossing.replace("/", "-")}`)

// Committed acceptance oracles, independent of the production implementation.
// Tuple: effective writes across the kill, successful settlement facts.
export const githubRecoveryExpected: Readonly<Record<string, readonly [number, number]>> = {
  "push/before-send": [1, 1], "push/potentially-sent": [1, 1], "push/remote-success": [1, 1],
  "open/before-send": [1, 1], "open/potentially-sent": [1, 1], "open/remote-success": [1, 1],
  "body/before-send": [1, 1], "body/potentially-sent": [1, 1], "body/remote-success": [1, 1],
  "merge/before-send": [1, 1], "merge/potentially-sent": [1, 1], "merge/remote-success": [1, 1],
  "close/before-send": [1, 1], "close/potentially-sent": [1, 1], "close/remote-success": [1, 1],
  "open-drop/remote-success": [1, 1], "body-order/remote-success": [2, 2],
  "push-foreign/before-send": [0, 0], "push-foreign/potentially-sent": [0, 0], "push-foreign/remote-success": [1, 0],
  "close-reopen/remote-success": [1, 1],
  "merge-revoked/before-send": [0, 0], "merge-revoked/potentially-sent": [0, 0], "merge-revoked/remote-success": [1, 1],
  "merge-stale-head/before-send": [0, 0], "merge-stale-head/potentially-sent": [0, 0], "merge-stale-head/remote-success": [1, 1],
  "merge-missing-approval/before-send": [0, 0], "merge-missing-approval/potentially-sent": [0, 0], "merge-missing-approval/remote-success": [1, 1],
  "merge-competing-fence/before-send": [1, 1], "merge-competing-fence/potentially-sent": [1, 1], "merge-competing-fence/remote-success": [1, 1],
  "close-person-event/potentially-sent": [1, 1], "close-other-app-event/potentially-sent": [1, 1], "close-canonical-event/potentially-sent": [0, 1],
  "close-person-marker/potentially-sent": [1, 1], "close-other-app-marker/potentially-sent": [1, 1], "close-canonical-marker/potentially-sent": [1, 1],
}

export function requireGitHubRecoveryObservations(log: string, crossings: readonly string[] = githubCrossings): void {
  const names = crossings.map(crossing => `TestGitHubOutboundKillProductionProposal/${crossing}/crossing`)
  const points = crossings.map(crossing => `github-${crossing.replace("/", "-")}`)
  requireReachedGoFaultMatrix(log, names, [...points, "github-production-propose"])
  const events = log.split("\n").filter(Boolean).map(line => JSON.parse(line) as { Test?: string; Output?: string })
  crossings.forEach((crossing, index) => {
    const expected = githubRecoveryExpected[crossing]
    assert(expected, `missing literal recovery oracle: ${crossing}`)
    const output = events.filter(event => event.Test === names[index]).map(event => event.Output ?? "").join("")
    const observations = [...output.matchAll(/^(?:[ \t]+[^\r\n:]+\.go:\d+: )?CRASH-OBSERVATION (\{[^\r\n]*\})\r?$/gm)]
      .map(match => JSON.parse(match[1]!) as Record<string, unknown>)
    assert.equal(observations.length, 1, `required one final recovery observation: ${crossing}`)
    assert.deepEqual(observations[0], {
      point: points[index], subject: "todo", effectiveWrites: expected[0], settlementFacts: expected[1],
    }, `literal recovery observation mismatch: ${crossing}`)
  })
}
import { strict as assert } from "node:assert"
import { requireReachedGoFaultMatrix } from "./durability.ts"
