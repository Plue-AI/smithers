import type { Action } from "../../src/CardAction.ts"
import type { FlowCard } from "../../src/FlowCard.ts"
import { type Story, story } from "./_story.ts"

const steps: FlowCard["versions"][number]["steps"] = [
  { id: "plan", label: "Plan", detail: "Read acceptance", agent: "planner" },
  { id: "implement", label: "Implement", agent: "implementer" },
  { id: "check", label: "Check", agent: "reviewer" },
  { id: "merge", wait: true, signals: [{ on: "rebase", to: "check" }, { on: "steer", to: "implement" }] }
]
const base: FlowCard = { name: "todo", source: { builtin: true }, versions: [{ id: "v3", state: "active", steps }] }
const buttons = (name: string): Action[] => [
  { tag: "flow.source", label: "Source", args: { name } },
  { tag: "flow.plan", label: "Plan", args: { name } },
  { tag: "flow.run", label: "Run", args: { name }, primary: true },
  { tag: "flow.edit", label: "Edit", args: { name } }
]
export const fixtures = {
  active: story("Built-in TODO flow", base, { actions: buttons("todo"), expect: ["Implement", "planner", "Source"] }),
  repository: story(
    "A repository flow without a merge wait",
    {
      name: "checks",
      source: { path: "flows/checks/flow.ts" },
      versions: [{ id: "v1", state: "active", steps: [{ id: "run", label: "Run checks" }] }]
    },
    { actions: buttons("checks"), expect: ["flows/checks/flow.ts", "Run checks"] }
  ),
  proposed: story(
    "An edit proposed by T12",
    {
      ...base,
      versions: [...base.versions, {
        id: "v4",
        state: "proposed",
        todo: 12,
        // added: relative to Active (C-J5-01).
        steps: [
          ...steps.slice(0, 3),
          { id: "docs", label: "Update docs", agent: "implementer", added: true },
          steps[3]!
        ]
      }]
    },
    { actions: buttons("todo"), expect: ["Implement", "Update docs"] }
  ),
  merged_syncing: story(
    "Merged, syncing",
    { ...base, versions: [{ id: "v4", state: "merged-syncing", todo: 12, steps }, base.versions[0]!] },
    { actions: buttons("todo"), expect: ["Implement"] }
  ),
  merged_failed: story(
    "Merged, failed to load",
    {
      ...base,
      versions: [
        { id: "v4", state: "merged-failed", todo: 12, error: "Flow validation failed", steps },
        base.versions[0]!
      ]
    },
    { actions: buttons("todo"), expect: ["Flow validation failed"] }
  ),
  previous: story(
    "With a previous version",
    { ...base, versions: [...base.versions, { id: "v2", state: "previous", steps: [{ id: "run", label: "Run" }] }] },
    { actions: buttons("todo"), expect: ["Implement"] }
  ),
  empty: story("No versions yet", { ...base, name: "release", versions: [] }, { expect: ["release"] })
} satisfies Record<string, Story<FlowCard>>
