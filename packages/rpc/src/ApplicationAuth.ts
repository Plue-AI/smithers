/**
 * Shared owner-auth, selected-identity, and socket-ticket wire contracts.
 *
 * @since 1.0.0
 */

import { z } from "zod"

/** Local owner status route.
 * @since 1.0.0
 * @category constants
 */
export const LOCAL_AUTH_STATUS_PATH = "/api/auth/local/status"
/** Local owner bootstrap route.
 * @since 1.0.0
 * @category constants
 */
export const LOCAL_AUTH_BOOTSTRAP_PATH = "/api/auth/local/bootstrap"
/** Local owner browser-login route.
 * @since 1.0.0
 * @category constants
 */
export const LOCAL_AUTH_LOGIN_PATH = "/api/auth/local/login"
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
/** Trusted first-owner bootstrap request header.
 * @since 1.0.0
 * @category constants
 */
export const BOOTSTRAP_TOKEN_HEADER_NAME = "X-Smithers-Bootstrap-Token"

/** Local owner setup status response.
 * @since 1.0.0
 * @category models
 */
export const LocalIdentityStatusSchema = z.object({
  enabled: z.boolean(),
  initialized: z.boolean(),
  username: z.string().min(1).optional()
}).strict()
/** Local owner setup status.
 * @since 1.0.0
 * @category models
 */
export type LocalIdentityStatus = z.infer<typeof LocalIdentityStatusSchema>

/** Local username and password input.
 * @since 1.0.0
 * @category models
 */
export const LocalCredentialSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
}).strict()
/** Local username and password input.
 * @since 1.0.0
 * @category models
 */
export type LocalCredential = z.infer<typeof LocalCredentialSchema>

/** First-owner setup request.
 * @since 1.0.0
 * @category models
 */
export const LocalBootstrapRequestSchema = LocalCredentialSchema.extend({
  email: z.string().email().optional(),
  bootstrapToken: z.string().min(1)
}).strict()
/** First-owner setup request.
 * @since 1.0.0
 * @category models
 */
export type LocalBootstrapRequest = z.infer<typeof LocalBootstrapRequestSchema>

/** Local owner identity returned by credential routes.
 * @since 1.0.0
 * @category models
 */
export const LocalAuthUserSchema = z.object({
  id: z.number().int(),
  username: z.string().min(1)
}).strict()
/** Local browser-login response.
 * @since 1.0.0
 * @category models
 */
export const LocalLoginResponseSchema = z.object({ user: LocalAuthUserSchema }).strict()
/** Local browser-login response.
 * @since 1.0.0
 * @category models
 */
export type LocalLoginResponse = z.infer<typeof LocalLoginResponseSchema>

/** Local owner token request.
 * @since 1.0.0
 * @category models
 */
export const LocalTokenRequestSchema = LocalCredentialSchema.extend({
  name: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1)).optional()
}).strict()
/** Local owner token request.
 * @since 1.0.0
 * @category models
 */
export type LocalTokenRequest = z.infer<typeof LocalTokenRequestSchema>

/** Local owner token response.
 * @since 1.0.0
 * @category models
 */
export const LocalTokenResponseSchema = z.object({
  token: z.string().min(1),
  token_id: z.number().int(),
  expires_at: z.string().min(1),
  user: LocalAuthUserSchema
}).strict()
/** Local owner token response.
 * @since 1.0.0
 * @category models
 */
export type LocalTokenResponse = z.infer<typeof LocalTokenResponseSchema>

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
