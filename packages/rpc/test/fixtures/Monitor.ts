import type { Action } from "../../src/CardAction.ts"
import type { MonitorCard, RunView } from "../../src/MonitorCard.ts"
import { agent, at, person, reviewer } from "./_shared.ts"
import { type Story, story } from "./_story.ts"

type Attempt = MonitorCard["attempts"][number]
const later = "2026-10-02T17:51:00.000Z"
const engine: MonitorCard["engine"] = [{ label: "Durable run", detail: "Journal seq 9 · resumable" }]
const checkCell: Attempt["phases"][number]["cells"][number] = {
  id: "attempt-1-check-run",
  kind: "run",
  label: "Ran pnpm test · 2 failed",
  code: "pnpm test",
  output: "2 failed",
  tone: "fail",
  tokens: 120,
  took_s: 3,
  actor: agent
}
const first: Attempt = {
  n: 1,
  run_id: "run-41",
  state: "running",
  graph: [
    { id: "implement", label: "Implement", state: "done", deps: [] },
    { id: "check", label: "Check", state: "current", deps: ["implement"] }
  ],
  steps: [{
    key: "implement#1",
    id: "implement",
    k: 1,
    label: "Implement",
    state: "done",
    started_at: at,
    ended_at: at,
    took_s: 412,
    input: { prompt: "Publish card projections" },
    output: { files: ["packages/rpc/src/MonitorCard.ts"] },
    agent,
    usage: { tokens: 18_400, cost_usd: 0.42 }
  }, {
    key: "check#1",
    id: "check",
    k: 1,
    label: "Check",
    state: "current",
    started_at: at,
    agent: reviewer
  }],
  phases: [{
    id: "attempt-1-check",
    step: "check#1",
    title: "Ran checks · 2 failed",
    took_s: 3,
    tone: "fail",
    cells: [checkCell]
  }]
}
const failedFirst: Attempt = {
  ...first,
  state: "failed",
  graph: [first.graph[0]!, { ...first.graph[1]!, state: "failed" }],
  steps: [first.steps[0]!, { ...first.steps[1]!, state: "failed", ended_at: later, took_s: 3 }]
}
// The second attempt retries Check inside itself: check#1 fails, the agent fixes, check#2 runs.
const second: Attempt = {
  n: 2,
  run_id: "run-42",
  state: "running",
  graph: [
    { id: "implement", label: "Implement", state: "done", deps: [] },
    { id: "check", label: "Check", state: "current", deps: ["implement"] }
  ],
  steps: [
    { key: "check#1", id: "check", k: 1, label: "Check", state: "failed", started_at: at, ended_at: at, took_s: 2 },
    {
      key: "implement#1",
      id: "implement",
      k: 1,
      label: "Implement",
      state: "done",
      took_s: 95,
      agent,
      usage: { tokens: 6_100, cost_usd: 0.14 }
    },
    { key: "check#2", id: "check", k: 2, label: "Check", state: "current", started_at: later }
  ],
  phases: [{
    id: "attempt-2-check-1",
    step: "check#1",
    title: "Ran checks · 1 failed",
    took_s: 2,
    tone: "fail",
    cells: [{ ...checkCell, id: "attempt-2-check-1-run", label: "Ran pnpm test · 1 failed" }]
  }, {
    id: "attempt-2-check-2",
    step: "check#2",
    title: "Running checks",
    took_s: 1,
    tone: "live",
    cells: [{ id: "attempt-2-check-2-run", kind: "run", label: "Running pnpm test", tone: "live" }]
  }]
}
const base: MonitorCard = {
  id: "run-41",
  flow: "todo",
  version: "v3",
  title: "Card model contracts",
  todo: 12,
  branch: "todo/12",
  state: "running",
  attempts: [first],
  waits: [],
  tokens: 18_520,
  time_s: 415,
  cost_usd: 0.44,
  engine
}
const n = { n: "12" }
const inspect: Action = { tag: "run.inspect", label: "Inspect", args: { id: "run-41" } }
const steer: Action = {
  tag: "todo.steer",
  label: "Steer",
  args: n,
  input: [{ name: "text", label: "Steer", kind: "text", required: true, multiline: true }]
}
const stop: Action = { tag: "todo.stop", label: "Stop", args: n }

