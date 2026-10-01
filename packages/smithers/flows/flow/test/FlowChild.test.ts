/**
 * The `.child()` boundary: ONE node in the caller's plan, and a real child
 * execution underneath it.
 *
 * `docs/concepts/flows-and-actions.md` gives composition two modes —
 * inline by default, boundary by choice — and names the two cases that force
 * the boundary loudly at build time: a recursive `.call()`, and a placement the
 * caller cannot satisfy. Both refusals and the boundary they point at are here.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime, Graph, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { withCrypto } from "./Crypto.ts"
import { isComplete, pollUntil } from "./Harness.ts"
import { layerMemory, layerWired, makeInstance } from "./MemoryFlowRuntime.ts"

const Bump = Action.make("child/bump", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

/** The action invocations one case saw, in dispatch order. */
const calls: Array<string> = []

const bumps = Bump.toLayer(({ value }) =>
  Effect.sync(() => {
    calls.push(`bump:${value}`)
    return value + 1
  })
)

const Child = Flow.make("child/child", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Bump.call({ value })
})

const Parent = Flow.make("child/parent", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Child.child({ value }).pipe(Node.map((settled) => settled * 10))
})

/** The node id the boundary in `Parent`'s body is recorded under. */
const boundaryNode = "root.flow.map"

const node = (graph: Graph.Graph, id: string): Graph.GraphNode =>
  Graph.nodes(graph).find((observed) => observed.id === id)!

const wired = (
  registration: Layer.Layer<never, never, FlowRuntime.FlowRuntime | Action.Implementations>
) => layerWired(Layer.merge(bumps, registration))

const isSuspended = (result: Flow.Result<unknown, unknown>) => result._tag === "Suspended"

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

describe("Graph.build keeps a child boundary as a leaf", () => {
  it("records one node for the whole callee, with its tag, payload, and declared envelope", () => {
    const graph = Graph.build(Parent, { value: 4 })
    const boundary = node(graph, boundaryNode)

    // The callee has a body, and an inline call would have spliced it in as a
    // `.flow` child. A boundary has no children at all: one node, one leaf.
    expect(Graph.nodes(graph).map((observed) => [observed.id, observed.kind])).toEqual([
      [boundaryNode, "FlowCall"],
      ["root.flow", "Map"],
      ["root", "FlowCall"]
    ])
    expect(boundary.dependencies).toEqual([])
    expect(boundary.ast).toMatchObject({ _tag: "FlowCall", flow: "child/child", mode: "boundary" })
    expect(boundary.payload).toEqual({ value: 4 })
    expect(boundary.draft.material.body).toMatchObject({
      _tag: "FlowCall",
      flow: "child/child",
      mode: "boundary"
    })
    expect(boundary.draft.material.inputs).toEqual([{ _tag: "Literal", value: { value: 4 } }])
  })

  it("summarizes the callee's declared capabilities, effects, and placement in the material", () => {
    const effects: Flow.Effects = { reads: ["counter.txt"], writes: [], boundaryMode: "hard" }
    const placement = opaque({ host: "sandbox" })
    const Sealed = Flow.make("child/sealed", {
      payload: { value: Schema.Number },
      success: Schema.Number,
      body: ({ value }) => Bump.call({ value })
    })
      .annotate(Flow.Capabilities, ["fs:read"])
      .annotate(Flow.EffectsDeclaration, effects)
      .annotate(Flow.Placement, placement)
    const Caller = Flow.make("child/sealed-caller", {
      payload: {},
      success: Schema.Number,
      body: () => Sealed.child({ value: 1 })
    })
    const boundary = node(Graph.build(Caller, {}), "root.flow")

    expect(boundary.draft.effects).toEqual(effects)
    expect(boundary.draft.material.effects).toEqual(effects)
    expect(boundary.draft.material.placement).toEqual(placement)
    expect(boundary.placement).toEqual(placement)
    expect(boundary.draft.material.body).toMatchObject({
      declaration: { capabilities: ["fs:read"] }
    })
  })

  it("is the way out of the recursion refusal an inline self-call raises", () => {
    const Recursive: Flow.Flow<
      "child/recursive",
      Schema.Struct<{ depth: typeof Schema.Number }>,
      typeof Schema.Number,
      typeof Schema.Never
    > = Flow.make("child/recursive", {
      payload: { depth: Schema.Number },
      success: Schema.Number,
      body: ({ depth }): Node.Node<number> => Recursive.child({ depth })
    })

    // The same shape written as `.call()` throws `recursion_requires_boundary`
    // and names this as the fix; as a boundary it plans, because a leaf is not
    // an expansion.
    expect(Graph.nodes(Graph.build(Recursive, { depth: 0 })).map((observed) => observed.id))
      .toEqual(["root.flow", "root"])
  })
})

