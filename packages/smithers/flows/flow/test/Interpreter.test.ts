/**
 * The body interpreter, against the authoring package's own runtime fixture:
 * what each node variant does when it is driven with real values, and what the
 * interpreter refuses.
 */
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node, Planned } from "@smthrs/plan"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { withCrypto } from "./Crypto.ts"
import { layerMemory, layerWired, makeInstance } from "./MemoryFlowRuntime.ts"

const Read = Action.make("interpreter/read", {
  payload: { path: Schema.String },
  success: Schema.Struct({ value: Schema.Number, files: Schema.Array(Schema.String) })
})

const Write = Action.make("interpreter/write", {
  payload: { path: Schema.String, value: Schema.Number },
  success: Schema.Number
})

const Sum = Action.make("interpreter/sum", {
  payload: { values: Schema.Array(Schema.Number), label: Schema.String },
  success: Schema.Number
})

const Fallible = Action.make("interpreter/fallible", {
  payload: { fail: Schema.Boolean, error: Schema.String },
  success: Schema.Number,
  error: Schema.String
})

/** The calls each action received, in the order the walk dispatched them. */
const calls: Array<string> = []

const implementations = Layer.mergeAll(
  Read.toLayer(({ path }) =>
    Effect.sync(() => {
      calls.push(`read:${path}`)
      return { value: 41, files: [`${path}.a`, `${path}.b`] }
    })
  ),
  Write.toLayer(({ path, value }) =>
    Effect.sync(() => {
      calls.push(`write:${path}:${value}`)
      return value + 1
    })
  ),
  Sum.toLayer(({ label, values }) =>
    Effect.sync(() => {
      calls.push(`sum:${label}`)
      return values.reduce((total, value) => total + value, 0)
    })
  ),
  Fallible.toLayer(({ error, fail }) => fail ? Effect.fail(error) : Effect.succeed(7))
)

/** What a layer under test may ask for: the table, and a runtime to register with. */
type Wiring = Layer.Layer<never, never, FlowRuntime.FlowRuntime | Action.Implementations>

/** Everything a driven body needs: the table, the implementations, a runtime. */
const wired = (registration: Wiring = Layer.empty) => layerWired(Layer.merge(implementations, registration))

/** A bare interpretation, outside any registered flow execution. */
const drive = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Crypto.Crypto | FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | Action.Implementations
  >,
  layer: Layer.Layer<
    FlowRuntime.FlowRuntime | Action.Implementations,
    never,
    Crypto.Crypto
  > = wired()
) =>
  withCrypto(
    effect.pipe(
      Effect.provideService(
        FlowRuntime.FlowInstance,
        makeInstance(
          Flow.make("interpreter/host", { payload: {}, body: () => Node.succeed(undefined) }),
          "interpretation"
        )
      ),
      Effect.provide(layer)
    )
  )

/** An AST that crossed a serialization boundary, leaving its side tables behind. */
const detached = <A, E = never, R = never>(built: Node.Node<A, E, R>): Node.Node<A, E, R> => ({
  ...built,
  ast: JSON.parse(JSON.stringify(built.ast)) as Node.Ast
})

const refusal = (
  effect: Effect.Effect<
    unknown,
    unknown,
    Crypto.Crypto | FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | Action.Implementations
  >
) =>
  Effect.gen(function*() {
    const exit = yield* drive(Effect.exit(effect))
    expect(Exit.isFailure(exit)).toBe(true)
    return Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  })

describe("Interpreter.layer", () => {
  it.effect("drives actions, reference paths, and a deferred map end to end", () =>
    Effect.gen(function*() {
      calls.length = 0
      const Pipeline = Flow.make("interpreter/pipeline", {
        payload: { path: Schema.String },
        success: Schema.Number,
        body: ({ path }) =>
          Read.call({ path }).pipe(
            Node.bindPlanned((result) => Write.call({ path: result.files[1]!, value: result.value })),
            Node.map((written) => written * 2)
          )
      })

      const value = yield* withCrypto(
        Pipeline.execute({ path: "counter.txt" }, { executionId: "pipeline-1" }).pipe(
          Effect.provide(wired(Interpreter.layer(Pipeline)))
        )
      )

      expect(value).toBe(84)
      expect(calls).toEqual(["read:counter.txt", "write:counter.txt.b:41"])
    }))

  it.effect("returns the recorded result for a replayed execution id without rerunning the effects", () =>
    Effect.gen(function*() {
      calls.length = 0
      const Replayed = Flow.make("interpreter/replayed", {
        payload: { path: Schema.String },
        success: Schema.Number,
        body: ({ path }) => Write.call({ path, value: 1 })
      })
      const layer = wired(Interpreter.layer(Replayed))

      const results = yield* withCrypto(
        Effect.gen(function*() {
          const first = yield* Replayed.execute({ path: "replay.txt" }, { executionId: "replay-1" })
          const second = yield* Replayed.execute({ path: "replay.txt" }, { executionId: "replay-1" })
          return [first, second]
        }).pipe(Effect.provide(layer))
      )

      expect(results).toEqual([2, 2])
      expect(calls).toEqual(["write:replay.txt:1"])
    }))
})

