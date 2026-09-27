/**
 * Bounded diagnostics for failures that cross the control wire boundary.
 *
 * @since 0.1.0
 */

import { CanonicalError } from "@smthrs/canonical"

const maximumIssueLength = 512

/**
 * Joins a stable location and reason without allowing an RPC error to grow
 * without bound.
 *
 * @private
 * @since 0.1.0
 */
export const cappedIssue = (path: string, reason: string): string => {
  const issue = `${path}: ${reason}`
  return issue.length <= maximumIssueLength ? issue : `${issue.slice(0, maximumIssueLength - 3)}...`
}

/**
 * Renders canonical's stable located failure without copying its rejected
 * value or a nested cause message into an RPC error.
 *
 * @private
 * @since 0.1.0
 */
export const canonicalIssue = (cause: unknown): string =>
  cause instanceof CanonicalError
    ? cappedIssue(cause.path, cause.code)
    : cappedIssue("$", "canonicalization failed")

/**
 * Finds the first rejected field without rendering its value.
 * @private
 * @since 0.1.0
 */
export { firstPath as schemaIssuePath } from "@smthrs/canonical/IssuePath"
