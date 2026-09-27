/**
 * The descendant walk over lineage edges, shared by both stores.
 *
 * `TimeTravelStore` promises that the memory and SQL stores answer alike for
 * the same history, and which descendants a rewind crosses decides which
 * journals it archives. Each store used to carry its own copy of this walk,
 * and the copies drifted once; there is now one.
 *
 * @since 0.1.0
 */

import type { Frame, LineageEdge } from "../Frame.ts"

/**
 * The descendants a rewind of `runId` to `frame` crosses.
 *
 * Only the root's edges above `frame.seq` count. Attached children are walked
 * transitively; a detached child is reported but its own subtree is not, since
 * it no longer depends on the truncated history. One child is one descendant:
 * the edge union can name the same child twice (a fork edge plus a journaled
 * handoff), and reporting it twice made a caller cancel it twice.
 *
 * @since 0.1.0
 * @category combinators
 */
export const descendants = (
  edges: ReadonlyArray<LineageEdge>,
  runId: string,
  frame: Frame
): {
  readonly attached: ReadonlyArray<LineageEdge>
  readonly detached: ReadonlyArray<LineageEdge>
  readonly attachedRunIds: ReadonlySet<string>
} => {
  const attached: Array<LineageEdge> = []
  const detached: Array<LineageEdge> = []
  const attachedRunIds = new Set<string>()
  const detachedRunIds = new Set<string>()
  const queue: Array<string> = []

  const include = (edge: LineageEdge): void => {
    if (edge.attached) {
      if (attachedRunIds.has(edge.childRunId)) return
      attached.push(edge)
      attachedRunIds.add(edge.childRunId)
      queue.push(edge.childRunId)
    } else {
      if (detachedRunIds.has(edge.childRunId)) return
      detached.push(edge)
      detachedRunIds.add(edge.childRunId)
    }
  }

  for (const edge of edges) {
    if (edge.parentRunId === runId && edge.parentSeq > frame.seq) include(edge)
  }
  while (queue.length > 0) {
    const parentRunId = queue.shift()!
    for (const edge of edges) {
      if (edge.parentRunId === parentRunId) include(edge)
    }
  }

  return { attached, detached, attachedRunIds }
}