describe("Interpreter payload resolution", () => {
  it.effect("keeps an own __proto__ field as data in the value a node is driven with", () =>
    Effect.gen(function*() {
      const interpretation = yield* drive(
        Interpreter.interpret(Node.succeed({ data: { ["__proto__"]: "own" } }))
      )
      const data = (interpretation.value as { readonly data: Record<string, unknown> }).data

      expect(Object.hasOwn(data, "__proto__")).toBe(true)
      expect(data["__proto__"]).toBe("own")
    }))

  it.effect("records an object-valued own __proto__ field instead of reparenting the resolved value", () =>
    Effect.gen(function*() {
      const interpretation = yield* drive(
        Interpreter.interpret(Node.succeed({ data: { ["__proto__"]: { evil: 1 } } }))
      )
      const data = (interpretation.value as { readonly data: Record<string, unknown> }).data

      expect(Object.getPrototypeOf(data)).toBe(null)
      expect(data["__proto__"]).toEqual({ evil: 1 })
      // Reparenting would have served `evil` off the prototype instead.
      expect(data["evil"]).toBeUndefined()
    }))
})

describe("Interpreter projected constants", () => {
  it.effect("delivers the documented projection through Flow.done", () =>
    Effect.gen(function*() {
      const node = Flow.done(new Date(0))
      expectTypeOf<Node.Success<typeof node>>().toEqualTypeOf<{
        readonly _tag: "Done"
        readonly value: string | null
      }>()
      expect((yield* drive(Interpreter.interpret(node))).value).toMatchObject({
        _tag: "Done",
        value: "1970-01-01T00:00:00.000Z"
      })
    }))
})

describe("Interpreter branches", () => {
  const Increment = Action.make("interpreter/increment", {
    payload: { path: Schema.String },
    success: Schema.Number
  })

  const CountTo = (settledValue: number) =>
    Layer.mergeAll(Increment.toLayer(() => Effect.succeed(settledValue))).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(layerMemory)
    )

  const Decide = Flow.make("interpreter/decide", {
    payload: { path: Schema.String, target: Schema.Number },
    success: Schema.Unknown,
    body: ({ path, target }): Node.Node<unknown, never, Action.Requirement<"interpreter/increment">> =>
      Increment.call({ path }).pipe(
        Node.branch({
          if: (value) => value >= target,
          then: (value) => Flow.done(value),
          else: (): Node.Node<unknown> => Decide.to({ path, target })
        })
      )
  })

  it.effect("takes the snapshotted arm after caller options change", () =>
    Effect.gen(function*() {
      const options = {
        if: Node.capture({}, (_value: number) => true),
        then: () => Node.succeed("then"),
        else: () => Node.succeed("else")
      }
      const node = Node.branch(Node.succeed(1), options)
      options.if = Node.capture({}, (_value: number) => false)
      expect((yield* drive(Interpreter.interpret(node))).value).toBe("then")
    }))

  it.effect("takes the then arm on a real value and settles the untaken arm as skipped", () =>
    Effect.gen(function*() {
      const interpretation = yield* drive(
        Interpreter.interpret(Decide, { path: "counter.txt", target: 100 }),
        CountTo(100)
      )

      expect(interpretation.value).toEqual({ _tag: "Done", value: 100 })
      expect(interpretation.skipped).toEqual(["root.flow.else"])
      expect(interpretation.settled.get("root.flow.branch")).toBe(100)
    }))

  it.effect("takes the else arm on a real value, and the taken arm is the one that settles", () =>
    Effect.gen(function*() {
      const interpretation = yield* drive(
        Interpreter.interpret(Decide, { path: "counter.txt", target: 100 }),
        CountTo(7)
      )

      expect(interpretation.value).toEqual({
        _tag: "To",
        flow: "interpreter/decide",
        payload: { path: "counter.txt", target: 100 }
      })
      expect(interpretation.skipped).toEqual(["root.flow.then"])
    }))

  it.effect("refuses a branch whose predicate did not survive serialization", () =>
    Effect.gen(function*() {
      const lost = detached(
        Node.succeed(1).pipe(
          Node.branch({ if: (value) => value > 0, then: () => Node.succeed("yes"), else: () => Node.succeed("no") })
        )
      )

      expect(yield* refusal(Interpreter.interpret(lost))).toMatchObject({
        error: { _tag: "@smthrs/flow/InterpreterError", code: "missing_operation", node: "root" }
      })
    }))
})

