// Generated from packages/backend/flowruntime/outside_change.json.
// Regenerate: node packages/backend/flowruntime/generate-outside-change.mjs
/**
 * The build-time outside-change switch the agent host shares with the backend.
 * While it is false, the host refuses outside_change signals. Enable it only
 * with the pinned durable consumer and daemon stale-write enforcement composed.
 *
 * @since 1.0.0
 */

/**
 * @since 1.0.0
 * @private
 */
export const outsideChangeConsumerEnabled: boolean = false
