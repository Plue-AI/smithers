/**
 * Telegram Mini App `initData` verification.
 *
 * `initData` is the signed query string a Mini App exposes as
 * `window.Telegram.WebApp.initData`. A backend must verify it before trusting
 * the user; `initDataUnsafe` is named that for a reason.
 *
 * Two paths, both on Web Crypto and no `node:` builtin, which is what would
 * let the same code run under Bun and a Cloudflare Worker. Only Node is
 * verified: this package is not in the browser-contract list in
 * `scripts/browser-check.mjs`, and the Ed25519
 * `importKey` is the call most likely to differ between engines, which is why
 * this module has an `UNSUPPORTED` branch at all.
 *
 * - **HMAC**, when you hold the bot token. The secret is
 *   `HMAC_SHA256(key="WebAppData", msg=botToken)`, and the data-check string is
 *   every field except `hash`, with the `signature` field staying in, as
 *   `key=value`, sorted, newline-joined.
 * - **Ed25519**, for a third party holding only the numeric bot id. The
 *   message is `<botId>:WebAppData\n` plus the data-check string with both
 *   `hash` and `signature` removed, verified against Telegram's public key.
 *
 * Verified against core.telegram.org/bots/webapps,
 * `@telegram-apps/init-data-node`, and aiogram.
 *
 * @since 1.0.0
 */

import { SmithersError } from "@smthrs/errors/SmithersError"

/**
 * Telegram's production Ed25519 public key, in hex.
 *
 * @category constants
 * @since 1.0.0
 */
export const ED25519_PUBLIC_KEY_PROD = "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d"

/**
 * Telegram's test-datacenter Ed25519 public key, in hex.
 *
 * @category constants
 * @since 1.0.0
 */
export const ED25519_PUBLIC_KEY_TEST = "40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec"

const DEFAULT_MAX_AGE_SECONDS = 3600
/** A day. Any freshness window longer than this is a configuration mistake. */
const MAX_MAX_AGE_SECONDS = 86_400
/**
 * How far into the future an `auth_date` may sit and still be accepted.
 *
 * Telegram signs `auth_date` itself, so this is defense in depth: without an
 * upper bound a correctly signed payload dated a year ahead stays fresh for
 * that whole year.
 */
const MAX_FUTURE_SKEW_SECONDS = 300
const ED25519_KEY_PATTERN = /^[0-9a-fA-F]{64}$/
const encoder = new TextEncoder()

/**
 * A Telegram user, as it appears inside `initData`.
 *
 * @category models
 * @since 1.0.0
 */
export interface InitDataUser {
  readonly id: number
  readonly is_bot?: boolean | undefined
  readonly first_name?: string | undefined
  readonly last_name?: string | undefined
  readonly username?: string | undefined
  readonly language_code?: string | undefined
  readonly is_premium?: boolean | undefined
  readonly photo_url?: string | undefined
  readonly [key: string]: unknown
}

/**
 * The parsed contents of an `initData` query string.
 *
 * @category models
 * @since 1.0.0
 */
export interface InitData {
  /** The exact string that was verified. */
  readonly raw: string
  readonly hash: string | null
  readonly signature: string | null
  /** `auth_date` in seconds, or `null` when absent or non-numeric. */
  readonly authDate: number | null
  /** Present only for an inline-keyboard or menu-button launch. */
  readonly queryId: string | null
  readonly user: InitDataUser | null
  readonly receiver: InitDataUser | null
  readonly chat: Record<string, unknown> | null
  readonly chatType: string | null
  readonly chatInstance: string | null
  /** From a `?startapp=` deep link. */
  readonly startParam: string | null
  /** Every decoded pair, for fields not surfaced above. */
  readonly params: Readonly<Record<string, string>>
}

/**
 * What the verifiers allow.
 *
 * @category models
 * @since 1.0.0
 */
export interface VerifyOptions {
  /**
   * Reject `initData` older than this, in seconds. Must be an integer from 0
   * to 86400; `0` disables the age check, and anything outside the range is a
   * configuration error rather than a silently disabled check.
   */
  readonly maxAgeSeconds?: number | undefined
  /** Overrides "now", in epoch milliseconds. */
  readonly nowMs?: number | undefined
}

/**
 * What {@link verifySignature} allows.
 *
 * @category models
 * @since 1.0.0
 */
