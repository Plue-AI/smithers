/**
 * Pure, pipeable nodes: the shape a flow body describes and nothing more.
 *
 * Building a node records an inspectable AST and executes nothing — the same
 * split as Bazel's `ctx.actions.run`, which declares an action rather than
 * running one. A plan is
 * always a DAG, so there is no loop node here and never will be: repetition
 * lives one level up, in what a flow settles with.
 *
 * A node also carries Effect's requirement channel, `R`, and carries it as a
 * PHANTOM: building a plan demands nothing, and every combinator here unions
 * `R` without ever reading it. What fills the channel is a call to something
 * whose code lives elsewhere — an action — so the type of a plan states which
 * implementations executing it will need, and the place that executes it is
 * where the compiler asks for them.
 *
 * Control flow is structure. {@link branch} takes both arms and evaluates each
 * ONCE, symbolically, so the exit condition and the handoff site are visible
 * topology before anything runs; its predicate is digested and runs later on
 * the real value. {@link map} is transformation only. The rule the authoring
 * note states, and this module encodes: **map transforms; branch decides.**
 *
 * Adapted from `@smthrs/core` (`packages/smithers/flows/core`) `Node.ts`.
 * `Dynamic` is gone — a model call is an ordinary action, and nothing
 * model-shaped belongs in this package — and node annotations are gone with
 * it, because the AST has to stay JSON serializable.
 *
 * @since 0.1.0
 */

import { dual } from "effect/Function"
import type * as Pipeable from "effect/Pipeable"
import type * as Schema from "effect/Schema"
import type * as Types from "effect/Types"
import { GraphBuildError } from "./GraphBuildError.ts"
import * as internal from "./internal/node.ts"
import * as Planned from "./Planned.ts"

/**
 * The runtime type identifier carried by every node.
 *
 * @since 0.1.0
 * @category type ids
 * @slop
 */
export const TypeId: TypeId = internal.TypeId

/**
 * The type-level form of {@link TypeId}.
 *
 * @since 0.1.0
 * @category type ids
 * @slop
 */
export type TypeId = "~@smthrs/plan/Node"

/**
 * The inspectable AST a node stores: closure-free, and JSON serializable for
 * every JSON payload an author puts in it.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Ast = internal.NodeAst

/**
 * How a flow call joins the caller's plan: `inline` splices the callee's body
 * in, `boundary` makes it one child execution, and `handoff` names the next
 * trampoline round.
 *
 * This is the ONE call-mode vocabulary. {@link flowCall} takes it and
 * `@smthrs/flow`'s graph builder switches on it, so a second spelling in
 * either package would fork the moment one gained a mode.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const CallMode = internal.CallMode

/**
 * The value form of {@link CallMode}.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type CallMode = internal.CallMode

/**
 * The serializable stand-in an AST keeps for a plan-time function: a digest of
 * its normalized source, hashed in place of a closure that could not be
 * shipped, stored, or compared.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type FunctionIdentity = Extract<Ast, { readonly _tag: "Map" }>["mapper"]

/**
 * Reads the inert AST reference created for a planned value.
 *
 * Structural lookalikes remain ordinary payload data. This accessor is the
 * only recognition path because the marker itself is deliberately private to
 * the AST cloner.
 *
 * @since 1.0.0
 * @category accessors
 */
export const plannedReference = internal.plannedReference

