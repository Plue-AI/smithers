/**
 * Explicit access to the integrations host's process environment.
 *
 * @since 1.0.0
 */

/**
 * Reads the ambient process environment by deliberate host choice.
 *
 * Using this gives up a caller-scoped credential source. Integration clients
 * use it only for their documented host convenience; callers that require
 * account isolation pass an environment record explicitly.
 *
 * @category accessors
 * @since 1.0.0
 */
export const ambientEnvironment = (): Readonly<Record<string, string | undefined>> => process.env
