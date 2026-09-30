import { expect, test } from "bun:test"
import * as Panels from "../src/panels.ts"
import * as Session from "../src/session.ts"

const base: Panels.Panel = { id: "status", title: "Worker", summary: "Requested", rows: [] }

test("only unbound panels containing status without evidence or actions are status panels", () => {
  const status: Panels.Row = { id: "work", label: "Work", status: "running", details: [] }
  expect(Panels.unboundStatus(base)).toBe(true)
  expect(Panels.unboundStatus({ ...base, rows: [status] })).toBe(true)
  expect(Panels.unboundStatus({ ...base, bind: { tree: "root" } })).toBe(false)
  expect(Panels.unboundStatus({ ...base, rows: [{ ...status, details: [{ kind: "text", text: "Receipt" }] }] })).toBe(
    false
  )
  expect(
    Panels.unboundStatus({
      ...base,
      rows: [{ ...status, action: { label: "Open", action: { kind: "open", surface: "summary" } } }]
    })
  ).toBe(false)
  expect(Panels.unboundStatus({ ...base, rows: [{ id: "result", label: "Result", details: [] }] })).toBe(false)
})

test("restart drops legacy status cards and tabs while retaining bound and evidence views", () => {
  const bound = { ...base, id: "bound", bind: { tree: "root" } }
  const evidence = {
    ...base,
    id: "evidence",
    rows: [{ id: "result", label: "Result", details: [{ kind: "text" as const, text: "Receipt" }] }]
  }
  const restored = Session.restore([
    { type: "card", at: 1, panel: base },
    { type: "panel", panel: { ...base, id: "status-tab" } },
    { type: "card", at: 2, panel: bound },
    { type: "panel", panel: evidence }
  ])
  expect(restored.workspace.panels.map((panel) => panel.id)).toEqual(["bound", "evidence"])
  expect(restored.workspace.cards).toEqual(["bound"])
  expect(restored.transcript.items.filter((item) => item.kind === "card").map((item) => item.panel.id)).toEqual([
    "bound"
  ])
})

test("restart replaces legacy flow panels with the durable run while preserving ordinary result panels", () => {
  const result = { ...base, rows: [{ id: "result", label: "Result", details: [{ kind: "text" as const, text: "5" }] }] }
  const restored = Session.restore([
    {
      type: "flow",
      run: {
        id: "words",
        flow: "wordcount",
        by: "user",
        input: {},
        requested: "{}",
        status: "done",
        startedAt: 0,
        endedAt: 40,
        answer: "5"
      }
    },
    { type: "card", at: 40, panel: { ...result, id: "flow:words" } },
    { type: "panel", placement: "card", panel: { ...result, id: "flow:legacy" } },
    { type: "panel", panel: { ...result, id: "result-view" } }
  ])
  expect(restored.flows).toMatchObject([{ id: "words", status: "done", answer: "5" }])
  expect(restored.workspace.panels.map((panel) => panel.id)).toEqual(["result-view"])
  expect(restored.transcript.items.filter((item) => item.kind === "card")).toEqual([])
})