/**
 * A pure graph-building value, covariant in what it will succeed and fail
 * with and in what it will need to run. It is a description: holding one has
 * run nothing.
 *
 * `R` is Effect's requirement channel, and it is PHANTOM here. Nothing at plan
 * time reads it: the AST, the graph built from it, its key material, and every
 * digest are identical whatever `R` says. It exists so a value that names an
 * implementation it does not carry — an action call — can say so in its type,
 * and so the place that finally has to run that implementation can demand it.
 * Building a plan therefore stays requirement-free; only executing one is not.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Node<out A, out E = never, out R = never> extends Pipeable.Pipeable {
  readonly [TypeId]: {
    readonly _A: Types.Covariant<A>
    readonly _E: Types.Covariant<E>
    readonly _R: Types.Covariant<R>
  }
  readonly ast: Ast
}

/**
 * Any node, whatever it succeeds or fails with and whatever it requires.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Any = Node<unknown, unknown, any>

/**
 * The success type of a node.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Success<N> = N extends Node<infer A, infer _E, infer _R> ? A : never

/**
 * The error type of a node.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Error<N> = N extends Node<infer _A, infer E, infer _R> ? E : never

/**
 * The requirements of a node: what has to be provided wherever it is finally
 * executed, and nothing that has to be provided to build it.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Services<N> = N extends Node<infer _A, infer _E, infer R> ? R : never

/**
 * The node reference a branch arm's symbolic subject carries. Arms are built
 * before the graph assigns ids, so every reference an arm records names this
 * placeholder, and graph building rewrites it to the branch's own upstream
 * node — which is `first`, structurally, and therefore not a guess.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const branchSubject = "branch/subject"

/** @private */
const subjectsKey = Symbol.for("@smthrs/plan/Node/subjects/v1")
const globals = globalThis as typeof globalThis & { [subjectsKey]?: { branch: number; catch: number } }
const subjects = globals[subjectsKey] ??= { branch: 0, catch: 0 }

/**
 * The prefix of the node reference a catch failure arm's symbolic error
 * carries. Each {@link catch_} mints its own token under this prefix, so an
 * outer error captured inside a nested failure arm keeps naming the outer
 * catch, and graph building rewrites each token to the node that catch
 * protects.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const catchSubject = "catch/subject"

/**
 * The two arms of a decision plus the predicate that chooses between them.
 *
 * `if` runs at RUN time on the real value. `then` and `else` run at PLAN time,
 * once each, against a {@link module:Planned.Planned} placeholder — they
 * describe topology, so they may pass the value on but never compute on it.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface BranchOptions<A, B1, E1, R1, B2, E2, R2> {
  readonly if: (value: A) => boolean
  readonly then: (value: Planned.Planned<A>) => Node<B1, E1, R1>
  readonly else: (value: Planned.Planned<A>) => Node<B2, E2, R2>
}

/**
 * The statically planned recovery arm and optional schema selecting which
 * typed failures it handles.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface CatchOptions<E, B, E2, R2 = never, Handled = E> {
  readonly error?: Schema.Schema<Handled> | undefined
  readonly onFailure: (error: Planned.Planned<Handled>) => Node<B, E2, R2>
}

/**
 * Checks whether a value is a node.
 *
 * A node this package built is recognized by registration at construction. A
 * node that crossed a serialization boundary, an object sharing the node
 * prototype whose own `ast` is a well-formed AST, is recognized by that shape,
 * because `@smthrs/flow` hands a rehydrated AST back as a node and its side
 * tables are all a round trip loses. The {@link TypeId} marker is a public
 * string any object can carry, so it counts for nothing on its own: every
 * combinator that admits a node reads its `ast` as trusted topology, and an
 * object carrying the marker on any other prototype, one inheriting it from a
 * node, and one whose `ast` is missing, malformed, cyclic, or an accessor are
 * all refused with the same `GraphBuildError` as any other non-node. A proxy
 * is judged by the shape it forwards: one that forwards a node unchanged
 * passes, and one that diverges from it does not.
 *
 * @since 0.1.0
 * @category guards
 * @slop
 */
export const isNode = (value: unknown): value is Any => internal.isNode(value)

/**
 * The inert value delivered by {@link succeed}. Planned references resolve to
 * their result type; other values follow the payload's JSON projection.
 * Invalid dates serialize to null. Members without a JSON representation are
 * omitted from objects and replaced with null in arrays.
 *
 * @since 1.0.0
 * @category models
 */
export type Succeed<A> = A extends Planned.Planned<infer Value> ? Value
  : A extends Date ? string | null
  : A extends { toJSON: (...args: any) => infer Value } ? Succeed<Value>
  : A extends (...args: any) => any ? undefined
  : A extends symbol ? undefined
  : A extends ReadonlyArray<unknown> ? { [K in keyof A]: SucceedArrayMember<A[K]> }
  : A extends object ? {
      [K in keyof A as K extends string | number ? [Succeed<A[K]>] extends [undefined] ? never : K : never]: Succeed<
        A[K]
      >
    }
  : A

/** @private */
type SucceedArrayMember<A> = A extends Planned.Planned<infer Value> ? Value
  : A extends unknown ? Succeed<A> extends infer Value ? Value extends undefined ? null : Value
    : never
  : never

