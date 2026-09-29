import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Graph } from "@smthrs/flow"
import { KeyMaterial, Node, Plan, Planned } from "@smthrs/plan"
import { Effect, Schema, SchemaAST, SchemaIssue } from "effect"
import { withCrypto } from "./Crypto.ts"

const Read = Action.make("counter/read", {
  payload: { path: Schema.String },
  success: Schema.Struct({ value: Schema.Number, files: Schema.Array(Schema.String) })
})

const Increment = Action.make("counter/increment", {
  payload: { path: Schema.String },
  success: Schema.Number
})

const Write = Action.make("counter/write", {
  payload: { path: Schema.String, value: Schema.Number },
  success: Schema.Number
})

const Sum = Action.make("counter/sum", {
  payload: { values: Schema.Array(Schema.Number) },
  success: Schema.Number
})

const Child = Flow.make("counter/child", {
  payload: { path: Schema.String, seed: Schema.Number },
  success: Schema.Number,
  body: ({ path, seed }) => Write.call({ path, value: seed })
})

const Parent = Flow.make("counter/parent", {
  payload: { path: Schema.String },
  success: Schema.Number,
  body: ({ path }) =>
    Node.all({ left: Read.call({ path }), right: Node.succeed(1) }).pipe(
      Node.map((both) => both.right),
      Node.bindPlanned((seed) => Child.call({ path, seed }))
    )
})

const node = (graph: Graph.Graph, id: string): Graph.GraphNode => {
  const found = Graph.nodes(graph).find((candidate) => candidate.id === id)
  expect(found, `node ${id}`).toBeDefined()
  return found!
}

const material = (graph: Graph.Graph, id: string): KeyMaterial.KeyMaterial => node(graph, id).draft.material

const body = (graph: Graph.Graph, id: string): Record<string, unknown> =>
  material(graph, id).body as Record<string, unknown>

const planNode = (plan: Plan.Plan, id: string): Plan.PlanNode => {
  const found = plan.nodes.find((candidate) => candidate.id === id)
  expect(found, `plan node ${id}`).toBeDefined()
  return found!
}

const compile = (planId: string, flow: string, graph: Graph.Graph) =>
  withCrypto(Plan.compile({ planId, flow, nodes: Graph.drafts(graph) }))

/**
 * An AST that crossed a serialization boundary, leaving its side tables behind.
 * The node's own prototype is kept, because a rehydrated AST is still handed
 * back as a node — only what lived beside it is gone.
 */
const detached = <A, E = never, R = never>(built: Node.Node<A, E, R>): Node.Node<A, E, R> =>
  Object.assign(Object.create(Object.getPrototypeOf(built) as object) as Node.Node<A, E, R>, {
    ast: JSON.parse(JSON.stringify(built.ast)) as Node.Ast
  })

const buildWithPlacements = (enclosing: unknown, callee: unknown): Graph.Graph => {
  const Callee = Flow.make("placement/comparison/callee", {
    payload: {},
    body: () => Node.succeed(undefined)
  }).annotate(Flow.Placement, callee)
  const Caller = Flow.make("placement/comparison/caller", {
    payload: {},
    body: () => Callee.call({})
  }).annotate(Flow.Placement, enclosing)
  return Graph.build(Caller, {})
}

/**
 * A placement value that is not one of the four directives.
 *
 * `Flow.PlacementDirective` is `@smthrs/plan`'s typed model now, but a type is
 * erased: an annotation bag assembled at run time, or a declaration loaded from
 * a file flow, still carries whatever the caller put there. These cases drive
 * exactly that, which is what `Graph`'s bounded placement rendering and its
 * structural identity check exist for, so the cast is the point rather than a
 * way around the type.
 */
const opaque = (value: unknown): Flow.PlacementDirective => value as Flow.PlacementDirective

describe("Graph.build topology", () => {
  it("expands every node variant, entering the flow as a call to itself", () => {
    const graph = Graph.build(Parent, { path: "counter.txt" })

    expect(Graph.nodes(graph).map((observed) => [observed.id, observed.kind])).toEqual([
      ["root.flow.andThen.map.all.left", "ActionCall"],
      ["root.flow.andThen.map.all.right", "Succeed"],
      ["root.flow.andThen.map", "All"],
      ["root.flow.andThen", "Map"],
      ["root.flow.then.flow", "ActionCall"],
      ["root.flow.then", "FlowCall"],
      ["root.flow", "AndThen"],
      ["root", "FlowCall"]
    ])
    expect(Graph.edges(graph)).toEqual([
      { from: "root.flow.andThen.map.all.left", to: "root.flow.andThen.map", reason: "value" },
      { from: "root.flow.andThen.map.all.right", to: "root.flow.andThen.map", reason: "value" },
      { from: "root.flow.andThen.map", to: "root.flow.andThen", reason: "value" },
      { from: "root.flow.andThen", to: "root.flow", reason: "value" },
      { from: "root.flow.andThen", to: "root.flow.then", reason: "continuation" },
      { from: "root.flow.then.flow", to: "root.flow.then", reason: "value" },
      { from: "root.flow.then", to: "root.flow", reason: "value" },
      { from: "root.flow", to: "root", reason: "value" }
    ])
    expect(Graph.diagnostics(graph)).toEqual([])
    expect(Graph.drafts(graph).map((draft) => draft.id)).toEqual(
      Graph.nodes(graph).map((observed) => observed.id)
    )
    expect(Graph.drafts(graph).every((draft) => draft.kind === undefined)).toBe(true)
  })

  it("hashes the deferred mapper, the members of a combination, and a static continuation", () => {
    const graph = Graph.build(Parent, { path: "counter.txt" })

    expect(body(graph, "root.flow.andThen").mapper).toMatchObject({
      _tag: "FunctionIdentity",
      algorithm: "sha256-source-ephemeral/v4"
    })
    expect(body(graph, "root.flow.andThen.map")).toEqual({ _tag: "All", members: ["left", "right"] })
    expect(body(graph, "root.flow")).toMatchObject({ _tag: "AndThen", static: false })
    expect(body(graph, "root.flow.then")).toMatchObject({ _tag: "FlowCall", flow: "counter/child", mode: "inline" })
    expect(body(graph, "root.flow.then.flow")).toMatchObject({
      _tag: "ActionCall",
      action: "counter/write",
      tier: "sealed"
    })

    const stat = Graph.build(Node.andThen(Node.succeed(1), Node.succeed(2)))
    expect(body(stat, "root")).toMatchObject({ _tag: "AndThen", static: true })
    expect(Graph.nodes(stat).map((observed) => observed.id)).toEqual(["root.andThen", "root.then", "root"])
  })

  it("keeps right-nested sequence Pending inputs and continuation edges linear", () => {
    for (const depth of [1, 10, 100, 300]) {
      let next: Node.Node<number> = Node.succeed(depth)
      for (let index = depth - 1; index >= 0; index--) next = Node.andThen(Node.succeed(index), next)
      const graph = Graph.build(next)
      const pending = Graph.drafts(graph).flatMap((draft) =>
        draft.material.inputs.filter((input) => input._tag === "Pending")
      )

      expect(Graph.nodes(graph)).toHaveLength(2 * depth + 1)
      expect(pending).toHaveLength(2 * depth - 1)
      expect(Graph.edges(graph).filter((edge) => edge.reason === "continuation")).toHaveLength(2 * depth - 1)
      for (const observed of Graph.nodes(graph)) {
        expect(observed.draft.material.inputs.filter((input) => input._tag === "Pending").length).toBeLessThanOrEqual(1)
      }
    }
  })

  it("keeps a real payload intact for the body, values that are not plain data included", () => {
    const when = new Date(0)
    const seen: Array<unknown> = []
    const flow = Flow.make("literal/passthrough", {
      payload: { when: Schema.Unknown, missing: Schema.Unknown, tags: Schema.Unknown },
      success: Schema.Unknown,
      body: (payload) => {
        seen.push(payload.when)
        return Node.succeed(payload.missing)
      }
    })
    const graph = Graph.build(flow, { when, missing: null, tags: ["a", "b"] })

    expect(seen).toEqual([when])
    expect(seen[0]).toBe(when)
    expect(material(graph, "root").inputs[0]).toEqual({
      _tag: "Literal",
      value: { missing: null, tags: ["a", "b"], when }
    })
  })

  it("keeps an own __proto__ field in what the body sees and in the key material", () => {
    const seen: Array<unknown> = []
    const flow = Flow.make("literal/proto-field", {
      payload: { data: Schema.Unknown },
      success: Schema.Unknown,
      body: (payload) => {
        seen.push(payload.data)
        return Node.succeed(payload.data)
      }
    })
    const carried = Graph.build(flow, { data: { ["__proto__"]: "own" } })
    const bare = Graph.build(flow, { data: {} })

    expect(Object.hasOwn(seen[0] as object, "__proto__")).toBe(true)
    expect((seen[0] as Record<string, unknown>)["__proto__"]).toBe("own")
    expect(material(carried, "root").inputs[0]).toEqual({
      _tag: "Literal",
      value: { data: { ["__proto__"]: "own" } }
    })
    // The field is key material, so dropping it hashed two distinct payloads alike.
    expect(material(carried, "root").inputs[0]).not.toEqual(material(bare, "root").inputs[0])
  })

  it("records an object-valued own __proto__ field instead of reparenting the clone", () => {
    const flow = Flow.make("literal/proto-object", {
      payload: { data: Schema.Unknown },
      success: Schema.Unknown,
      body: (payload) => Node.succeed(payload.data)
    })
    const graph = Graph.build(flow, { data: { ["__proto__"]: { evil: 1 } } })
    const data = (node(graph, "root").payload as { readonly data: Record<string, unknown> }).data

    expect(Object.getPrototypeOf(data)).toBe(null)
    expect(data["__proto__"]).toEqual({ evil: 1 })
    // Reparenting would have served `evil` off the prototype instead.
    expect(data["evil"]).toBeUndefined()
    expect(material(graph, "root").inputs[0]).toEqual({
      _tag: "Literal",
      value: { data: { ["__proto__"]: { evil: 1 } } }
    })
  })
})

