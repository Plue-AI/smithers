/**
 * The GitHub integration surface.
 *
 * A narrow host layer plus the durable actions over it: a REST client,
 * payload schemas, and the actions a flow calls. An application composes them
 * into flows of its own and adds actions for the endpoints it needs. GitHub
 * webhooks enter through the Smithers backend, which decides who may start
 * work.
 *
 * @since 1.0.0
 */

/**
 * @category actions
 * @since 1.0.0
 */
export * as Actions from "./github/Actions.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Config from "./github/Config.ts"

/**
 * @category services
 * @since 1.0.0
 */
export * as GitHubClient from "./github/GitHubClient.ts"

/**
 * @category schemas
 * @since 1.0.0
 */
export * as Payload from "./github/Payload.ts"

/**
 * @category services
 * @since 1.0.0
 */
export * as Proxy from "./github/Proxy.ts"

/**
 * @category services
 * @since 1.0.0
 */
export * as RateLimit from "./github/RateLimit.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Repository from "./github/Repository.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Sync from "./github/Sync.ts"
