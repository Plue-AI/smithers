/**
 * The provenance envelope for anything an integration retrieves.
 *
 * A message, a GitHub issue comment and an external event are different
 * documents, and this package keeps their provider payload exactly as it
 * arrived. What every one of them also needs, before it can be stored,
 * retrieved or placed in a prompt, is the same set of facts: which provider
 * and connection it came from, its stable external identity and link, who
 * wrote it and when, which version this is, when it was retrieved, who may
 * read it, and which thread it belongs to. `SourceRecord` is that set.
 *
 * `text` is the provider adapter's searchable rendering of the payload; it is
 * data, never instructions. `deleted` marks a tombstone: the provider removed
 * the object, so its payload and text are empty and retrieval never returns it.
 *
 * @since 1.0.0
 */

import { Schema } from "effect"

/**
 * Who may read a record, as the provider scoped it.
 *
 * `private` is one person's data (a direct message, a personal calendar),
 * `container` is visible to members of `access.containerId` (a channel, a
 * repository), `workspace` to every member of the connected workspace, and
 * `public` to anyone.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AccessScope = Schema.Literals(["private", "container", "workspace", "public"])

/**
 * One of {@link AccessScope}'s values.
 *
 * @category models
 * @since 1.0.0
 */
export type AccessScope = typeof AccessScope.Type

/**
 * The provider's author identity for a record.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Author = Schema.Struct({
  /** The provider's stable user or bot id. */
  id: Schema.NonEmptyString,
  /** A display label, when the provider supplied one. Never an identity. */
  label: Schema.NullOr(Schema.String)
})

/**
 * The provider's access scope for a record.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Access = Schema.Struct({
  scope: AccessScope,
  /** The container the scope is relative to, or `null` when it names none. */
  containerId: Schema.NullOr(Schema.NonEmptyString)
})

/**
 * Where a record sits in its conversation or hierarchy.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Thread = Schema.Struct({
  /** The channel, repository or calendar holding the record. */
  containerId: Schema.NullOr(Schema.NonEmptyString),
  /** The thread root's external id, or `null` outside a thread. */
  threadId: Schema.NullOr(Schema.NonEmptyString),
  /** The direct parent's external id (a comment's issue), or `null`. */
  parentId: Schema.NullOr(Schema.NonEmptyString)
})

/**
 * One retrieved provider object with its provenance.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SourceRecord = Schema.Struct({
  /** The provider that produced it: `github`. */
  provider: Schema.NonEmptyString,
  /** The configured connection it was retrieved through. */
  connectionId: Schema.NonEmptyString,
  /** The provider's stable identity for the object, unique within the connection. */
  externalId: Schema.NonEmptyString,
  /** The provider object kind: `message`, `issue`, `issue-comment`, `event`. */
  kind: Schema.NonEmptyString,
  /** A link to the object at the provider, when it has one. */
  url: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Author),
  /** When the provider says the object was created, in Unix milliseconds. */
  createdAtMs: Schema.NullOr(Schema.Number),
  /** When the provider says the object last changed, in Unix milliseconds. */
  updatedAtMs: Schema.NullOr(Schema.Number),
  /** The provider's version token (an edit timestamp, an etag), when it has one. */
  version: Schema.NullOr(Schema.String),
  /** When this copy was retrieved, in Unix milliseconds. */
  retrievedAtMs: Schema.Number,
  access: Access,
  thread: Thread,
  /** Searchable text rendered by the provider adapter. Data, never instructions. */
  text: Schema.String,
  /** Whether the provider deleted the object. A tombstone carries empty text and payload. */
  deleted: Schema.Boolean,
  /** The provider payload, as delivered. */
  payload: Schema.Json
})

/**
 * One retrieved provider object with its provenance.
 *
 * @category models
 * @since 1.0.0
 */
export type SourceRecord = typeof SourceRecord.Type

/**
 * Decodes an unknown value as a {@link SourceRecord}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const decode = Schema.decodeUnknownEffect(SourceRecord)

/**
 * The fields that order two copies of one record.
 *
 * @category models
 * @since 1.0.0
 */
export type Ordering = Pick<SourceRecord, "updatedAtMs" | "deleted" | "version">

// A decimal version token: `1712345678.000200`, an external sequence.
const DECIMAL_VERSION = /^(\d+)(?:\.(\d+))?$/

const sign = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1

/**
 * Orders two provider version tokens.
 *
 * A missing token sorts first. Two decimal tokens compare as numbers, digit by
 * digit, so `10.5` follows `9.75` without a floating-point round trip that
 * would merge two microsecond-distinct timestamps. Any other pair
 * compares by code unit: a total order, so the same pair always resolves the
 * same way whichever copy arrives first.
 *
 * @category ordering
 * @since 1.0.0
 */
