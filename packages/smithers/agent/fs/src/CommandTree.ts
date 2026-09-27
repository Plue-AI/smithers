/**
 * The bounded, immutable segment trie shared by every command projection.
 *
 * @since 0.1.0
 */

import * as ReadonlyMap from "@smthrs/canonical/ReadonlyMap"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { FsError } from "./FsError.ts"
import * as Boundary from "./internal/Boundary.ts"
import * as CommandLine from "./internal/CommandLine.ts"
import * as Route from "./Route.ts"

/**
 * Maximum routes accepted by one tree.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumRoutes = 256

/**
 * Maximum total path segments accepted by one tree.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumTotalSegments = 4_096

/**
 * Maximum tokens accepted by one direct resolution request.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumResolutionTokens = 4_096

/**
 * A node of the command trie.
 *
 * A node may carry a route, children, or both: `domains` and `domains/list`
 * may both be routable in the same tree.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommandTree {
  readonly route: Option.Option<Route.Route>
  readonly children: ReadonlyMap<string, CommandTree>
}

/**
 * A route selected from an argv prefix, with the unconsumed tokens.
 *
 * @category models
 * @since 0.1.0
 */
export interface Resolved {
  readonly route: Route.Route
  readonly rest: ReadonlyArray<string>
}

interface MutableTree {
  route: Option.Option<Route.Route>
  readonly children: Map<string, MutableTree>
}

const emptyNode = (): MutableTree => ({ route: Option.none(), children: new Map() })

const resourceLimit = (method: string, description: string): FsError =>
  new FsError({ code: "resource_limit", method, description })

const routeReferences = (input: ReadonlyArray<Route.Route>): ReadonlyArray<Route.Route> => {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      throw new FsError({
        code: "invalid_route",
        method: "CommandTree.make",
        description: "Routes must be supplied as an ordinary dense array"
      })
    }
    if (input.length > maximumRoutes) {
      throw resourceLimit("CommandTree.make", `A command tree may contain at most ${maximumRoutes} routes`)
    }
    if (Reflect.ownKeys(input).length !== input.length + 1) {
      throw new FsError({
        code: "invalid_route",
        method: "CommandTree.make",
        description: "Routes must be supplied as an ordinary dense array"
      })
    }
    const output: Array<Route.Route> = []
    for (let index = 0; index < input.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new FsError({
          code: "invalid_route",
          method: "CommandTree.make",
          description: "Routes must be supplied as enumerable data properties",
          path: `$[${index}]`
        })
      }
      output.push(descriptor.value as Route.Route)
    }
    return Object.freeze(output)
  } catch (cause) {
    if (cause instanceof FsError) throw cause
    throw new FsError({
      code: "invalid_route",
      method: "CommandTree.make",
      description: "Routes could not be inspected without executing user code"
    })
  }
}

const freezeTree = (root: MutableTree): CommandTree => {
  const frozen = new Map<MutableTree, CommandTree>()
  const stack: Array<{ readonly node: MutableTree; readonly visited: boolean }> = [{ node: root, visited: false }]
  while (stack.length > 0) {
    const frame = stack.pop()!
    if (!frame.visited) {
      stack.push({ node: frame.node, visited: true })
      for (const child of frame.node.children.values()) stack.push({ node: child, visited: false })
      continue
    }
    const entries = Array.from(frame.node.children, ([segment, child]) => [segment, frozen.get(child)!] as const)
    frozen.set(
      frame.node,
      Object.freeze({
        route: Option.isSome(frame.node.route) ? Object.freeze(Option.some(frame.node.route.value)) : Option.none(),
        children: ReadonlyMap.make(entries)
      })
    )
  }
  return frozen.get(root)!
}

