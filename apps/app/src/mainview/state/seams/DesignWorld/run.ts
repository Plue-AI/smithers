/*
 * MOCK SEAM, run and flow lane (delete with ./index.ts). The Run card
 * (T-FLW-07) and the Flow card (T-APP-05) read the seeded traces and flow
 * versions here, mapped to their rpc models. Replaced by topic `run:<id>`
 * (/api/runs/<id>) and topic `flows` (/api/flows) once those land.
 */
import type { FlowCard } from "@smthrs/rpc/FlowCard"
import type { MonitorCard } from "@smthrs/rpc/MonitorCard"
import type { PhaseTone } from "@smthrs/rpc/CardPrimitives"
import { designActor } from "./shell"
import {
  todoOf, traceOf, type DesignFlowStep, type DesignPhase, type DesignTrace, type DesignWorldRows
} from "./index"

type Attempt = MonitorCard["attempts"][number]
type Phase = Attempt["phases"][number]
type Node = Attempt["graph"][number]["state"]

/** "41 s", "3 min" as seconds. */
const seconds = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined
  const value = Number.parseFloat(text)
  if (!Number.isFinite(value)) return undefined
  return text.includes("min") ? value * 60 : value
}
/** "3.4k" as a count. */
const tokenCount = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined
  const value = Number.parseFloat(text)
  return Number.isFinite(value) ? Math.round(value * (text.endsWith("k") ? 1000 : 1)) : undefined
}