describe("Graph.build placement refusal", () => {
  const Remote = Flow.make("child/remote", {
    payload: { value: Schema.Number },
    success: Schema.Number,
    body: ({ value }) => Bump.call({ value })
  }).annotate(Flow.Placement, opaque({ host: "sandbox" }))

  it("refuses an inline call the enclosing flow cannot host, and directs to the boundary", () => {
    const Local = Flow.make("child/local", {
      payload: {},
      success: Schema.Number,
      body: () => Remote.call({ value: 1 })
    }).annotate(Flow.Placement, opaque({ host: "worker" }))

    expect(() => Graph.build(Local, {})).toThrowError(expect.objectContaining({
      _tag: "@smthrs/plan/GraphBuildError",
      code: "placement_requires_boundary",
      node: "root.flow",
      path: [],
      message: expect.stringMatching(/child\/remote\.child\(payload\)/)
    }))
  })

  it("keeps a placement refusal typed when rendering an object with a throwing tag", () => {
    class HostilePlacement {
      get [Symbol.toStringTag](): string {
        throw new Error("boom")
      }
    }
    const Hostile = Flow.make("child/hostile-placement", {
      payload: {},
      success: Schema.Number,
      body: () => Bump.call({ value: 1 })
    }).annotate(Flow.Placement, opaque(new HostilePlacement()))
    const Local = Flow.make("child/local-hostile-placement", {
      payload: {},
      success: Schema.Number,
      body: () => Hostile.call({})
    }).annotate(Flow.Placement, opaque({ host: "worker" }))

    expect(() => Graph.build(Local, {})).toThrowError(expect.objectContaining({
      _tag: "@smthrs/plan/GraphBuildError",
      code: "placement_requires_boundary"
    }))
  })

  it("admits the same pair as a child boundary", () => {
    const Local = Flow.make("child/local-boundary", {
      payload: {},
      success: Schema.Number,
      body: () => Remote.child({ value: 1 })
    }).annotate(Flow.Placement, opaque({ host: "worker" }))

    expect(node(Graph.build(Local, {}), "root.flow").draft.material.placement).toEqual({ host: "sandbox" })
  })

  it("treats an enclosing flow that declared no placement as unconstrained", () => {
    const Unconstrained = Flow.make("child/unconstrained", {
      payload: {},
      success: Schema.Number,
      body: () => Remote.call({ value: 1 })
    })

    expect(Graph.nodes(Graph.build(Unconstrained, {})).map((observed) => observed.id)).toEqual([
      "root.flow.flow",
      "root.flow",
      "root"
    ])
  })

  it("compares directives structurally, not by reference or key order", () => {
    const Placed = Flow.make("child/placed", {
      payload: { value: Schema.Number },
      success: Schema.Number,
      body: ({ value }) => Bump.call({ value })
    }).annotate(Flow.Placement, opaque({ host: "sandbox", pool: "a" }))
    const Same = Flow.make("child/same-placement", {
      payload: {},
      success: Schema.Number,
      body: () => Placed.call({ value: 1 })
    }).annotate(Flow.Placement, opaque({ pool: "a", host: "sandbox" }))

    expect(Graph.nodes(Graph.build(Same, {})).map((observed) => observed.id)).toEqual([
      "root.flow.flow",
      "root.flow",
      "root"
    ])
  })

  it("carries the enclosing placement down into a spliced body whose callee declared none", () => {
    const Middle = Flow.make("child/middle", {
      payload: {},
      success: Schema.Number,
      body: () => Remote.call({ value: 1 })
    })
    const Outer = Flow.make("child/outer", {
      payload: {},
      success: Schema.Number,
      body: () => Middle.call({})
    }).annotate(Flow.Placement, opaque({ host: "worker" }))

    // `Middle` declares nothing, so the refusal is raised against `Outer`'s
    // placement two levels down rather than being lost at the first hop.
    expect(() => Graph.build(Outer, {})).toThrowError(expect.objectContaining({
      code: "placement_requires_boundary",
      node: "root.flow.flow"
    }))
  })
})