describe("Graph.build planned values", () => {
  it("threads reference paths from a payload into Ref inputs, once per distinct path", () => {
    const flow = Flow.make("refs/thread", {
      payload: { path: Schema.String },
      success: Schema.Unknown,
      body: ({ path }) =>
        Read.call({ path }).pipe(
          Node.bindPlanned((result) =>
            Node.all({
              written: Write.call({ path: result.files[0]!, value: result.value }),
              summed: Sum.call({ values: [result.value, result.value] })
            })
          )
        )
    })
    const graph = Graph.build(flow, { path: "counter.txt" })
    const upstream = "root.flow.andThen"

    expect(material(graph, "root.flow.then.all.written").inputs).toEqual([
      {
        _tag: "Literal",
        value: {
          path: { _tag: "PlannedInput", path: ["files", "0"] },
          value: { _tag: "PlannedInput", path: ["value"] }
        }
      },
      { _tag: "Ref", from: upstream, path: ["files", "0"] },
      { _tag: "Ref", from: upstream, path: ["value"] }
    ])
    expect(material(graph, "root.flow.then.all.summed").inputs).toEqual([
      {
        _tag: "Literal",
        value: {
          values: [{ _tag: "PlannedInput", path: ["value"] }, { _tag: "PlannedInput", path: ["value"] }]
        }
      },
      { _tag: "Ref", from: upstream, path: ["value"] }
    ])
    expect(material(graph, "root.flow.then").inputs).toEqual([{ _tag: "Pending", from: upstream }, {
      _tag: "Ref",
      from: "root.flow.then.all.written",
      path: []
    }, { _tag: "Ref", from: "root.flow.then.all.summed", path: [] }])
  })

  it("expands both branch arms and rewrites the subject to the branch's own upstream node", () => {
    const CountTo100 = Flow.make("counter/count-to-100", {
      payload: { path: Schema.String },
      success: Schema.Number,
      body: ({ path }) =>
        Increment.call({ path }).pipe(
          Node.branch({
            if: (value) => value >= 100,
            then: (value) => Flow.done(value),
            else: (): Node.Node<Flow.To<{ readonly path: string }>> => CountTo100.to({ path })
          })
        )
    })
    const graph = Graph.build(CountTo100, { path: "counter.txt" })

    expect(Graph.nodes(graph).map((observed) => [observed.id, observed.kind])).toEqual([
      ["root.flow.branch", "ActionCall"],
      ["root.flow.then", "Succeed"],
      ["root.flow.else", "FlowCall"],
      ["root.flow", "Branch"],
      ["root", "FlowCall"]
    ])
    expect(body(graph, "root.flow").predicate).toMatchObject({
      _tag: "FunctionIdentity",
      algorithm: "sha256-source-ephemeral/v4"
    })
    expect(material(graph, "root.flow.then").inputs).toEqual([
      { _tag: "Literal", value: { _tag: "Done", value: { _tag: "PlannedInput", path: [] } } },
      { _tag: "Ref", from: "root.flow.branch", path: [] },
      { _tag: "Pending", from: "root.flow.branch" }
    ])
    expect(material(graph, "root.flow.else").inputs).toEqual([
      { _tag: "Literal", value: { path: "counter.txt" } },
      { _tag: "Pending", from: "root.flow.branch" }
    ])
  })

  it("keeps a captured outer branch subject inside a nested branch arm", () => {
    const graph = Graph.build(
      Node.succeed("outer").pipe(Node.branch({
        if: () => true,
        then: (outer) =>
          Node.succeed("inner").pipe(Node.branch({
            if: () => true,
            then: () => Node.succeed({ outer }),
            else: () => Node.succeed("unused")
          })),
        else: () => Node.succeed("unused")
      }))
    )

    expect(material(graph, "root.then.then").inputs).toContainEqual({
      _tag: "Ref",
      from: "root.branch",
      path: []
    })
    expect(material(graph, "root.then.then").inputs).not.toContainEqual({
      _tag: "Ref",
      from: "root.then.branch",
      path: []
    })
  })

  it("evaluates each continuation and arm builder exactly once", () => {
    let continued = 0
    let armed = 0
    const flow = Flow.make("strict/once", {
      payload: { path: Schema.String },
      success: Schema.String,
      body: ({ path }) =>
        Increment.call({ path }).pipe(
          Node.bindPlanned((value) => {
            continued++
            return Write.call({ path, value }).pipe(
              Node.branch({
                if: (settled) => settled >= 100,
                then: () => {
                  armed++
                  return Node.succeed("done")
                },
                else: () => {
                  armed++
                  return Node.succeed("again")
                }
              })
            )
          })
        )
    })
    Graph.build(flow, { path: "counter.txt" })

    expect(continued).toBe(1)
    expect(armed).toBe(2)
  })

  it("throws on computation in a continuation, naming the source node and the fix", () => {
    const flow = Flow.make("strict/computed", {
      payload: { path: Schema.String },
      success: Schema.String,
      body: ({ path }) =>
        Read.call({ path }).pipe(
          Node.bindPlanned((result) => Node.succeed(`${result.value}`))
        )
    })
    expect(() => Graph.build(flow, { path: "counter.txt" })).toThrowError(expect.objectContaining({
      _tag: "@smthrs/plan/GraphBuildError",
      code: "planned_value_computed",
      node: "root.flow.andThen",
      path: ["value"],
      message: expect.stringContaining("Use Node.map to compute")
    }))
  })

  it("throws on computation inside a branch arm", () => {
    const flow = Flow.make("strict/armed", {
      payload: { path: Schema.String },
      success: Schema.String,
      body: ({ path }) =>
        Increment.call({ path }).pipe(
          Node.branch({
            if: (value) => value >= 100,
            then: (value) => Node.succeed(`${value}`),
            else: () => Node.succeed("again")
          })
        )
    })
    expect(() => Graph.build(flow, { path: "counter.txt" })).toThrowError(expect.objectContaining({
      _tag: "@smthrs/plan/GraphBuildError",
      code: "planned_value_computed",
      node: expect.stringMatching(/^branch\/subject\/\d+$/),
      path: [],
      message: expect.stringContaining("Node.branch to decide")
    }))
  })

  it("lets a failure that is not a build refusal escape the body untouched", () => {
    const boom = new TypeError("the body itself is broken")
    const flow = Flow.make("strict/defect", {
      payload: {},
      body: (): Node.Node<never> => {
        throw boom
      }
    })

    expect(() => Graph.build(flow, {})).toThrow(boom)
  })
})

