/** The packaged TUI loads project flows from a second copy of these packages. */
import { expect, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { build } from "esbuild"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import * as DeclarationSite from "../src/internal/DeclarationSite.ts"

it("shares live metadata across bundles while serialized ASTs remain inert", async () => {
  // Keep effect external, exactly as build-tui.mjs does. Inlining flow/plan
  // creates independent module instances even when their sources are identical.
  const scratch = mkdtempSync(join(import.meta.dirname, ".cross-bundle-"))
  try {
    const outfile = join(scratch, "copy.mjs")
    await build({
      stdin: {
        contents:
          "export * as Node from \"@smthrs/plan/Node\"; export * as Flow from \"@smthrs/flow/Flow\"; export * as Graph from \"@smthrs/flow/Graph\";",
        resolveDir: import.meta.dirname
      },
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "bundle",
      external: ["effect", "effect/*"]
    })
    const copy = await import(pathToFileURL(outfile).href) as {
      Node: typeof Node
      Flow: typeof Flow
      Graph: typeof Graph
    }
    expect(copy.Node.map).not.toBe(Node.map)
    const mapper = copy.Node.capture({ suffix: "!" }, function(value: string) {
      return value + this.suffix
    })
    expect(Node.functionIdentity(mapper)).toEqual(copy.Node.functionIdentity(mapper))
    expect(Node.functionIdentity(mapper).algorithm).toBe("sha256-source-captures/v5")
    const ephemeral = (value: string) => value
    expect(Node.functionIdentity(ephemeral)).toEqual(copy.Node.functionIdentity(ephemeral))

    const mapped = copy.Node.map(copy.Node.succeed("ok"), mapper)
    expect(Node.mapper(mapped.ast)?.("ok")).toBe("ok!")
    expect(Node.mapper(JSON.parse(JSON.stringify(mapped.ast)))).toBeUndefined()
    const recovered = copy.Node.catch(copy.Node.fail("bad"), {
      error: Schema.String,
      onFailure: (error) => copy.Node.succeed(error)
    })
    expect(Node.catchFilter(recovered.ast)).toBe(Schema.String)
    expect(Node.catchFilter(JSON.parse(JSON.stringify(recovered.ast)))).toBeUndefined()

    const branched = copy.Node.branch(copy.Node.succeed(true), {
      if: (value) => value,
      then: () => copy.Node.succeed("yes"),
      else: () => copy.Node.succeed("no")
    })
    expect(Node.predicate(branched.ast)?.(true)).toBe(true)
    expect(Node.predicate(JSON.parse(JSON.stringify(branched.ast)))).toBeUndefined()
    const otherBranch = Node.branch(Node.succeed(true), {
      if: (value) => value,
      then: () => Node.succeed("yes"),
      else: () => Node.succeed("no")
    })
    if (branched.ast._tag !== "Branch" || otherBranch.ast._tag !== "Branch") throw new Error("Expected branches")
    expect(branched.ast.subject).not.toBe(otherBranch.ast.subject)

    const child = copy.Flow.make("bundle/child", {
      payload: { text: Schema.String },
      success: Schema.String,
      body: ({ text }) => copy.Node.succeed(text)
    })
    const parent = copy.Flow.make("bundle/parent", {
      payload: {},
      success: Schema.String,
      body: () => copy.Node.succeed("ok").pipe(copy.Node.bindPlanned((text) => child.call({ text })))
    })
    const call = parent.call({})
    if (call.ast._tag !== "FlowCall") throw new Error("Expected a flow call")
    expect(Node.declaration(call.ast)).toBe(parent)
    expect(Node.declaration(JSON.parse(JSON.stringify(call.ast)))).toBeUndefined()
    const graph = Graph.build(parent, {})
    expect(Graph.nodes(graph).map((node) => node.kind)).toEqual([
      "Succeed",
      "Succeed",
      "FlowCall",
      "AndThen",
      "FlowCall"
    ])
    expect(Graph.nodes(graph).map((node) => node.draft.material.inputs)).toEqual(
      copy.Graph.nodes(copy.Graph.build(parent, {})).map((node) => node.draft.material.inputs)
    )
    copy.Graph.evaluatedFrom(outfile, "/project/flows/entry/flow.ts")
    // Both copies see the loader's source mapping before module evaluation.
    expect(DeclarationSite.parseFrame(`at declaration (${outfile}:10:2)`)).toEqual({
      path: "/project/flows/entry/flow.ts",
      line: 10
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
