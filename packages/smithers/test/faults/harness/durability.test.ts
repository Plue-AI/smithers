import { expect, test } from "vitest"
import { requireReachedGoFault, requireReachedGoFaultMatrix } from "./durability.ts"

const machine = "TestMachineKillRetainsDiskAndRecoveryIsolation"
const log = (...events: ReadonlyArray<Record<string, string>>) => events.map(event => JSON.stringify(event)).join("\n")

const githubPoints = ["github-push", "github-open", "github-body", "github-merge", "github-close"] as const
const githubNames = ["TestPushKill", "TestOpenKill", "TestBodyKill", "TestMergeKill", "TestCloseKill"]
const githubLog = () => log(...githubNames.flatMap((name, i) => [
  { Action: "output", Test: name, Output: `CRASH-POINT ${githubPoints[i]}\n` },
  { Action: "pass", Test: name }
]))

test("GitHub qualification requires all five operations across selected tests", () => {
  expect(() => requireReachedGoFaultMatrix(githubLog(), githubNames, githubPoints)).not.toThrow()
  expect(() => requireReachedGoFaultMatrix(githubLog(), githubNames.slice(0, 4), githubPoints))
    .toThrow("github-close")
})

test("an unrelated operation cannot supply a matrix crossing", () => {
  expect(() => requireReachedGoFaultMatrix(githubLog(), [githubNames[0]!], githubPoints))
    .toThrow("github-open")
})

test("a matrix cannot qualify an empty selection or a selected test without a kill", () => {
  expect(() => requireReachedGoFaultMatrix(githubLog(), [], githubPoints)).toThrow("no acceptance tests")
  expect(() => requireReachedGoFaultMatrix(githubLog() + "\n" + log({ Action: "pass", Test: "TestUnreached" }),
    [...githubNames, "TestUnreached"], githubPoints)).toThrow("logged no kill marker")
})

test("transport-only machine evidence cannot qualify TODO recovery", () => {
  const transcript = log(
    { Action: "run", Test: machine },
    { Action: "output", Test: machine, Output: "CRASH-POINT machine-mid-command subject retained-workspace\n" },
    { Action: "pass", Test: machine }
  )
  expect(() => requireReachedGoFault(transcript, machine, ["machine-mid-command", "machine-mid-todo"]))
    .toThrow("machine-mid-todo")
})

test("a successful Go package with no matching acceptance test is refused", () => {
  expect(() => requireReachedGoFault(log({ Action: "pass", Package: "flowhost" }), machine))
    .toThrow("required fault test did not pass")
})

test("a skipped child cannot qualify a passing matrix parent", () => {
  expect(() => requireReachedGoFault(log(
    { Action: "output", Test: machine, Output: "CRASH-POINT machine-mid-command\n" },
    { Action: "skip", Test: `${machine}/todo` },
    { Action: "pass", Test: machine }
  ), machine)).toThrow("skipped or failed")
})

test("one killed sibling cannot qualify another leaf that never reached its boundary", () => {
  expect(() => requireReachedGoFault(log(
    { Action: "output", Test: `${machine}/command`, Output: "CRASH-POINT machine-mid-command\n" },
    { Action: "pass", Test: `${machine}/command` },
    { Action: "pass", Test: `${machine}/todo` },
    { Action: "pass", Test: machine }
  ), machine)).toThrow(`logged no kill marker: ${machine}/todo`)
})

test("both executed reference boundaries are required for the machine receipt", () => {
  expect(() => requireReachedGoFault(log(
    { Action: "output", Test: `${machine}/command`, Output: "CRASH-POINT machine-mid-command\n" },
    { Action: "pass", Test: `${machine}/command` },
    { Action: "output", Test: `${machine}/todo`, Output: "CRASH-POINT machine-mid-todo subject todo\n" },
    { Action: "pass", Test: `${machine}/todo` },
    { Action: "pass", Test: machine }
  ), machine, ["machine-mid-command", "machine-mid-todo"])).not.toThrow()
})
