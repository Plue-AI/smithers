import type { Tone } from "@smthrs/rpc/CardPrimitives"

/** The status channel is independent of member identity colors. */
export const toneTokens = {
  live: "--brand", attention: "--attention", failed: "--danger", done: "--text-muted", quiet: "--text-muted"
} as const satisfies Record<Tone, string>