describe("Graph.build composition", () => {
  it("throws when a flow calls itself inline and names the two ways out", () => {
    const Recursive = Flow.make("recursion/self", {
      payload: { depth: Schema.Number },
      success: Schema.Number,
      body: ({ depth }): Node.Node<number> => Recursive.call({ depth })
    })
    expect(() => Graph.build(Recursive, { depth: 0 })).toThrowError(expect.objectContaining({
      _tag: "@smthrs/plan/GraphBuildError",
      code: "recursion_requires_boundary",
      node: "root.flow",
      path: [],
      message: expect.stringMatching(/recursion\/self\.to\(payload\).*\.child\(payload\)/)
    }))
  })

  it("detects mutual recursion through the flow the expansion stack already holds", () => {
    const Ping: Flow.Flow<"recursion/ping", Schema.Struct<{ depth: Schema.Number }>, Schema.Number, Schema.Never> = Flow
      .make("recursion/ping", {
        payload: { depth: Schema.Number },
        success: Schema.Number,
        body: ({ depth }): Node.Node<number> => Pong.call({ depth })
      })
    const Pong = Flow.make("recursion/pong", {
      payload: { depth: Schema.Number },
      success: Schema.Number,
      body: ({ depth }): Node.Node<number> => Ping.call({ depth })
    })
    expect(() => Graph.build(Ping, { depth: 0 })).toThrowError(expect.objectContaining({
      _tag: "@smthrs/plan/GraphBuildError",
      code: "recursion_requires_boundary",
      node: "root.flow.flow",
      message: expect.stringContaining("recursion/ping.to(payload)")
    }))
  })

  it("leaves an explicit boundary and a declaration-less inline call as leaf nodes", () => {
    // Every flow has a body, so an inline call splices unless its declaration
    // did not survive beside its AST. Those are the only two leaves left.
    const boundary: Node.Node<number> = Node.flowCall(Child, "counter/child", "boundary", { path: "p", seed: 1 })
    const leaf = detached<number>(Node.flowCall(Child, "counter/child", "inline", { path: "p", seed: 1 }))
    const flow = Flow.make("counter/leaves", {
      payload: {},
      success: Schema.Struct({ boundary: Schema.Number, leaf: Schema.Number }),
      body: () => Node.all({ boundary, leaf })
    })
    const graph = Graph.build(flow, {})

    expect(Graph.nodes(graph).map((observed) => [observed.id, observed.kind])).toEqual([
      ["root.flow.all.boundary", "FlowCall"],
      ["root.flow.all.leaf", "FlowCall"],
      ["root.flow", "All"],
      ["root", "FlowCall"]
    ])
    expect(body(graph, "root.flow.all.boundary")).toMatchObject({ mode: "boundary", flow: "counter/child" })
    expect(body(graph, "root.flow.all.leaf")).toMatchObject({ mode: "inline", declaration: undefined })
    expect(node(graph, "root.flow.all.leaf").dependencies).toEqual([])
  })

  it("intersects the caller's capabilities with the callee's declared ceiling", () => {
    const Narrow = Flow.make("caps/narrow", {
      payload: {},
      success: Schema.Number,
      body: () => Increment.call({ path: "counter.txt" })
    }).annotate(Flow.Capabilities, ["fs:read:**"])
    const Wide = Flow.make("caps/wide", {
      payload: {},
      success: Schema.Number,
      body: () => Narrow.call({})
    }).annotate(Flow.Capabilities, ["fs:read:**", "fs:write:**"])
    const graph = Graph.build(Wide, {})

    expect(node(graph, "root").capabilities).toEqual(["fs:read:**", "fs:write:**"])
    expect(node(graph, "root.flow").capabilities).toEqual(["fs:read:**", "fs:write:**"])
    expect(node(graph, "root.flow.flow").capabilities).toEqual(["fs:read:**"])
    expect(material(graph, "root.flow.flow").capabilities).toEqual(["fs:read:**"])
    expect(body(graph, "root.flow").declaration).toMatchObject({ capabilities: ["fs:read:**"] })
  })

  it("carries an action's declared capability ceiling into its graph node", () => {
    const Restricted = Action.make("caps/restricted", {
      payload: { path: Schema.String },
      success: Schema.Number,
      capabilities: ["fs:write:**", "fs:read:**"]
    })
    const Holder = Flow.make("caps/holder", {
      payload: {},
      success: Schema.Number,
      capabilities: ["fs:read:**", "fs:write:**"],
      body: () => Restricted.call({ path: "counter.txt" })
    })

    const graph = Graph.build(Holder, {})

    // Sorted and deduped exactly as a flow declaration's ceiling is.
    expect(body(graph, "root.flow").declaration).toMatchObject({ capabilities: ["fs:read:**", "fs:write:**"] })
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("leaves the declaration of an action that declares no ceiling without one", () => {
    const graph = Graph.build(
      Flow.make("caps/unceilinged", {
        payload: {},
        success: Schema.Number,
        capabilities: ["fs:read:**"],
        body: () => Increment.call({ path: "counter.txt" })
      }),
      {}
    )

    expect(body(graph, "root.flow").declaration).not.toHaveProperty("capabilities")
  })

  it("folds the callee's own body digest into a call the graph keeps as a leaf", () => {
    const digestOf = (
      calleeBody: (
        payload: { readonly path: string }
      ) => Node.Node<number, never, Action.Requirement<"counter/write">>
    ): unknown => {
      const Callee = Flow.make("keys/callee", {
        payload: { path: Schema.String },
        success: Schema.Number,
        body: Node.capture({}, calleeBody)
      })
      const boundary: Node.Node<number> = Node.flowCall(Callee, "keys/callee", "boundary", { path: "counter.txt" })
      return (body(Graph.build(boundary), "root").declaration as Record<string, unknown>).body
    }
    const one = digestOf(({ path }) => Write.call({ path, value: 1 }))

    expect(one).toMatchObject({ _tag: "FunctionIdentity", algorithm: "sha256-source-captures/v5" })
    expect(digestOf(({ path }) => Write.call({ path, value: 1 }))).toEqual(one)
    expect(digestOf(({ path }) => Write.call({ path, value: 2 }))).not.toEqual(one)

    // A call whose declaration did not survive has no digest to fold in at all,
    // which is the only way a leaf call carries none.
    const lost = detached<number>(Node.flowCall(Child, "counter/child", "inline", { path: "p", seed: 1 }))
    expect(body(Graph.build(lost), "root").declaration).toBeUndefined()
  })
})

describe("Graph.build annotations", () => {
  it("carries declared effects, placement, tier, and resolved layers into the material", () => {
    const effects: Flow.Effects = { reads: ["counter.txt"], writes: ["counter.txt"], boundaryMode: "hard" }
    const placement = opaque({ host: "sandbox" })
    const Risky = Action.make("counter/risky", {
      payload: { path: Schema.String },
      success: Schema.Number,
      tier: "irreversible"
    })
      .annotate(Flow.EffectsDeclaration, effects)
      .annotate(Flow.Placement, placement)
    const flow = Flow.make("counter/annotated", {
      payload: {},
      success: Schema.Number,
      body: () => Risky.call({ path: "counter.txt" })
    })
    const graph = Graph.build(flow, {}, {
      resolveLayers: (request) => request.kind === "ActionCall" ? ["host:sandbox", "host:sandbox"] : []
    })
    const risky = node(graph, "root.flow")

    expect(risky.draft.material.kind).toBe("irreversible")
    expect(risky.draft.effects).toEqual(effects)
    expect(risky.draft.material.effects).toEqual(effects)
    expect(risky.draft.material.placement).toEqual(placement)
    expect(risky.draft.material.layers).toEqual(["host:sandbox"])
    expect(risky.placement).toEqual(placement)

    const root = node(graph, "root")
    expect(root.draft.effects).toEqual({ reads: [], writes: [], boundaryMode: "expected" })
    expect(root.draft.material.effects).toBeUndefined()
    expect(root.draft.material.placement).toBeUndefined()
    expect(root.draft.material.layers).toEqual([])
    expect(root.placement).toBeUndefined()
  })

  it("folds a declared action's output nondeterminism into plan key material", () => {
    const Unstable = Action.make("counter/unstable", {
      payload: {},
      success: Schema.Number,
      nondeterministic: true
    })
    const graph = Graph.build(Unstable.call({}))

    expect(material(graph, "root").nondeterministic).toBe(true)
  })
})

describe("Graph.build diagnostics", () => {
  it("records a continuation that did not answer with a node instead of throwing", () => {
    const broken = Node.bindPlanned(
      Node.succeed(1),
      (() => 42) as unknown as (value: Planned.Planned<number>) => Node.Node<number>
    )
    const graph = Graph.build(broken)

    expect(Graph.diagnostics(graph)).toHaveLength(1)
    expect(Graph.diagnostics(graph)[0]).toMatchObject({
      code: "invalid_continuation",
      node: "root",
      path: []
    })
    expect(Graph.nodes(graph).map((observed) => observed.id)).toEqual(["root.andThen", "root"])
    expect(node(graph, "root").capabilities).toEqual([])
    expect(() => Graph.drafts(graph)).toThrow(Graph.diagnostics(graph)[0])
    // One refusing surface: the built graph carries no field handing the
    // truncated drafts of an incomplete graph back past the accessor.
    expect(Object.hasOwn(graph, "drafts")).toBe(false)
  })

  it("treats an AST that lost its side tables as leaves, and records its lost continuation", () => {
    const graph = Graph.build(detached(
      Read.call({ path: "counter.txt" }).pipe(Node.bindPlanned(() => Child.call({ path: "counter.txt", seed: 1 })))
    ))

    expect(Graph.diagnostics(graph)).toHaveLength(1)
    expect(Graph.diagnostics(graph)[0]).toMatchObject({ code: "invalid_continuation", node: "root" })
    expect(body(graph, "root.andThen")).toEqual({
      _tag: "ActionCall",
      action: "counter/read",
      tier: "sealed",
      declaration: undefined
    })

    const call = Graph.build(detached(Child.call({ path: "counter.txt", seed: 1 })))
    expect(Graph.nodes(call).map((observed) => observed.id)).toEqual(["root"])
    expect(body(call, "root")).toEqual({
      _tag: "FlowCall",
      flow: "counter/child",
      mode: "inline",
      declaration: undefined
    })
  })

  it("refuses duplicate structural addresses before returning a graph", () => {
    expect(() =>
      Graph.build(Node.all({
        "x.all.y": Node.succeed("outer"),
        x: Node.all({ y: Node.succeed("nested") })
      }))
    ).toThrowError(expect.objectContaining({
      code: "duplicate_node",
      node: "root.all.x.all.y",
      path: [],
      message: expect.stringContaining("durable dispatch identity")
    }))
  })

  it("accepts dotted All member names whose structural addresses remain distinct", () => {
    const graph = Graph.build(Node.all({
      "x.all.z": Node.succeed("outer"),
      x: Node.all({ y: Node.succeed("nested") })
    }))

    expect(Graph.diagnostics(graph)).toEqual([])
    expect(new Set(Graph.nodes(graph).map((current) => current.id)).size).toBe(Graph.nodes(graph).length)
  })
})

describe("Graph.build placement identity", () => {
  const conflict = (enclosing: unknown, callee: unknown): void => {
    expect(() => buildWithPlacements(enclosing, callee)).toThrowError(expect.objectContaining({
      _tag: "@smthrs/plan/GraphBuildError",
      code: "placement_requires_boundary"
    }))
  }

  it("distinguishes an undefined-valued own key from a missing key", () => {
    conflict({ x: undefined }, {})
  })

  it("distinguishes NaN from null but treats NaN as identical to itself", () => {
    conflict({ x: Number.NaN }, { x: null })
    expect(() => buildWithPlacements({ x: Number.NaN }, { x: Number.NaN })).not.toThrow()
  })

  it("compares bigint directives without serialization", () => {
    expect(() => buildWithPlacements({ x: 1n }, { x: 1n })).not.toThrow()
    conflict({ x: 1n }, { x: 2n })
  })

  it("ignores object key order", () => {
    expect(() =>
      buildWithPlacements(
        { host: "sandbox", pool: "a" },
        { pool: "a", host: "sandbox" }
      )
    ).not.toThrow()
  })

  it("compares arrays, enumerable keys, symbols, null, and signed zero structurally", () => {
    const sharedSymbol = Symbol("shared")
    expect(() => buildWithPlacements({ x: [1, sharedSymbol] }, { x: [1, sharedSymbol] })).not.toThrow()

    conflict({ x: [1] }, { x: [1, 2] })
    conflict({ x: [1] }, { x: { 0: 1, length: 1 } })
    conflict({ x: { same: 1 } }, { x: { other: 1 } })
    conflict({ x: {} }, { x: null })
    conflict({ x: null }, { x: {} })
    conflict({ x: Symbol("left") }, { x: Symbol("left") })
    conflict({ x: -0 }, { x: 0 })
  })

  it("terminates on structurally equal cyclic directives", () => {
    const enclosing: { self?: unknown } = {}
    const callee: { self?: unknown } = {}
    enclosing.self = enclosing
    callee.self = callee

    expect(() => buildWithPlacements(enclosing, callee)).not.toThrow()
  })

  it("refuses to prove identity for values it cannot read inertly", () => {
    // The comparison replaced JSON.stringify, which distinguished these by
    // their serialized form. Own enumerable keys alone would call every pair
    // below identical, because each side carries none, and admit an inline
    // call against a placement nobody compared. Refusing is the safe verdict:
    // it pushes the call to an explicit .child() boundary.
    conflict({ at: new Date(0) }, { at: new Date(9_000_000_000_000) })
    conflict({ at: new Date(0) }, { at: new Date(0) })
    conflict({ run: () => 1 }, { run: () => 2 })
    conflict({ pool: new Map([["a", 1]]) }, { pool: new Map([["b", 2]]) })
    conflict({ pool: new Set([1]) }, { pool: new Set([2]) })
    conflict({ match: /a/ }, { match: /b/ })
    conflict({ at: new Date(0) }, { at: {} })
    conflict({ at: {} }, { at: new Date(0) })

    // The same value by reference is still identical, and a null-prototype
    // object is as plain as a literal.
    const shared = new Date(0)
    expect(() => buildWithPlacements({ at: shared }, { at: shared })).not.toThrow()
    expect(() =>
      buildWithPlacements(
        Object.assign(Object.create(null) as object, { host: "sandbox" }),
        Object.assign(Object.create(null) as object, { host: "sandbox" })
      )
    ).not.toThrow()
  })

  it("never runs an accessor on a placement while comparing it", () => {
    let reads = 0
    const withGetter = () => ({
      get host() {
        reads++
        return "sandbox"
      }
    })

    conflict(withGetter(), { host: "sandbox" })
    conflict({ host: "sandbox" }, withGetter())
    conflict(withGetter(), withGetter())
    expect(reads).toBe(0)
  })

  it("refuses a placement whose own reflection throws, instead of letting it escape", () => {
    // `isPlainObject` calls `Object.getPrototypeOf`, which on a Proxy runs the
    // author's trap. A trap that throws used to leave graph building as a raw
    // Error, past the typed refusal every other unreadable placement gets.
    const hostile = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error("boom")
      }
    })

    conflict(hostile, { host: "sandbox" })
    conflict({ host: "sandbox" }, hostile)
  })

  it("refuses to prove identity past its comparison budget", () => {
    // Two directives large enough to exhaust the budget are refused rather than
    // compared to the end, so a placement cannot make planning unbounded. The
    // verdict is the same fail-closed one every unreadable value gets.
    const wide = () => Array.from({ length: 100_001 }, () => 0)
    conflict(wide(), wide())

    // A directive that fits the budget is still proved identical.
    const narrow = () => Array.from({ length: 1_000 }, () => 0)
    expect(() => buildWithPlacements(narrow(), narrow())).not.toThrow()
  })

  it("judges two cycles that unfold alike identical", () => {
    // Identity over a cyclic directive is bisimulation: a self-cycle and a
    // two-node cycle unfold to the same infinite tree, so they are the same
    // directive. This is deliberate, and the comparison budget is what keeps it
    // decidable in bounded time.
    const enclosing: { next?: unknown } = {}
    enclosing.next = enclosing
    const first: { next?: unknown } = {}
    const second: { next?: unknown } = {}
    first.next = second
    second.next = first

    expect(() => buildWithPlacements(enclosing, first)).not.toThrow()
  })

  it("names both placements in the refusal, bounded and inert", () => {
    const message = (enclosing: unknown, callee: unknown): string => {
      try {
        buildWithPlacements(enclosing, callee)
      } catch (thrown) {
        return (thrown as { message: string }).message
      }
      throw new Error("the build did not refuse")
    }

    // An author cannot act on "they differ" alone, so both directives are in
    // the message, rendered independent of key order.
    const rendered = message({ host: "sandbox", pool: "a" }, { host: "vm" })
    expect(rendered).toContain(`{host:"vm"}`)
    expect(rendered).toContain(`{host:"sandbox",pool:"a"}`)
    expect(rendered).toContain(".child(payload)")

    // Every kind renders inertly: no accessor runs, no cycle recurses, no
    // exotic object is walked, and nothing is serialized.
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const exotic = message({
      n: 1,
      big: 2n,
      nothing: null,
      missing: undefined,
      flag: false,
      tag: Symbol.for("tag"),
      list: [1, "two"],
      when: new Date(0),
      get lazy() {
        return "never read"
      },
      cyclic,
      deep: { a: { b: { c: { d: 1 } } } }
    }, { host: "vm" })
    expect(exotic).toContain("big:2n")
    expect(exotic).toContain("nothing:null")
    expect(exotic).toContain("missing:undefined")
    expect(exotic).toContain("flag:false")
    expect(exotic).toContain("tag:Symbol(tag)")
    expect(exotic).toContain(`list:[1,"two"]`)
    expect(exotic).toContain("when:[object Date]")
    expect(exotic).toContain("lazy:<accessor>")
    expect(exotic).toContain("self:<cycle>")
    expect(exotic).toContain("<elided>")

    // A large directive is truncated rather than becoming the whole message.
    const large = message({ host: "x".repeat(400) }, { host: "vm" })
    expect(large).toContain("characters dropped]")
    expect(large).not.toContain("x".repeat(400))
  })

  it("renders array members inertly and under a member bound", () => {
    const message = (enclosing: unknown, callee: unknown): string => {
      try {
        buildWithPlacements(enclosing, callee)
      } catch (thrown) {
        return (thrown as { message: string }).message
      }
      throw new Error("the build did not refuse")
    }

    // `Array.prototype.map` invokes an index getter. Reading own descriptors
    // instead keeps the rendering as inert as the comparison that preceded it.
    let reads = 0
    const withGetter: Array<unknown> = []
    Object.defineProperty(withGetter, "0", {
      get: () => {
        reads++
        return "sandbox"
      },
      enumerable: true,
      configurable: true
    })
    expect(message({ list: withGetter }, { host: "vm" })).toContain("<accessor>")
    expect(reads).toBe(0)

    // A sparse array costs its member bound, not its length. Rendering through
    // `map` and `join` built one separator per element -- a hundred thousand
    // commas for a directive that owns no properties at all.
    const sparse = message({ list: new Array(100_000) }, { host: "vm" })
    expect(sparse).toContain("<hole>")
    expect(sparse).not.toContain(",,,,,")

    // Past the bound, both kinds mark the tail they dropped.
    expect(message({ list: Array.from({ length: 40 }, () => 1) }, { host: "vm" })).toContain("<more>")
    const wide: Record<string, number> = {}
    for (let index = 0; index < 40; index++) wide[`k${index}`] = 1
    expect(message(wide, { host: "vm" })).toContain("<more>")
  })
})

