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


test("a composed host fault qualifies its kill child separately from setup", () => {
  const parent = "TestTodoHostKillThroughInstall"
  const fault = `${parent}/host-keyless-crossing`
  const transcript = log(
    { Action: "pass", Test: `${parent}/Install through Machine ready` },
    { Action: "output", Test: fault, Output: "CRASH-POINT host-keyless-crossing subject todo\n" },
    { Action: "pass", Test: fault },
    { Action: "pass", Test: parent }
  )
  expect(() => requireReachedGoFault(transcript, fault, ["host-keyless-crossing"])).not.toThrow()
  expect(() => requireReachedGoFault(transcript, parent, ["host-keyless-crossing"])).toThrow("logged no kill marker")
  expect(() => requireReachedGoFault(log(
    { Action: "pass", Test: `${parent}/Install through Machine ready` },
    { Action: "pass", Test: parent }
  ), fault, ["host-keyless-crossing"])).toThrow("did not pass")
})


test("matrix qualification retains every rebase point in both presence contexts", () => {
  const parent = "TestRebaseCrashThroughDispatcher"
  const contexts = ["people-present", "people-absent"]
  const transcript = (absentPoints: readonly string[] | undefined) => log(
    ...contexts.flatMap(context => {
      const points = context === "people-present" ? ["rebase-mid", "rebase-post-apply"] : absentPoints
      return points === undefined ? [] : [
        { Action: "output", Test: `${parent}/${context}`, Output: points.map(point => `CRASH-POINT ${point}\n`).join("") },
        { Action: "pass", Test: `${parent}/${context}` }
      ]
    }),
    { Action: "pass", Test: parent }
  )
  const qualify = (points: readonly string[] | undefined) =>
    requireReachedGoFaultMatrix(transcript(points), [parent], ["rebase-mid", "rebase-post-apply"], contexts)
  expect(() => qualify(["rebase-mid", "rebase-post-apply"])).not.toThrow()
  expect(() => qualify(undefined)).toThrow("people-absent")
  expect(() => qualify(["rebase-mid"])).toThrow("people-absent/rebase-post-apply")
})

test("five candidate-fixture kills cannot qualify the production propose boundary", () => {
  expect(() => requireReachedGoFaultMatrix(githubLog(), githubNames, [...githubPoints, "github-production-propose"]))
    .toThrow("github-production-propose")
})


test("production GitHub evidence requires each send boundary and late Drop", () => {
  const kinds = ["push", "open", "body", "merge", "close"]
  const stages = ["before-send", "potentially-sent", "remote-success"]
  const points = [...kinds.flatMap(kind => stages.map(stage => `github-${kind}-${stage}`)), "github-open-drop-remote-success"]
  const names = points.map(point => `TestProduction/${point}/crossing`)
  const transcript = (missing?: string) => log(...points.flatMap((point, i) => [
    { Action: "output", Test: names[i]!, Output: `CRASH-POINT ${point === missing ? "other" : point} subject todo\nCRASH-POINT github-production-propose subject todo\n` },
    { Action: "pass", Test: names[i]! }
  ]))
  expect(() => requireReachedGoFaultMatrix(transcript(), names, [...points, "github-production-propose"])).not.toThrow()
  for (const point of points) {
    expect(() => requireReachedGoFaultMatrix(transcript(point), names, points)).toThrow(point)
  }
})

test("packaged Stop and Resume each require their own reached crossing", () => {
  const parent = "TestTodoStartPauseResumeCrashThroughRoutes"
  const names = ["stop", "resume"].map(point => `${parent}/${point}`)
  const transcript = (resumeReached = true, setup = "pass") => log(
    { Action: setup, Test: `${parent}/Install_through_Machine_ready` },
    { Action: "output", Test: names[0]!, Output: "CRASH-POINT stop\n" },
    { Action: "pass", Test: names[0]! },
    ...(resumeReached ? [{ Action: "output", Test: names[1]!, Output: "CRASH-POINT resume\n" }] : []),
    { Action: "pass", Test: names[1]! },
    { Action: "pass", Test: parent }
  )
  expect(() => requireReachedGoFaultMatrix(transcript(), names, ["stop", "resume"])).not.toThrow()
  expect(() => requireReachedGoFaultMatrix(transcript(false), names, ["stop", "resume"]))
    .toThrow("logged no kill marker")
  for (const state of ["skip", "fail"]) {
    expect(() => requireReachedGoFaultMatrix(transcript(true, state), names, ["stop", "resume"]))
      .toThrow("skipped or failed")
  }
})


test("accepts a fault marker bound to its Go subtest log", () => {
  const name = "TestHost/fault"
  const transcript = [
    { Action: "output", Test: name, Output: "    host_test.go:80: CRASH-POINT host-keyless-crossing subject todo\n" },
    { Action: "pass", Test: name },
  ].map(event => JSON.stringify(event)).join("\n")
  expect(() => requireReachedGoFault(transcript, name, ["host-keyless-crossing"])).not.toThrow()
  expect(() => requireReachedGoFault(transcript.replace(name, "TestHost"), name)).toThrow("logged no kill marker")
})