export interface VerifySignatureOptions extends VerifyOptions {
  /**
   * The Ed25519 public key, as exactly 64 hexadecimal characters. Defaults to
   * the production key. A malformed value fails `INVALID_INPUT` naming the
   * field, not `UNSUPPORTED`.
   */
  readonly publicKeyHex?: string | undefined
}

/** Hex for a Web Crypto digest, which is always an `ArrayBuffer`. */
const bytesToHex = (buffer: ArrayBuffer): string => {
  let out = ""
  for (const byte of new Uint8Array(buffer)) out += byte.toString(16).padStart(2, "0")
  return out
}

/** Decodes hex its caller has already validated against a pattern. */
const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

const base64UrlToBytes = (value: string): Uint8Array => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = base64.length % 4 === 0 ? base64 : base64 + "=".repeat(4 - (base64.length % 4))
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * Constant-time equality of two hex strings.
 *
 * The received hash is attacker-controlled, so a `===` here would be the
 * classic HMAC-verification timing side channel. The reference JavaScript
 * libraries use `===`; this does not.
 */
const timingSafeEqualHex = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

const parseJsonField = (params: URLSearchParams, key: string): Record<string, unknown> | null => {
  const raw = params.get(key)
  if (raw === null || raw.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * Parses `initData` into its fields.
 *
 * Uses `URLSearchParams`, which splits before decoding each value once.
 * Decoding the whole string first would corrupt any value containing a
 * percent-encoded delimiter, which the JSON `user` and `chat` blobs routinely
 * do.
 *
 * @category constructors
 * @since 1.0.0
 */
export const parse = (initData: string): InitData => {
  const raw = typeof initData === "string" ? initData : ""
  const params = new URLSearchParams(raw)
  const all: Record<string, string> = {}
  for (const [key, value] of params.entries()) all[key] = value
  const authDateRaw = params.get("auth_date")
  const authDate = authDateRaw !== null && /^\d+$/.test(authDateRaw) ? Number.parseInt(authDateRaw, 10) : null
  return {
    raw,
    hash: params.get("hash"),
    signature: params.get("signature"),
    authDate,
    queryId: params.get("query_id"),
    user: parseJsonField(params, "user") as InitDataUser | null,
    receiver: parseJsonField(params, "receiver") as InitDataUser | null,
    chat: parseJsonField(params, "chat"),
    chatType: params.get("chat_type"),
    chatInstance: params.get("chat_instance"),
    startParam: params.get("start_param"),
    params: all
  }
}

/** Every pair except the excluded keys, `key=value`, sorted, newline-joined. */
const dataCheckString = (params: URLSearchParams, exclude: ReadonlySet<string>): string => {
  const pairs: Array<string> = []
  for (const [key, value] of params.entries()) {
    if (!exclude.has(key)) pairs.push(`${key}=${value}`)
  }
  pairs.sort()
  return pairs.join("\n")
}

/** The validated freshness policy, or an `INVALID_INPUT` failure. */
const requirePolicy = (options: VerifyOptions): { readonly maxAgeSeconds: number; readonly nowMs: number } => {
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0 || maxAgeSeconds > MAX_MAX_AGE_SECONDS) {
    throw new SmithersError(
      "INVALID_INPUT",
      `maxAgeSeconds must be an integer between 0 and ${MAX_MAX_AGE_SECONDS}.`,
      { maxAgeSeconds }
    )
  }
  const nowMs = options.nowMs ?? Date.now()
  if (!Number.isFinite(nowMs)) throw new SmithersError("INVALID_INPUT", "nowMs must be a finite number.", { nowMs })
  return { maxAgeSeconds, nowMs }
}

/**
 * Whether `authDate` sits inside the accepted window.
 *
 * Both ends are bounded. Only bounding the old end let a correctly signed
 * far-future `auth_date` stay fresh for as long as it was dated ahead.
 */
const isFresh = (authDate: number | null, maxAgeSeconds: number, nowMs: number): boolean => {
  if (maxAgeSeconds <= 0) return true
  if (authDate === null) return false
  const authMs = authDate * 1000
  if (authMs > nowMs + MAX_FUTURE_SKEW_SECONDS * 1000) return false
  return authMs + maxAgeSeconds * 1000 >= nowMs
}

const invalid = (message: string, details?: Record<string, unknown>): SmithersError =>
  new SmithersError("TELEGRAM_INIT_DATA_INVALID", message, details)

const subtleCrypto = (): SubtleCrypto => {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) {
    throw new SmithersError("UNSUPPORTED", "Web Crypto (crypto.subtle) is not available in this runtime.")
  }
  return subtle
}