describe("Graph.build into a plan", () => {
  it.effect("compiles hundreds of All members without dropping or aliasing nodes", () =>
    Effect.gen(function*() {
      const members: Record<string, Node.Node<number>> = {}
      for (let index = 0; index < 500; index++) members[`member-${index}`] = Node.succeed(index)

      const graph = Graph.build(Node.all(members))
      const plan = yield* compile("plan-wide-all", "wide-all", graph)

      expect(Graph.nodes(graph)).toHaveLength(501)
      expect(new Set(Graph.nodes(graph).map((current) => current.id)).size).toBe(501)
      expect(plan.nodes).toHaveLength(501)
    }))

  // The walk is an explicit stack, so depth is a policy refusal rather than a
  // native stack overflow: topology past the bound fails typed and loudly.
  it("rejects a very deep AndThen graph with a typed error instead of overflowing the stack", () => {
    let deep: Node.Node<number> = Node.succeed(0)
    for (let index = 1; index <= 10_000; index++) deep = Node.andThen(deep, Node.succeed(index))

    expect(() => Graph.build(deep)).toThrowError(expect.objectContaining({
      _tag: "@smthrs/plan/GraphBuildError",
      code: "graph_too_deep",
      message: expect.stringContaining(".child()")
    }))
  })

  it("rejects a cyclic unknown payload with a typed error instead of overflowing the stack", () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic

    expect(() => Graph.build(Node.succeed(cyclic))).toThrowError(expect.objectContaining({
      _tag: "@smthrs/plan/GraphBuildError",
      code: "cyclic_payload",
      node: "root",
      message: expect.stringContaining("acyclic")
    }))
  })

  it("keeps a PlannedReference-shaped payload as data and never invokes payload accessors", () => {
    let reads = 0
    const shaped = { _tag: "PlannedReference", node: "ghost", path: [] }
    const payload = Object.defineProperty({ shaped }, "active", {
      enumerable: true,
      get: () => {
        reads += 1
        return true
      }
    })

    expect(() => Graph.build(Node.succeed(payload))).toThrowError(expect.objectContaining({
      code: "invalid_payload",
      message: expect.stringContaining("accessor")
    }))
    expect(reads).toBe(0)

    const graph = Graph.build(Node.succeed(shaped))
    expect(Graph.drafts(graph)[0]?.material.inputs).toEqual([
      { _tag: "Literal", value: shaped }
    ])
  })

  it("refuses hostile payload containers and inert accessor-backed members", () => {
    const hostilePrototype = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("prototype trap")
      }
    })
    const hostileDescriptors = new Proxy({}, {
      getPrototypeOf: () => Object.prototype,
      ownKeys() {
        throw new Error("descriptor trap")
      }
    })
    const arrayAccessor: Array<unknown> = []
    Object.defineProperty(arrayAccessor, "0", { get: () => 1, enumerable: true })
    const objectAccessor = Object.defineProperty({}, "value", { get: () => 1, enumerable: true })
    const nodeWith = (payload: unknown) => {
      const node = Node.succeed<unknown>(null)
      ;(node.ast as { value: unknown }).value = payload
      return node
    }

    for (const payload of [hostilePrototype, hostileDescriptors, arrayAccessor, objectAccessor]) {
      expect(() => Graph.build(nodeWith(payload))).toThrowError(expect.objectContaining({
        code: "invalid_payload"
      }))
    }
    expect(Graph.nodes(Graph.build(nodeWith(new Array(1))))[0]?.payload).toEqual([undefined])
  })

  it("fails closed when an authored outcome loses its branded payload", () => {
    const done = Flow.done(1)
    ;(done.ast as { value: unknown }).value = 1
    expect(() => Graph.build(done)).toThrowError(expect.objectContaining({
      code: "invalid_payload",
      message: expect.stringContaining("lost its Done payload")
    }))

    const unrecognized = Flow.done(1)
    const marker = Reflect.ownKeys(unrecognized.ast).find((key) => typeof key === "symbol")!
    const cloned = { ...unrecognized.ast }
    Object.defineProperty(cloned, marker, { value: "Other" })
    ;(unrecognized as { ast: Node.Ast }).ast = cloned as Node.Ast
    expect(Graph.build(unrecognized).diagnostics).toEqual([])
  })

  it("rejects a very deep unknown payload with a typed error instead of overflowing the stack", () => {
    let payload: Record<string, unknown> = { value: "leaf" }
    for (let index = 0; index < 20_000; index++) payload = { next: payload }

    expect(() => Graph.build(Node.succeed(payload))).toThrowError(expect.objectContaining({
      _tag: "@smthrs/plan/GraphBuildError",
      code: "payload_too_deep",
      node: "root",
      message: expect.stringContaining("Flatten the payload")
    }))
  })

  it.effect("rejects self-referential and dangling authored refs as typed PlanErrors", () =>
    Effect.gen(function*() {
      const cases = [
        {
          code: "cycle",
          dependency: "root",
          graph: Graph.build(Node.succeed(Planned.make("root")))
        },
        {
          code: "unknown_dependency",
          dependency: "missing",
          graph: Graph.build(Node.succeed(Planned.make("missing")))
        }
      ] as const

      for (const current of cases) {
        const error = yield* withCrypto(Effect.flip(
          Plan.compile({
            planId: `plan-${current.code}`,
            flow: current.code,
            nodes: Graph.drafts(current.graph)
          })
        ))

        expect(error).toMatchObject({
          _tag: "@smthrs/plan/PlanError",
          code: current.code,
          message: expect.stringContaining(current.dependency)
        })
      }
    }))

  it.effect("keys catch refinement behavior even when JSON schemas are identical", () =>
    Effect.gen(function*() {
      const make = (accepted: string) =>
        Node.catch(Node.succeed("protected"), {
          error: Schema.String.check(Schema.makeFilter((value) => value === accepted)),
          onFailure: () => Node.succeed("recovered")
        })
      const left = make("a")
      const right = make("b")
      expect(Schema.toJsonSchemaDocument(Node.catchFilter(left.ast)!))
        .toEqual(Schema.toJsonSchemaDocument(Node.catchFilter(right.ast)!))
      expect(Schema.is(Node.catchFilter(left.ast)!)("a")).toBe(true)
      expect(Schema.is(Node.catchFilter(right.ast)!)("a")).toBe(false)
      const a = yield* compile("catch-identity", "catch", Graph.build(left))
      const b = yield* compile("catch-identity", "catch", Graph.build(right))
      expect(a.digest).not.toBe(b.digest)
      expect(a.nodes.map((node) => node.key)).not.toEqual(b.nodes.map((node) => node.key))
    }))

  it.effect("includes captured nested filter behavior in stable catch identities", () =>
    Effect.gen(function*() {
      const make = (accepted: string) =>
        Node.catch(Node.succeed("protected"), {
          error: Schema.Struct({
            value: Schema.String.check(
              new SchemaAST.Filter(Node.capture(
                { accepted, implementationVersion: "catch-filter/v1" },
                (value: string) => value === accepted ? undefined : new SchemaIssue.InvalidValue(undefined, value)
              ))
            )
          }),
          onFailure: () => Node.succeed("recovered")
        })
      const build = (accepted: string) => Graph.build(make(accepted), undefined, { callbackIdentity: "stable" })
      const left = build("a")
      expect(left.diagnostics).toEqual([])
      const a = yield* compile("stable-catch", "catch", left)
      const same = yield* compile("stable-catch", "catch", build("a"))
      const different = yield* compile("stable-catch", "catch", build("b"))
      expect(a.digest).toBe(same.digest)
      expect(a.digest).not.toBe(different.digest)
    }))

  it("refuses opaque schema checks in stable graphs and admits structural schemas", () => {
    const make = (error: Schema.Schema<string>) =>
      Node.catch(Node.succeed(1), {
        error,
        onFailure: () => Node.succeed(0)
      })
    const stable = { callbackIdentity: "stable" } as const
    expect(Graph.build(make(Schema.String), undefined, stable).diagnostics).toEqual([])
    expect(
      Graph.build(make(Schema.String.check(Schema.makeFilter((value) => value === "a"))), undefined, stable)
        .diagnostics
    ).toContainEqual(expect.objectContaining({ code: "unstable_callback", path: ["filter"] }))
  })

  it.effect("shows protected and on-failure topology in the graph and compiled plan", () =>
    Effect.gen(function*() {
      const graph = Graph.build(
        Read.call({ path: "counter.txt" }).pipe(
          Node.catch({ onFailure: (error) => Node.succeed({ recovered: error }) })
        )
      )
      const plan = yield* compile("plan-catch", "catch", graph)

      expect(Graph.nodes(graph).map((observed) => [observed.id, observed.kind])).toEqual([
        ["root.protected", "ActionCall"],
        ["root.failure", "Succeed"],
        ["root", "Catch"]
      ])
      expect(Graph.edges(graph)).toContainEqual({
        from: "root.protected",
        to: "root.failure",
        reason: "failure"
      })
      expect(body(graph, "root")).toMatchObject({ _tag: "Catch" })
      expect(plan.nodes.map((planned) => planned.id)).toEqual([
        "root.protected",
        "root.failure",
        "root"
      ])
      expect(planNode(plan, "root.failure").dependsOn).toEqual(["root.protected"])
    }))

  it.effect("drafts a constant failure and keys it on the error it carries", () =>
    Effect.gen(function*() {
      const graph = Graph.build(Node.fail({ reason: "quota" }))
      const plan = yield* compile("plan-fail", "fail", graph)

      expect(Graph.nodes(graph).map((observed) => [observed.id, observed.kind])).toEqual([["root", "Fail"]])
      expect(Graph.edges(graph)).toEqual([])
      expect(node(graph, "root").payload).toEqual({ reason: "quota" })
      expect(body(graph, "root")).toEqual({ _tag: "Fail" })
      // The error is hashed the way a Succeed value is, so two different
      // refusals are two different steps.
      expect(material(graph, "root").inputs).toEqual([{ _tag: "Literal", value: { reason: "quota" } }])
      expect(planNode(plan, "root").key).toMatch(/^key1_[0-9a-f]{64}$/)
      const other = yield* compile("plan-fail", "fail", Graph.build(Node.fail({ reason: "budget" })))
      expect(planNode(other, "root").key).not.toBe(planNode(plan, "root").key)
    }))

  it.effect("wires a failure arm onto a constant failure", () =>
    Effect.gen(function*() {
      const graph = Graph.build(
        Node.fail("boom").pipe(Node.catch({ onFailure: (error) => Node.succeed({ recovered: error }) }))
      )
      const plan = yield* compile("plan-fail-catch", "fail", graph)

      expect(Graph.nodes(graph).map((observed) => [observed.id, observed.kind])).toEqual([
        ["root.protected", "Fail"],
        ["root.failure", "Succeed"],
        ["root", "Catch"]
      ])
      expect(Graph.edges(graph)).toContainEqual({
        from: "root.protected",
        to: "root.failure",
        reason: "failure"
      })
      expect(planNode(plan, "root.failure").dependsOn).toEqual(["root.protected"])
    }))

  it("keeps a captured outer catch subject inside a nested catch arm", () => {
    const graph = Graph.build(
      Read.call({ path: "outer.txt" }).pipe(Node.catch({
        onFailure: (outer: Planned.Planned<unknown>) =>
          Read.call({ path: "inner.txt" }).pipe(Node.catch({
            onFailure: () => Node.succeed({ outer })
          }))
      }))
    )

    expect(material(graph, "root.failure.failure").inputs).toContainEqual({
      _tag: "Ref",
      from: "root.protected",
      path: []
    })
    expect(material(graph, "root.failure.failure").inputs).not.toContainEqual({
      _tag: "Ref",
      from: "root.failure.protected",
      path: []
    })
  })

  it.effect("compiles drafts into a keyed plan whose edges are the material references", () =>
    Effect.gen(function*() {
      const graph = Graph.build(Parent, { path: "counter.txt" })
      const plan = yield* compile("plan-parent", "counter/parent", graph)

      expect(plan.nodes.map((planned) => planned.id)).toEqual(Graph.drafts(graph).map((draft) => draft.id))
      expect(plan.nodes.every((planned) => /^key1_[0-9a-f]{64}$/.test(planned.key))).toBe(true)
      expect(planNode(plan, "root.flow.andThen.map").dependsOn).toEqual([
        "root.flow.andThen.map.all.left",
        "root.flow.andThen.map.all.right"
      ])
      expect(planNode(plan, "root.flow.then").dependsOn).toEqual(["root.flow.andThen", "root.flow.then.flow"])
      expect(planNode(plan, "root.flow").dependsOn).toEqual(["root.flow.andThen", "root.flow.then"])
      expect(planNode(plan, "root").dependsOn).toEqual(["root.flow"])
      expect(planNode(plan, "root.flow.andThen.map.all.right").dependsOn).toEqual([])
    }))

  it.effect("re-keys exactly what reads an edited mapper, and nothing upstream of it", () =>
    Effect.gen(function*() {
      const flowWith = (delta: number) =>
        Flow.make("keys/map", {
          payload: { path: Schema.String },
          success: Schema.Number,
          body: Node.capture({ delta }, ({ path }) =>
            Increment.call({ path }).pipe(
              Node.map(Node.capture({ delta }, (value: number) => value + delta)),
              Node.bindPlanned(Node.capture({ path }, (value) => Write.call({ path, value })))
            ))
        })
      const before = yield* compile(
        "plan-keys",
        "keys/map",
        Graph.build(flowWith(1), { path: "counter.txt" })
      )
      const after = yield* compile(
        "plan-keys",
        "keys/map",
        Graph.build(flowWith(2), { path: "counter.txt" })
      )

      expect(after.nodes.map((planned) => planned.id)).toEqual(before.nodes.map((planned) => planned.id))
      expect(planNode(after, "root.flow.andThen.map").key).toBe(planNode(before, "root.flow.andThen.map").key)
      for (const id of ["root.flow.andThen", "root.flow.then", "root.flow", "root"]) {
        expect(planNode(after, id).key, id).not.toBe(planNode(before, id).key)
      }
      expect(after.digest).not.toBe(before.digest)
    }))

  it.effect("appends a later round that consumes a node the plan already holds", () =>
    Effect.gen(function*() {
      const plan = yield* compile("plan-round", "counter/parent", Graph.build(Parent, { path: "counter.txt" }))
      const Follow = Flow.make("counter/follow", {
        payload: { seed: Schema.Number },
        success: Schema.Number,
        body: ({ seed }) => Write.call({ path: "counter.txt", value: seed })
      })
      const next = Graph.build(Follow, { seed: Planned.make<number>("root.flow.then.flow") }, { root: "round-1" })
      const grown = yield* withCrypto(Plan.append(plan, Graph.drafts(next)))

      expect(Graph.nodes(next).map((observed) => observed.id)).toEqual(["round-1.flow", "round-1"])
      expect(grown.generation).toBe(1)
      expect(planNode(grown, "round-1.flow").dependsOn).toEqual(["root.flow.then.flow"])
      expect(planNode(grown, "round-1").dependsOn).toEqual(["root.flow.then.flow", "round-1.flow"])
      expect(planNode(grown, "root").key).toBe(planNode(plan, "root").key)
    }))
})

