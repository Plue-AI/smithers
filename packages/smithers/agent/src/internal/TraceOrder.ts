/**
 * Where a control record sits in its frame, for its trace identity.
 *
 * @since 1.0.0-rc.0
 */

/**
 * Record types that take no ordinal in their frame.
 *
 * `AgentSession.traceIdentity` folds in an event's ordinal within its frame, so an
 * event type added in the MIDDLE of a frame moves every row after it: a run
 * journaled before the type existed and resumed after would re-derive its
 * whole recorded prefix one ordinal along, match none of it, and publish all
 * of it a second time. `AgentSession`'s `lateFields` cannot help, because nothing about
 * the rows that moved has changed except where they sit.
 *
 * These are therefore identified by what they say rather than by where
 * they sit, the way `prompt-rendered` is. Each carries its own coordinates in
 * its payload (`scope`, `frame`, and for a request `purpose` and `attempt`),
 * which no two records of one run share, and they are written at ordinal zero
 * without advancing the count the other rows are numbered by.
 *
 * @category projections
 * @since 1.0.0-rc.0
 */
export const unordered: ReadonlySet<string> = new Set([
  "control.agent.model-requested",
  "control.agent.decision-settled",
  // Written by the supervisor fiber off the loop's hot path, at whatever
  // ordinal the frame has reached when Jev answers; `scope` and `frame` are
  // the coordinates, and no two readings of one run share them.
  "control.agent.supervisor-settled",
  "control.agent.supervisor-unjudged",
  "control.agent.supervisor-memory-failed",
  // Jev readings outside the supervisor, each carrying its own coordinates.
  "control.agent.decision-unjudged",
  "control.agent.relevance-settled",
  "control.agent.relevance-restored",
  "control.agent.seat-routed"
])
