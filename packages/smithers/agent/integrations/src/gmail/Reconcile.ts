/**
 * Finding a message this package wrote, after its answer was lost.
 *
 * A draft or a send that ended `outcomeUnknown` may exist. Every composed
 * message carries `X-Smithers-Key` and a Message-ID derived from the key, so
 * {@link findByKey} searches the mailbox, trash and spam included, for that
 * Message-ID with Gmail's `rfc822msgid:` operator, reads each hit's headers,
 * and keeps only messages whose key header is exactly the key.
 *
 * An empty answer is evidence, not proof. Gmail's search index can lag a
 * write, and this package has observed the lookup only against a fixture
 * server, not a live mailbox; a caller deciding whether to write again should
 * wait and look again rather than treat one empty answer as "never sent".
 * Searching needs the connection's `read` operation.
 *
 * @since 1.0.0
 */

import { Effect, Schema } from "effect"
import { IntegrationError } from "../core/IntegrationError.ts"
import type { GmailClient } from "./GmailClient.ts"
import { KEY_HEADER, messageIdFor, SmithersKey } from "./Mime.ts"
import { header } from "./Records.ts"

/**
 * One message carrying the key.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Match = Schema.Struct({
  messageId: Schema.String,
  threadId: Schema.String,
  labelIds: Schema.Array(Schema.String)
})

/**
 * One message carrying the key.
 *
 * @category models
 * @since 1.0.0
 */
export type Match = typeof Match.Type

/**
 * The most search hits read for one key.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_CANDIDATES = 10

/**
 * The Gmail search that finds a key's Message-ID.
 *
 * @category constructors
 * @since 1.0.0
 */
export const queryFor = (key: string): string => `rfc822msgid:${messageIdFor(key).slice(1, -1)}`

/**
 * The messages in the mailbox that carry `key`, drafts included.
 *
 * @category constructors
 * @since 1.0.0
 */
export const findByKey = (client: GmailClient, key: string): Effect.Effect<ReadonlyArray<Match>, IntegrationError> =>
  Effect.gen(function*() {
    if (!Schema.is(SmithersKey)(key)) {
      return yield* Effect.fail(
        new IntegrationError("invalid-config", "The Gmail reconciliation key is not a Smithers key.", {
          retryable: false
        })
      )
    }
    const page = yield* client.listMessages({
      q: queryFor(key),
      includeSpamTrash: true,
      maxResults: MAX_CANDIDATES
    })
    const found = yield* Effect.forEach(
      page.messages ?? [],
      (ref) =>
        client.getMessage(ref.id, { format: "metadata", metadataHeaders: [KEY_HEADER, "Message-ID"] }).pipe(
          Effect.map((message) =>
            header(message, KEY_HEADER) === key
              ? [{ messageId: message.id, threadId: message.threadId, labelIds: [...(message.labelIds ?? [])] }]
              : []
          ),
          // Deleted between the search and the read: it no longer carries anything.
          Effect.catchIf((error) => error.details?.["status"] === 404, () => Effect.succeed([]))
        )
    )
    return found.flat()
  })