describe("Graph.build limits and cost", () => {
  const codeOf = (build: () => unknown): string => {
    try {
      build()
      return "built"
    } catch (thrown) {
      return (thrown as { code: string }).code
    }
  }

  it("accepts an AndThen graph exactly maximumGraphDepth deep and refuses one level more", () => {
    const leftNested = (depth: number) => {
      let deep: Node.Node<number> = Node.succeed(0)
      for (let index = 1; index <= depth; index++) deep = Node.andThen(deep, Node.succeed(index))
      return deep
    }
    const rightNested = (depth: number) => {
      let deep: Node.Node<number> = Node.succeed(0)
      for (let index = 1; index <= depth; index++) deep = Node.andThen(Node.succeed(index), deep)
      return deep
    }

    // The EXPORTED constant is the boundary, so a pattern computing its own
    // bound refusal reads the same number the build enforces.
    expect(Graph.maximumGraphDepth).toBe(1_000)
    expect(codeOf(() => Graph.build(leftNested(Graph.maximumGraphDepth)))).toBe("built")
    expect(codeOf(() => Graph.build(leftNested(Graph.maximumGraphDepth + 1)))).toBe("graph_too_deep")
    expect(codeOf(() => Graph.build(rightNested(Graph.maximumGraphDepth)))).toBe("built")
    expect(codeOf(() => Graph.build(rightNested(Graph.maximumGraphDepth + 1)))).toBe("graph_too_deep")
  })

  it("accepts a payload exactly maximumPayloadDepth containers deep and refuses one more", () => {
    const nested = (containers: number) => {
      let payload: Record<string, unknown> = { value: "leaf" }
      for (let index = 1; index < containers; index++) payload = { next: payload }
      return payload
    }

    expect(codeOf(() => Graph.build(Node.succeed(nested(1_000))))).toBe("built")
    expect(codeOf(() => Graph.build(Node.succeed(nested(1_001))))).toBe("payload_too_deep")
  })

  it("proves identity at exactly maxComparisonPairs and refuses one pair more", () => {
    // Comparing two arrays of length n examines the pair of arrays plus n
    // member pairs, so length 99_999 is exactly 100_000 pairs.
    const wide = (length: number) => Array.from({ length }, () => 0)
    expect(codeOf(() => buildWithPlacements(wide(99_999), wide(99_999)))).toBe("built")
    expect(codeOf(() => buildWithPlacements(wide(100_000), wide(100_000)))).toBe("placement_requires_boundary")
  })

  it("renders exactly maxPlacementMembers members without <more> and one more with it", () => {
    const message = (enclosing: unknown): string => {
      try {
        buildWithPlacements(enclosing, { host: "vm" })
      } catch (thrown) {
        return (thrown as { message: string }).message
      }
      throw new Error("the build did not refuse")
    }
    const wide = (members: number) => {
      const object: Record<string, number> = {}
      for (let index = 0; index < members; index++) object[`k${index}`] = 1
      return object
    }

    expect(message(Array.from({ length: 32 }, () => 1))).not.toContain("<more>")
    expect(message(Array.from({ length: 33 }, () => 1))).toContain("<more>")
    expect(message(wide(32))).not.toContain("<more>")
    expect(message(wide(33))).toContain("<more>")
  })

  it("reuses one schema document per declaration across nodes and builds", () => {
    const body = (graph: Graph.Graph) =>
      Graph.drafts(graph)
        .map((draft) => draft.material.body as { _tag: string; declaration?: { payload: unknown; success: unknown } })
        .filter((current) => current._tag === "ActionCall")
    const build = () => Graph.build(Node.all({ a: Increment.call({ path: "a" }), b: Increment.call({ path: "b" }) }))

    const [first, second] = body(build())
    const [again] = body(build())
    expect(first?.declaration?.payload).toBeDefined()
    expect(second?.declaration?.payload).toBe(first?.declaration?.payload)
    expect(again?.declaration?.payload).toBe(first?.declaration?.payload)
    expect(again?.declaration?.success).toBe(first?.declaration?.success)
  })

  it("hashes a payload and collects its references in one walk", () => {
    const containers = 10
    let payload: Record<string, unknown> = { value: "leaf" }
    for (let index = 1; index < containers; index++) payload = { next: payload, [`k${index}`]: index }

    const original = Object.getOwnPropertyDescriptors
    let opened = 0
    Object.getOwnPropertyDescriptors = ((source: object) => {
      opened++
      return original(source)
    }) as typeof Object.getOwnPropertyDescriptors
    let graph: Graph.Graph
    try {
      graph = Graph.build(Node.succeed(payload))
    } finally {
      Object.getOwnPropertyDescriptors = original
    }

    // One pass clones the AST in @smthrs/plan, one hydrates, and one hashes
    // and collects references together. Hashing and collecting used to be
    // two separate walks, for four passes per container.
    expect(opened).toBe(3 * containers)
    expect(Graph.drafts(graph).find((draft) => draft.id === "root")?.material.inputs).toEqual([
      { _tag: "Literal", value: payload }
    ])
  })
})
