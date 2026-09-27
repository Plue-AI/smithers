/**
 * Derives a vendor machine name from a session key.
 *
 * @since 0.1.0
 */

import { sessionSlug } from "./sessionSlug.ts"

/**
 * The lowercase, dot- and underscore-free name `prefix` plus the session slug.
 *
 * @category utils
 * @since 0.1.0
 */
export const machineName = (prefix: string, session: string): string =>
  `${prefix}${sessionSlug(session)}`.toLowerCase().replaceAll(/[._]/g, "-")