/**
 * A node that succeeds with the constant's inert JSON projection.
 *
 * Dates produce strings (or null for invalid dates), URLs produce strings,
 * and callable object members are omitted. Use {@link map} to reconstruct a
 * domain value explicitly after this serialization boundary.
 *
 * @since 0.1.0
 * @category constructors
 */
export const succeed = <A>(value: A): Node<Succeed<A>> => internal.makeNode<Succeed<A>>(internal.succeed(value))

/**
 * The inert error delivered by {@link fail}: the same JSON projection
 * {@link Succeed} describes, because a plan stores an error exactly as it
 * stores a value.
 *
 * @since 1.0.0
 * @category models
 */
export type Fail<E> = Succeed<E>

/**
 * A node that fails with the constant's inert JSON projection, in the typed
 * error channel.
 *
 * It is how a plan states a refusal it already knows about — an unsupported
 * input, an exhausted budget, a compensation that has nothing left to undo —
 * without an action that exists only to fail. {@link catch} recovers it exactly
 * as it recovers an action's failure, and an uncaught one is the flow's typed
 * failure.
 *
 * @since 1.0.0
 * @category constructors
 */
export const fail = <E>(error: E): Node<never, Fail<E>> => internal.makeNode<never, Fail<E>>(internal.fail(error))

/**
 * Combines independent children into one node, keyed by name.
 *
 * Width is fixed here, at plan time. Fanning out over something a step
 * discovered is not this: end the round and carry the list in the next flow's
 * payload, where it is real data.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const all = <const Nodes extends Readonly<Record<string, Any>>>(
  nodes: Nodes
): Node<
  Types.Simplify<{ readonly [K in keyof Nodes]: Success<Nodes[K]> }>,
  Error<Nodes[keyof Nodes]>,
  Services<Nodes[keyof Nodes]>
> => internal.makeNode(internal.all(memberAsts(nodes, "all", "invalid_all_member")))

/**
 * The member ASTs of a combination, keyed by name, refusing a non-node member.
 *
 * @private
 */
const memberAsts = (
  nodes: Readonly<Record<string, unknown>>,
  combinator: string,
  code: "invalid_all_member" | "invalid_join"
): Record<string, Ast> => {
  const asts: Record<string, Ast> = Object.create(null) as Record<string, Ast>
  for (const [member, node] of Object.entries(nodes)) {
    if (!isNode(node)) {
      throw new GraphBuildError({
        code,
        node: member,
        path: [],
        message: `Node.${combinator} expected a Node at member "${member}"`
      })
    }
    Object.defineProperty(asts, member, {
      configurable: true,
      enumerable: true,
      value: node.ast,
      writable: true
    })
  }
  return asts
}

/**
 * Builds a join that settles early, refusing a member set it could never
 * decide on.
 *
 * @private
 */
const join = (mode: internal.RaceMode, count: number, nodes: Readonly<Record<string, unknown>>): Ast => {
  const asts = memberAsts(nodes, mode, "invalid_join")
  const width = Object.keys(asts).length
  if (!internal.isRaceCount(mode, count, width)) {
    throw new GraphBuildError({
      code: "invalid_join",
      node: mode,
      path: [],
      message: mode === "quorum"
        ? `Node.quorum needs a whole number of successes between 1 and its ${width} members, got ${String(count)}`
        : `Node.${mode} needs at least one member`
    })
  }
  return internal.race(mode, count, asts)
}

/**
 * The members of an early-settling join, keyed by name.
 *
 * @since 1.0.0
 * @category models
 */
export type Members = Readonly<Record<string, Any>>

/**
 * Settles with the first member to settle, success or typed failure.
 *
 * The other members are interrupted. The winner is journaled, so a resumed run
 * settles the same member and never starts the others again.
 *
 * @since 1.0.0
 * @category constructors
 */
export const race = <const Nodes extends Members>(
  nodes: Nodes
): Node<Success<Nodes[keyof Nodes]>, Error<Nodes[keyof Nodes]>, Services<Nodes[keyof Nodes]>> =>
  internal.makeNode(join("race", 1, nodes))

/**
 * Settles with the first member to succeed, ignoring typed failures while a
 * member is still running.
 *
 * It fails with the last failure when every member fails. The other members
 * are interrupted, and the winner is journaled as {@link race} journals it.
 *
 * @since 1.0.0
 * @category constructors
 */
