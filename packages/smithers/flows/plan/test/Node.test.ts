import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import * as Identity from "@smthrs/crypto/Identity"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import { readFileSync } from "node:fs"
import { GraphBuildError } from "../src/GraphBuildError.ts"
import * as internal from "../src/internal/node.ts"
import * as Node from "../src/Node.ts"
import * as Planned from "../src/Planned.ts"
import * as StepKey from "../src/StepKey.ts"
import { withCrypto } from "./Crypto.ts"

const tagged = <T extends internal.NodeAst["_tag"]>(
  ast: Node.Ast,
  tag: T
): Extract<internal.NodeAst, { readonly _tag: T }> => {
  expect(ast._tag).toBe(tag)
  return ast as Extract<internal.NodeAst, { readonly _tag: T }>
}

const contentKey = (body: unknown) => StepKey.content({ body, inputs: {}, layers: [], capabilities: {} })

describe("Node", () => {
  it("records a constant", () => {
    expect(Node.succeed(1).ast).toEqual({ _tag: "Succeed", value: 1 })
    expect(Node.isNode(Node.succeed(1))).toBe(true)
    expect(Node.isNode({ ast: { _tag: "Succeed", value: 1 } })).toBe(false)
  })

  it("admits undefined data toJSON without invoking getters", () => {
    const nested = { toJSON: undefined, value: 2 }
    const hidden = Object.defineProperty({ value: 3 }, "toJSON", { value: undefined })
    const input = { toJSON: undefined, value: 1, nested, hidden }
    expect(tagged(Node.succeed(input).ast, "Succeed").value).toEqual({
      value: 1,
      nested: { value: 2 },
      hidden: { value: 3 }
    })

    let called = false
    const accessor = Object.defineProperty({ value: 1 }, "toJSON", {
      get: () => {
        called = true
        return undefined
      }
    })
    expect(() => Node.succeed(accessor)).toThrow(GraphBuildError)
    expect(called).toBe(false)
  })

  it("records a constant failure in the typed error channel", () => {
    const node = Node.fail({ _tag: "Refused", reason: "quota" } as const)

    expect(node.ast).toEqual({ _tag: "Fail", error: { _tag: "Refused", reason: "quota" } })
    expect(Node.isNode(node)).toBe(true)
    expectTypeOf(node).toEqualTypeOf<Node.Node<never, { readonly _tag: "Refused"; readonly reason: "quota" }>>()
    // The error is mirrored to inert JSON exactly as a success value is, so a
    // stored plan carries it without the process that built it.
    expect(tagged(Node.fail({ reason: "quota", ignored: () => 1 }).ast, "Fail").error).toEqual({ reason: "quota" })
    const json = JSON.stringify(node.ast)
    expect(JSON.parse(json)).toEqual(node.ast)
    expect(Node.isNode({ ast: JSON.parse(json) as Node.Ast })).toBe(false)
  })

  it("carries a scheduling priority on a failure like any other node", () => {
    expect(Node.fail("boom").pipe(Node.priority(3)).ast).toEqual({ _tag: "Fail", error: "boom", priority: 3 })
  })

  it("recovers a constant failure through catch, binding its error", () => {
    const recovered = Node.catch(Node.fail("boom" as const), {
      onFailure: (error) => Node.succeed({ handled: error })
    })

    const ast = tagged(recovered.ast, "Catch")
    expect(tagged(ast.protected, "Fail").error).toBe("boom")
    // The constant failure is what the failure arm is typed against, so a
    // recovery that mishandles it does not compile.
    expectTypeOf<Node.Success<typeof recovered>>().toEqualTypeOf<{ handled: "boom" }>()
    expectTypeOf<Node.Error<typeof recovered>>().toBeNever()
  })

  it("snapshots the branch predicate before building either arm", () => {
    const options = {
      if: Node.capture({}, (_value: number) => true),
      then: () => Node.succeed("then"),
      else: () => Node.succeed("else")
    }
    const ast = tagged(Node.branch(Node.succeed(1), options).ast, "Branch")
    const identity = ast.predicate
    options.if = Node.capture({}, (_value: number) => false)
    expect(Node.predicate(ast)?.(1)).toBe(true)
    expect(ast.predicate).toEqual(identity)
  })

  it("types the JSON value delivered to a Date mapper", () => {
    const node = Node.map(Node.succeed(new Date(0)), (date) => {
      expectTypeOf(date).toEqualTypeOf<string | null>()
      return date?.slice(0, 4)
    })
    const ast = tagged(node.ast, "Map")
    expect(Node.mapper(ast)?.(tagged(ast.first, "Succeed").value)).toBe("1970")
  })

  it("projects nested payload types and resolves planned result types", () => {
    const node = Node.succeed({
      url: new URL("https://example.test/"),
      date: new Date(NaN),
      ignored: () => 1,
      symbol: Symbol("ignored"),
      array: [() => 1, new URL("https://example.test/")] as const,
      encoded: { toJSON: () => ({ value: 1 }) },
      reference: Planned.make<Date>("upstream")
    })
    expectTypeOf<Node.Success<typeof node>>().toEqualTypeOf<{
      url: string
      date: string | null
      array: readonly [null, string]
      encoded: { value: number }
      reference: Date
    }>()
    const ast = tagged(node.ast, "Succeed")
    expect(ast.value).toMatchObject({
      url: "https://example.test/",
      date: null,
      array: [null, "https://example.test/"],
      encoded: { value: 1 }
    })
    expect(Object.hasOwn(ast.value as object, "ignored")).toBe(false)
  })

  it("preserves errors rejected by a schema refinement in both catch forms", () => {
    const source: Node.Node<number, string> = Node.succeed(1)
    const options = { error: Schema.NonEmptyString, onFailure: () => Node.succeed(0) }
    const direct = Node.catch(source, options)
    const piped = source.pipe(Node.catch(options))
    expectTypeOf<Node.Error<typeof direct>>().toEqualTypeOf<string>()
    expectTypeOf<Node.Error<typeof piped>>().toEqualTypeOf<string>()
    expect(Schema.is(Node.catchFilter(direct.ast)!)("")).toBe(false)
  })

  it("combines independent children by name", () => {
    const node = Node.all({ left: Node.succeed(1), right: Node.succeed("two") })
    expect(tagged(node.ast, "All").nodes).toEqual({
      left: { _tag: "Succeed", value: 1 },
      right: { _tag: "Succeed", value: "two" }
    })
  })

  it("preserves an own __proto__ child", () => {
    const members = Object.create(null) as Record<string, Node.Any>
    Object.defineProperty(members, "__proto__", { enumerable: true, value: Node.succeed("safe") })
    const nodes = tagged(Node.all(members).ast, "All").nodes
    expect(Object.hasOwn(nodes, "__proto__")).toBe(true)
    expect(nodes.__proto__).toEqual({ _tag: "Succeed", value: "safe" })
  })

  it("refuses a member of Node.all that is not a node", () => {
    let refusal: unknown
    try {
      Node.all({ left: Node.succeed(1), right: 2 as unknown as Node.Any })
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(GraphBuildError)
    expect(refusal).toMatchObject({
      code: "invalid_all_member",
      node: "right",
      path: [],
      message: "Node.all expected a Node at member \"right\""
    })
  })

  it("builds race, any, and quorum joins with their mode and success count", () => {
    const members = { left: Node.succeed(1), right: Node.fail("two") }
    const raced = Node.race(members)
    const first = Node.any(members)
    const agreed = Node.quorum(2, { ...members, third: Node.succeed(true) })
    expect(raced.ast).toEqual({
      _tag: "Race",
      mode: "race",
      count: 1,
      nodes: { left: { _tag: "Succeed", value: 1 }, right: { _tag: "Fail", error: "two" } }
    })
    expect(tagged(first.ast, "Race")).toMatchObject({ mode: "any", count: 1 })
    expect(tagged(agreed.ast, "Race")).toMatchObject({ mode: "quorum", count: 2 })
    expectTypeOf<Node.Success<typeof raced>>().toEqualTypeOf<number>()
    expectTypeOf<Node.Error<typeof first>>().toEqualTypeOf<string>()
    expectTypeOf<Node.Success<typeof agreed>>().toEqualTypeOf<
      { readonly left?: number; readonly right?: never; readonly third?: boolean }
    >()
    expect(Node.isNode(raced) && Node.isNode(first) && Node.isNode(agreed)).toBe(true)
  })

  it.each(
    [
      ["an empty race", () => Node.race({}), "race", "Node.race needs at least one member"],
      ["an empty any", () => Node.any({}), "any", "Node.any needs at least one member"],
      ["a quorum of zero", () => Node.quorum(0, { a: Node.succeed(1) }), "quorum", /got 0$/],
      [
        "a quorum wider than its members",
        () => Node.quorum(3, { a: Node.succeed(1), b: Node.succeed(2) }),
        "quorum",
        /between 1 and its 2 members, got 3$/
      ],
      ["a fractional quorum", () => Node.quorum(1.5, { a: Node.succeed(1), b: Node.succeed(2) }), "quorum", /got 1.5$/],
      ["an empty quorum", () => Node.quorum(1, {}), "quorum", /its 0 members/],
      [
        "a non-node member",
        () => Node.any({ a: Node.succeed(1), b: 2 as unknown as Node.Any }),
        "b",
        "Node.any expected a Node at member \"b\""
      ]
    ] as const
  )("refuses %s as invalid_join", (_, build, node, message) => {
    let refusal: unknown
    try {
      build()
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(GraphBuildError)
    expect(refusal).toMatchObject({ code: "invalid_join", node, path: [], message: expect.stringMatching(message) })
  })

  it("stores a digest for a mapper and keeps the function beside the AST", () => {
    const node = Node.succeed(2).pipe(Node.map((value) => value + 1))
    const ast = tagged(node.ast, "Map")
    expect(ast.first).toEqual({ _tag: "Succeed", value: 2 })
    expect(ast.mapper).toMatchObject({ _tag: "FunctionIdentity", algorithm: "sha256-source-ephemeral/v4" })
    expect(ast.mapper.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(internal.operation(ast)?.(2)).toBe(3)
  })

  it("defers a continuation builder and reveals nothing until the graph is built", () => {
    let built = 0
    const node = Node.succeed(2).pipe(Node.bindPlanned((value: Planned.Planned<number>) => {
      built++
      return Node.succeed(value)
    }))
    const ast = tagged(node.ast, "AndThen")
    expect(built).toBe(0)
    expect(ast.next).toBeUndefined()
    expect(ast.continuation.algorithm).toBe("sha256-source-ephemeral/v4")
    const continued = internal.operation(ast)?.(Planned.make<number>("upstream"))
    expect(built).toBe(1)
    expect(Node.isNode(continued)).toBe(true)
  })

  it("records a directly supplied continuation as static topology", () => {
    const node = Node.succeed(2).pipe(Node.andThen(Node.succeed("done")))
    const ast = tagged(node.ast, "AndThen")
    expect(ast.next).toEqual({ _tag: "Succeed", value: "done" })
    expect(ast.continuation.algorithm).toBe("static-node/v1")
    expect(ast.continuation.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(internal.operation(ast)).toBeUndefined()
  })

  it("refuses a direct continuation that is not a node", () => {
    expect(() => Node.andThen(Node.succeed(1), 2 as unknown as Node.Any)).toThrow(expect.objectContaining({
      code: "invalid_continuation",
      node: "andThen/next",
      message:
        "Node.andThen expects a Node; use Node.bindPlanned for a symbolic builder or Node.map for value computation"
    }))
  })

  it("builds each branch arm exactly once, against the symbolic subject", () => {
    const seen: Array<Planned.Reference | undefined> = []
    let evaluated = 0
    const node = Node.succeed(1).pipe(Node.branch({
      if: (value) => value >= 100,
      then: (value) => {
        evaluated++
        seen.push(Planned.reference(value))
        return Node.succeed("done")
      },
      else: (value) => {
        evaluated++
        seen.push(Planned.reference(value))
        return Node.succeed("again")
      }
    }))
    const ast = tagged(node.ast, "Branch")
    expect(evaluated).toBe(2)
    expect(seen).toHaveLength(2)
    expect(seen[0]?.node).toBe(ast.subject)
    expect(seen[1]?.node).toBe(ast.subject)
    expect(ast.subject).toMatch(/^branch\/subject\/\d+$/)
    expect(ast.first).toEqual({ _tag: "Succeed", value: 1 })
    expect(ast.then).toEqual({ _tag: "Succeed", value: "done" })
    expect(ast.else).toEqual({ _tag: "Succeed", value: "again" })
    expect(internal.predicate(ast)?.(100)).toBe(true)
    expect(internal.predicate(ast)?.(99)).toBe(false)
  })

  it("builds a catch failure arm once against its own symbolic error", () => {
    const seen: Array<Planned.Reference | undefined> = []
    let evaluated = 0
    const build = () =>
      Node.succeed(1).pipe(Node.catch({
        onFailure: (error: Planned.Planned<string>) => {
          evaluated++
          seen.push(Planned.reference(error))
          return Node.succeed(error)
        }
      }))
    const ast = tagged(build().ast, "Catch")

    expect(evaluated).toBe(1)
    expect(seen).toEqual([{ node: ast.subject, path: [] }])
    expect(ast.subject).toMatch(/^catch\/subject\/\d+$/)
    expect(ast.protected).toEqual({ _tag: "Succeed", value: 1 })
    expect(ast.failure).toEqual({
      _tag: "Succeed",
      value: { _tag: "PlannedReference", node: ast.subject, path: [] }
    })
    expect(ast.filter).toBeUndefined()
    expect(Node.catchFilter(ast)).toBeUndefined()
    expect(Node.catchFilter(Node.succeed(1).ast)).toBeUndefined()
    // Each catch mints its own token, so a nested arm cannot rebind an outer
    // one to the inner catch's protected node.
    expect(tagged(build().ast, "Catch").subject).not.toBe(ast.subject)
  })

  it("records a catch schema identity and keeps the live filter beside the AST", () => {
    const error = Schema.Literal("recoverable")
    const ast = tagged(
      Node.catch(Node.succeed(1), { error, onFailure: () => Node.succeed(0) }).ast,
      "Catch"
    )

    expect(ast.filter).toEqual(Schema.toJsonSchemaDocument(error, { onExcessProperty: "error" }))
    expect(Node.catchFilter(ast)).toBe(error)
  })

  it("keeps schema function captures and never invokes accessor metadata", () => {
    let reads = 0
    const metadata: Record<string, unknown> = { nullable: null }
    metadata.self = metadata
    Object.defineProperties(metadata, {
      read: { get: () => ++reads },
      write: {
        set: (_value: unknown) => {
          reads++
        }
      }
    })
    const error = Schema.String.check(new SchemaAST.Filter(Node.capture({}, () => undefined)))
    Object.defineProperty(error.ast, "metadata", { value: metadata })
    const ast = tagged(Node.catch(Node.succeed(1), { error, onFailure: () => Node.succeed(0) }).ast, "Catch")
    expect(reads).toBe(0)
    expect(ast.filterIdentity?.algorithm).toBe("sha256-source-ephemeral/v4")
    expect(internal.isNodeAst(ast)).toBe(true)
    expect(internal.isNodeAst({ ...ast, filterIdentity: { _tag: "FunctionIdentity" } })).toBe(false)

    const captured = Schema.String.check(new SchemaAST.Filter(Node.capture({}, () => undefined)))
    const stable = tagged(
      Node.catch(Node.succeed(1), {
        error: captured,
        onFailure: () => Node.succeed(0)
      }).ast,
      "Catch"
    )
    expect(stable.filterIdentity?.algorithm).toBe("sha256-source-captures/v5")
  })

  it("refuses a catch failure arm that does not return a node", () => {
    expect(() =>
      Node.catch(Node.succeed(1), {
        onFailure: () => 1 as unknown as Node.Node<number>
      })
    ).toThrow(expect.objectContaining({
      code: "invalid_continuation",
      node: Node.catchSubject,
      message: "Node.catch expected its failure arm to return a Node"
    }))
  })

  it("hands a driver the deferred mapper and the run-time predicate, and nothing else", () => {
    const mapped = Node.succeed(2).pipe(Node.map((value) => value + 1))
    const decided = Node.succeed(2).pipe(
      Node.branch({ if: (value) => value >= 100, then: () => Node.succeed("done"), else: () => Node.succeed("again") })
    )

    expect(Node.mapper(mapped.ast)?.(2)).toBe(3)
    expect(Node.predicate(decided.ast)?.(100)).toBe(true)
    expect(Node.predicate(decided.ast)?.(99)).toBe(false)
    // Each accessor answers for its own variant only, so a driver switching on
    // the AST tag never has to guard the lookup itself.
    expect(Node.mapper(decided.ast)).toBeUndefined()
    expect(Node.predicate(mapped.ast)).toBeUndefined()
    // A rehydrated AST left its side tables behind.
    expect(Node.mapper(JSON.parse(JSON.stringify(mapped.ast)) as Node.Ast)).toBeUndefined()
    expect(Node.predicate(JSON.parse(JSON.stringify(decided.ast)) as Node.Ast)).toBeUndefined()
  })

  it("refuses a branch arm that does not return a node", () => {
    const notANode = 1 as unknown as Node.Node<string>
    for (const side of ["then", "else"]) {
      let refusal: unknown
      try {
        Node.branch(Node.succeed(1), {
          if: (value) => value >= 100,
          then: () => side === "then" ? notANode : Node.succeed("done"),
          else: () => side === "else" ? notANode : Node.succeed("again")
        })
      } catch (error) {
        refusal = error
      }
      expect(refusal).toMatchObject({
        code: "invalid_continuation",
        node: `${Node.branchSubject}/${side}`,
        path: [],
        message: `Node.branch expected its "${side}" arm to return a Node`
      })
    }
  })

  it("keeps the AST closure-free and JSON serializable", () => {
    const payload = {
      path: "counter.txt",
      ignored: () => 1
    }
    const payloadNode = Node.succeed(payload)
    const functionOnly = Node.succeed({ ignored: () => 1 })
    const node = payloadNode.pipe(
      Node.map((value) => value.path),
      Node.andThen(Node.all({ count: Node.succeed(1) })),
      Node.branch({
        if: (value) => value.count >= 100,
        then: () => Node.succeed("done"),
        else: () => Node.succeed("again")
      })
    )
    expect(tagged(payloadNode.ast, "Succeed").value).toEqual({ path: "counter.txt" })
    expect(tagged(functionOnly.ast, "Succeed").value).toEqual({})
    const json = JSON.stringify(node.ast)
    expect(json).not.toContain("=>")
    expect(json).not.toContain("function")
    expect(JSON.parse(json)).toEqual(node.ast)
    expect(JSON.parse(JSON.stringify(functionOnly.ast))).toEqual(functionOnly.ast)
  })

  it.effect("keeps distinct Date payloads and the empty object in distinct content identities", () =>
    Effect.gen(function*() {
      const epoch = tagged(Node.succeed(new Date(0)).ast, "Succeed")
      const nextDay = tagged(Node.succeed(new Date(86_400_000)).ast, "Succeed")
      const empty = tagged(Node.succeed({}).ast, "Succeed")
      expect(epoch).not.toEqual(nextDay)

      const epochKey = yield* withCrypto(contentKey(epoch.value))
      const nextDayKey = yield* withCrypto(contentKey(nextDay.value))
      const emptyKey = yield* withCrypto(contentKey(empty.value))
      expect(new Set([epochKey, nextDayKey, emptyKey]).size).toBe(3)
    }))

  it.effect("keys a URL payload apart from the empty object", () =>
    Effect.gen(function*() {
      const url = tagged(Node.succeed(new URL("https://x.test/a")).ast, "Succeed").value
      const empty = tagged(Node.succeed({}).ast, "Succeed").value
      expect(yield* withCrypto(contentKey(url))).not.toBe(yield* withCrypto(contentKey(empty)))
    }))

  it.effect("mirrors canonical payload serialization across representative values", () =>
    Effect.gen(function*() {
      const callable = Object.assign(() => 1, { toJSON: () => new Date(0) })
      const corpus: ReadonlyArray<unknown> = [
        new Date(0),
        new URL("https://x.test/a"),
        { a: 1 },
        [1, "x", true, null],
        { outer: { inner: [1, { value: "leaf" }] } },
        { u: undefined },
        { f: () => 1 },
        [() => 1],
        callable,
        { toJSON: 1 }
      ]

      for (const input of corpus) {
        const cloned = tagged(Node.succeed(input).ast, "Succeed").value
        expect(yield* withCrypto(contentKey(cloned))).toBe(yield* withCrypto(contentKey(input)))
      }

      const selfReturning: { readonly toJSON: () => unknown } = {
        toJSON() {
          return selfReturning
        }
      }
      const input = { m: selfReturning }
      expect(() => Node.succeed(input)).toThrowError(expect.objectContaining({
        code: "cyclic_payload",
        path: ["m"]
      }))
      const canonicalFailure = yield* Effect.flip(withCrypto(contentKey(input)))
      expect(canonicalFailure).toMatchObject({ _tag: "SchemaError" })
      expect(canonicalFailure.message).toContain("canonicalization_failed")
    }))

  it("drops values without a JSON representation and nulls array positions", () => {
    expect(tagged(Node.succeed({ value: undefined, symbol: Symbol("value") }).ast, "Succeed").value).toEqual({})
    expect(tagged(Node.succeed([() => 1, undefined, Symbol("value")]).ast, "Succeed").value).toEqual([
      null,
      null,
      null
    ])
    expect(tagged(Node.succeed(() => 1).ast, "Succeed").value).toBeUndefined()
    expect(tagged(Node.succeed(Symbol("value")).ast, "Succeed").value).toBeUndefined()
    // eslint-disable-next-line no-sparse-arrays
    expect(tagged(Node.succeed([, 1]).ast, "Succeed").value).toEqual([null, 1])
  })

  it("refuses unsupported prototypes instead of collapsing them onto an empty object", () => {
    class Example {
      readonly count: number
      constructor(count: number) {
        this.count = count
      }
    }
    for (const payload of [new Map([["a", 1]]), new Set([1]), /abc/g, new Example(1)]) {
      expect(() => Node.succeed(payload)).toThrowError(expect.objectContaining({
        code: "invalid_payload",
        path: []
      }))
    }
  })

  it("refuses payload accessors without invoking them", () => {
    let calls = 0
    const member = Object.defineProperty({}, "credential", {
      enumerable: true,
      get: () => {
        calls++
        return "secret"
      }
    })
    const toJSON = Object.defineProperty({}, "toJSON", {
      get: () => {
        calls++
        return () => ({})
      }
    })
    const array = new Array<unknown>(1)
    Object.defineProperty(array, "0", {
      enumerable: true,
      get: () => {
        calls++
        return "secret"
      }
    })

    expect(() => Node.succeed({ nested: member })).toThrowError(expect.objectContaining({
      code: "invalid_payload",
      path: ["nested", "credential"]
    }))
    expect(() => Node.succeed(toJSON)).toThrowError(expect.objectContaining({
      code: "invalid_payload",
      path: []
    }))
    expect(() => Node.succeed(array)).toThrowError(expect.objectContaining({
      code: "invalid_payload",
      path: ["0"]
    }))
    expect(calls).toBe(0)
  })

  it("keeps raw function identity stable per object and fail-closed across objects", () => {
    const increment = (value: number): number => value + 1
    const alsoIncrement = (value: number): number => value + 1
    const decrement = (value: number): number => value - 1
    const digest = (f: (value: number) => number): string =>
      tagged(Node.succeed(1).pipe(Node.map(f)).ast, "Map").mapper.digest
    expect(digest(increment)).toBe(digest(increment))
    expect(digest(increment)).not.toBe(digest(alsoIncrement))
    expect(digest(increment)).not.toBe(digest(decrement))

    const continueWithValue = (value: Planned.Planned<number>) => Node.succeed(value)
    const alsoContinueWithValue = (value: Planned.Planned<number>) => Node.succeed(value)
    const continueWithZero = (_value: Planned.Planned<number>): Node.Node<number> => Node.succeed(0)
    const continuationDigest = (
      f: (value: Planned.Planned<number>) => Node.Any
    ): string => tagged(Node.bindPlanned(Node.succeed(1), f).ast, "AndThen").continuation.digest
    expect(continuationDigest(continueWithValue)).toBe(continuationDigest(continueWithValue))
    expect(continuationDigest(continueWithValue)).not.toBe(continuationDigest(alsoContinueWithValue))
    expect(continuationDigest(continueWithValue)).not.toBe(continuationDigest(continueWithZero))
  })
})

describe("internal/node call factories", () => {
  it("records a flow call with its mode, payload, and declaration", () => {
    const declaration = { tag: "counter/count-to-100" }
    const ast = internal.flowCall(declaration, "counter/count-to-100", "boundary", { path: "counter.txt" })
    expect(ast).toEqual({
      _tag: "FlowCall",
      flow: "counter/count-to-100",
      mode: "boundary",
      payload: { path: "counter.txt" }
    })
    expect(internal.declaration(ast)).toBe(declaration)

    const handoff = Node.flowCall(declaration, "counter/count-to-100", "handoff", { value: 2 })
    expect(handoff.ast).toMatchObject({
      _tag: "FlowCall",
      flow: "counter/count-to-100",
      mode: "handoff",
      payload: { value: 2 }
    })
  })

  it("records an action call with its payload and declaration", () => {
    const declaration = { tag: "counter/read" }
    const ast = internal.actionCall(declaration, "counter/read", { path: "counter.txt" })
    expect(ast).toEqual({
      _tag: "ActionCall",
      action: "counter/read",
      payload: { path: "counter.txt" }
    })
    expect(internal.declaration(ast)).toBe(declaration)
    expect(JSON.parse(JSON.stringify(ast))).toEqual(ast)
  })

  it("exposes private node factories to the flow package and serializes planned payload references", () => {
    const declaration = { tag: "counter/read" }
    const planned = Planned.make<{ readonly path: string }>("previous")
    const shared = { literal: true }
    const flow = Node.flowCall(declaration, "counter/next", "inline", { path: planned.path })
    const action = Node.actionCall(declaration, "counter/read", {
      paths: [planned.path],
      shared: [shared, shared]
    })
    expect(flow.ast).toEqual({
      _tag: "FlowCall",
      flow: "counter/next",
      mode: "inline",
      payload: {
        path: { _tag: "PlannedReference", node: "previous", path: ["path"] }
      }
    })
    expect(action.ast).toEqual({
      _tag: "ActionCall",
      action: "counter/read",
      payload: {
        paths: [{ _tag: "PlannedReference", node: "previous", path: ["path"] }],
        shared: [{ literal: true }, { literal: true }]
      }
    })
    const encoded = tagged(flow.ast, "FlowCall").payload as {
      readonly path: internal.PlannedReference
    }
    expect(Node.plannedReference(encoded.path)).toBe(encoded.path)
    expect(Node.plannedReference({ ...encoded.path })).toBeUndefined()
    expect(internal.declaration(tagged(flow.ast, "FlowCall"))).toBe(declaration)
    expect(internal.declaration(tagged(action.ast, "ActionCall"))).toBe(declaration)
    expect(JSON.parse(JSON.stringify({ flow: flow.ast, action: action.ast }))).toEqual({
      flow: flow.ast,
      action: action.ast
    })
  })

  it("clones a very deep payload without exhausting the native stack", () => {
    let payload: Record<string, unknown> = { value: "leaf" }
    for (let index = 0; index < 20_000; index++) payload = { next: payload }
    const cloned = tagged(Node.succeed(payload).ast, "Succeed").value as Record<string, unknown>

    let depth = 0
    let current: Record<string, unknown> | undefined = cloned
    while (current !== undefined && Object.hasOwn(current, "next")) {
      depth++
      current = current.next as Record<string, unknown>
    }
    expect(depth).toBe(20_000)
    expect(current).toEqual({ value: "leaf" })
    expect(Object.getPrototypeOf(cloned)).toBeNull()
  })

  it("clones shared and cyclic references into shared and cyclic clones", () => {
    // Whether a cyclic payload is PLANNABLE is graph building's verdict; the
    // cloner's own contract is only that it terminates and preserves aliasing.
    const shared = { leaf: true }
    const cyclic: { self?: unknown; twice?: ReadonlyArray<unknown> } = { twice: [shared, shared] }
    cyclic.self = cyclic
    const cloned = tagged(Node.succeed(cyclic).ast, "Succeed").value as {
      readonly self: unknown
      readonly twice: ReadonlyArray<unknown>
    }

    expect(cloned).not.toBe(cyclic)
    expect(cloned.self).toBe(cloned)
    expect(cloned.twice[0]).toEqual({ leaf: true })
    expect(cloned.twice[0]).not.toBe(shared)
    expect(cloned.twice[1]).toBe(cloned.twice[0])

    const jsonCycle: { readonly toJSON: () => unknown } = {
      toJSON() {
        return { self: jsonCycle }
      }
    }
    const clonedJsonCycle = tagged(Node.succeed(jsonCycle).ast, "Succeed").value as { readonly self: unknown }
    expect(clonedJsonCycle.self).toBe(clonedJsonCycle)

    const directCycle: { readonly toJSON: () => unknown } = {
      toJSON() {
        return directCycle
      }
    }
    expect(() => Node.succeed({ member: directCycle })).toThrowError(expect.objectContaining({
      code: "cyclic_payload",
      path: ["member"]
    }))
  })

  it("preserves an own __proto__ payload field without changing the clone prototype", () => {
    const payload = Object.create(null) as Record<string, unknown>
    Object.defineProperty(payload, "__proto__", { enumerable: true, value: "safe" })
    const ast = internal.actionCall({}, "safe", payload)
    const cloned = ast.payload as Record<string, unknown>
    expect(Object.getPrototypeOf(cloned)).toBeNull()
    expect(Object.hasOwn(cloned, "__proto__")).toBe(true)
    expect(cloned.__proto__).toBe("safe")
  })

  it("reads back the declaration and the continuation a graph builder needs", () => {
    const declaration = { tag: "counter/read" }
    const action = Node.actionCall(declaration, "counter/read", { path: "counter.txt" })
    const flow = Node.flowCall(declaration, "counter/next", "inline", { path: "counter.txt" })
    expect(Node.declaration(tagged(action.ast, "ActionCall"))).toBe(declaration)
    expect(Node.declaration(tagged(flow.ast, "FlowCall"))).toBe(declaration)

    const built = Node.bindPlanned(Node.succeed(1), (value: Planned.Planned<number>) => Node.succeed(value))
    const continued = Node.continuation(tagged(built.ast, "AndThen"))?.(Planned.make<number>("upstream"))
    expect(Node.isNode(continued)).toBe(true)
    const supplied = Node.andThen(Node.succeed(1), Node.succeed(2))
    expect(Node.continuation(tagged(supplied.ast, "AndThen"))).toBeUndefined()
  })

  it("digests a function the AST does not store the same way it digests one it does", () => {
    const mapper = (value: number): number => value + 1
    const identity: Node.FunctionIdentity = Node.functionIdentity(mapper)

    expect(identity).toEqual(tagged(Node.map(Node.succeed(1), mapper).ast, "Map").mapper)
    expect(Node.functionIdentity((value: number): number => value + 2)).not.toEqual(identity)
    expect(identity.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(() => Node.functionIdentity(null)).toThrow(/requires a function/)
  })

  it("does not collapse behaviorally significant source or known FNV-1a collisions", () => {
    const oneSpace = Function("return 'one space'")
    const twoSpaces = Function("return 'one  space'")
    expect(Node.functionIdentity(oneSpace)).not.toEqual(Node.functionIdentity(twoSpaces))

    // After the previous whitespace normalization, these two sources both
    // have the 32-bit FNV-1a digest 4b1d29dc.
    function f2152() {
      return 2152
    }
    function f19965() {
      return 19965
    }
    const first = f2152
    const second = f19965
    expect(Node.functionIdentity(first)).not.toEqual(Node.functionIdentity(second))
  })

  it("keys declared closure captures and freezes the captured graph", () => {
    const make = (offset: number) => Node.capture({ offset }, (value: number) => value + offset)
    const one = make(1)
    const two = make(2)

    expect(one(2)).toBe(3)
    expect(Node.functionIdentity(one)).toMatchObject({ algorithm: "sha256-source-captures/v5" })
    expect(Node.functionIdentity(one)).not.toEqual(Node.functionIdentity(two))
    expect(Node.functionIdentity(make(1))).toEqual(Node.functionIdentity(one))

    const nested = { threshold: { value: 3 } }
    const read = Node.capture(nested, function(value: number) {
      return value >= this.threshold.value
    })
    const copy = Node.capture(nested, function() {
      return this
    })()
    expect(Object.isFrozen(copy)).toBe(true)
    expect(Object.isFrozen(copy.threshold)).toBe(true)
    expect(() => copy.threshold.value++).toThrow(TypeError)
    nested.threshold.value = 99
    expect(read(3)).toBe(true)
  })

  it("shared versus copied capture changes mapper identity", () => {
    const mapped = (captures: { left: object; right: object }) =>
      tagged(
        Node.map(
          Node.succeed(1),
          Node.capture(captures, function(value: number) {
            return value > 0 && this.left === this.right
          })
        ).ast,
        "Map"
      )

    for (const make of [() => ({ value: 1 }), () => [1]]) {
      const member = make()
      const shared = mapped({ left: member, right: member })
      const copied = mapped({ left: make(), right: make() })

      expect(Node.mapper(shared)?.(1)).toBe(true)
      expect(Node.mapper(copied)?.(1)).toBe(false)
      expect(shared.mapper).not.toEqual(copied.mapper)
    }
  })

  it("maps nested capture aliases according to their targets", () => {
    const mapped = (target: "left" | "right") => {
      const left = { value: 1 }
      const right = { value: 1 }
      const captures = { left, right, nested: { alias: target === "left" ? left : right } }
      return tagged(
        Node.map(
          Node.succeed(1),
          Node.capture(captures, function(value: number) {
            return value > 0 && this.nested.alias === this.left
          })
        ).ast,
        "Map"
      )
    }
    const left = mapped("left")
    const right = mapped("right")

    expect(Node.mapper(left)?.(1)).toBe(true)
    expect(Node.mapper(right)?.(1)).toBe(false)
    expect(left.mapper).not.toEqual(right.mapper)
  })

  it("preserves inner function identity when captures are nested", () => {
    const make = (offset: number) => Node.capture({ offset }, (value: number) => value + offset)
    const one = Node.capture({ outer: true }, make(1))
    const two = Node.capture({ outer: true }, make(999))

    expect(one(1)).toBe(2)
    expect(two(1)).toBe(1000)
    expect(Node.functionIdentity(one)).not.toEqual(Node.functionIdentity(two))
    expect(Node.functionIdentity(one)).toEqual(Node.functionIdentity(Node.capture({ outer: true }, make(1))))
    expect(Node.functionIdentity(one)).not.toEqual(Node.functionIdentity(Node.capture({ outer: false }, make(1))))
  })

  // The digest lives in `@smthrs/crypto`, and every node model embeds that one
  // implementation. A capture declared through either surface has to be
  // interchangeable, nested captures included, or two planners would key the
  // same function two ways.
  it("shares captured and raw function identities with the digest package", () => {
    const operation = (value: number) => value + 1
    const plan = Node.capture({ offset: 1 }, operation)
    const digest = Identity.capture({ offset: 1 }, operation)

    expect(internal.functionIdentity).toBe(Identity.functionIdentity)
    expect(Node.functionIdentity(plan)).toEqual(Identity.functionIdentity(digest))
    expect(Node.functionIdentity(Node.capture({ outer: true }, plan))).toEqual(
      Identity.functionIdentity(Identity.capture({ outer: true }, digest))
    )
    expect(Node.functionIdentity(digest)).toEqual(Identity.functionIdentity(digest))
    expect(Node.functionIdentity(operation)).toEqual(Identity.functionIdentity(operation))
    expect(Node.functionIdentity(Node.capture({ outer: true }, digest))).toEqual(
      Identity.functionIdentity(Identity.capture({ outer: true }, plan))
    )
  })

  it("rejects non-function capture operations explicitly", () => {
    expect(() => Node.capture({}, null as unknown as () => void)).toThrow(
      new TypeError("Node.capture requires a function operation")
    )
  })

  it("canonicalizes capture records without erasing observable values", () => {
    const operation = (value: number) => value
    expect(Node.functionIdentity(Node.capture({ a: 1, b: 2 }, operation))).toEqual(
      Node.functionIdentity(Node.capture({ b: 2, a: 1 }, operation))
    )
    expect(Node.functionIdentity(Node.capture({ value: -0 }, operation))).not.toEqual(
      Node.functionIdentity(Node.capture({ value: 0 }, operation))
    )
    const complete = Node.capture({ array: [null, true, false, "text"], empty: Object.create(null) }, operation)
    expect(complete(3)).toBe(3)

    const shared = { value: 1 }
    Node.capture({ left: shared, right: shared }, operation)
    const copy = Node.capture({ left: shared, right: shared }, function() {
      return this
    })()
    expect(copy.left).toBe(copy.right)
    expect(copy.left).not.toBe(shared)
    expect(Object.isFrozen(copy.left)).toBe(true)
  })

  it("refuses capture material whose behavior cannot be canonically identified", () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => Node.capture(cyclic, () => undefined)).toThrow(/capture at \$\.self is cyclic/)

    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 })
    expect(() => Node.capture(accessor, () => undefined)).toThrow(/capture at \$\.value is an accessor/)
    expect(() => Node.capture({ [Symbol("key")]: 1 }, () => undefined)).toThrow(/has symbol key/)
    expect(() => Node.capture({ date: new Date(0) }, () => undefined)).toThrow(/built-in internal slots/)
    expect(() => Node.capture({ value: Number.NaN }, () => undefined)).toThrow(/is not finite/)
    expect(() => Node.capture({ values: Array(1) }, () => undefined)).toThrow(/is an array hole/)
    for (const value of [undefined, 1n, Symbol("value"), () => undefined]) {
      expect(() => Node.capture({ value }, () => undefined)).toThrow(/has unsupported type/)
    }

    const arrayAccessor: Array<unknown> = [1]
    Object.defineProperty(arrayAccessor, "0", { get: () => 1 })
    expect(() => Node.capture({ arrayAccessor }, () => undefined)).toThrow(/is an accessor/)

    const arrayProperty: Array<unknown> = []
    Object.defineProperty(arrayProperty, "extra", { value: 1 })
    expect(() => Node.capture({ arrayProperty }, () => undefined)).toThrow(/unsupported array key extra/)
    const arraySymbol: Array<unknown> = []
    Object.defineProperty(arraySymbol, Symbol("extra"), { value: 1 })
    expect(() => Node.capture({ arraySymbol }, () => undefined)).toThrow(/unsupported array key Symbol\(extra\)/)
  })

  const nestedCapture = (depth: number): Record<string, unknown> => {
    let nested: unknown = "leaf"
    for (let index = 0; index < depth; index++) nested = { next: nested }
    return nested as Record<string, unknown>
  }

  const captureFailure = (captures: Readonly<Record<string, unknown>>): unknown => {
    try {
      Node.capture(captures, () => undefined)
      return undefined
    } catch (error) {
      return error
    }
  }

  it("accepts capture data nested exactly through the 256-level limit", () => {
    expect(Node.capture(nestedCapture(256), () => "ok")()).toBe("ok")
  })

  it("refuses capture data one level beyond the depth limit with an exact typed message", () => {
    const error = captureFailure(nestedCapture(257))
    expect(error).toBeInstanceOf(TypeError)
    expect(error).not.toBeInstanceOf(RangeError)
    expect((error as TypeError).message).toBe(
      `Node.capture: capture at $${".next".repeat(257)} exceeds the maximum capture depth of 256; ` +
        "captures must be finite, inert data"
    )
  })

  it("refuses a 2,000-level capture with the bounded typed error", () => {
    const error = captureFailure(nestedCapture(2_000))
    expect(error).toBeInstanceOf(TypeError)
    expect(error).not.toBeInstanceOf(RangeError)
    expect((error as TypeError).message).toBe(
      `Node.capture: capture at $${".next".repeat(257)} exceeds the maximum capture depth of 256; ` +
        "captures must be finite, inert data"
    )
  })
  it("records a scheduling priority on the node it annotates and leaves the original alone", () => {
    const plain = Node.succeed(1)
    const urgent = Node.priority(plain, 9)

    expect(urgent.ast).toEqual({ _tag: "Succeed", value: 1, priority: 9 })
    expect(Node.declaredPriority(urgent.ast)).toBe(9)
    // The original is unchanged, so one node used at two positions can carry
    // two priorities.
    expect(Node.declaredPriority(plain.ast)).toBeUndefined()
    expect(Node.declaredPriority(Node.priority(9)(plain).ast)).toBe(9)
    expect(Node.declaredPriority(Node.priority(urgent, 1).ast)).toBe(1)
  })

  it("keeps the side tables reachable through a prioritized copy", () => {
    // The AST is copied to attach the priority. A copy that left the side
    // tables behind would silently drop the continuation, the predicate, the
    // filter schema, or the declaration the graph walk needs.
    const mapped = Node.priority(Node.map(Node.succeed(1), (value: number) => value + 1), 3)
    expect(Node.mapper(mapped.ast)?.(1)).toBe(2)

    const sequenced = Node.priority(Node.bindPlanned(Node.succeed(1), () => Node.succeed(2)), 3)
    const builder = Node.continuation(tagged(sequenced.ast, "AndThen"))
    expect(Node.isNode(builder?.(Planned.make("upstream")))).toBe(true)

    const decided = Node.priority(
      Node.branch(Node.succeed(1), {
        if: (value: number) => value > 0,
        then: () => Node.succeed("yes"),
        else: () => Node.succeed("no")
      }),
      3
    )
    expect(Node.predicate(decided.ast)?.(1)).toBe(true)

    const protectedNode = Node.priority(
      Node.catch(Node.succeed(1) as Node.Node<number, { readonly _tag: "Boom" }>, {
        error: Schema.Struct({ _tag: Schema.Literal("Boom") }),
        onFailure: () => Node.succeed(0)
      }),
      3
    )
    expect(Node.catchFilter(protectedNode.ast)).toBeDefined()

    const declared = { action: "build" }
    const called = Node.priority(Node.actionCall(declared, "build", { target: "all" }), 3)
    expect(Node.declaration(tagged(called.ast, "ActionCall"))).toBe(declared)
  })

  it("attaches a priority to an AST that carries no side-table entry", () => {
    // An AST reaches `priority` without a side-table entry when it did not
    // come from the constructors: a shallow copy, or a plan decoded from
    // storage. Re-filing must copy what the table holds and invent nothing,
    // so the accessors keep reporting `undefined` instead of handing the
    // graph walk an entry belonging to another node.
    const detached = <A, E, R>(node: Node.Node<A, E, R>): Node.Node<A, E, R> =>
      internal.makeNode<A, E, R>({ ...node.ast } as internal.NodeAst)

    const mapped = Node.priority(detached(Node.map(Node.succeed(1), (value: number) => value + 1)), 3)
    expect(Node.declaredPriority(mapped.ast)).toBe(3)
    expect(Node.mapper(mapped.ast)).toBeUndefined()

    const decided = Node.priority(
      detached(
        Node.branch(Node.succeed(1), {
          if: (value: number) => value > 0,
          then: () => Node.succeed("yes"),
          else: () => Node.succeed("no")
        })
      ),
      3
    )
    expect(Node.declaredPriority(decided.ast)).toBe(3)
    expect(Node.predicate(decided.ast)).toBeUndefined()

    const protectedNode = Node.priority(
      detached(
        Node.catch(Node.succeed(1) as Node.Node<number, { readonly _tag: "Boom" }>, {
          error: Schema.Struct({ _tag: Schema.Literal("Boom") }),
          onFailure: () => Node.succeed(0)
        })
      ),
      3
    )
    expect(Node.declaredPriority(protectedNode.ast)).toBe(3)
    expect(Node.catchFilter(protectedNode.ast)).toBeUndefined()

    const called = Node.priority(detached(Node.actionCall({ action: "build" }, "build", { target: "all" })), 3)
    expect(Node.declaredPriority(called.ast)).toBe(3)
    expect(Node.declaration(tagged(called.ast, "ActionCall"))).toBeUndefined()
  })

  it("refuses a priority that is not a safe integer", () => {
    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      let refusal: unknown
      try {
        Node.priority(Node.succeed(1), value)
      } catch (error) {
        refusal = error
      }
      expect(refusal).toBeInstanceOf(GraphBuildError)
      expect((refusal as GraphBuildError).code).toBe("invalid_priority")
    }
  })
})

