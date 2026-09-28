/**
 * Exact optional-schema failure classification across SQL driver wrappers.
 * @since 1.0.0
 */

/**
 * Driver messages stay separate so wrapper context cannot identify a different failure.
 * The depth bound terminates cyclic driver causes.
 * @since 1.0.0
 * @private
 */
export const causeMessages = (value: unknown, depth = 4): ReadonlyArray<string> => {
  if (typeof value === "string") return [value]
  if (depth === 0 || typeof value !== "object" || value === null) return []
  const fields = value as { readonly message?: unknown; readonly cause?: unknown; readonly reason?: unknown }
  return [
    ...(typeof fields.message === "string" ? [fields.message] : []),
    ...causeMessages(fields.reason, depth - 1),
    ...causeMessages(fields.cause, depth - 1)
  ]
}

/**
 * Only the relation named by a driver's missing-table diagnostic may be absent.
 * @since 1.0.0
 * @private
 */
export const missingTable = (table: string) => (cause: unknown): boolean =>
  causeMessages(cause).some((message) => {
    const relation = /^no such table: (\S+)$/.exec(message)?.[1]
      ?? /^relation "([^"]+)" does not exist$/.exec(message)?.[1]
    // These queries name unqualified relations. A qualified name can refer
    // to a different schema's dependency, so do not discard its qualifier.
    if (relation !== undefined) return relation === table
    // MySQL always names the database in its table diagnostic.
    return /^Table '[^.']+\.([^']+)' doesn't exist$/.exec(message)?.[1] === table
  })