/**
 * Verifies `initData` with the bot token.
 *
 * Resolves with the parsed fields, or rejects with `TELEGRAM_INIT_DATA_INVALID`.
 * The bot token never appears in the error output.
 *
 * @category verification
 * @since 1.0.0
 */
export const verifyWithBotToken = async (
  initData: string,
  botToken: string,
  options: VerifyOptions = {}
): Promise<InitData> => {
  if (typeof botToken !== "string" || botToken.length === 0) {
    throw new SmithersError("INVALID_INPUT", "verifyWithBotToken requires a bot token.")
  }
  if (typeof initData !== "string" || initData.length === 0) throw invalid("initData is empty.")
  const params = new URLSearchParams(initData)
  const hash = params.get("hash")
  if (hash === null || hash.length === 0) throw invalid("initData is missing the hash field.")
  const parsed = parse(initData)
  const policy = requirePolicy(options)
  if (!isFresh(parsed.authDate, policy.maxAgeSeconds, policy.nowMs)) {
    throw invalid("initData is expired, dated in the future, or missing auth_date.", { authDate: parsed.authDate })
  }
  const subtle = subtleCrypto()
  const webAppDataKey = await subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const secret = await subtle.sign("HMAC", webAppDataKey, encoder.encode(botToken))
  const secretKey = await subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = await subtle.sign("HMAC", secretKey, encoder.encode(dataCheckString(params, new Set(["hash"]))))
  if (!timingSafeEqualHex(bytesToHex(mac), hash)) throw invalid("initData HMAC signature does not match.")
  return parsed
}

/**
 * Verifies `initData` with Telegram's Ed25519 key and the numeric bot id.
 *
 * For a third party that must authenticate a Mini App user without holding the
 * bot token.
 *
 * @category verification
 * @since 1.0.0
 */
export const verifySignature = async (
  initData: string,
  botId: number | string,
  options: VerifySignatureOptions = {}
): Promise<InitData> => {
  if (botId == null || String(botId).length === 0) {
    throw new SmithersError("INVALID_INPUT", "verifySignature requires a numeric bot id.")
  }
  if (typeof initData !== "string" || initData.length === 0) throw invalid("initData is empty.")
  const params = new URLSearchParams(initData)
  const signature = params.get("signature")
  if (signature === null || signature.length === 0) throw invalid("initData is missing the signature field.")
  const parsed = parse(initData)
  const policy = requirePolicy(options)
  if (!isFresh(parsed.authDate, policy.maxAgeSeconds, policy.nowMs)) {
    throw invalid("initData is expired, dated in the future, or missing auth_date.", { authDate: parsed.authDate })
  }
  // Validated before the try below, so a mistyped key is reported as the
  // caller error it is instead of as "this runtime has no Ed25519", which
  // sends an operator looking at Node versions.
  const publicKeyHex = options.publicKeyHex ?? ED25519_PUBLIC_KEY_PROD
  if (!ED25519_KEY_PATTERN.test(publicKeyHex)) {
    throw new SmithersError(
      "INVALID_INPUT",
      "publicKeyHex must be 64 hexadecimal characters (a 32-byte Ed25519 public key).",
      { length: publicKeyHex.length }
    )
  }
  const publicKey = hexToBytes(publicKeyHex)
  const subtle = subtleCrypto()
  const message = `${botId}:WebAppData\n${dataCheckString(params, new Set(["hash", "signature"]))}`
  // The signature is attacker-controlled: a malformed base64url value must
  // reject as invalid init data, not escape as a raw DOMException.
  let signatureBytes: Uint8Array
  try {
    signatureBytes = base64UrlToBytes(signature)
  } catch {
    throw invalid("initData signature is not valid base64url.")
  }
  let key: CryptoKey
  try {
    key = await subtle.importKey("raw", publicKey as BufferSource, { name: "Ed25519" }, false, ["verify"])
  } catch (cause) {
    throw new SmithersError("UNSUPPORTED", "Ed25519 verification is not supported in this runtime.", undefined, {
      cause
    })
  }
  const ok = await subtle.verify("Ed25519", key, signatureBytes as BufferSource, encoder.encode(message))
  if (!ok) throw invalid("initData Ed25519 signature does not match.")
  return parsed
}