export const compareVersion = (left: string | null, right: string | null): number => {
  if (left === right) return 0
  if (left === null) return -1
  if (right === null) return 1
  const leftDecimal = DECIMAL_VERSION.exec(left)
  const rightDecimal = DECIMAL_VERSION.exec(right)
  if (leftDecimal !== null && rightDecimal !== null) {
    const leftWhole = leftDecimal[1]!.replace(/^0+(?=\d)/, "")
    const rightWhole = rightDecimal[1]!.replace(/^0+(?=\d)/, "")
    if (leftWhole.length !== rightWhole.length) return leftWhole.length < rightWhole.length ? -1 : 1
    const whole = sign(leftWhole, rightWhole)
    if (whole !== 0) return whole
    const width = Math.max(leftDecimal[2]?.length ?? 0, rightDecimal[2]?.length ?? 0)
    const fraction = sign((leftDecimal[2] ?? "").padEnd(width, "0"), (rightDecimal[2] ?? "").padEnd(width, "0"))
    if (fraction !== 0) return fraction
  }
  return sign(left, right)
}

/**
 * Orders two copies of one record: negative when `candidate` is older than
 * `current`, zero when neither is newer, positive when `candidate` is newer.
 *
 * The provider's change time decides first, and a copy with no change time is
 * older than any copy that has one. At the same time a deletion follows the
 * live copy, because a provider stamps a delete with the time of the version it
 * removed. Then the version token decides. Between two copies with no change
 * time, the version is the only change order, so it decides before deletion:
 * a provider without change times versions every copy, deletions and
 * restorations included, from one sequence. Each time class is ordered
 * lexicographically, so this is a total order and applying copies in any
 * order converges on the same winner.
 *
 * @category ordering
 * @since 1.0.0
 */
export const compare = (current: Ordering, candidate: Ordering): number => {
  if (current.updatedAtMs !== candidate.updatedAtMs) {
    if (current.updatedAtMs === null) return 1
    if (candidate.updatedAtMs === null) return -1
    return candidate.updatedAtMs > current.updatedAtMs ? 1 : -1
  }
  if (current.updatedAtMs === null) {
    const version = compareVersion(candidate.version, current.version)
    if (version !== 0) return version
  }
  if (current.deleted !== candidate.deleted) return candidate.deleted ? 1 : -1
  return compareVersion(candidate.version, current.version)
}

/**
 * Whether `candidate` is strictly newer than `current`.
 *
 * Ordered by `updatedAtMs`, then deletion, then `version`; see {@link compare}.
 * A copy equal on all three does not supersede, which is what makes applying
 * the same record twice a no-op.
 *
 * @category ordering
 * @since 1.0.0
 */
export const supersedes = (current: Ordering, candidate: Ordering): boolean => compare(current, candidate) > 0

/**
 * What a tombstone keeps of the record it removes.
 *
 * @category models
 * @since 1.0.0
 */
export type Identity =
  & Pick<SourceRecord, "provider" | "connectionId" | "externalId" | "kind" | "access" | "thread">
  & Partial<Pick<SourceRecord, "createdAtMs" | "updatedAtMs" | "version">>

/**
 * A tombstone: the provider deleted the object.
 *
 * It keeps identity, placement, times and version, and nothing else: text,
 * payload, author and link are empty, so a deleted object's content cannot be
 * retrieved from the tombstone. Its change time is the later of the removed
 * version's and `deletedAtMs`, so it supersedes the copy it removes and loses
 * to any later edit, which is how an object the provider restores comes back.
 *
 * @category constructors
 * @since 1.0.0
 */
export const tombstone = (of: Identity, deletedAtMs: number, retrievedAtMs: number = deletedAtMs): SourceRecord => ({
  provider: of.provider,
  connectionId: of.connectionId,
  externalId: of.externalId,
  kind: of.kind,
  url: null,
  author: null,
  createdAtMs: of.createdAtMs ?? null,
  updatedAtMs: Math.max(of.updatedAtMs ?? deletedAtMs, deletedAtMs),
  version: of.version ?? null,
  retrievedAtMs,
  access: of.access,
  thread: of.thread,
  text: "",
  deleted: true,
  payload: null
})

/**
 * The containers a record lives in: its access container and its thread
 * container, without duplicates. A record in none is readable only through a
 * grant that covers the whole connection.
 *
 * @category getters
 * @since 1.0.0
 */
export const containers = (record: Pick<SourceRecord, "access" | "thread">): ReadonlyArray<string> => {
  const ids: Array<string> = []
  for (const id of [record.access.containerId, record.thread.containerId]) {
    if (id !== null && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * A pointer to one retrieved copy of a record, as a prompt or a run keeps it.
 *
 * A resumed run holds references, not text, and asks the store whether each
 * one is still readable and still the copy it used.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Reference = Schema.Struct({
  connectionId: Schema.NonEmptyString,
  externalId: Schema.NonEmptyString,
  updatedAtMs: Schema.NullOr(Schema.Number),
  version: Schema.NullOr(Schema.String),
  retrievedAtMs: Schema.Number
})

/**
 * A pointer to one retrieved copy of a record.
 *
 * @category models
 * @since 1.0.0
 */
export type Reference = typeof Reference.Type

/**
 * The reference to `record` as retrieved.
 *
 * @category constructors
 * @since 1.0.0
 */
export const reference = (record: SourceRecord): Reference => ({
  connectionId: record.connectionId,
  externalId: record.externalId,
  updatedAtMs: record.updatedAtMs,
  version: record.version,
  retrievedAtMs: record.retrievedAtMs
})
