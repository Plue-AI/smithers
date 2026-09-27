/**
 * Local-session authentication cookies, headers, and origins.
 *
 * @since 1.0.0
 */

/** Per-launch local-origin capability contract shared by Bun and the browser.
 * @since 1.0.0
 * @category constants
 */
export const LOCAL_SESSION_META = "smithers-local-session"
/**
 * Shared local session header used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const LOCAL_SESSION_HEADER = "x-smithers-local-session"
/**
 * The local session protocol prefix route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const LOCAL_SESSION_PROTOCOL_PREFIX = "smithers.local."

/** Tokens are 256 random bits encoded as unpadded base64url.
 * @since 1.0.0
 * @category conversions
 */
export const isLocalSessionToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)

/**
 * The WebSocket subprotocol that carries a local session token.
 *
 * @since 1.0.0
 * @category conversions
 */
export const localSessionProtocol = (token: string): string => `${LOCAL_SESSION_PROTOCOL_PREFIX}${token}`
