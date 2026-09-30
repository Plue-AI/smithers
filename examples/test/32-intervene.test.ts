import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { expect, it } from "@effect/vitest"
import { Graph } from "@smthrs/flow"
import { GraphBuildError, isFatalDiagnostic } from "@smthrs/plan/GraphBuildError"
import * as Effect from "effect/Effect"
import { dryPlan, intervene, main, plan } from "../src/32-intervene.ts"

const literal = (node: Graph.GraphNode): Record<string, unknown> => {
  const first = node.draft.material.inputs[0]
  return first !== undefined && first._tag === "Literal" ? first.value as Record<string, unknown> : {}
}

/** The nodes that call the approval, which `WithApproval` marks with a run scope. */
const approvals = (graph: Graph.Graph): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) => node.kind === "FlowCall" && literal(node).scope === "run")

/**
 * Every capability the nodes of a graph run under: each node's own ceiling and
 * the ceilings of the flows that call it.
 *
 * Re-pinned 2026-09-30. `Intervene.make` composes the step flows without
 * restating their capabilities. Until 48776efd43 that composition granted
 * nothing, so every step that named a capability drew an advisory
 * `capability_outside_grant`, and these tests pinned that list. Since then an
 * omitted declaration inherits its caller's authority (see the engine's
 * capability-ceilings concept page), so the plan records no diagnostic at all
 * and each step keeps the ceiling it declares. What a plan can reach is read
 * off those ceilings instead.
 */
const authority = (graph: Graph.Graph): ReadonlyArray<string> =>
  [...new Set(Graph.nodes(graph).flatMap((node) => node.capabilityCeilings.flat()))].sort()

/** The fatal diagnostics a graph records. A plan must have none. */
const fatal = (graph: Graph.Graph): ReadonlyArray<GraphBuildError> =>
  Graph.diagnostics(graph).filter((diagnostic) => isFatalDiagnostic(diagnostic))

/** The nodes that call the write. */
const writes = (graph: Graph.Graph): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) => node.kind === "FlowCall" && literal(node).phase === "apply")

it.effect("rewrites the file once the approval answers approved", () =>
  Effect.gen(function*() {
    const { content, report } = yield* main

    expect(report).toEqual({ path: expect.stringContaining("greeting.txt"), replacements: 1, dryRun: false })
    expect(content).toBe("Hello, Ada.\n")
  }))

it.effect("leaves the file alone on a dry run", () =>
  Effect.gen(function*() {
    const { content, report } = yield* intervene({ dryRun: true, decision: "approved" }).pipe(
      Effect.provide(NodeFileSystem.layer)
    )

    expect(report.dryRun).toBe(true)
    expect(report.replacements).toBe(0)
    expect(content).toBe("Hello, world.\n")
  }))

it.effect("refuses the write when the approval answers anything else", () =>
  Effect.gen(function*() {
    const failure = yield* intervene({ dryRun: false, decision: "denied" }).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.flip
    )

    expect(failure._tag).toBe("SchemaError")
  }))

it("plans the approval ahead of the write", () => {
  const graph = Graph.build(plan, { input: "greeting" })
  const approval = approvals(graph)

  expect(approval).toHaveLength(1)
  expect(fatal(graph)).toEqual([])
  // The composition restates no capabilities, so it inherits authority and
  // nothing is advisory. The plan still reaches for both the read and the
  // write, which the steps declare themselves.
  expect(Graph.diagnostics(graph)).toEqual([])
  expect(authority(graph)).toEqual(["fs:read:/**", "fs:write:/**"])
  const gates = Graph.edges(graph).filter((edge) => edge.from === approval[0]!.id)
  const gatedWrites = writes(graph).filter((node) => node.dependencies.includes(approval[0]!.id))
  expect(gatedWrites).toHaveLength(1)
  const write = gatedWrites[0]!
  // The declared apply step is a signature with no body, so the node its call
  // expands into is the action a host implements.
  const body = Graph.nodes(graph).find((node) => node.id === `${write.id}.flow`)!
  expect(body.kind).toBe("ActionCall")
  expect(body.dependencies).toContain(approval[0]!.id)
  // Graph propagates continuation prerequisites into a FlowCall's body.
  // Both the apply call and its executable body must wait for approval, so
  // scheduling the body directly cannot bypass the gate. The third edge is the
  // approval's own value reaching the call that asked for it.
  const asked = approval[0]!.id.slice(0, approval[0]!.id.lastIndexOf("."))
  expect(gates).toEqual([
    { from: approval[0]!.id, to: asked, reason: "value" },
    { from: approval[0]!.id, to: write.id, reason: "continuation" },
    { from: approval[0]!.id, to: body.id, reason: "continuation" }
  ])
})

it("plans no write and no approval at all on a dry run", () => {
  const graph = Graph.build(dryPlan, { input: "greeting" })

  expect(approvals(graph)).toEqual([])
  expect(writes(graph)).toEqual([])
  expect(
    Graph.nodes(graph).filter((node) => node.kind === "FlowCall" && literal(node).phase === "report")
  ).toHaveLength(1)
  expect(fatal(graph)).toEqual([])
  // The dry-run plan reads and never writes: no node runs under an `fs:write`
  // ceiling, where the full plan above does.
  expect(Graph.diagnostics(graph)).toEqual([])
  expect(authority(graph)).toEqual(["fs:read:/**"])
})
