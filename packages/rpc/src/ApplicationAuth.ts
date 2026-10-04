/**
 * Shared owner-auth, selected-identity, and socket-ticket wire contracts.
 *
 * @since 1.0.0
 */

import { z } from "zod"

/** One-use socket-ticket route.
 * @since 1.0.0
 * @category constants
 */
export const SOCKET_TICKET_PATH = "/api/auth/sse-ticket"
/** Selected backend identity route.
 * @since 1.0.0
 * @category constants
 */
export const AUTHENTICATED_USER_PATH = "/api/user"
/** GitHub sign-in route on the selected backend.
 * @since 1.0.0
 * @category constants
 */
export const APPLICATION_SIGN_IN_PATH = "/api/auth/github"
/** Double-submit CSRF cookie name.
 * @since 1.0.0
 * @category constants
 */
export const CSRF_COOKIE_NAME = "__csrf"
/** Double-submit CSRF request header.
 * @since 1.0.0
 * @category constants
 */
export const CSRF_HEADER_NAME = "X-CSRF-Token"
/** One-use socket-ticket response.
 * @since 1.0.0
 * @category models
 */
export const SocketTicketResponseSchema = z.object({
  ticket: z.string().min(1),
  expires_at: z.string().min(1)
}).strict()
/** One-use socket-ticket response.
 * @since 1.0.0
 * @category models
 */
export type SocketTicketResponse = z.infer<typeof SocketTicketResponseSchema>

/** `/api/user` is the selected backend's identity and token-scope authority.
 * @since 1.0.0
 * @category models
 */
export const ApplicationUserSchema = z.object({
  username: z.string().min(1),
  /** The profile name; GitHub sign-in stores GitHub's name, or the login when GitHub has none. */
  display_name: z.string().optional(),
  is_admin: z.boolean().optional(),
  token_scopes: z.array(z.string().min(1)).optional(),
  token_source: z.string().min(1).optional()
}).passthrough()
/** Selected backend identity and token authority.
 * @since 1.0.0
 * @category models
 */
export type ApplicationUser = z.infer<typeof ApplicationUserSchema>

/** The app's required token capabilities; write scopes also satisfy their read side.
 * @since 1.0.0
 * @category constants
 */
export const APPLICATION_TOKEN_SCOPES = [
  "write:user",
  "write:repository",
  "write:workspace",
  "write:approval",
  "write:agent"
] as const
