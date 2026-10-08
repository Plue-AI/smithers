import { strict as assert } from "node:assert"
import { requireReachedGoFault } from "./durability.ts"

export const hostTodoPoints = ["K1", "K2", "K3", "K4", "K5"] as const
export const machineTodoPoints = ["M1", "M2", "M3", "M4"] as const

// Literal check oracles, never derived from the flow or the spec at runtime.
export const todoRecoveryExpected: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  K1: { completedRouteCalls: 1, newAttempts: 0 },
  K2: { completedRouteCalls: 1, newAttempts: 0 },
  K3: { completedRouteCalls: 1, newAttempts: 0, checkCalls: 2, acceptedCheckResults: 1 },
  K4: { completedRouteCalls: 1, newAttempts: 0, waitPreserved: true },
  K5: { completedRouteCalls: 1, newAttempts: 0 },
  M1: { completedRouteCalls: 1, newAttempts: 0 },
  M2: { completedRouteCalls: 1, newAttempts: 0, checkCalls: 2, acceptedCheckResults: 1 },
  M3: { completedStepCalls: 1, effectiveWrites: 1, lookups: 2, newAttempts: 0 },
  M4: { stepsReRun: 0, automaticKeylessRepeats: 0, retryAttempts: 1, hostCanaryAbsent: true },
}

export function requireTodoRecoveryObservations(log: string, kind: "host" | "machine"): void {
  const points = kind === "host" ? hostTodoPoints : machineTodoPoints
  const parent = kind === "host" ? "TestTodoHostRecordedKillThroughInstall" : "TestTodoMachineKillThroughInstall"
  const events = log.split("\n").filter(Boolean).map(line => JSON.parse(line) as { Test?: string; Output?: string })
  for (const point of points) {
    const name = `${parent}/${point}/crossing`
    requireReachedGoFault(log, name, [point])
    const output = events.filter(event => event.Test === name).map(event => event.Output ?? "").join("")
    const observations = [...output.matchAll(/^(?:[ \t]+[^\r\n:]+\.go:\d+: )?CRASH-OBSERVATION (\{[^\r\n]*\})\r?$/gm)]
      .map(match => JSON.parse(match[1]!) as Record<string, unknown>)
    assert.equal(observations.length, 1, `required one final TODO recovery observation: ${point}`)
    const observation = observations[0]!
    const { terminal, modelRequestCalls, ...facts } = observation
    assert.deepEqual(facts, { point, subject: "todo", ...todoRecoveryExpected[point] },
      `literal TODO recovery observation mismatch: ${point}`)
    if (["K2", "K5", "M1"].includes(point)) {
      assert([1, 2].includes(modelRequestCalls as number), `in-flight model request repeated more than once: ${point}`)
    } else assert.equal(modelRequestCalls, undefined)
    if (point === "M3" || point === "M4") assert.equal(terminal, undefined)
    else if (kind === "machine") assert.equal(terminal, "in_review", `machine must resume: ${point}`)
    else assert(["in_review", "failed"].includes(terminal as string), `missing terminal TODO state: ${point}`)
  }
}
