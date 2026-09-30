import { expect, it } from "bun:test"
import * as Catalog from "../src/catalog.ts"
import type * as Flows from "../src/flows.ts"

const listed = (name: string, kind: "module" | "markdown" = "module"): Flows.Listed => ({
  name,
  description: `${name} does it`,
  modelInvocable: true,
  kind,
  flows: [],
  capabilities: [],
  path: `flows/${name}/flow.${kind === "module" ? "ts" : "mdx"}`
})
const run = (flow: string, status: Flows.Run["status"], startedAt: number, endedAt?: number): Flows.Run => ({
  id: `${flow}-${startedAt}`,
  flow,
  by: "user",
  input: {},
  requested: "{}",
  status,
  startedAt,
  ...(endedAt === undefined ? {} : { endedAt })
})
const base = {
  flows: [listed("sum"), listed("review", "markdown"), listed("late")],
  fields: (name: string) => (name === "sum" ? ["a", "b", "unit"] : name === "late" ? ["x"] : undefined),
  unloaded: (name: string) => name === "late",
  keys: (name: string) => (name === "review" ? ["alt+r"] : name === "sum" ? ["alt+s"] : []),
  runs: [],
  tabs: [],
  recorded: []
}

it("hints a flow's inputs then its keys, an agent's keys, and a late flow's restart", () => {
  expect(Catalog.entries(base).map(({ name, hint, keys, unloaded }) => ({ name, hint, keys, unloaded }))).toEqual([
    { name: "sum", hint: "a, b, unit  alt+s", keys: ["alt+s"], unloaded: false },
    { name: "review", hint: "alt+r", keys: ["alt+r"], unloaded: false },
    { name: "late", hint: "Restart to load", keys: [], unloaded: true }
  ])
  // Before the host loads a module, its inputs are unknown and the hint says nothing about them.
  expect(Catalog.entries({ ...base, fields: () => undefined, keys: () => [] })[0]!.hint).toBe("")
})

it("takes each flow's newest run from this conversation, its agent tabs, or the store", () => {
  const entries = Catalog.entries({
    ...base,
    runs: [run("sum", "failed", 10, 20), run("sum", "done", 30, 40)],
    tabs: [{ agent: { name: "review" }, status: "running", startedAt: 50 }, {
      status: "done",
      startedAt: 90,
      endedAt: 95
    }],
    recorded: [
      { runId: "r1", flow: "sum", status: "completed", at: 35 },
      {
        runId: "r2",
        flow: "review",
        status: "cancelled",
        at: 70
      },
      { runId: "r3", flow: "late", status: "completed", at: 99 },
      { runId: "r4", flow: "sum", status: "failed" }
    ]
  })
  expect(entries.map((entry) => [entry.name, entry.last])).toEqual([
    ["sum", { status: "done", at: 40 }],
    ["review", { status: "cancelled", at: 70 }],
    // A late flow runs nowhere until a restart, so it shows no last run.
    ["late", undefined]
  ])
  expect(entries.map((entry) => entry.last === undefined ? "" : Catalog.mark(entry.last))).toEqual(["✓", "■", ""])
  expect(Catalog.mark({ status: "running", at: 0 })).toBe("◌")
  expect(Catalog.mark({ status: "failed", at: 0 })).toBe("✗")
})