export const any = <const Nodes extends Members>(
  nodes: Nodes
): Node<Success<Nodes[keyof Nodes]>, Error<Nodes[keyof Nodes]>, Services<Nodes[keyof Nodes]>> =>
  internal.makeNode(join("any", 1, nodes))

/**
 * Succeeds once `count` members succeed, with exactly those members' values
 * keyed by name.
 *
 * It fails with the failure that leaves fewer than `count` members able to
 * succeed. Either way the members still running are interrupted, and the
 * members that decided are journaled as {@link race} journals its winner.
 *
 * @since 1.0.0
 * @category constructors
 */
export const quorum = <const Nodes extends Members>(
  count: number,
  nodes: Nodes
): Node<
  Types.Simplify<{ readonly [K in keyof Nodes]?: Success<Nodes[K]> }>,
  Error<Nodes[keyof Nodes]>,
  Services<Nodes[keyof Nodes]>
> => internal.makeNode(join("quorum", count, nodes))

/**
 * Transforms an eventual success value with a deferred pure function.
 *
 * The function is digested, not run: it executes later, on the real value.
 * This is where computation on a step result belongs — and only computation. A
 * `map` that decides what happens next is a `branch` written wrongly.
 *
 * @since 0.1.0
 * @category mapping
 * @slop
 */
export const map: {
  <A, B>(f: (a: A) => B): <E, R>(self: Node<A, E, R>) => Node<B, E, R>
  <A, E, R, B>(self: Node<A, E, R>, f: (a: A) => B): Node<B, E, R>
} = dual(
  2,
  <A, E, R, B>(self: Node<A, E, R>, f: (a: A) => B): Node<B, E, R> =>
    internal.makeNode<B, E, R>(internal.map(self.ast, (value) => f(value as A), f))
)

/**
 * Starts the entire next subtree only after this node succeeds, without
 * consuming its result. Failure or interruption prevents that subtree from
 * starting, including actions nested inside combinations or inline flows.
 *
 * Use {@link bindPlanned} to build a dependency from a symbolic result, or
 * {@link map} to compute on the eventual value.
 *
 * @since 0.1.0
 * @category sequencing
 * @slop
 */
export const andThen: {
  <B, E2, R2>(next: Node<B, E2, R2>): <A, E, R>(self: Node<A, E, R>) => Node<B, E | E2, R | R2>
  <A, E, R, B, E2, R2>(self: Node<A, E, R>, next: Node<B, E2, R2>): Node<B, E | E2, R | R2>
} = dual(
  2,
  <A, E, R, B, E2, R2>(
    self: Node<A, E, R>,
    next: Node<B, E2, R2>
  ): Node<B, E | E2, R | R2> => {
    if (!isNode(next)) {
      throw new GraphBuildError({
        code: "invalid_continuation",
        node: "andThen/next",
        path: [],
        message:
          "Node.andThen expects a Node; use Node.bindPlanned for a symbolic builder or Node.map for value computation"
      })
    }
    return internal.makeNode<B, E | E2, R | R2>(internal.andThenNode(self.ast, next.ast))
  }
)

/**
 * Builds a dependency using a symbolic reference to this node's future result.
 *
 * The builder runs during planning. Its argument is a {@link module:Planned.Planned}
 * reference, not the value the node will eventually produce. Pass references
 * into action payloads; use {@link branch} for decisions and {@link map} for
 * computation on real results. JavaScript truthiness and reference equality
 * cannot inspect a planned result. Enable type-aware ESLint's
 * `@typescript-eslint/strict-boolean-expressions` to reject planned conditions.
 * Independent descendants of the built subtree can start while this producer
 * is running; consumers of its reference wait for its value. Use
 * {@link andThen} when the whole next subtree must wait for success.
 *
 * @since 1.0.0
 * @category sequencing
 */
