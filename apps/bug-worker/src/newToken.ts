/** Single-use confirmation and cancellation tokens; 128 bits, hex encoded. */
export function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