describe("Interpreter catches", () => {
  for (
    const [operation, node] of [
      ["mapper", Read.call({ path: "counter.txt" }).pipe(Node.map((value) => value.value))],
      [
        "predicate",
        Node.succeed(1).pipe(Node.branch({
          if: (value) => value > 0,
          then: () => Node.succeed(1),
          else: () => Node.succeed(0)
        }))
      ],
      [
        "schema filter",
        Node.succeed(1).pipe(Node.catch({
          error: Schema.String,
          onFailure: () => Node.succeed(0)
        }))
      ]
    ] as const
  ) {
    it.effect(`refuses a detached ${operation} inside an unfiltered catch before dispatch`, () =>
      Effect.gen(function*() {
        calls.length = 0
        const caught = Read.call({ path: "upstream.txt" }).pipe(
          Node.andThen(node),
          Node.catch({ onFailure: () => Node.succeed("recovered-from-interpreter-refusal") })
        )

        const exit = yield* drive(Effect.exit(Interpreter.interpret(detached(caught))))
        expect(calls).toEqual([])
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons[0]).toMatchObject({
            error: {
              _tag: "@smthrs/flow/InterpreterError",
              code: "missing_operation",
              message: expect.stringContaining(`lost its ${operation}`)
            }
          })
        }
      }))
  }

  it.effect("does not recover a walk-time interpreter refusal with an unfiltered catch", () =>
    Effect.gen(function*() {
      const Callee = Flow.make("interpreter/caught-leaf-callee", {
        payload: {},
        success: Schema.Number,
        body: () => Node.succeed(1)
      })
      const inline = Node.flowCall<number>(Callee, Callee._tag, "inline", {})
      const caught = inline.pipe(Node.catch({ onFailure: () => Node.succeed(0) }))

      expect(yield* refusal(Interpreter.interpret(detached(caught)))).toMatchObject({
        error: { _tag: "@smthrs/flow/InterpreterError", code: "unsupported_call", node: "root.protected" }
      })
    }))

  it.effect("takes a matching failure arm and binds the typed error", () =>
    Effect.gen(function*() {
      const interpretation = yield* drive(Interpreter.interpret(
        Fallible.call({ fail: true, error: "recoverable" }).pipe(
          Node.catch({
            error: Schema.Literal("recoverable"),
            onFailure: (error) => Node.succeed({ recovered: error })
          })
        )
      ))

      expect(interpretation.value).toEqual({ recovered: "recoverable" })
      expect(interpretation.settled.has("root.protected")).toBe(false)
      expect(interpretation.failed.get("root.protected")).toBe("recoverable")
      expect(interpretation.skipped).toEqual([])
    }))

  it.effect("recovers a constant failure exactly as it recovers an action failure", () =>
    Effect.gen(function*() {
      calls.length = 0
      const interpretation = yield* drive(Interpreter.interpret(
        Node.fail({ reason: "quota" } as const).pipe(
          Node.catch({ onFailure: (error) => Node.succeed({ recovered: error }) })
        )
      ))

      expect(interpretation.value).toEqual({ recovered: { reason: "quota" } })
      expect(calls).toEqual([])
      expect(interpretation.settled.has("root.protected")).toBe(false)
      expect(interpretation.failed.get("root.protected")).toEqual({ reason: "quota" })
      expect(interpretation.skipped).toEqual([])
    }))

  it.effect("filters a constant failure by schema like any other typed error", () =>
    Effect.gen(function*() {
      const caught = yield* drive(Interpreter.interpret(
        Node.fail("recoverable" as const).pipe(
          Node.catch({ error: Schema.Literal("recoverable"), onFailure: () => Node.succeed(0) })
        )
      ))
      expect(caught.value).toBe(0)

      expect(
        yield* refusal(Interpreter.interpret(
          Node.fail("fatal" as const).pipe(
            Node.catch({ error: Schema.Literal("recoverable"), onFailure: () => Node.succeed(0) })
          )
        ))
      ).toMatchObject({ error: "fatal" })
    }))

  it.effect("surfaces an uncaught constant failure as the flow's typed failure", () =>
    Effect.gen(function*() {
      calls.length = 0
      const exit = yield* drive(Effect.exit(Interpreter.interpret(
        Write.call({ path: "unreached.txt", value: 1 }).pipe(
          Node.andThen(Node.fail({ reason: "quota" } as const))
        )
      )))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons[0]).toMatchObject({ error: { reason: "quota" } })
      }
      expect(calls).toEqual(["write:unreached.txt:1"])
    }))

  it.effect("passes through success and leaves the failure arm skipped", () =>
    Effect.gen(function*() {
      const interpretation = yield* drive(Interpreter.interpret(
        Fallible.call({ fail: false, error: "unused" }).pipe(
          Node.catch({ onFailure: () => Node.succeed(0) })
        )
      ))

      expect(interpretation.value).toBe(7)
      expect(interpretation.skipped).toEqual(["root.failure"])
    }))

  it.effect("preserves an empty string rejected by NonEmptyString", () =>
    Effect.gen(function*() {
      expect(
        yield* refusal(Interpreter.interpret(
          Fallible.call({ fail: true, error: "" }).pipe(Node.catch({
            error: Schema.NonEmptyString,
            onFailure: () => Node.succeed(0)
          }))
        ))
      ).toMatchObject({ error: "" })
    }))

  it.effect("propagates an unmatched typed error", () =>
    Effect.gen(function*() {
      expect(
        yield* refusal(Interpreter.interpret(
          Fallible.call({ fail: true, error: "fatal" }).pipe(
            Node.catch({
              error: Schema.Literal("recoverable"),
              onFailure: () => Node.succeed(0)
            })
          )
        ))
      ).toMatchObject({ error: "fatal" })
    }))

  it.effect("allows an outer catch to recover an error unmatched by an inner catch", () =>
    Effect.gen(function*() {
      const interpretation = yield* drive(Interpreter.interpret(
        Fallible.call({ fail: true, error: "outer" }).pipe(
          Node.catch({
            error: Schema.Literal("inner"),
            onFailure: () => Node.succeed(1)
          }),
          Node.catch({ onFailure: (error) => Node.succeed({ outer: error }) })
        )
      ))

      expect(interpretation.value).toEqual({ outer: "outer" })
      expect(interpretation.failed).toEqual(
        new Map([
          ["root.protected.protected", "outer"],
          ["root.protected", "outer"]
        ])
      )
      expect(interpretation.skipped).toEqual(["root.protected.failure"])
    }))

  it.effect("refuses when a serialized catch loses its schema filter", () =>
    Effect.gen(function*() {
      const lost = detached(
        Fallible.call({ fail: true, error: "recoverable" }).pipe(
          Node.catch({ error: Schema.String, onFailure: () => Node.succeed(0) })
        )
      )

      expect(yield* refusal(Interpreter.interpret(lost))).toMatchObject({
        error: { _tag: "@smthrs/flow/InterpreterError", code: "missing_operation", node: "root" }
      })
    }))
})

