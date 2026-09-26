/**
 * The Telegram integration surface.
 *
 * A Bot API client, a long-poll source, inline-keyboard approvals, Mini App
 * `initData` verification, and the chunking and MarkdownV2 helpers the client
 * uses.
 *
 * @since 1.0.0
 */

/**
 * @category actions
 * @since 1.0.0
 */
export * as Actions from "./telegram/Actions.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Approval from "./telegram/Approval.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Chunk from "./telegram/Chunk.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Config from "./telegram/Config.ts"

/**
 * @category verification
 * @since 1.0.0
 */
export * as InitData from "./telegram/InitData.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Markdown from "./telegram/Markdown.ts"

/**
 * @category schemas
 * @since 1.0.0
 */
export * as Payload from "./telegram/Payload.ts"

/**
 * @category services
 * @since 1.0.0
 */
export * as Source from "./telegram/Source.ts"

/**
 * @category services
 * @since 1.0.0
 */
export * as TelegramClient from "./telegram/TelegramClient.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as IssueSync from "./telegram/IssueSync.ts"
