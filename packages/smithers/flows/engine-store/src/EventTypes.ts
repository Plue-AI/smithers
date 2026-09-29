/**
 * Stable engine journal record names shared with replay consumers.
 *
 * @since 1.0.0
 */

/**
 * Persisted event types and the child-spawn effect kind. Writers and readers
 * share these identities; changing a value requires migrating stored history.
 * `childSpawnKind` names the effect inside a boundary, not its event type.
 *
 * @since 1.0.0
 * @category constants
 */
export const EventTypes = {
  runDecision: "flows.engine.run-decision",
  attemptStarted: "flows.engine.attempt-started",
  attemptFinished: "flows.engine.attempt-finished",
  snapshotIdentified: "flows.engine.snapshot-identified",
  planRecorded: "flows.engine.plan-recorded",
  subgraphAppended: "flows.engine.subgraph-appended",
  deferredCompleted: "flows.engine.deferred-completed",
  clockScheduled: "flows.engine.clock-scheduled",
  childSpawnKind: "flows/engine-store/child-spawn"
} as const