describe("Interpreter node variants", () => {
  it.effect("joins a combination by member name and threads planned arrays into a payload", () =>
    Effect.gen(function*() {
      calls.length = 0
      const Joined = Flow.make("interpreter/joined", {
        payload: { path: Schema.String },
        success: Schema.Number,
        body: ({ path }) =>
          Node.all({ left: Read.call({ path }), right: Node.succeed(2) }).pipe(
            Node.bindPlanned((both) => Sum.call({ values: [both.left.value, both.right], label: path }))
          )
      })

      const interpretation = yield* drive(Interpreter.interpret(Joined, { path: "counter.txt" }))

      expect(interpretation.value).toBe(43)
      expect(interpretation.settled.get("root.flow.andThen")).toEqual({
        left: { value: 41, files: ["counter.txt.a", "counter.txt.b"] },
        right: 2
      })
      expect(interpretation.skipped).toEqual([])
      expect(calls).toEqual(["read:counter.txt", "sum:counter.txt"])
    }))

  it.effect("interprets dotted All member names whose addresses do not collide", () =>
    Effect.gen(function*() {
      const interpretation = yield* drive(Interpreter.interpret(Node.all({
        "x.all.z": Node.succeed("outer"),
        x: Node.all({ y: Node.succeed("nested") })
      })))

      expect(interpretation.value).toEqual({
        "x.all.z": "outer",
        x: { y: "nested" }
      })
    }))

  it.effect("preserves an own __proto__ member when joining a combination", () =>
    Effect.gen(function*() {
      const members = Object.create(null) as Record<string, Node.Any>
      Object.defineProperty(members, "__proto__", {
        enumerable: true,
        value: Node.succeed({ safe: true })
      })
      Object.defineProperty(members, "ordinary", { enumerable: true, value: Node.succeed(1) })

      const interpretation = yield* drive(Interpreter.interpret(Node.all(members)))
      const joined = interpretation.value as Record<string, unknown>

      expect(Object.getPrototypeOf(joined)).toBe(null)
      expect(Object.hasOwn(joined, "__proto__")).toBe(true)
      expect(joined["__proto__"]).toEqual({ safe: true })
      expect(joined["ordinary"]).toBe(1)
      expect(joined["safe"]).toBeUndefined()
    }))

  it.effect("settles a bare node graph under a caller-chosen root", () =>
    Effect.gen(function*() {
      const interpretation = yield* drive(
        Interpreter.interpret(
          Node.succeed({ label: "round", nothing: null, values: [1, 2] }),
          undefined,
          { root: "round-1" }
        )
      )

      expect(interpretation.value).toEqual({ label: "round", nothing: null, values: [1, 2] })
      expect([...interpretation.settled.keys()]).toEqual(["round-1"])
    }))

  it.effect("refuses a payload reference to a node this graph does not hold", () =>
    Effect.gen(function*() {
      calls.length = 0
      const Follow = Flow.make("interpreter/follow", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        body: ({ value }) => Write.call({ path: "next.txt", value })
      })

      // The shape `Plan.append` plans a later round in: a payload naming a node
      // an earlier generation settled. One interpretation settles one graph.
      expect(
        yield* refusal(
          Interpreter.interpret(
            Follow,
            { value: Planned.make<number>("round-0") },
            { root: "round-1" }
          )
        )
      ).toMatchObject({
        error: {
          _tag: "@smthrs/flow/InterpreterError",
          code: "unresolved_reference",
          node: "round-1.flow",
          message: expect.stringContaining("round-0")
        }
      })
      expect(calls).toEqual([])
    }))
})

