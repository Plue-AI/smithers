import { expect, it } from "bun:test"
import type * as Flows from "../src/flows.ts"
import type * as Graph from "../src/graph.ts"
import * as Inbox from "../src/inbox.ts"
import { forest } from "../src/subagent-view.tsx"
import * as Transcript from "../src/transcript.ts"
import type { Tab } from "../src/workspace.ts"

const now = 1_000_000
const tab = (id: string, status: Tab["status"], parent?: string): Tab => ({
  id,
  title: id,
  prompt: id,
  depth: 1,
  seat: "openai:gpt-6-sol",
  file: `/tmp/${id}.jsonl`,
  status,
  startedAt: now - 60_000,
  ...(parent === undefined ? {} : { parent })
})
const shape = (node: Graph.Node): unknown => [node.key, node.children.map(shape)]
const rows = (tabs: ReadonlyArray<Tab>, runs: ReadonlyArray<Flows.Run> = []) =>
  Inbox.flat(Inbox.rows({ tabs, runs, transcript: () => Transcript.empty, contextWindow: () => 0, models: [], now }))

it("draws the whole tree above and below the selected worker, the ones that need the person included", () => {
  const tabs = [
    tab("root", "running"),
    tab("kid", "failed", "root"),
    tab("grand", "running", "kid"),
    tab("other", "done")
  ]
  const all = rows(tabs)
  const grand = all.find((row) => row.key === "grand")!
  expect(shape(forest(grand, all, tabs, () => [], now))).toEqual(["root", [["kid", [["grand", []]]]]])
})

it("draws a flow run with its node calls", () => {
  const run: Flows.Run = {
    id: "r",
    flow: "deploy",
    by: "user",
    input: {},
    requested: "{}",
    status: "running",
    startedAt: now
  }
  const all = rows([], [run])
  const node = forest(all[0]!, all, [], () => [{ id: "build#1", label: "build", status: "done" }], now)
  expect(shape(node)).toEqual(["flow:r", [["flow:r:build#1", []]]])
  expect(node.children[0]).toMatchObject({ glyph: "●", name: "build", sub: "fn" })
})

it("stops at a parent cycle in restored tabs", () => {
  // The inbox never lists a cycle (it has no root); the forest still must not hang on one.
  const all = rows([tab("a", "running"), tab("b", "running", "a")])
  const cyclic = [tab("a", "running", "b"), tab("b", "running", "a")]
  expect(shape(forest(all.find((row) => row.key === "a")!, all, cyclic, () => [], now))).toEqual(["a", [["b", []]]])
})