describe("the interpreter drives a child boundary as a real execution", () => {
  it.effect("registers children with the parent layer's implementation context", () =>
    Effect.gen(function*() {
      class Offset extends Context.Service<Offset, number>()("child/registration-offset") {}
      const Read = Action.make("child/read-registration-offset", { payload: {}, success: Schema.Number })
      const Inner = Flow.make("child/context-inner", {
        payload: {},
        success: Schema.Number,
        body: () => Read.call({})
      })
      const Outer = Flow.make("child/context-outer", {
        payload: {},
        success: Schema.Number,
        body: () => Inner.child({})
      })
      const registration = Interpreter.layer(Outer).pipe(Layer.provide(Layer.succeed(Offset)(42)))
      const implementation = Read.toLayer(() => Offset)
      const layer = Layer.merge(implementation, registration).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(layerMemory)
      )

      // Offset is supplied by the registered handler's captured context,
      // rather than by the caller executing this flow.
      const value = yield* withCrypto(
        Outer.execute({}, { executionId: "parent-only-context" }).pipe(
          Effect.provide(layer as Layer.Layer<FlowRuntime.FlowRuntime | Action.Implementations>)
        )
      )

      expect(value).toBe(42)
    }))

  for (const mode of ["boundary", "inline"] as const) {
    it.effect(`registers transitive children from only the parent layer through ${mode} calls`, () =>
      Effect.gen(function*() {
        calls.length = 0
        const Middle = Flow.make(`child/registered-middle-${mode}`, {
          payload: { value: Schema.Number },
          success: Schema.Number,
          body: ({ value }) => Child.child({ value }).pipe(Node.map((answer) => answer * 2))
        })
        const Outer = Flow.make(`child/registered-outer-${mode}`, {
          payload: { value: Schema.Number },
          success: Schema.Number,
          body: ({ value }) =>
            (mode === "boundary" ? Middle.child({ value }) : Middle.call({ value })).pipe(
              Node.map((answer) => answer + 3)
            )
        })

        const value = yield* withCrypto(
          Outer.execute({ value: 4 }, { executionId: `parent-only-${mode}` }).pipe(
            Effect.provide(wired(Interpreter.layer(Outer)))
          )
        )

        expect(value).toBe(13)
        expect(calls).toEqual(["bump:4"])
      }))
  }

  it.effect("registers recursive children without expanding their bodies eagerly", () =>
    Effect.gen(function*() {
      const Recursive: Flow.Flow<
        "child/registered-recursive",
        Schema.Struct<{ depth: typeof Schema.Number }>,
        typeof Schema.Number,
        typeof Schema.Never
      > = Flow.make("child/registered-recursive", {
        payload: { depth: Schema.Number },
        success: Schema.Number,
        body: ({ depth }): Node.Node<number> =>
          depth === 0
            ? Node.succeed(0)
            : Recursive.child({ depth: depth - 1 }).pipe(Node.map((answer) => answer + 1))
      })
      const Outer = Flow.make("child/registered-recursive-parent", {
        payload: {},
        success: Schema.Number,
        body: () => Recursive.child({ depth: 3 })
      })

      const value = yield* withCrypto(
        Outer.execute({}, { executionId: "parent-only-recursion" }).pipe(
          Effect.provide(wired(Interpreter.layer(Outer)))
        )
      )

      expect(value).toBe(3)
    }))

  it.effect("runs the callee under a derived execution id and settles the node with its success", () =>
    Effect.gen(function*() {
      calls.length = 0
      const layer = wired(Layer.mergeAll(Interpreter.layer(Parent), Interpreter.layer(Child)))

      const settled = yield* withCrypto(
        Effect.gen(function*() {
          const value = yield* Parent.execute({ value: 4 }, { executionId: "child-parent-1" })
          const childId = yield* Interpreter.childExecutionId("child-parent-1", boundaryNode, Child._tag, { value: 4 })
          const childResult = yield* Child.poll(childId)
          return { childId, childResult, value }
        }).pipe(Effect.provide(layer))
      )

      expect(settled.value).toBe(50)
      expect(calls).toEqual(["bump:4"])
      expect(settled.childId).toMatch(/^[0-9a-f]{64}$/)
      expect(settled.childId).toBe("de42e9de2118e15f0849d62ff3dd52fdb48ceec24692f9caef86b023d35af875")
      // The child is its own execution with its own result, not a step of the
      // parent's: polling the derived id answers with the child's own settlement.
      expect(Option.isSome(settled.childResult)).toBe(true)
      expect(
        Option.isSome(settled.childResult) && settled.childResult.value._tag === "Complete" &&
          Exit.isSuccess(settled.childResult.value.exit) && settled.childResult.value.exit.value
      ).toBe(5)
    }))

  it.effect("does not rerun a settled child when the parent body is replayed", () =>
    Effect.gen(function*() {
      calls.length = 0
      const layer = wired(Interpreter.layer(Child))

      const replay = yield* withCrypto(
        Effect.gen(function*() {
          // Re-driving the BODY under one instance is what a replay is, and it is
          // the only shape that reaches the boundary node twice: asking the
          // runtime for the same parent execution id instead answers from the
          // settled parent without planning anything, so a minted child id would
          // pass that test unnoticed.
          const instance = makeInstance(Parent, "child-parent-replay")
          const drive = Interpreter.interpret(Parent, { value: 4 }).pipe(
            Effect.provideService(FlowRuntime.FlowInstance, instance)
          )
          const first = yield* drive
          const second = yield* drive
          return [first.value, second.value]
        }).pipe(Effect.scoped, Effect.provide(layer))
      )

      // The derived id is the whole mechanism: the second drive re-derives it and
      // lands on the child execution that already exists rather than opening a
      // second copy of it, so the callee's one action ran once.
      expect(replay).toEqual([50, 50])
      expect(calls).toEqual(["bump:4"])
    }))

  it.effect("suspends the parent while the child is suspended, and completes it when the child does", () =>
    Effect.gen(function*() {
      const Gate = DurableDeferred.make("child/gate", { success: Schema.Number })
      const Await = Action.make("child/await", { payload: {}, success: Schema.Number })
      const Gated = Flow.make("child/gated", {
        payload: {},
        success: Schema.Number,
        body: () => Await.call({})
      })
      const Waiting = Flow.make("child/waiting", {
        payload: {},
        success: Schema.Number,
        body: () => Gated.child({}).pipe(Node.map((settled) => settled + 1))
      })
      const layer = Layer.mergeAll(
        Await.toLayer(() => DurableDeferred.await(Gate)),
        Interpreter.layer(Waiting)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(layerMemory)
      )
      const settled = yield* withCrypto(
        Effect.gen(function*() {
          const childId = yield* Interpreter.childExecutionId("child-waiting", "root.flow.map", Gated._tag, {})
          yield* Waiting.execute({}, { executionId: "child-waiting", discard: true })
          const parked = yield* pollUntil(Waiting.poll("child-waiting"), isSuspended, { turns: 200 })
          const childParked = yield* pollUntil(Gated.poll(childId), isSuspended, { turns: 200 })

          yield* DurableDeferred.succeed(Gate, {
            token: DurableDeferred.tokenFromExecutionId(Gate, { flow: Gated, executionId: childId }),
            value: 41
          })
          const done = yield* pollUntil(Waiting.poll("child-waiting"), isComplete, { turns: 200 })
          return { childParked, done, parked }
        }).pipe(Effect.provide(layer))
      )

      // The child's suspension travelled: the parent is parked, not failed.
      expect(Option.isSome(settled.parked)).toBe(true)
      expect(Option.isSome(settled.childParked)).toBe(true)
      expect(
        Option.isSome(settled.done) && settled.done.value._tag === "Complete" &&
          Exit.isSuccess(settled.done.value.exit) && settled.done.value.exit.value
      ).toBe(42)
    }))

  it.effect("refuses a boundary whose declaration did not survive serialization", () =>
    Effect.gen(function*() {
      const authored: Node.Node<number> = Node.flowCall(Child, "child/child", "boundary", { value: 1 })
      const lost: Node.Node<number> = {
        ...authored,
        ast: JSON.parse(JSON.stringify(authored.ast)) as Node.Ast
      }

      const exit = yield* withCrypto(
        Effect.exit(Interpreter.interpret(lost)).pipe(
          Effect.provideService(
            FlowRuntime.FlowInstance,
            makeInstance(Flow.make("child/host", { payload: {}, body: () => Node.succeed(undefined) }), "child-host")
          ),
          Effect.provide(wired(Layer.empty))
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
        error: {
          _tag: "@smthrs/flow/InterpreterError",
          code: "unsupported_call",
          node: "root",
          message: expect.stringContaining("lost its declaration")
        }
      })
    }))
})