/**
 * `isNode` guards every combinator that reads a value's `ast` as trusted
 * topology. The public marker is an exported string any object can carry, so
 * a node is either one this package registered when it built it or one with
 * the node prototype and a well-formed own `ast`: the shape `@smthrs/flow`
 * hands back for an AST that crossed a serialization boundary.
 */
describe("Node.isNode", () => {
  const genuine = Node.succeed(1)
  const NodeProto = Object.getPrototypeOf(genuine) as object
  const leaf = { _tag: "Succeed", value: 1 }
  const identity = { _tag: "FunctionIdentity", algorithm: "static-node/v1", digest: "d" }
  /** The shape a rehydrated node has: the node prototype and an own `ast` data property. */
  const rehydrate = (ast: unknown): Node.Any => Object.assign(Object.create(NodeProto) as Node.Any, { ast })

  const cyclic: Record<string, unknown> = { _tag: "Map", mapper: identity }
  cyclic.first = cyclic
  /** Values that are not an AST, each refused at the field that breaks the shape. */
  const malformed: ReadonlyArray<readonly [label: string, ast: unknown]> = [
    ["null", null],
    ["a number", 1],
    ["no tag", { value: 1 }],
    ["an unknown tag", { _tag: "Loop" }],
    ["a priority that is not a safe integer", { _tag: "Succeed", value: 1, priority: 1.5 }],
    ["an All without nodes", { _tag: "All" }],
    ["an All whose nodes is an array", { _tag: "All", nodes: [leaf] }],
    ["an All with a malformed member", { _tag: "All", nodes: { ok: leaf, bad: { _tag: "Loop" } } }],
    ["a Race without nodes", { _tag: "Race", mode: "race", count: 1 }],
    ["a Race whose nodes is an array", { _tag: "Race", mode: "race", count: 1, nodes: [leaf] }],
    ["a Race with an unknown mode", { _tag: "Race", mode: "all", count: 1, nodes: { a: leaf } }],
    ["a Race with no members", { _tag: "Race", mode: "any", count: 1, nodes: {} }],
    ["a race needing two successes", { _tag: "Race", mode: "race", count: 2, nodes: { a: leaf, b: leaf } }],
    ["a quorum wider than its members", { _tag: "Race", mode: "quorum", count: 2, nodes: { a: leaf } }],
    ["a quorum count that is not an integer", { _tag: "Race", mode: "quorum", count: "1", nodes: { a: leaf } }],
    ["a Race with a malformed member", {
      _tag: "Race",
      mode: "any",
      count: 1,
      nodes: { ok: leaf, bad: { _tag: "Loop" } }
    }],
    ["a Map without a mapper", { _tag: "Map", first: leaf }],
    ["a Map whose mapper has the wrong tag", { _tag: "Map", first: leaf, mapper: { ...identity, _tag: "Digest" } }],
    ["a Map whose mapper names an unknown algorithm", {
      _tag: "Map",
      first: leaf,
      mapper: { ...identity, algorithm: "md5" }
    }],
    ["a Map whose mapper digest is not a string", { _tag: "Map", first: leaf, mapper: { ...identity, digest: 1 } }],
    ["a Map with a malformed first", { _tag: "Map", first: 1, mapper: identity }],
    ["an AndThen without a continuation", { _tag: "AndThen", first: leaf }],
    ["an AndThen with a malformed first", { _tag: "AndThen", first: null, continuation: identity }],
    ["an AndThen with a malformed next", {
      _tag: "AndThen",
      first: leaf,
      continuation: identity,
      next: { _tag: "Loop" }
    }],
    ["a Branch without a subject", { _tag: "Branch", first: leaf, predicate: identity, then: leaf, else: leaf }],
    ["a Branch without a predicate", { _tag: "Branch", subject: "s", first: leaf, then: leaf, else: leaf }],
    ["a Branch with a malformed arm", {
      _tag: "Branch",
      subject: "s",
      first: leaf,
      predicate: identity,
      then: leaf,
      else: 1
    }],
    ["a Catch without a subject", { _tag: "Catch", protected: leaf, failure: leaf }],
    ["a Catch with a malformed failure arm", {
      _tag: "Catch",
      subject: "s",
      protected: leaf,
      failure: { _tag: "Loop" }
    }],
    ["a FlowCall without a flow", { _tag: "FlowCall", mode: "inline", payload: {} }],
    ["a FlowCall with an unknown mode", { _tag: "FlowCall", flow: "f", mode: "detached", payload: {} }],
    ["an ActionCall without an action", { _tag: "ActionCall", payload: {} }],
    ["a cyclic ast", cyclic]
  ]

  const impostors: ReadonlyArray<readonly [label: string, value: unknown]> = [
    ["an own marker beside a well-formed ast", { [Node.TypeId]: {}, ast: leaf }],
    ["an own marker and no ast", { [Node.TypeId]: true }],
    ["an own marker beside a malformed ast tag", { [Node.TypeId]: true, ast: { _tag: "Loop" } }],
    ["a marker and ast inherited from a genuine node", Object.create(genuine) as unknown],
    ["a marker and ast inherited from a rehydrated node", Object.create(rehydrate(leaf)) as unknown],
    ["the node prototype and no ast", Object.create(NodeProto) as unknown],
    [
      "the node prototype and an ast accessor",
      Object.defineProperty(Object.create(NodeProto) as object, "ast", { get: () => leaf })
    ],
    ["a proxy that hides a genuine node's ast", new Proxy(genuine, { getOwnPropertyDescriptor: () => undefined })],
    ["a proxy that disowns the node prototype", new Proxy(genuine, { getPrototypeOf: () => Object.prototype })],
    ...malformed.map(([label, ast]) => [`the node prototype and ${label} as its ast`, rehydrate(ast)] as const)
  ]

  const refusal = (build: () => unknown): unknown => {
    try {
      build()
    } catch (error) {
      return error
    }
    return undefined
  }

  it("recognizes nodes this package built", () => {
    expect(Node.isNode(genuine)).toBe(true)
    expect(Node.isNode(genuine.pipe(Node.priority(1)))).toBe(true)
    expect(Node.isNode(Node.all({ genuine }))).toBe(true)
    expect(Node.isNode(genuine.pipe(Node.map((value) => value + 1)))).toBe(true)
    expect(Node.isNode(Node.actionCall({}, "act", {}))).toBe(true)
  })

  it("recognizes a rehydrated node: the node prototype and a JSON round-tripped ast", () => {
    const built = Node.all({
      chain: Node.succeed(0).pipe(
        Node.map((value) => value + 1),
        Node.bindPlanned(() => Node.succeed("built")),
        Node.andThen(Node.succeed("direct")),
        Node.branch({ if: (value) => value === "direct", then: () => Node.succeed(1), else: () => Node.succeed(2) }),
        Node.catch({ error: Schema.String, onFailure: () => Node.succeed(3) }),
        Node.priority(7)
      ),
      flow: Node.flowCall({}, "flow/child", "boundary", { seed: 1 }),
      // A payload of `undefined` has no JSON form, so the round trip drops the key.
      action: Node.actionCall({}, "action/write", undefined)
    })
    const rehydrated = rehydrate(JSON.parse(JSON.stringify(built.ast)))
    expect(rehydrated.ast).not.toBe(built.ast)
    expect(Node.isNode(rehydrated)).toBe(true)
    // Every combinator admits it and stores the ast it carries.
    expect(tagged(Node.all({ member: rehydrated }).ast, "All").nodes.member).toBe(rehydrated.ast)
    expect(tagged(Node.race({ member: rehydrated }).ast, "Race").nodes.member).toBe(rehydrated.ast)
    expect(tagged(Node.andThen(Node.succeed(0), rehydrated).ast, "AndThen").next).toBe(rehydrated.ast)
    const decided = Node.branch(Node.succeed(0), { if: () => true, then: () => rehydrated, else: () => rehydrated })
    expect(tagged(decided.ast, "Branch")).toMatchObject({ then: rehydrated.ast, else: rehydrated.ast })
    expect(tagged(Node.catch(Node.succeed(0), { onFailure: () => rehydrated }).ast, "Catch").failure).toBe(
      rehydrated.ast
    )
  })

  it("accepts a shared sub-ast and refuses a cyclic one", () => {
    expect(Node.isNode(rehydrate({ _tag: "All", nodes: { left: leaf, right: leaf } }))).toBe(true)
    expect(Node.isNode(rehydrate({ _tag: "Race", mode: "quorum", count: 2, nodes: { left: leaf, right: leaf } })))
      .toBe(true)
    expect(Node.isNode(rehydrate({ _tag: "AndThen", first: leaf, continuation: identity, next: leaf }))).toBe(true)
    expect(Node.isNode(rehydrate(cyclic))).toBe(false)
  })

  it("walks an ast deeper than the native stack allows", () => {
    let ast: unknown = leaf
    for (let depth = 0; depth < 100_000; depth++) ast = { _tag: "Map", first: ast, mapper: identity }
    expect(Node.isNode(rehydrate(ast))).toBe(true)
  })

  it("judges a proxy by the shape it forwards", () => {
    // Nothing structural tells a proxy that forwards a node unchanged from the
    // node, and the ast it forwards is the node's own, so it passes; the two
    // proxies in the impostor list diverge from that shape and do not.
    expect(Node.isNode(new Proxy(genuine, {}))).toBe(true)
  })

  it("refuses every impostor and every non-object", () => {
    for (const [label, impostor] of impostors) {
      expect(Node.isNode(impostor), label).toBe(false)
    }
    for (const [label, ast] of malformed) {
      expect(internal.isNodeAst(ast), label).toBe(false)
    }
    expect(Node.isNode(null)).toBe(false)
    expect(Node.isNode(undefined)).toBe(false)
    expect(Node.isNode(1)).toBe(false)
    expect(Node.isNode(Node.TypeId)).toBe(false)
  })

  // The closed unions the walk checks are declared once, as schemas, so an
  // algorithm or a mode added to a union cannot be missed by the guard: this
  // enumerates each literal the schema carries and rehydrates an AST for it.
  it("accepts every algorithm and every call mode the schemas declare", () => {
    for (const algorithm of internal.IdentityAlgorithm.literals) {
      const ast = { _tag: "Map", first: leaf, mapper: { ...identity, algorithm } }
      expect(internal.isNodeAst(ast), algorithm).toBe(true)
      expect(Node.isNode(rehydrate(ast)), algorithm).toBe(true)
    }
    for (const mode of internal.CallMode.literals) {
      const ast = { _tag: "FlowCall", flow: "child", mode, payload: { n: 1 } }
      expect(internal.isNodeAst(ast), mode).toBe(true)
      expect(Node.isNode(rehydrate(ast)), mode).toBe(true)
    }
  })

  it("refuses every impostor in every combinator that admits a node", () => {
    for (const [label, impostor] of impostors) {
      const forged = impostor as Node.Any
      expect(refusal(() => Node.all({ member: forged })), label).toMatchObject({
        code: "invalid_all_member",
        node: "member",
        message: "Node.all expected a Node at member \"member\""
      })
      expect(refusal(() => Node.andThen(Node.succeed(0), forged)), label).toMatchObject({
        code: "invalid_continuation",
        node: "andThen/next",
        message:
          "Node.andThen expects a Node; use Node.bindPlanned for a symbolic builder or Node.map for value computation"
      })
      for (const side of ["then", "else"] as const) {
        expect(
          refusal(() =>
            Node.branch(Node.succeed(0), {
              if: () => true,
              then: () => side === "then" ? forged : Node.succeed("then"),
              else: () => side === "else" ? forged : Node.succeed("else")
            })
          ),
          `${label} (${side})`
        ).toMatchObject({
          code: "invalid_continuation",
          node: `${Node.branchSubject}/${side}`,
          message: `Node.branch expected its "${side}" arm to return a Node`
        })
      }
      expect(refusal(() => Node.catch(Node.succeed(0), { onFailure: () => forged })), label).toMatchObject({
        code: "invalid_continuation",
        node: Node.catchSubject,
        message: "Node.catch expected its failure arm to return a Node"
      })
    }
  })

  it("admits a genuine node in every combinator that guards one", () => {
    expect(tagged(Node.all({ member: genuine }).ast, "All").nodes).toEqual({ member: genuine.ast })
    expect(tagged(Node.andThen(Node.succeed(0), genuine).ast, "AndThen").next).toEqual(genuine.ast)
    const decided = Node.branch(Node.succeed(0), { if: () => true, then: () => genuine, else: () => genuine })
    expect(tagged(decided.ast, "Branch")).toMatchObject({ then: genuine.ast, else: genuine.ast })
    expect(tagged(Node.catch(Node.succeed(0), { onFailure: () => genuine }).ast, "Catch").failure).toEqual(genuine.ast)
  })

  it("declares the Node interface once, in the public module", () => {
    const node = internal.makeNode<number, string, "R">({ _tag: "Succeed", value: 1 })
    expectTypeOf(node).toEqualTypeOf<Node.Node<number, string, "R">>()
    expectTypeOf(Node.succeed(1)).toEqualTypeOf<Node.Node<number>>()
    const source = readFileSync(new URL("../src/internal/node.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/\binterface Node\b/)
  })
})
