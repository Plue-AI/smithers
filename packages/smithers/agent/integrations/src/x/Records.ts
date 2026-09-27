/**
 * X posts and direct messages as provenance-carrying source records.
 *
 * A mention is a public post, so its record is scoped `public`; its thread is
 * the post's conversation, its parent the post it replies to, and its
 * container the account it mentions. A direct message is scoped `private` to
 * its conversation, whatever the conversation says. Text is the post or
 * message text as X returned it; it is data, never instructions.
 *
 * Posts are immutable (an edit is a new post id), so `version` is `null`. A
 * post's link is X's id-only status URL; a direct message has no public link.
 *
 * @since 1.0.0
 */

import type { SourceRecord } from "../core/SourceRecord.ts"
import type { DmEvent, Includes, Tweet, User } from "./XClient.ts"

/**
 * The record provider name.
 *
 * @category constants
 * @since 1.0.0
 */
export const PROVIDER = "x"

/**
 * The record kind of a mention.
 *
 * @category constants
 * @since 1.0.0
 */
export const MENTION_KIND = "mention"

/**
 * The record kind of a direct message.
 *
 * @category constants
 * @since 1.0.0
 */
export const DIRECT_MESSAGE_KIND = "direct-message"

/**
 * Where a record came from.
 *
 * @category models
 * @since 1.0.0
 */
export interface Context {
  readonly connectionId: string
  readonly retrievedAtMs: number
}

/**
 * The link to a post.
 *
 * @category constructors
 * @since 1.0.0
 */
export const tweetUrl = (id: string): string => `https://x.com/i/web/status/${id}`

/**
 * An ISO 8601 instant in Unix milliseconds, or `null`.
 *
 * @category conversions
 * @since 1.0.0
 */
export const instant = (value: string | undefined): number | null => {
  const ms = value === undefined ? Number.NaN : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

const userOf = (includes: Includes | undefined, id: string | undefined): User | undefined =>
  id === undefined ? undefined : includes?.users?.find((user) => user.id === id)

const author = (id: string | undefined, user: User | undefined) =>
  id === undefined
    ? null
    : { id, label: user?.username !== undefined ? `@${user.username}` : user?.name ?? null }

/**
 * A post that mentions `userId`, as a public record.
 *
 * @category conversions
 * @since 1.0.0
 */
export const fromMention = (
  tweet: Tweet,
  includes: Includes | undefined,
  context: Context & { readonly userId: string }
): SourceRecord => {
  const user = userOf(includes, tweet.author_id)
  const at = instant(tweet.created_at)
  return {
    provider: PROVIDER,
    connectionId: context.connectionId,
    externalId: tweet.id,
    kind: MENTION_KIND,
    url: tweetUrl(tweet.id),
    author: author(tweet.author_id, user),
    createdAtMs: at,
    updatedAtMs: at,
    version: null,
    retrievedAtMs: context.retrievedAtMs,
    access: { scope: "public", containerId: null },
    thread: {
      containerId: context.userId,
      threadId: tweet.conversation_id ?? null,
      parentId: tweet.referenced_tweets?.find((reference) => reference.type === "replied_to")?.id ?? null
    },
    text: tweet.text,
    deleted: false,
    payload: { tweet, author: user ?? null }
  }
}

/**
 * A direct-message event, as a record private to its conversation.
 *
 * @category conversions
 * @since 1.0.0
 */
export const fromDirectMessage = (event: DmEvent, includes: Includes | undefined, context: Context): SourceRecord => {
  const sender = userOf(includes, event.sender_id)
  const at = instant(event.created_at)
  const conversation = event.dm_conversation_id ?? null
  return {
    provider: PROVIDER,
    connectionId: context.connectionId,
    externalId: event.id,
    kind: DIRECT_MESSAGE_KIND,
    url: null,
    author: author(event.sender_id, sender),
    createdAtMs: at,
    updatedAtMs: at,
    version: null,
    retrievedAtMs: context.retrievedAtMs,
    access: { scope: "private", containerId: conversation },
    thread: { containerId: conversation, threadId: conversation, parentId: null },
    text: event.text ?? "",
    deleted: false,
    payload: { event, sender: sender ?? null }
  }
}