export const bindPlanned: {
  <A, B, E2, R2>(
    build: (reference: Planned.Planned<A>) => Node<B, E2, R2>
  ): <E, R>(self: Node<A, E, R>) => Node<B, E | E2, R | R2>
  <A, E, R, B, E2, R2>(
    self: Node<A, E, R>,
    build: (reference: Planned.Planned<A>) => Node<B, E2, R2>
  ): Node<B, E | E2, R | R2>
} = dual(
  2,
  <A, E, R, B, E2, R2>(
    self: Node<A, E, R>,
    build: (reference: Planned.Planned<A>) => Node<B, E2, R2>
  ): Node<B, E | E2, R | R2> =>
    internal.makeNode<B, E | E2, R | R2>(
      internal.andThen(self.ast, (value) => build(value as Planned.Planned<A>), build)
    )
)

/**
 * Builds one arm, once, against the symbolic subject.
 *
 * @private
 */
const arm = <A, B, E, R>(
  build: (value: Planned.Planned<A>) => Node<B, E, R>,
  subject: Planned.Planned<A>,
  side: string
): Ast => {
  const node = build(subject)
  if (!isNode(node)) {
    throw new GraphBuildError({
      code: "invalid_continuation",
      node: `${branchSubject}/${side}`,
      path: [],
      message: `Node.branch expected its "${side}" arm to return a Node`
    })
  }
  return node.ast
}

/**
 * Decides between two arms, both of them static topology.
 *
 * Each arm builder is evaluated exactly once, here, against a
 * {@link module:Planned.Planned} placeholder, and the resulting ASTs are what
 * the node stores — so a plan shows the exit condition and both continuations
 * before it runs. The predicate is digested and evaluated at run time on the
 * real value, which is why none of the plan-time placeholder machinery leaks
 * into control flow.
 *
 * Both arms contribute their requirements, because both arms are topology the
 * plan carries. A run takes one of them, but which one is not known until the
 * predicate sees the real value, so an execution has to be able to take either.
 *
 * @since 0.1.0
 * @category sequencing
 * @slop
 */
export const branch: {
  <A, B1, E1, R1, B2, E2, R2>(
    options: BranchOptions<A, B1, E1, R1, B2, E2, R2>
  ): <E, R>(self: Node<A, E, R>) => Node<B1 | B2, E | E1 | E2, R | R1 | R2>
  <A, E, R, B1, E1, R1, B2, E2, R2>(
    self: Node<A, E, R>,
    options: BranchOptions<A, B1, E1, R1, B2, E2, R2>
  ): Node<B1 | B2, E | E1 | E2, R | R1 | R2>
} = dual(
  2,
  <A, E, R, B1, E1, R1, B2, E2, R2>(
    self: Node<A, E, R>,
    options: BranchOptions<A, B1, E1, R1, B2, E2, R2>
  ): Node<B1 | B2, E | E1 | E2, R | R1 | R2> => {
    const predicate = options.if
    const subjectToken = `${branchSubject}/${subjects.branch++}`
    const subject = Planned.make<A>(subjectToken)
    return internal.makeNode<B1 | B2, E | E1 | E2, R | R1 | R2>(
      internal.branch(
        subjectToken,
        self.ast,
        (value) => predicate(value as A),
        predicate,
        arm(options.then, subject, "then"),
        arm(options.else, subject, "else")
      )
    )
  }
)

/**
 * Recovers from matching typed failures with static failure topology.
 *
 * The protected graph and failure arm are both stored in the AST. The arm is
 * built once at plan time against a strict planned error placeholder. With no
 * schema the whole typed error channel is handled. A schema handles only the
 * values it accepts, so its overloads retain E: a refinement can reject values
 * without narrowing its TypeScript type. Runtime schema callbacks enter the
 * filter identity along with its JSON Schema. Uncaptured callbacks are local
 * to this process, just like uncaptured mappers.
 *
 * The failure arm contributes its requirements to the node's, for the same
 * reason a branch's arms do: it is topology the plan carries, and a run reaches
 * it whenever the protected graph fails.
 *
 * @since 0.1.0
 * @category sequencing
 * @slop
 */