describe("Interpreter refusals", () => {
  const Missing = Action.make("interpreter/missing", {
    payload: { path: Schema.String },
    success: Schema.Number
  })

  it.effect("names the action that has no implementation", () =>
    Effect.gen(function*() {
      const Orphan = Flow.make("interpreter/orphan", {
        payload: { path: Schema.String },
        success: Schema.Number,
        body: ({ path }) => Missing.call({ path })
      })

      expect(yield* refusal(Interpreter.interpret(Orphan, { path: "counter.txt" }))).toMatchObject({
        error: {
          _tag: "@smthrs/flow/InterpreterError",
          code: "unresolved_action",
          flow: "interpreter/orphan",
          node: "root.flow",
          message: expect.stringContaining("interpreter/missing.toLayer(execute)")
        }
      })
    }))

  it.effect("refuses duplicate node ids before constructing a last-write-wins lookup", () =>
    Effect.gen(function*() {
      const collided = Node.all({
        "x.all.y": Node.succeed("outer"),
        x: Node.all({ y: Node.succeed("nested") })
      })

      expect(yield* refusal(Interpreter.interpret(collided))).toMatchObject({
        error: {
          _tag: "@smthrs/flow/InterpreterError",
          code: "duplicate_node_id",
          flow: "node",
          node: "root.all.x.all.y",
          message: expect.stringContaining("durable dispatch identity")
        }
      })
    }))

  it.effect("maps a synchronous graph-build refusal into the typed interpreter channel", () =>
    Effect.gen(function*() {
      const Recursive = Flow.make("interpreter/recursive", {
        payload: { depth: Schema.Number },
        success: Schema.Number,
        body: ({ depth }): Node.Node<number> => Recursive.call({ depth })
      })

      const reason = yield* refusal(Interpreter.interpret(Recursive, { depth: 0 }))
      expect(reason).toMatchObject({
        error: {
          _tag: "@smthrs/flow/InterpreterError",
          code: "incomplete_graph",
          flow: "interpreter/recursive",
          node: "root.flow"
        }
      })
      expect((reason as { readonly error: Error }).error.message).toContain("cannot call itself inline")
    }))

  it.effect("keeps the reason when a body throws something that is not a build refusal", () =>
    Effect.gen(function*() {
      // A body is arbitrary code: a target implementation validates its own
      // declaration and throws a plain Error naming the fix. That value has no
      // `node`, and reading one built an InterpreterError the schema rejected,
      // so the author read "Schema validation failed" instead of the fix.
      const Refusing = Flow.make("interpreter/body-throws", {
        payload: {},
        success: Schema.Number,
        body: (): Node.Node<number> => {
          throw new Error("the rendered workflow is missing required jobs: rust")
        }
      })

      expect(yield* refusal(Interpreter.interpret(Refusing, {}))).toMatchObject({
        error: {
          _tag: "@smthrs/flow/InterpreterError",
          code: "incomplete_graph",
          flow: "interpreter/body-throws",
          node: "",
          message: "the rendered workflow is missing required jobs: rust"
        }
      })
    }))

  it.effect("names the thrown value when a body throws one that carries no message", () =>
    Effect.gen(function*() {
      const Refusing = Flow.make("interpreter/body-throws-bare", {
        payload: {},
        success: Schema.Number,
        body: (): Node.Node<number> => {
          throw "bare refusal"
        }
      })

      expect(yield* refusal(Interpreter.interpret(Refusing, {}))).toMatchObject({
        error: {
          _tag: "@smthrs/flow/InterpreterError",
          code: "incomplete_graph",
          flow: "interpreter/body-throws-bare",
          node: "",
          message: "building the graph of flow interpreter/body-throws-bare threw bare refusal"
        }
      })
    }))

  it.effect("keeps graph-build catch fields inert when a body throws accessor-backed data", () =>
    Effect.gen(function*() {
      let messageReads = 0
      const accessor = Object.defineProperty({}, "message", {
        get() {
          messageReads++
          throw new Error("secondary")
        }
      })
      const thrown = new Proxy(accessor, {
        getOwnPropertyDescriptor(target, key) {
          if (key === "node") throw new Error("descriptor trap")
          return Reflect.getOwnPropertyDescriptor(target, key)
        }
      })
      const Refusing = Flow.make("interpreter/body-throws-accessor", {
        payload: {},
        success: Schema.Number,
        body: (): Node.Node<number> => {
          throw thrown
        }
      })

      expect(yield* refusal(Interpreter.interpret(Refusing, {}))).toMatchObject({
        error: {
          _tag: "@smthrs/flow/InterpreterError",
          code: "incomplete_graph",
          flow: "interpreter/body-throws-accessor",
          node: ""
        }
      })
      expect(messageReads).toBe(0)
    }))

  it.effect("refuses an unimplemented action before the implemented ones ahead of it run", () =>
    Effect.gen(function*() {
      calls.length = 0
      // Wiring is knowable from the graph, so it is refused from the graph. The
      // alternative surfaces the same error after `Read` has already committed
      // whatever its implementation does.
      const Half = Flow.make("interpreter/half-wired", {
        payload: { path: Schema.String },
        success: Schema.Number,
        body: ({ path }) =>
          Read.call({ path }).pipe(Node.bindPlanned((result) => Missing.call({ path: result.files[0]! })))
      })

      expect(yield* refusal(Interpreter.interpret(Half, { path: "counter.txt" }))).toMatchObject({
        error: { code: "unresolved_action", node: "root.flow.then" }
      })
      expect(calls).toEqual([])
    }))

  it.effect("refuses a graph whose topology is incomplete", () =>
    Effect.gen(function*() {
      const lost = detached(Node.succeed(1).pipe(Node.bindPlanned(() => Node.succeed(2))))

      expect(yield* refusal(Interpreter.interpret(lost))).toMatchObject({
        error: { _tag: "@smthrs/flow/InterpreterError", code: "incomplete_graph", flow: "node", node: "root" }
      })
    }))

  it.effect("refuses a map whose deferred function did not survive serialization", () =>
    Effect.gen(function*() {
      calls.length = 0
      const lost = detached(Read.call({ path: "counter.txt" }).pipe(Node.map((value) => value.value + 1)))

      expect(yield* refusal(Interpreter.interpret(lost))).toMatchObject({
        error: { _tag: "@smthrs/flow/InterpreterError", code: "missing_operation", node: "root" }
      })
      expect(calls).toEqual([])
    }))

  it.effect("refuses an inline call it keeps as a leaf, naming the same process and the boundary as the fixes", () =>
    Effect.gen(function*() {
      // Every flow has a body, so the only inline call with nothing to splice is
      // one whose declaration did not survive beside its AST — and a leaf inline
      // call is the one flow node with no behavior at all. `.child()` is a leaf
      // too, but it has an execution underneath it.
      const Callee = Flow.make("interpreter/leaf-callee", {
        payload: { path: Schema.String },
        success: Schema.Number,
        body: ({ path }) => Write.call({ path, value: 1 })
      })
      const inline = detached<number>(
        Node.flowCall(Callee, "interpreter/leaf-callee", "inline", { path: "p" })
      )

      expect(yield* refusal(Interpreter.interpret(inline))).toMatchObject({
        error: {
          _tag: "@smthrs/flow/InterpreterError",
          code: "unsupported_call",
          node: "root",
          message: expect.stringContaining("interpreter/leaf-callee.child(payload)")
        }
      })
    }))

  it.effect("refuses a detached handoff whose declaration cannot encode its payload", () =>
    Effect.gen(function*() {
      const Target = Flow.make("interpreter/handoff-target", {
        payload: { path: Schema.String },
        success: Schema.Number,
        body: () => Node.succeed(0)
      })
      const lost = detached(
        Node.flowCall<number>(Target, Target._tag, "handoff", { path: "p" })
      )

      expect(yield* refusal(Interpreter.interpret(lost))).toMatchObject({
        error: {
          _tag: "@smthrs/flow/InterpreterError",
          code: "unsupported_call",
          node: "root",
          message: expect.stringContaining("lost its declaration")
        }
      })
    }))
})

