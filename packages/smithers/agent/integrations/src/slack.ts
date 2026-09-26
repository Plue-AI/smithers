/**
 * The Slack integration surface.
 *
 * A Web API client, an Events API webhook door, a Socket Mode source, a
 * conversation change feed that produces source records, durable post, update
 * and reconcile actions, and Block Kit button approvals. Every ingress admits
 * through the same fail-closed workspace and channel allowlists and refuses
 * the app's own messages.
 *
 * @since 1.0.0
 */

/**
 * @category actions
 * @since 1.0.0
 */
export * as Actions from "./slack/Actions.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Approval from "./slack/Approval.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Config from "./slack/Config.ts"

/**
 * @category services
 * @since 1.0.0
 */
export * as Connections from "./slack/Connections.ts"

/**
 * @category schemas
 * @since 1.0.0
 */
export * as Payload from "./slack/Payload.ts"

/**
 * @category services
 * @since 1.0.0
 */
export * as SlackClient from "./slack/SlackClient.ts"

/**
 * @category services
 * @since 1.0.0
 */
export * as SocketSource from "./slack/SocketSource.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Sync from "./slack/Sync.ts"

/**
 * @category verification
 * @since 1.0.0
 */
export * as Webhook from "./slack/Webhook.ts"

/** @category constructors
 * @since 1.0.0
 */
export * as IssueSync from "./slack/IssueSync.ts"
