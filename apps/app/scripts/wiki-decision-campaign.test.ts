import { test, expect } from "bun:test"
import { validateInstalls, requirePassingReport, type WikiDecisionInstall } from "./wiki-decision-campaign"
const installs = (): WikiDecisionInstall[] => [1, 2, 3].map(n => ({ stateDirectory: `/install/${n}`, environment: {
  SMITHERS_REAL_BASE_URL: `http://reference:${48000 + n}`, SMITHERS_REAL_E2E_BUILD_SHA: "a".repeat(40), SMITHERS_JOURNEY_REPOSITORY: `smithers-mvp-canary/run-${n}`,
  SMITHERS_JOURNEY_DATABASE_URL: `postgres://reference/run${n}`, SMITHERS_JOURNEY_SMTHRS: "/bundle/smthrs", SMITHERS_JOURNEY_WILL_SESSION: "/will.json", SMITHERS_JOURNEY_BEN_SESSION: "/ben.json", SMITHERS_JOURNEY_ALICE_SESSION: "/alice.json"
} }))
test("three independent prepared installs at one commit", () => expect(() => validateInstalls(installs())).not.toThrow())
test("refuses incomplete campaigns and mixed revisions", () => {
  expect(() => validateInstalls(installs().slice(0, 2))).toThrow()
  for (const key of Object.keys(installs()[0].environment)) {
    const input = installs(); delete input[0].environment[key]
    expect(() => validateInstalls(input)).toThrow()
  }
  const input = installs(); input[1].environment.SMITHERS_REAL_E2E_BUILD_SHA = "b".repeat(40)
  expect(() => validateInstalls(input)).toThrow()
})
test("refuses reused state, repositories and databases", () => {
  for (const key of ["stateDirectory", "SMITHERS_JOURNEY_REPOSITORY", "SMITHERS_JOURNEY_DATABASE_URL"]) {
    const input = installs()
    if (key === "stateDirectory") input[1].stateDirectory = input[0].stateDirectory + "/../1"
    else input[1].environment[key] = input[0].environment[key]
    expect(() => validateInstalls(input)).toThrow()
  }
})
test("skips, failures, flaky retries and empty reports never qualify", () => {
  expect(() => requirePassingReport({ stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 } })).not.toThrow()
  for (const stats of [{ expected: 0 }, { expected: 2 }, { unexpected: 1 }, { skipped: 1 }, { flaky: 1 }]) {
    expect(() => requirePassingReport({ stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0, ...stats } })).toThrow()
  }
  expect(() => requirePassingReport({})).toThrow()
})
