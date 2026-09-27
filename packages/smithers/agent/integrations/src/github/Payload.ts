/**
 * Schemas for the GitHub webhook payloads this package types.
 *
 * GitHub payloads are large and evolve without notice, so every schema here
 * validates the fields a caller is likely to read and passes everything else
 * through untouched. A real delivery is never rejected for carrying a field
 * this package has not heard of.
 *
 * @since 1.0.0
 */

import { Schema } from "effect"

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const

const open = <Fields extends Schema.Struct.Fields>(fields: Fields) => Schema.StructWithRest(Schema.Struct(fields), rest)

/**
 * A GitHub account.
 *
 * `type` distinguishes a person from a GitHub App, so the field is modelled
 * rather than left to the open rest.
 *
 * @category schemas
 * @since 1.0.0
 */
export const User = open({
  login: Schema.String,
  id: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String)
})

/**
 * How the author of a comment, issue, or pull request relates to the
 * repository, as GitHub sends it on every author-attributed delivery. It names
 * the author's standing, not who last edited the text, so it is not an
 * authorization signal.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AuthorAssociation = Schema.String

/**
 * A repository, as embedded in a webhook payload.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Repository = open({
  full_name: Schema.String,
  name: Schema.optional(Schema.String),
  owner: Schema.optional(User),
  default_branch: Schema.optional(Schema.String)
})

/**
 * A pull request.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PullRequest = open({
  number: Schema.Number,
  author_association: Schema.optional(AuthorAssociation),
  title: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.String),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.Boolean),
  merged: Schema.optional(Schema.Boolean),
  user: Schema.optional(User),
  head: Schema.optional(open({ ref: Schema.String, sha: Schema.String })),
  base: Schema.optional(open({ ref: Schema.String, sha: Schema.optional(Schema.String) }))
})

/**
 * An issue.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Issue = open({
  number: Schema.Number,
  author_association: Schema.optional(AuthorAssociation),
  title: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.String),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(User),
  labels: Schema.optional(Schema.Array(Schema.Unknown))
})

/**
 * An issue or pull-request comment.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Comment = open({
  id: Schema.optional(Schema.Number),
  author_association: Schema.optional(AuthorAssociation),
  body: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.String),
  user: Schema.optional(User)
})

/**
 * A `pull_request` delivery.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PullRequestEvent = open({
  action: Schema.String,
  number: Schema.optional(Schema.Number),
  pull_request: PullRequest,
  repository: Repository,
  sender: Schema.optional(User)
})

/**
 * An `issues` delivery.
 *
 * @category schemas
 * @since 1.0.0
 */
export const IssuesEvent = open({
  action: Schema.String,
  issue: Issue,
  repository: Repository,
  sender: Schema.optional(User)
})

/**
 * An `issue_comment` delivery.
 *
 * @category schemas
 * @since 1.0.0
 */
export const IssueCommentEvent = open({
  action: Schema.String,
  issue: Issue,
  comment: Comment,
  repository: Repository,
  sender: Schema.optional(User)
})

/**
 * A `push` delivery.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PushEvent = open({
  ref: Schema.String,
  before: Schema.optional(Schema.String),
  after: Schema.optional(Schema.String),
  repository: Repository,
  commits: Schema.optional(
    Schema.Array(open({ id: Schema.optional(Schema.String), message: Schema.optional(Schema.String) }))
  ),
  pusher: Schema.optional(open({ name: Schema.optional(Schema.String) }))
})