export const fixtures = {
  running: story("Running Check", base, {
    actions: [inspect, steer, stop],
    expect: ["Card model contracts", "Ran checks · 2 failed", "Ran pnpm test · 2 failed"]
  }),
  waiting: story(
    "Waiting for an answer",
    {
      ...base,
      state: "waiting",
      waits: [{ id: "wait-question-1", kind: "question", label: "Include S3 fields?", since: later }]
    },
    { actions: [inspect, steer], expect: ["Include S3 fields?"] }
  ),
  two_attempts: story(
    "Two attempts, a retried step and a settled wait",
    {
      ...base,
      state: "waiting",
      attempts: [failedFirst, second],
      waits: [
        {
          id: "wait-question-1",
          kind: "question",
          label: "Include S3 fields?",
          since: at,
          settled: { by: person, at }
        },
        { id: "wait-approval-1", kind: "approval", label: "Run the schema checks?", since: later }
      ],
      tokens: 24_620,
      time_s: 513,
      cost_usd: 0.58
    },
    { actions: [inspect, steer], expect: ["Ran checks · 1 failed", "Running checks", "Run the schema checks?"] }
  ),
  held: story(
    "Held for merge",
    {
      ...base,
      state: "held",
      held: { since: later },
      attempts: [{ ...first, state: "held", graph: [{ ...first.graph[1]!, state: "held" }] }]
    },
    { actions: [inspect], expect: ["Card model contracts"] }
  ),
  failed: story("Failed in Check", { ...base, state: "failed", attempts: [failedFirst] }, {
    actions: [inspect, { tag: "todo.retry", label: "Retry", args: n, primary: true }],
    expect: ["Ran pnpm test · 2 failed", "Retry"]
  }),
  done: story(
    "Done",
    {
      ...base,
      state: "done",
      attempts: [{
        ...first,
        state: "done",
        graph: first.graph.map((node) => ({ ...node, state: "done" as const })),
        steps: first.steps.map((step) => ({ ...step, state: "done" }))
      }]
    },
    { actions: [inspect], expect: ["Card model contracts"] }
  ),
  interrupted: story("Interrupted", { ...base, state: "interrupted", attempts: [{ ...first, state: "interrupted" }] }, {
    actions: [inspect, { tag: "todo.retry", label: "Retry", args: n, primary: true }],
    expect: ["Retry"]
  }),
  summarized: story(
    "Model summaries arrived",
    {
      ...base,
      attempts: [{
        ...first,
        phases: [{
          ...first.phases[0]!,
          summary: "Two checks failed",
          cells: [{ ...checkCell, explain: "The schema rejected the fixture" }]
        }]
      }]
    },
    { actions: [inspect], expect: ["Two checks failed", "The schema rejected the fixture"] }
  ),
  answer: story(
    "An answer quoted in a steer cell",
    {
      ...base,
      attempts: [{
        ...first,
        phases: [{
          ...first.phases[0]!,
          cells: [{
            id: "attempt-1-check-steer",
            kind: "steer",
            label: "Use the existing schema",
            quote: "Reuse Changes.ts",
            actor: person
          }]
        }]
      }]
    },
    { actions: [inspect], expect: ["Use the existing schema", "Reuse Changes.ts"] }
  ),
  selected: story<MonitorCard, RunView>("A cell selected", base, {
    actions: [inspect],
    view: { maximized: true, selected: "attempt-1-check-run" },
    expect: ["pnpm test", "2 failed"]
  }),
  journal: story<MonitorCard, RunView>(
    "Journal tab loaded",
    {
      ...base,
      journal: [
        { seq: 1, at, type: "run_started", text: "Run started" },
        { seq: 2, at, type: "step_started", step: "implement#1", text: "Implement started" },
        { seq: 3, at: later, type: "step_started", step: "check#1", text: "Check started" }
      ]
    },
    { actions: [inspect], view: { maximized: true, tab: "journal" }, expect: ["Implement started", "Check started"] }
  ),
  replay: story<MonitorCard, RunView>(
    "Scrubbing back to seq 3",
    {
      ...base,
      replay: { at: 3, last: 9 },
      journal: [{ seq: 3, at: later, type: "step_started", step: "check#1", text: "Check started" }]
    },
    { actions: [inspect], view: { maximized: true, tab: "journal", at: 3 }, expect: ["Check started"] }
  ),
  background: story(
    "A background run waiting on a job and a timer",
    {
      ...base,
      id: "run-77",
      flow: "wiki-refresh",
      version: "v1",
      title: "Refresh wiki",
      todo: undefined,
      branch: undefined,
      state: "waiting",
      attempts: [{ ...first, run_id: "run-77", phases: [] }],
      waits: [
        { id: "wait-job-1", kind: "external_job", label: "Waiting for the docs build", since: at },
        { id: "wait-sleep-1", kind: "sleep", label: "Sleeping until 18:00", since: at },
        { id: "wait-signal-1", kind: "signal", label: "Waiting for main to move", since: at },
        { id: "wait-pause-1", kind: "pause", label: "Paused by Ben", since: at, settled: { by: person, at: later } }
      ]
    },
    { expect: ["Refresh wiki", "Waiting for the docs build", "Sleeping until 18:00"] }
  ),
  queued: story(
    "Not started",
    { ...base, attempts: [], tokens: 0, time_s: 0, cost_usd: 0, engine: [] },
    { expect: ["Card model contracts"] }
  )
} satisfies Record<string, Story<MonitorCard, RunView>>