const catch_: {
  <Handled, B, E2, R2>(
    options: CatchOptions<unknown, B, E2, R2, Handled> & {
      readonly error: Schema.Schema<Handled>
    }
  ): <A, E, R>(self: Node<A, E, R>) => Node<A | B, E | E2, R | R2>
  <E, B, E2, R2>(
    options: CatchOptions<E, B, E2, R2> & {
      readonly error?: undefined
    }
  ): <A, R>(self: Node<A, E, R>) => Node<A | B, E2, R | R2>
  <A, E, R, Handled, B, E2, R2>(
    self: Node<A, E, R>,
    options: CatchOptions<E, B, E2, R2, Handled> & {
      readonly error: Schema.Schema<Handled>
    }
  ): Node<A | B, E | E2, R | R2>
  <A, E, R, B, E2, R2>(
    self: Node<A, E, R>,
    options: CatchOptions<E, B, E2, R2> & {
      readonly error?: undefined
    }
  ): Node<A | B, E2, R | R2>
} = dual(
  2,
  <A, E, R, Handled, B, E2, R2>(
    self: Node<A, E, R>,
    options: CatchOptions<E, B, E2, R2, Handled>
  ): Node<A | B, E | E2, R | R2> => {
    const subjectToken = `${catchSubject}/${subjects.catch++}`
    const failure = options.onFailure(Planned.make<Handled>(subjectToken))
    if (!isNode(failure)) {
      throw new GraphBuildError({
        code: "invalid_continuation",
        node: catchSubject,
        path: [],
        message: "Node.catch expected its failure arm to return a Node"
      })
    }
    return internal.makeNode(internal.catch_(subjectToken, self.ast, failure.ast, options.error))
  }
)

export { catch_ as catch }

/**
 * Attaches a scheduling priority to a node, leaving the original unchanged.
 *
 * The scheduler runs ready work with a higher number first, so a priority
 * changes LATENCY and nothing else. It never enters key material: a node
 * ordered ahead of another still computes the same result, so re-keying it
 * would throw away a legitimate cache hit. Children inherit the value
 * lexically when the graph is built, and a child that states its own keeps it.
 *
 * @since 0.1.0
 * @category annotations
 * @slop
 */
export const priority: {
  (value: number): <A, E, R>(self: Node<A, E, R>) => Node<A, E, R>
  <A, E, R>(self: Node<A, E, R>, value: number): Node<A, E, R>
} = dual(
  2,
  <A, E, R>(self: Node<A, E, R>, value: number): Node<A, E, R> => {
    if (!Number.isSafeInteger(value)) {
      throw new GraphBuildError({
        code: "invalid_priority",
        node: self.ast._tag,
        path: [],
        message: `Node.priority expects a safe integer, received ${value}`
      })
    }
    return internal.makeNode<A, E, R>(internal.withPriority(self.ast, value))
  }
)

/**
 * Reads the scheduling priority a node carries, or `undefined` when it states
 * none and inherits from whatever encloses it.
 *
 * @since 0.1.0
 * @category accessors
 * @slop
 */
export const declaredPriority = (ast: Ast): number | undefined => ast.priority

/**
 * Constructs the flow-call node used by `@smthrs/flow` without making flow
 * calls part of the public authoring surface of this package.
 *
 * Reserved for `@smthrs/flow`, which owns flow authoring. It is not part
 * of this package's authoring surface, and it validates nothing: an unknown
 * flow tag becomes a call node the graph keeps as a leaf.
 *
 * @since 0.1.0
 * @category engine
 * @slop
 */
export const flowCall = <A = unknown, E = never, R = never>(
  declaration: unknown,
  flow: string,
  mode: CallMode,
  payload: unknown
): Node<A, E, R> => internal.makeNode<A, E, R>(internal.flowCall(declaration, flow, mode, payload))

/**
 * Constructs the action-call node used by `@smthrs/flow` without making
 * action calls part of the public authoring surface of this package.
 *
 * Reserved for `@smthrs/flow`, which owns action authoring. It is not part
 * of this package's authoring surface, and an unknown action tag becomes a
 * call node the graph keeps as a leaf.
 *
 * @since 0.1.0
 * @category engine
 * @slop
 */
export const actionCall = <A = unknown, E = never, R = never>(
  declaration: unknown,
  action: string,
  payload: unknown
): Node<A, E, R> => internal.makeNode<A, E, R>(internal.actionCall(declaration, action, payload))

/**
 * Reads the flow or action declaration a call node names, so `@smthrs/flow`
 * can expand a call it recorded. It is `undefined` for an AST that was
 * rehydrated from JSON, because the declaration lives beside the AST rather
 * than inside it — a graph built from such an AST keeps the call as a leaf.
 *
 * Reserved for `@smthrs/flow`, which files the declaration when it builds
 * the call. Authors never call it.
 *
 * @since 0.1.0
 * @category engine
 * @slop
 */