describe("a flow's behavior is its body", () => {
  const Bodied = Flow.make("interpreter/bodied", {
    payload: { path: Schema.String },
    success: Schema.Number,
    body: ({ path }) => Write.call({ path, value: 1 })
  })

  it("has no handler attachment point, in the type or on the value", () => {
    expectTypeOf(Bodied).not.toHaveProperty("toLayer")
    // An erased `Flow.Any` and a JavaScript caller reach the same surface, so
    // the refusal is the absence of the property rather than a run-time defect.
    expect("toLayer" in Bodied).toBe(false)
  })

  it("kept nothing the optional-body stage needed", () => {
    // `Flow.Bodied` described a flow that had a body, which is now every flow;
    // `BodyDefinesBehavior` was the defect a bodied flow raised when a second,
    // opaque behavior was attached to it; `missing_body` was the interpreter
    // refusing a flow with nothing to interpret. None of the three has anything
    // left to name.
    // @ts-expect-error -- `Flow.Flow` is the type of a flow that has a body.
    type _Bodied = Flow.Bodied
    expect("BodyDefinesBehavior" in Flow).toBe(false)
    expectTypeOf<Interpreter.InterpreterError["code"]>().toEqualTypeOf<
      | "incomplete_graph"
      | "duplicate_node_id"
      | "unresolved_action"
      | "implementation_version_mismatch"
      | "missing_implementation_version"
      | "unresolved_reference"
      | "unsupported_call"
      | "missing_operation"
      | "node_record_too_large"
      | "join_mismatch"
    >()
  })

  it("keeps that surface, and the body itself, across annotation", () => {
    const annotated = Bodied.annotate(Flow.Capabilities, ["fs"])
    const merged = Bodied.annotateMerge(Context.empty())

    expectTypeOf(annotated).not.toHaveProperty("toLayer")
    expectTypeOf(merged).not.toHaveProperty("toLayer")
    expect("toLayer" in annotated).toBe(false)
    expect("toLayer" in merged).toBe(false)
    expect(annotated.body).toBe(Bodied.body)
    expect(merged.body).toBe(Bodied.body)
  })

  it.effect("runs that body through the interpreter's registration layer", () =>
    Effect.gen(function*() {
      calls.length = 0
      const value = yield* withCrypto(
        Bodied.execute({ path: "bodied.txt" }, { executionId: "bodied-1" }).pipe(
          Effect.provide(wired(Interpreter.layer(Bodied)))
        )
      )

      expect(value).toBe(2)
      expect(calls).toEqual(["write:bodied.txt:1"])
    }))
})

