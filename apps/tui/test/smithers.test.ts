import { expect, it } from "bun:test"
import type { Listed, Run } from "../src/flows.ts"
import * as Panels from "../src/panels.ts"
import * as Smithers from "../src/smithers.ts"

const run = (id: string, status: Run["status"], extra: Partial<Run> = {}): Run => ({
  id,
  flow: "review",
  by: "agent",
  input: {},
  requested: "{}",
  status,
  startedAt: 1,
  ...extra
})
const flow = (name: string, description: string, modelInvocable: boolean): Listed => ({
  name,
  description,
  modelInvocable,
  kind: "module",
  flows: [],
  capabilities: [],
  path: `flows/${name}/flow.ts`
})
const listed: ReadonlyArray<Listed> = [
  flow("review", "Review a change.", true),
  flow("release", "Cut a release.", false)
]

it("shows runs newest first with their real status, then the discovered flows", () => {
  const panel = Smithers.panel(listed, [
    run("a", "done", { startedAt: 1, answer: "Approved." }),
    run("b", "input", { startedAt: 3 }),
    run("c", "failed", { startedAt: 2, message: "Unknown flow" })
  ])
  expect(Panels.decode(panel)).toEqual(panel)
  expect(panel.id).toBe("smithers")
  expect(panel.summary).toBe("2 flows · 1 active")
  expect(panel.rows.map((row) => [row.id, row.status])).toEqual([
    ["run:b", "requested"],
    ["run:c", "failed"],
    ["run:a", "done"],
    ["flow:review", undefined],
    ["flow:release", undefined]
  ])
  expect(panel.rows[1]!.details).toEqual([{ kind: "text", text: "Unknown flow" }])
  expect(panel.rows[2]!.details).toEqual([{ kind: "text", text: "Approved." }])
  expect(panel.rows[3]!.details).toEqual([{ kind: "text", text: "Review a change." }])
  expect(panel.rows.some((row) => row.action !== undefined)).toBe(false)
})

it("never calls a requested run running", () => {
  const panel = Smithers.panel([], [run("a", "requested"), run("b", "running"), run("c", "waiting")])
  expect(panel.rows.map((row) => row.status)).toEqual(["requested", "running", "running"])
  expect(panel.summary).toBe("0 flows · 3 active")
})

it("lists the homepage's apps first, running the ones this directory discovers", () => {
  const apps = [
    { flow: "review", title: "Review a PR", picture: "review" },
    { flow: "issue.implement", title: "Fix an issue", picture: "issue" }
  ]
  const panel = Smithers.panel(listed, [run("a", "done", { answer: "Approved." })], apps)
  expect(Panels.decode(panel)).toEqual(panel)
  expect(panel.summary).toBe("2 apps · 2 flows · 0 active")
  expect(panel.rows.map((row) => row.id)).toEqual(["app:review", "app:issue.implement", "run:a", "flow:review", "flow:release"])
  expect(panel.rows[0]).toEqual({ id: "app:review", label: "Review a PR", details: [{ kind: "text", text: "review" }],
    action: { label: "Review a PR", action: { kind: "flow", flow: "review" } } })
  // A flow the app home names but this directory does not discover is listed, and runs nowhere here.
  expect(panel.rows[1]).toEqual({ id: "app:issue.implement", label: "Fix an issue", details: [{ kind: "text", text: "issue.implement" }] })
})
