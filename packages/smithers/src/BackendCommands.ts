/**
 * The argument and option schemas of the backend commands the CLI mounts.
 *
 * Generators read this table to document a command exactly as the CLI parses
 * it. It carries no handler, transport or credential.
 *
 * @since 1.0.0
 */

import { definitions as mounted } from "./internal/backend/Definitions.ts"

/**
 * Every backend command by its space-separated name, with its description,
 * argument schema and option schema.
 *
 * @category models
 * @since 1.0.0
 */
export const definitions: typeof mounted = mounted
