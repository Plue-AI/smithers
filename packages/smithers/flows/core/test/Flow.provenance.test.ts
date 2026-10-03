import { Graph } from "@smthrs/flow"
import { Context } from "effect"
import { expect, it } from "vitest"
import { Flow, Markdown, Placement } from "../src/index.ts"

const original = Markdown.lowerMarkdown({ name: "provenance/original" }, "Prompt")
const sites = (signature: typeof original) =>
  Graph.nodes(Graph.build(signature.flow, { args: "same" }))
    .filter((node) => node.kind === "FlowCall" || node.kind === "ActionCall")
    .map((node) => node.declaredAt)

it("keeps the declaration's source when a decorator copies it", () => {
  const expected = sites(original)
  expect(expected.every((site) => site !== undefined)).toBe(true)
  for (
    const copy of [
      Flow.withFlows(original, ["helper"]),
      Flow.within(original, Placement.local()),
      Flow.annotate(original, Context.Service<string>("provenance/metadata"), "value")
    ]
  ) {
    expect(sites(copy)).toEqual(expected)
  }
})
