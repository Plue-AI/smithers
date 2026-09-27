/**
 * Repository coordinates, validated before they become a request path.
 *
 * This module exists because encoding is not enough. `encodeURIComponent("..")`
 * is `".."`, since dots are unreserved, and a hand-written `%2E%2E` is decoded
 * before the WHATWG URL parser removes dot segments, so
 * `new URL("https://api.github.com/repos/%2E%2E/%2E%2E/user/hooks").pathname`
 * is `/user/hooks`. An owner or repository interpolated straight into a path
 * therefore walks a token-bearing request to another GitHub endpoint, and the
 * client's origin pin does not help: the traversal stays on the configured
 * origin, so the bearer token goes with it.
 *
 * Every path this package builds from an owner and a repository goes through
 * {@link repositoryPath}, which validates each segment against GitHub's own
 * naming rules and only then encodes it.
 *
 * @since 1.0.0
 */

import { Effect, Schema } from "effect"
import { IntegrationError } from "../core/IntegrationError.ts"

/**
 * GitHub's rule for an account name: 1 to 39 characters, alphanumerics and
 * hyphens, not starting with a hyphen.
 *
 * One underscore is allowed as a separator, because a GitHub Enterprise
 * Managed User's login is `<name>_<enterprise shortcode>` and such an account
 * owns repositories in its own namespace. Refusing it locked every
 * enterprise-managed account out of this package and bought nothing: only `.`
 * and `/` can walk a request off its endpoint, and neither is in this class.
 *
 * @category constants
 * @since 1.0.0
 */
export const OWNER_PATTERN = /^(?=.{1,39}$)[A-Za-z0-9][A-Za-z0-9-]*(?:_[A-Za-z0-9][A-Za-z0-9-]*)?$/

/**
 * GitHub's rule for a repository name: 1 to 100 characters of alphanumerics,
 * dots, underscores, and hyphens. The leading guard excludes `.` and `..`,
 * which match the character class and are exactly the path traversal this
 * module exists to stop.
 *
 * @category constants
 * @since 1.0.0
 */
export const REPO_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/

/**
 * Whether `value` is a usable account name.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isOwner = (value: unknown): value is string => typeof value === "string" && OWNER_PATTERN.test(value)

/**
 * Whether `value` is a usable repository name.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isRepo = (value: unknown): value is string => typeof value === "string" && REPO_PATTERN.test(value)

/**
 * An account name, as a schema an action payload can demand.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Owner = Schema.String.check(
  Schema.isPattern(OWNER_PATTERN, { expected: "a GitHub account name" })
)

/**
 * A repository name, as a schema an action payload can demand.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Repo = Schema.String.check(
  Schema.isPattern(REPO_PATTERN, { expected: "a GitHub repository name" })
)

/**
 * An issue or pull-request number, as a schema an action payload can demand.
 *
 * @category schemas
 * @since 1.0.0
 */
export const IssueNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const refuse = (field: string, value: unknown): never => {
  throw new IntegrationError(
    "invalid-config",
    `GitHub ${field} is not a valid name, so it cannot be part of a request path.`,
    { field, retryable: false, [field]: typeof value === "string" ? value.slice(0, 64) : typeof value }
  )
}

/**
 * The `owner/repo` path segment pair, validated and then encoded.
 *
 * Throws an `IntegrationError` with reason `invalid-config` when either half
 * is not a name GitHub could have issued. Nothing in this package builds a
 * repository path any other way.
 *
 * @category constructors
 * @since 1.0.0
 */
export const repositoryPath = (owner: string, repo: string): string => {
  if (!isOwner(owner)) refuse("owner", owner)
  if (!isRepo(repo)) refuse("repo", repo)
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}

/**
 * The same, for the `owner/repository` spelling a listener declaration uses.
 *
 * @category constructors
 * @since 1.0.0
 */
export const fullNamePath = (fullName: string): string => {
  const parts = typeof fullName === "string" ? fullName.split("/") : []
  if (parts.length !== 2) refuse("repository", fullName)
  return repositoryPath(parts[0] as string, parts[1] as string)
}

/**
 * {@link fullNamePath} in the Effect channel, for a caller inside `Effect.gen`
 * that needs a typed failure rather than a defect.
 *
 * @category constructors
 * @since 1.0.0
 */
export const requireFullNamePath = (fullName: string): Effect.Effect<string, IntegrationError> =>
  Effect.try({ try: () => fullNamePath(fullName), catch: (cause) => cause as IntegrationError })

/**
 * {@link repositoryPath} in the Effect channel.
 *
 * @category constructors
 * @since 1.0.0
 */
export const requireRepositoryPath = (owner: string, repo: string): Effect.Effect<string, IntegrationError> =>
  Effect.try({ try: () => repositoryPath(owner, repo), catch: (cause) => cause as IntegrationError })
