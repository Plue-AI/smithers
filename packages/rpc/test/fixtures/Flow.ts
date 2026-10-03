import type { FlowCard } from "../../src/FlowCard.ts"

const steps: FlowCard["versions"][number]["steps"] = [
  { id: "plan", label: "Plan", detail: "Read acceptance", agent: { name: "planner", model: "gpt-6.1-sol" } },
  { id: "implement", label: "Implement", agent: { name: "implementer", model: "gpt-6.1-sol" } },
  { id: "check", label: "Check", agent: { name: "reviewer", model: "gpt-6-astra" } },
  { id: "merge", wait: true, signals: [{ on: "rebase", to: "check" }, { on: "steer", to: "implement" }] }
]
const base: FlowCard = { name: "todo", source: { builtin: true }, versions: [{ id: "v1", state: "active", steps }] }
export const fixtures = {
  active: base,
  system: { ...base, name: "merge", system: true },
  proposed: {
    ...base,
    source: { path: "flows/todo/flow.ts" },
    versions: [{
      id: "v2",
      state: "proposed",
      todo: 12,
      pr: { number: 3474, url: "https://github.com/smithersai/smithers/pull/3474" },
      steps
    }]
  },
  merged_syncing: { ...base, versions: [{ id: "v2", state: "merged_syncing", todo: 12, steps }] },
  merged_failed: {
    ...base,
    versions: [{ id: "v2", state: "merged_failed", todo: 12, error: "Flow validation failed", steps }]
  },
  previous: {
    ...base,
    versions: [{ id: "v0", state: "previous", steps: [{ id: "run", label: "Run" }] }, ...base.versions]
  },
  empty: { ...base, versions: [] }
} satisfies Record<string, FlowCard>
