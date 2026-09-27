/**
 * Schemas for Linear webhook deliveries.
 *
 * Core fields are typed and everything else passes through, so a workflow can
 * read a field this package does not model without waiting for a release.
 *
 * @since 1.0.0
 */

import { Schema } from "effect"

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const

const open = <Fields extends Schema.Struct.Fields>(fields: Fields) => Schema.StructWithRest(Schema.Struct(fields), rest)

/**
 * The `data` of an `Issue` delivery.
 *
 * @category schemas
 * @since 1.0.0
 */
export const IssueData = open({
  id: Schema.String,
  identifier: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  priority: Schema.optional(Schema.Number),
  url: Schema.optional(Schema.String),
  team: Schema.optional(
    open({ id: Schema.String, key: Schema.optional(Schema.String), name: Schema.optional(Schema.String) })
  ),
  state: Schema.optional(
    open({ id: Schema.String, name: Schema.optional(Schema.String), type: Schema.optional(Schema.String) })
  )
})

/**
 * The `data` of a `Comment` delivery.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CommentData = open({
  id: Schema.String,
  body: Schema.optional(Schema.String),
  issueId: Schema.optional(Schema.String),
  issue: Schema.optional(
    open({ id: Schema.String, identifier: Schema.optional(Schema.String), title: Schema.optional(Schema.String) })
  )
})

/**
 * Any delivery. `updatedFrom` carries the previous values of the fields an
 * `update` changed.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Delivery = open({
  action: Schema.String,
  type: Schema.String,
  data: open({ id: Schema.String }),
  updatedFrom: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  url: Schema.optional(Schema.String),
  webhookId: Schema.optional(Schema.String),
  webhookTimestamp: Schema.optional(Schema.Number),
  organizationId: Schema.optional(Schema.String)
})

/**
 * An `Issue` delivery.
 *
 * @category schemas
 * @since 1.0.0
 */
export const IssueDelivery = open({
  action: Schema.String,
  type: Schema.String,
  data: IssueData,
  updatedFrom: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  url: Schema.optional(Schema.String),
  webhookId: Schema.optional(Schema.String),
  webhookTimestamp: Schema.optional(Schema.Number),
  organizationId: Schema.optional(Schema.String)
})

/**
 * A `Comment` delivery.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CommentDelivery = open({
  action: Schema.String,
  type: Schema.String,
  data: CommentData,
  updatedFrom: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  url: Schema.optional(Schema.String),
  webhookId: Schema.optional(Schema.String),
  webhookTimestamp: Schema.optional(Schema.Number),
  organizationId: Schema.optional(Schema.String)
})