/**
 * Concurrency parity with `PlanScheduler`.
 *
 * The walk settled material dependencies and `All` members strictly
 * sequentially, so the same graph ran parallel under the scheduler and serial
 * here. Two execution surfaces disagreeing about concurrency is a correctness
 * hazard, not just a latency one.
 *
 * Nothing here sleeps: overlap is proved by a body that parks until another
 * body releases it, so a sequential walk deadlocks rather than passing slowly.
 */
describe("Interpreter concurrency", () => {
  /** Parks until {@link Release} runs, then reports the value it was given. */
  const Parking = Action.make("interpreter/parking", {
    payload: { name: Schema.String },
    success: Schema.Number
  })

  /** Releases every parked body. */
  const Release = Action.make("interpreter/release", { payload: {}, success: Schema.Number })

  const Failing = Action.make("interpreter/failing", {
    payload: { name: Schema.String },
    success: Schema.Number,
    error: Schema.String
  })

  interface Trace {
    readonly entered: Array<string>
    readonly interrupted: Array<string>
    readonly release: () => void
    readonly opened: Promise<void>
  }

  const concurrent = () => {
    let release = () => {}
    const opened = new Promise<void>((resolve) => {
      release = resolve
    })
    const state: Trace = { entered: [], interrupted: [], release: () => release(), opened }
    const layer = Layer.mergeAll(
      Parking.toLayer(({ name }) =>
        Effect.gen(function*() {
          state.entered.push(name)
          yield* Effect.promise(() => state.opened)
          return state.entered.length
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              state.interrupted.push(name)
            })
          )
        )
      ),
      Release.toLayer(() =>
        Effect.sync(() => {
          state.release()
          return 0
        })
      ),
      Failing.toLayer(({ name }) => Effect.fail(`${name} failed`))
    )
    return { state, layer }
  }

  const driveWith = <A, E>(
    layer: Wiring,
    effect: Effect.Effect<
      A,
      E,
      Crypto.Crypto | FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | Action.Implementations
    >
  ) =>
    drive(
      effect,
      Layer.mergeAll(implementations, layer).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(layerMemory)
      )
    )

  it.effect("settles `All` members concurrently", () =>
    Effect.gen(function*() {
      // `left` parks. Only `release`, a sibling member, unparks it — so this
      // resolves at all only because the two members overlapped.
      const { layer, state } = concurrent()
      const value = yield* driveWith(
        layer,
        Interpreter.interpret(Node.all({
          left: Parking.call({ name: "left" }),
          release: Release.call({})
        }))
      )
      expect(state.entered).toEqual(["left"])
      expect(value.value).toMatchObject({ release: 0 })
    }))

  it.effect("settles a shared dependency exactly once under concurrent demand", () =>
    Effect.gen(function*() {
      // A diamond: two `All` members whose material inputs both reference the
      // same upstream node. `settled.has()` answers "has this FINISHED", so two
      // demands arriving while the upstream is still parked would both execute
      // it. The in-flight deferred map is what makes the second one join the
      // first instead.
      const { layer, state } = concurrent()
      const value = yield* driveWith(
        layer,
        Interpreter.interpret(
          Parking.call({ name: "shared" }).pipe(
            Node.bindPlanned((shared) =>
              Node.all({
                left: Sum.call({ values: [shared], label: "left" }),
                right: Sum.call({ values: [shared], label: "right" }),
                release: Release.call({})
              })
            )
          )
        )
      )
      // Executed once despite two concurrent demands.
      expect(state.entered).toEqual(["shared"])
      expect(value.value).toMatchObject({ left: 1, right: 1 })
    }))

  it.effect("fails the parent and interrupts the surviving sibling", () =>
    Effect.gen(function*() {
      // Fail-fast with sibling interruption is the accepted semantics: it
      // matches `Effect.forEach`'s default and the scheduler's halt rule. The
      // interrupted sibling records nothing in `settled`, so it is reported as
      // skipped rather than as a phantom success.
      const { layer, state } = concurrent()
      const exit = yield* driveWith(
        layer,
        Effect.exit(Interpreter.interpret(Node.all({
          survivor: Parking.call({ name: "survivor" }),
          doomed: Failing.call({ name: "doomed" })
        })))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(state.entered).toEqual(["survivor"])
      expect(state.interrupted).toEqual(["survivor"])
    }))

  it.effect("interrupts a shared upstream when the walk fails, instead of orphaning it", () =>
    Effect.gen(function*() {
      // The ref-diamond case: the shared node's execution is owned by the
      // interpretation, not by the failing `All`'s forEach, so fail-fast cannot
      // reach it directly. Closing the interpretation's node scope on exit is
      // what interrupts it — the orphan must not keep running past the failure
      // and write a phantom success into `settled` afterwards.
      const { layer, state } = concurrent()
      const exit = yield* driveWith(
        layer,
        Effect.exit(Interpreter.interpret(
          Parking.call({ name: "shared" }).pipe(
            Node.bindPlanned((shared) =>
              Node.all({
                use: Sum.call({ values: [shared], label: "use" }),
                doomed: Failing.call({ name: "doomed" })
              })
            )
          )
        ))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(state.entered).toEqual(["shared"])
      expect(state.interrupted).toEqual(["shared"])
    }))

  it.effect("lets a Catch recovery arm join shared work the failed subtree demanded", () =>
    Effect.gen(function*() {
      // The recovery arm references the same upstream the failed `All` was
      // consuming. Because the interpretation owns the execution, the sibling
      // failure interrupts only the dead subtree's JOINS: the shared node keeps
      // running, the recovery arm's demand joins it, and the release member
      // unparks it — no deadlock on an orphaned deferred.
      const { layer, state } = concurrent()
      const value = yield* driveWith(
        layer,
        Interpreter.interpret(
          Parking.call({ name: "shared" }).pipe(
            Node.bindPlanned((shared) =>
              Node.all({
                use: Sum.call({ values: [shared], label: "use" }),
                doomed: Failing.call({ name: "doomed" })
              }).pipe(
                Node.catch({
                  onFailure: () =>
                    Node.all({
                      recovered: Sum.call({ values: [shared], label: "recovery" }),
                      release: Release.call({})
                    })
                })
              )
            )
          )
        )
      )
      expect(state.entered).toEqual(["shared"])
      expect(value.value).toMatchObject({ recovered: 1 })
    }))

  /** Parks on its first run until {@link Unpark} runs, then interrupts itself. */
  const Flaky = Action.make("interpreter/flaky", { payload: {}, success: Schema.Number })

  /** Unparks {@link Flaky} once the walk has recovered, and settles after that run is interrupted. */
  const Unpark = Action.make("interpreter/unpark", { payload: {}, success: Schema.Number })

  /** A recovery arm that gives the walk's remaining executions turns until `flaky` runs again. */
  const Recover = Action.make("interpreter/recover", { payload: {}, success: Schema.Number })

  it.effect("re-executes an interrupted node on a later demand instead of replaying the interrupt", () =>
    Effect.gen(function*() {
      // `flaky`'s binder is an `All` member whose sibling fails, so the
      // binder's join is interrupted and the walk recovers through the catch.
      // The binder's continuation keeps running, because the interpretation
      // owns it: it unparks `flaky`, whose execution then ends interrupted,
      // and only after that demands `flaky` again through `late`. An
      // interrupt says nothing about the node, so the interpretation evicted
      // it instead of memoizing it, and the later demand runs it a second time.
      let runs = 0
      let recover = () => {}
      const recovered = new Promise<void>((resolve) => {
        recover = resolve
      })
      let unpark = () => {}
      const unparked = new Promise<void>((resolve) => {
        unpark = resolve
      })
      let interrupt = () => {}
      const interrupted = new Promise<void>((resolve) => {
        interrupt = resolve
      })
      const layer = Layer.mergeAll(
        Flaky.toLayer(() =>
          Effect.gen(function*() {
            runs++
            if (runs > 1) return runs
            yield* Effect.promise(() => unparked)
            return yield* Effect.interrupt
          }).pipe(Effect.onInterrupt(() => Effect.sync(() => interrupt())))
        ),
        Unpark.toLayer(() =>
          Effect.gen(function*() {
            yield* Effect.promise(() => recovered)
            unpark()
            yield* Effect.promise(() => interrupted)
            return 0
          })
        ),
        Recover.toLayer(() =>
          Effect.gen(function*() {
            recover()
            for (let turn = 0; turn < 1000 && runs < 2; turn++) yield* Effect.yieldNow
            return runs
          })
        ),
        Failing.toLayer(({ name }) => Effect.fail(`${name} failed`))
      )
      const value = yield* driveWith(
        layer,
        Interpreter.interpret(
          Node.all({
            use: Flaky.call({}).pipe(
              Node.bindPlanned((flaky) =>
                Unpark.call({}).pipe(Node.andThen(Sum.call({ values: [flaky], label: "late" })))
              )
            ),
            doomed: Failing.call({ name: "doomed" })
          }).pipe(Node.catch({ onFailure: () => Recover.call({}) }))
        )
      )
      expect(runs).toBe(2)
      expect(value.value).toBe(2)
    }))
})
