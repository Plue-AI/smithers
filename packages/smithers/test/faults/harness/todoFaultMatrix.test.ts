import { expect, test } from "vitest"
import {
  hostTodoPoints,
  machineTodoPoints,
  requireTodoRecoveryObservations,
  todoRecoveryExpected
} from "./todoFaultMatrix.ts"

const transcript = (kind: "host" | "machine") => {
  const points = kind === "host" ? hostTodoPoints : machineTodoPoints
  const parent = kind === "host" ? "TestTodoHostRecordedKillThroughInstall" : "TestTodoMachineKillThroughInstall"
  return points.flatMap((point) => {
    const Test = `${parent}/${point}/crossing`
    const outcome = {
      point,
      subject: "todo",
      ...todoRecoveryExpected[point],
      ...(["K2", "K5", "M1"].includes(point) ? { modelRequestCalls: 2 } : {}),
      ...(["M3", "M4"].includes(point) ? {} : { terminal: "in_review" })
    }
    return [
      { Action: "output", Test, Output: `CRASH-POINT ${point} subject todo\n` },
      { Action: "output", Test, Output: `    todo_fault_test.go:42: CRASH-OBSERVATION ${JSON.stringify(outcome)}\n` },
      { Action: "pass", Test }
    ]
  }).map((event) => JSON.stringify(event)).join("\n")
}

for (const kind of ["host", "machine"] as const) {
  test(`${kind}: require every production crossing and its literal observation`, () => {
    expect(() => requireTodoRecoveryObservations(transcript(kind), kind)).not.toThrow()
  })
  test(`${kind}: a sibling or parent cannot supply a missing observation`, () => {
    const events = transcript(kind).split("\n").map((line) => JSON.parse(line))
    events[1].Test = events[1].Test.replace("/crossing", "")
    expect(() => requireTodoRecoveryObservations(events.map((event) => JSON.stringify(event)).join("\n"), kind))
      .toThrow("required one final TODO recovery observation")
  })
  test(`${kind}: compiled, skipped, failed and incomplete campaigns refuse qualification`, () => {
    expect(() => requireTodoRecoveryObservations("", kind)).toThrow("did not pass")
    for (const action of ["skip", "fail"]) {
      const log = transcript(kind).replace("\"Action\":\"pass\"", `"Action":"${action}"`)
      expect(() => requireTodoRecoveryObservations(log, kind)).toThrow()
    }
    expect(() => requireTodoRecoveryObservations(transcript(kind).split("\n").slice(0, -3).join("\n"), kind))
      .toThrow("did not pass")
  })
}

test("reject duplicate observations, changed literal counts and absent terminal state", () => {
  const log = transcript("host")
  const observation = log.split("\n")[1]!
  expect(() => requireTodoRecoveryObservations(log + "\n" + observation, "host")).toThrow("required one final")
  expect(() =>
    requireTodoRecoveryObservations(log.replace("completedRouteCalls\\\":1", "completedRouteCalls\\\":2"), "host")
  )
    .toThrow("literal TODO recovery observation mismatch")
  expect(() =>
    requireTodoRecoveryObservations(log.replace("terminal\\\":\\\"in_review", "terminal\\\":\\\"working"), "host")
  )
    .toThrow("missing terminal TODO state")
  expect(() =>
    requireTodoRecoveryObservations(
      transcript("machine").replace("terminal\\\":\\\"in_review", "terminal\\\":\\\"failed"),
      "machine"
    )
  )
    .toThrow("machine must resume")
})

test("model retries are counted by the identical in-flight request", () => {
  for (const kind of ["host", "machine"] as const) {
    expect(() =>
      requireTodoRecoveryObservations(
        transcript(kind).replaceAll("modelRequestCalls\\\":2", "modelRequestCalls\\\":3"),
        kind
      )
    )
      .toThrow("in-flight model request repeated more than once")
  }
})
