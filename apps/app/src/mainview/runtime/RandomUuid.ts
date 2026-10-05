/**
 * The app's one source of random ids: an RFC 4122 version 4 UUID over `crypto.getRandomValues`.
 *
 * `crypto.randomUUID` exists only in a secure context (https or localhost); a teammate opening the install at a
 * plain-HTTP LAN origin has `getRandomValues` and no `randomUUID` (spec §16.3.2, T-INS-04). The conformance suite
 * (lint/conformance/SecureContext.test.ts) bans the direct call everywhere else.
 */
export const randomUuid = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-")
}
