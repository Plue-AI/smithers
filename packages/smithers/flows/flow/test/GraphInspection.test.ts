import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Graph } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

describe("guest declaration inspection", () => {
  it("exports serializable steps and edges without a caller payload or action execution", () => {
    const read = Action.make("read", { payload: { path: Schema.String }, success: Schema.String })
    const child = Flow.make("child", {
      payload: { text: Schema.String },
      success: Schema.String,
      body: ({ text }) => Node.succeed(text)
    })
    const flow = Flow.make("example", {
      payload: { file: Schema.Struct({ path: Schema.String }) },
      success: Schema.String,
      body: ({ file }) => read.call({ path: file.path }).pipe(Node.bindPlanned((text) => child.child({ text })))
    })
    const inspection = Graph.inspect(flow)
    expect(inspection.diagnostics).toEqual([])
    expect(inspection.steps.map((step) => step.label)).toEqual(["read", "child"])
    expect(new Set(inspection.steps.map((step) => step.id)).size).toBe(2)
    expect(inspection.edges.length).toBeGreaterThan(0)
    expect(JSON.parse(JSON.stringify(inspection))).toEqual(inspection)
  })

  it("publishes prompt source without rendering it", () => {
    let rendered = false
    const flow = Flow.make("teach", {
      payload: { text: Schema.String },
      success: Schema.String,
      prompt: ({ text }) => {
        rendered = true
        return `Teach ${text}`
      }
    })
    const inspection = Graph.inspect(flow)
    expect(rendered).toBe(false)
    expect(inspection.prompt).toContain("Teach")
    expect(inspection.steps.map((step) => step.label)).toEqual(["teach/prompt"])
    expect(inspection.diagnostics).toEqual([])
  })

  it("reports input-dependent computation instead of making up a sample", () => {
    const flow = Flow.make("computed", {
      payload: { text: Schema.String },
      success: Schema.String,
      body: ({ text }) => Node.succeed(text.toUpperCase())
    })
    const inspection = Graph.inspect(flow)
    expect(inspection.steps).toEqual([{ id: "root", label: "computed" }])
    expect(inspection.diagnostics[0]?.code).toBe("declaration_requires_input")
    expect(inspection.diagnostics[0]?.message).toContain("function application")
    expect(Graph.build(flow, { text: "real" }).nodes.length).toBeGreaterThan(0)
  })

  it("keeps graph policy diagnostics and does not relabel defects as missing input", () => {
    const read = Action.make("private/read", { payload: {}, capabilities: ["fs:read"], success: Schema.String })
    const flow = Flow.make("restricted", {
      payload: {},
      capabilities: [],
      success: Schema.String,
      body: () => read.call({})
    })
    expect(Graph.inspect(flow).diagnostics.some((error) => error.code === "capability_outside_grant")).toBe(true)
    for (const cause of [new Error("broken body"), "broken body"]) {
      const broken = Flow.make("broken", {
        payload: {},
        body: () => {
          throw cause
        }
      })
      expect(Graph.inspect(broken).diagnostics).toEqual([{
        code: "declaration_inspection_failed",
        message: "broken body"
      }])
    }
  })

  it("distinguishes a complete empty graph from an unavailable one", () => {
    const flow = Flow.make("empty", { payload: {}, success: Schema.Void, body: () => Node.succeed(undefined) })
    expect(Graph.inspect(flow).steps).toEqual([])
    expect(Graph.inspect(flow).diagnostics).toEqual([])
  })
})
