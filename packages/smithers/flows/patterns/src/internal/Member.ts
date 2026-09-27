/**
 * The one type a pattern names when it takes something to call.
 *
 * Every pattern in this package composes members: the flows and actions a
 * caller hands it. `@smthrs/flow` has two kinds of declaration, a `Flow` and an
 * `Action.Declared`, and both record a call the same way, through their own
 * `.call(payload)`. This module names that shared shape once so no pattern
 * restates it, and carries the one helper that records a call.
 *
 * A member is described structurally rather than as a union of the two
 * declaration types, so a caller may also hand a pattern its own object with a
 * `.call`, which is what the package's own tests do.
 *
 * @since 1.0.0
 * @private
 */

import type * as Node from "@smthrs/plan/Node"

/**
 * Something a pattern calls: any `@smthrs/flow` declaration, flow or action,
 * whose `.call` records a node.
 *
 * A `Flow` names itself with `_tag` and an `Action.Declared` with `name`, so
 * both are read here and {@link displayName} answers from whichever is there.
 *
 * @since 1.0.0
 * @private
 */
export interface Member<R = never> {
  readonly _tag?: string | undefined
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly call: (payload: never) => Node.Node<unknown, unknown, R>
}

/**
 * Records one call to a member, with the payload a pattern hands it.
 *
 * A member's own `.call` is typed by its declared payload, and a pattern hands
 * it a payload the pattern composed, so the cast is the single place this
 * package crosses that boundary.
 *
 * @since 1.0.0
 * @private
 */
export const call = <R>(member: Member<R>, payload: unknown): Node.Node<unknown, unknown, R> =>
  member.call(payload as never)
