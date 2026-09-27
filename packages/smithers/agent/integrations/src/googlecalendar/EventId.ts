/**
 * Deterministic Google Calendar event ids.
 *
 * Google lets a client choose an event's id on insert, and refuses a second
 * insert of the same id with a 409. That makes the id the idempotency key an
 * event write otherwise lacks: derive it from what the event *is* (a meeting
 * series, one principal's slot), and a retried or replayed insert names the
 * same event instead of creating a second one.
 *
 * Google's rules for a caller-chosen id: only the base32hex alphabet
 * (lowercase `a`-`v` and the digits), between 5 and 1024 characters, unique
 * per calendar. {@link fromKey} is the SHA-256 of the key in that alphabet,
 * 52 characters, so any key yields a valid id and distinct keys collide only
 * as SHA-256 does.
 *
 * Ids a caller did not choose are looser: Google's generated ids and the
 * instance ids of a recurring series (the series id, an underscore, and the
 * original start) fall outside base32hex. {@link EventReference} accepts
 * those for reads, patches and deletes; only an insert needs {@link EventId}.
 *
 * @since 1.0.0
 */

import { Schema } from "effect"
import { createHash } from "node:crypto"

const ALPHABET = "0123456789abcdefghijklmnopqrstuv"

/**
 * The shape of an id a caller may choose on insert.
 *
 * @category constants
 * @since 1.0.0
 */
export const EVENT_ID_PATTERN = /^[a-v0-9]{5,1024}$/

/**
 * The shape of any event or instance id this package sends in a request path.
 *
 * Letters, digits, `_` and `-`, at most 1024 characters. Nothing that could
 * form a `.` or `..` path segment or leave the segment once encoded.
 *
 * @category constants
 * @since 1.0.0
 */
export const EVENT_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/

/**
 * An id a caller may choose when inserting an event.
 *
 * @category schemas
 * @since 1.0.0
 */
export const EventId = Schema.String.check(Schema.isPattern(EVENT_ID_PATTERN))

/**
 * An id a caller may choose when inserting an event.
 *
 * @category models
 * @since 1.0.0
 */
export type EventId = typeof EventId.Type

/**
 * The id of an existing event or of one instance of a recurring event.
 *
 * @category schemas
 * @since 1.0.0
 */
export const EventReference = Schema.String.check(Schema.isPattern(EVENT_REFERENCE_PATTERN))

/**
 * Whether `value` is valid as a caller-chosen event id.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isEventId = (value: unknown): value is EventId => typeof value === "string" && EVENT_ID_PATTERN.test(value)

/**
 * Whether `value` may name an existing event or instance in a request.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isEventReference = (value: unknown): value is string =>
  typeof value === "string" && EVENT_REFERENCE_PATTERN.test(value)

/**
 * RFC 4648 base32hex without padding, in lowercase.
 *
 * @category constructors
 * @since 1.0.0
 */
export const base32hex = (bytes: Uint8Array): string => {
  let output = ""
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) output += ALPHABET[(buffer << (5 - bits)) & 31]
  return output
}

/**
 * The event id for a caller's key: SHA-256 of its UTF-8 bytes in base32hex.
 *
 * The key should name the event in the caller's own terms and namespace it,
 * such as `weekly-one-on-one/lead`, so two features cannot pick the same id
 * by accident. The same key always yields the same id.
 *
 * @category constructors
 * @since 1.0.0
 */
export const fromKey = (key: string): EventId => base32hex(createHash("sha256").update(key, "utf8").digest())