const refNumber = (ref: string | undefined): number | undefined => {
  const n = Number((ref ?? "").replace(/^T/i, ""))
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** A flow's card title in product words. */
export const flowTitle = (name: string): string => name === "todo" ? "TODO flow" : name === "merge" ? "Merge flow" : `${name} flow`

/** A run keeps the flow version it started with: its TODO's pinned steps, else the active flow. */
const flowOf = (world: DesignWorldRows, trace: DesignTrace): ReadonlyArray<DesignFlowStep> =>
  (trace.todo === undefined ? undefined : todoOf(world, trace.todo)?.steps) ?? world.repo.flow

const nodeOf = (trace: DesignTrace, step: string): Node => {
  if (!trace.phases.some(phase => phase.step === step)) return "next"
  if (trace.phases.at(-1)?.step !== step) return "done"
  return trace.state === "running" ? "current" : trace.state === "waiting" ? "waiting" : trace.state === "failed" ? "failed" : "done"
}

const runState = (trace: DesignTrace): MonitorCard["state"] =>
  trace.state === "merged" ? "done"
    : trace.state === "failed" && trace.phases.at(-1)?.indicator === "Interrupted" ? "interrupted"
    : trace.state

/** Each phase's step instance key (ui-components.md T-UI-12): "verify#2" when a rebase brings the run back to Verify. */
const instanceKeys = (phases: ReadonlyArray<DesignPhase>): ReadonlyArray<string> => {
  const seen = new Map<string, number>()
  let previous: string | undefined
  return phases.map(phase => {
    if (phase.step !== previous) seen.set(phase.step, (seen.get(phase.step) ?? 0) + 1)
    previous = phase.step
    return `${phase.step}#${seen.get(phase.step)}`
  })
}

const phaseOf = (world: DesignWorldRows, phase: DesignPhase, key: string): Phase => ({
  id: phase.id, step: key, title: phase.title,
  ...(phase.summary === "" ? {} : { summary: phase.summary }),
  took_s: phase.took ?? 0,
  tone: phase.tone ?? "ok",
  ...(phase.indicator === undefined ? {} : { indicator: phase.indicator }),
  cells: phase.cells.map(cell => {
    const took = seconds(cell.took)
    const tokens = tokenCount(cell.tokens)
    return {
      id: cell.id, kind: cell.kind, label: cell.explain, explain: cell.explain,
      ...(cell.code === undefined ? {} : { code: cell.code }),
      ...(cell.output === undefined ? {} : { output: cell.output.join("\n") }),
      ...(cell.quote === undefined ? {} : { quote: cell.quote }),
      ...(cell.tone === undefined ? {} : { tone: cell.tone as PhaseTone }),
      ...(took === undefined ? {} : { took_s: took }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(cell.who === undefined ? {} : { actor: designActor(world, cell.who) })
    }
  })
})

const attemptOf = (world: DesignWorldRows, trace: DesignTrace): Attempt => {
  const flow = flowOf(world, trace)
  const wait: Node = trace.state === "held" ? "held" : trace.state === "merged" ? "done" : "next"
  const graph = [
    ...flow.map((step, index) => ({ id: step.id, label: step.title, state: nodeOf(trace, step.id), deps: index === 0 ? [] : [flow[index - 1]!.id] })),
    { id: "merge", label: "Merge", state: wait, deps: flow.length === 0 ? [] : [flow.at(-1)!.id] }
  ]
  const keys = instanceKeys(trace.phases)
  const steps = [...new Set(keys)].map(key => {
    const id = key.replace(/#\d+$/, "")
    const phases = trace.phases.filter((_, index) => keys[index] === key)
    const tokens = phases.flatMap(phase => phase.cells).reduce((sum, cell) => sum + (tokenCount(cell.tokens) ?? 0), 0)
    return {
      key, id, k: Number(key.slice(id.length + 1)), label: flow.find(step => step.id === id)?.title ?? id,
      state: keys.at(-1) === key ? nodeOf(trace, id) : "done",
      took_s: phases.reduce((sum, phase) => sum + (phase.took ?? 0), 0),
      ...(tokens === 0 ? {} : { usage: { tokens, cost_usd: 0 } })
    }
  })
  return { n: trace.attempt, run_id: trace.id, state: runState(trace), graph, steps, phases: trace.phases.map((phase, index) => phaseOf(world, phase, keys[index]!)) }
}

/** Every attempt of the run's TODO (or the run alone), oldest first. */
export const attemptsOf = (world: DesignWorldRows, trace: DesignTrace): ReadonlyArray<DesignTrace> =>
  trace.todo === undefined ? [trace] : world.traces.filter(each => each.todo === trace.todo).sort((left, right) => left.attempt - right.attempt)

/** A run id, a TODO id, a TODO ref ("T9") or its number ("9"): the trace it names, latest attempt for a TODO. */
export const traceNamed = (world: DesignWorldRows, name: string): DesignTrace | undefined => {
  const exact = world.traces.find(each => each.id === name)
  if (exact !== undefined) return exact
  const todo = world.todos.find(each => each.id === name || each.ref.toLowerCase() === name.toLowerCase() || each.ref === `T${name}`)
  return todo === undefined ? undefined : traceOf(world, todo.id)
}

/** The Run card's model (rpc MonitorCard) for one trace, with its TODO's earlier attempts. */
export const monitorOf = (world: DesignWorldRows, traceId: string): MonitorCard | undefined => {
  const trace = world.traces.find(each => each.id === traceId)
  if (trace === undefined) return undefined
  const todo = trace.todo === undefined ? undefined : todoOf(world, trace.todo)
  const all = attemptsOf(world, trace).filter(each => each.attempt <= trace.attempt)
  const cells = trace.phases.flatMap(phase => phase.cells)
  const n = refNumber(todo?.ref)
  const branch = world.branches.find(each => each.id === trace.branch)
  const waitPhase = trace.phases.find(phase => phase.tone === "wait")
  return {
    id: trace.id, flow: "todo", version: todo?.flowVersion ?? "v1", title: trace.title,
    ...(n === undefined ? {} : { todo: n }),
    ...(branch === undefined ? {} : { branch: branch.name }),
    state: runState(trace),
    ...(trace.held === undefined ? {} : { held: trace.held }),
    attempts: all.map(each => attemptOf(world, each)),
    /* The open question is the wait; the phase indicator says since when. */
    waits: waitPhase === undefined || trace.state !== "waiting" ? [] : [{
      id: waitPhase.id, kind: "question", label: todo?.question?.text ?? waitPhase.indicator ?? "Waiting for a person",
      since: /since (\S+)/.exec(waitPhase.indicator ?? "")?.[1] ?? ""
    }],
    tokens: cells.reduce((sum, cell) => sum + (tokenCount(cell.tokens) ?? 0), 0),
    time_s: trace.phases.reduce((sum, phase) => sum + (phase.took ?? 0), 0),
    cost_usd: 0,
    engine: []
  }
}

/** Active runs for /runs: each TODO's latest attempt that is still going, newest first. */
export const activeTraces = (world: DesignWorldRows): ReadonlyArray<DesignTrace> =>
  world.todos.flatMap(todo => traceOf(world, todo.id) ?? []).filter(trace => trace.state === "running" || trace.state === "waiting" || trace.state === "held")

/** The Flow card's model (rpc FlowCard) from the seeded versions of one flow. */
export const flowCardOf = (world: DesignWorldRows, name: string): FlowCard | undefined => {
  const versions = world.flowVersions.filter(each => each.flow === name && each.state !== "previous")
  if (versions.length === 0) return undefined
  const system = versions.some(each => each.system === true)
  return {
    name,
    source: system ? { builtin: true } : { path: `flows/${name}/flow.ts` },
    system,
    versions: versions.map(version => {
      const todo = version.todo === undefined ? undefined : refNumber(todoOf(world, version.todo)?.ref)
      return {
        id: version.id, state: version.state,
        ...(todo === undefined ? {} : { todo }),
        ...(version.error === undefined ? {} : { error: version.error }),
        steps: [
          ...version.steps.filter(step => step.id !== "merge").map(step => {
            const agent = world.agents.find(each => each.steps.includes(step.id))
            return { id: step.id, label: step.title, ...(step.detail === undefined ? {} : { detail: step.detail }),
              ...(agent === undefined || system ? {} : { agent: agent.model }) }
          }),
          ...(system ? [] : [{ id: "merge" as const, wait: true as const, signals: [{ on: "rebase" as const, to: "Verify" }, { on: "steer" as const, to: "Implement" }] }])
        ]
      }
    })
  }
}

/** Flow names the seed knows, for /flows. */
export const flowNames = (world: DesignWorldRows): ReadonlyArray<string> => [...new Set(world.flowVersions.map(each => each.flow))]