/**
 * Builds one immutable command trie.
 *
 * Two routes claiming the same segment path fail instead of shadowing one
 * another. Every route is detached before the first caller-observable await.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (input: ReadonlyArray<Route.Route>): Effect.Effect<CommandTree, FsError> =>
  Effect.gen(function*() {
    const references = yield* Effect.try({
      try: () => routeReferences(input),
      // `routeReferences` catches every reflective operation and normalizes
      // every throw before it leaves the synchronous boundary.
      catch: (cause) => cause as FsError
    })
    const routes = yield* Effect.forEach(references, Route.snapshot)
    const totalSegments = routes.reduce((total, route) => total + route.segments.length, 0)
    if (totalSegments > maximumTotalSegments) {
      return yield* Effect.fail(
        resourceLimit("CommandTree.make", `A command tree may contain at most ${maximumTotalSegments} total segments`)
      )
    }

    const root = emptyNode()
    for (const route of routes) {
      let node = root
      for (const segment of route.segments) {
        let child = node.children.get(segment)
        if (child === undefined) {
          child = emptyNode()
          node.children.set(segment, child)
        }
        node = child
      }
      if (Option.isSome(node.route)) {
        return yield* Effect.fail(
          new FsError({
            code: "duplicate_route",
            method: "CommandTree.make",
            description: "Two routes claim the same command name",
            path: route.name
          })
        )
      }
      node.route = Option.some(route)
    }
    return freezeTree(root)
  })

const resolutionTokens = (input: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>, FsError> => {
  const captured = Boundary.stringArray(input, {
    maxItems: maximumResolutionTokens,
    maxLength: CommandLine.maximumTokenLength,
    allowEmpty: true
  })
  return captured.ok
    ? Effect.succeed(captured.value)
    : Effect.fail(resourceLimit("CommandTree.resolve", "The command arguments exceed their resource bounds"))
}

/**
 * Resolves the longest routable prefix of an argv.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolve = (tree: CommandTree, input: ReadonlyArray<string>): Effect.Effect<Resolved, FsError> =>
  Effect.gen(function*() {
    const argv = yield* resolutionTokens(input)
    let node = tree
    let matched: { readonly route: Route.Route; readonly consumed: number } | undefined
    for (let index = 0; index < argv.length; index++) {
      const segment = argv[index]!
      if (segment.length === 0 || segment.length > Route.maximumRouteNameLength) {
        // Once a route matches, a token that cannot be a route segment belongs
        // to its argument tail and retains the command-token bounds.
        if (matched !== undefined) break
        return yield* Effect.fail(resourceLimit("CommandTree.resolve", "The command name exceeds its resource bounds"))
      }
      // Route identity is canonicalized to NFC in `Route.snapshot`, so a name
      // typed or transmitted in decomposed form still selects the same route.
      // Only the lookup key is normalized: unconsumed argument text is left
      // exactly as the caller supplied it.
      const child = node.children.get(segment.normalize("NFC"))
      if (child === undefined) break
      node = child
      if (Option.isSome(child.route)) matched = { route: child.route.value, consumed: index + 1 }
    }
    if (matched === undefined) {
      return yield* Effect.fail(
        new FsError({
          code: "unknown_command",
          method: "CommandTree.resolve",
          description: "No command matches the supplied name"
        })
      )
    }
    return Object.freeze({ route: matched.route, rest: Object.freeze(argv.slice(matched.consumed)) })
  })

/**
 * Resolves one complete route name and refuses unconsumed path segments.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolveExact = (tree: CommandTree, argv: ReadonlyArray<string>): Effect.Effect<Route.Route, FsError> =>
  Effect.flatMap(resolve(tree, argv), ({ rest, route }) =>
    rest.length === 0
      ? Effect.succeed(route)
      : Effect.fail(
        new FsError({
          code: "unknown_command",
          method: "CommandTree.resolveExact",
          description: "No command exactly matches the supplied name"
        })
      ))

/**
 * Lists every route in stable segment order.
 *
 * @category getters
 * @since 0.1.0
 */
export const traverse = (tree: CommandTree): ReadonlyArray<Route.Route> => {
  const routes: Array<Route.Route> = []
  const stack: Array<CommandTree> = [tree]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (Option.isSome(node.route)) routes.push(node.route.value)
    const children = Array.from(node.children.keys()).sort().reverse()
    for (const segment of children) stack.push(node.children.get(segment)!)
  }
  return Object.freeze(routes)
}
