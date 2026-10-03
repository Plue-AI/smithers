import type { MonitorCard } from "@smthrs/rpc/MonitorCard"
import { agent, at } from "./_shared.ts"

const attempt: MonitorCard["attempts"][number] = {
  n: 1,
  state: "running",
  graph: [{ id: "check", label: "Check", state: "current", deps: [] }],
  steps: [{
    id: "check",
    label: "Check",
    state: "current",
    started_at: at,
    input: [{ name: "todo", value: 12 }],
    agent: { name: "reviewer", model: "gpt-6.1-sol" }
  }],
  phases: [{
    id: "attempt-1-check",
    step: "check",
    title: "Ran checks · 2 failed",
    took_s: 3,
    tone: "fail",
    cells: [{
      id: "attempt-1-check-run",
      kind: "run",
      label: "Ran pnpm test · 2 failed",
      output: "2 failed",
      tokens: 120,
      took_s: 3,
      actor: agent
    }]
  }]
}
const retry: MonitorCard["attempts"][number] = {
  ...attempt,
  n: 2,
  state: "failed",
  graph: [{ ...attempt.graph[0]!, state: "failed" }],
  steps: [{ ...attempt.steps[0]!, state: "failed", ended_at: at }],
  phases: [{
    ...attempt.phases[0]!,
    id: "attempt-2-check",
    cells: [{ ...attempt.phases[0]!.cells[0]!, id: "attempt-2-check-run" }]
  }]
}
const base: MonitorCard = {
  id: "run-12-1",
  title: "Check T12",
  todo: 12,
  branch: "todo-12",
  flow: "todo",
  version: "v1",
  state: "running",
  attempts: [attempt],
  waits: [],
  tokens: 120,
  time_s: 3,
  cost_usd: 0.02
}
export const fixtures = {
  running: base,
  waiting: { ...base, state: "waiting", waits: [{ id: "answer", label: "Answer", since: at }] },
  held: { ...base, state: "held", held: { since: at } },
  failed: { ...base, state: "failed", attempts: [attempt, retry] },
  done: { ...base, state: "done" },
  interrupted: { ...base, state: "interrupted" },
  summarized: {
    ...base,
    attempts: [{
      ...attempt,
      phases: [{
        ...attempt.phases[0]!,
        summary: "Two checks failed",
        cells: [{ ...attempt.phases[0]!.cells[0]!, explain: "The schema rejected the fixture" }]
      }]
    }]
  },
  io: {
    ...base,
    attempts: [{
      ...attempt,
      steps: [{
        ...attempt.steps[0]!,
        input: [{ name: "request", value: { prompt: "Fix", nested: [null, true] } }],
        output: [{ name: "result", value: { ok: true, metadata: { commit: "r1" } } }]
      }]
    }]
  },
  answer: {
    ...base,
    attempts: [{
      ...attempt,
      phases: [{
        ...attempt.phases[0]!,
        cells: [{
          id: "attempt-1-check-answer",
          kind: "answer",
          label: "Use the existing schema",
          quote: "Reuse Changes.ts"
        }]
      }]
    }]
  },
  empty: { ...base, attempts: [], tokens: 0, time_s: 0, cost_usd: 0 }
} satisfies Record<string, MonitorCard>