export const declaration = (
  ast: Extract<Ast, { readonly _tag: "ActionCall" | "FlowCall" }>
): unknown => internal.declaration(ast)

/**
 * Reads the continuation builder of a sequenced node, which graph building
 * evaluates once against a placeholder. It is `undefined` when the author
 * supplied a node directly — the topology is already in `next` — and for a
 * rehydrated AST, whose side table did not survive serialization.
 *
 * Reserved for `@smthrs/flow`'s graph walk. Authors never call it.
 *
 * @since 0.1.0
 * @category engine
 * @slop
 */
export const continuation = (
  ast: Extract<Ast, { readonly _tag: "AndThen" }>
): ((value: Planned.Planned<unknown>) => unknown) | undefined => internal.operation(ast)

/**
 * Reads the deferred mapper of a {@link map} node, which a driver applies to
 * the real upstream value once it has one. It is `undefined` for every other
 * variant, and for a rehydrated AST whose side table did not survive
 * serialization.
 *
 * Reserved for `@smthrs/flow`'s interpreter. Authors never call it.
 *
 * @since 0.1.0
 * @category engine
 * @slop
 */
export const mapper = (ast: Ast): ((value: unknown) => unknown) | undefined =>
  ast._tag === "Map" ? internal.operation(ast) : undefined

/**
 * Reads the run-time predicate of a {@link branch} node, which a driver
 * evaluates on the real subject value to choose an arm. It is `undefined` for
 * every other variant, and for a rehydrated AST whose side table did not
 * survive serialization.
 *
 * Reserved for `@smthrs/flow`'s interpreter. Authors never call it.
 *
 * @since 0.1.0
 * @category engine
 * @slop
 */
export const predicate = (ast: Ast): ((value: unknown) => boolean) | undefined =>
  ast._tag === "Branch" ? internal.predicate(ast) : undefined

/**
 * Reads the optional schema selecting failures handled by a {@link catch_}.
 *
 * Reserved for `@smthrs/flow`'s interpreter. It is `undefined` for every
 * variant but `catch_`, and for a rehydrated AST whose side table did not
 * survive serialization.
 *
 * @since 0.1.0
 * @category engine
 * @slop
 */
export const catchFilter = (ast: Ast): Schema.Top | undefined => ast._tag === "Catch" ? internal.filter(ast) : undefined

/**
 * Identifies a plan-time function the AST does NOT store, a flow's `body`,
 * exactly as the AST identifies the mapper and continuation it does store.
 * A call that keeps its callee as a leaf still has to re-key when that
 * callee's body is edited, and this is the identity it folds in. Unannotated
 * functions fail closed with process-local identity; use {@link capture} to
 * declare inert captures and obtain deterministic identity.
 *
 * Reserved for `@smthrs/flow`, which folds a callee body's identity into a
 * call it keeps as a leaf. Authors never call it; it throws a `TypeError`
 * when handed anything but a function.
 *
 * @since 0.1.0
 * @category engine
 * @slop
 */
export const functionIdentity = (operation: unknown): FunctionIdentity => internal.functionIdentity(operation)

/**
 * Binds a frozen plain copy of inert captures as the callback's this receiver.
 *
 * Use a function expression to read the snapshot while keeping the ordinary
 * callback arguments: Node.capture({ factor: 3 }, function(value: number) {
 *   return value * this.factor
 * }). Caller objects remain unchanged; lexical aliases still name originals
 * and must not be used as mutable semantic inputs. Nested captures retain the
 * inner callback's snapshot and compose the two identities.
 *
 * Admission walks original descriptors once, rejects built-in brands and
 * non-plain prototypes without evaluating getters, then uses structuredClone
 * to refuse Proxies. Hosts without that API refuse object capture. Only the
 * owned frozen copy enters identity and the wrapper. Sealed, non-extensible,
 * frozen and Immer ordinary data are supported equally. Unsupported values
 * raise a TypeError naming the path. See core docs/api.md#nodecapture for the
 * complete algorithm and the migration from original-object locking.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const capture = <C extends Readonly<Record<string, unknown>>, Args extends ReadonlyArray<unknown>, A>(
  captures: C,
  operation: (this: Readonly<C>, ...args: Args) => A
): (...args: Args) => A => internal.capture(captures, operation)
