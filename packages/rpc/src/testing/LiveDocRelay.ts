import { decodeLiveDocBinary, LiveDocReply } from "../LiveDoc.ts"

/**
 * A literal text or byte frame used for document channel replay.
 * @since 1.0.0
 * @category testing
 */
export type LiveDocGoldenFrame = string | readonly number[]

// Scripted byte replay only: no CRDT, persistence, transport or production fallback.
// The consumer supplies checked-in literal fixtures, rather than an encoder.
/**
 * Replays checked-in document frames and restarts them on reconnect.
 * @since 1.0.0
 * @category testing
 */
export class LiveDocRelay {
  private offset = 0
  private readonly frames: readonly LiveDocGoldenFrame[]
  constructor(frames: readonly LiveDocGoldenFrame[]) { this.frames = frames }

  next(): string | Uint8Array | undefined {
    const frame = this.frames[this.offset]
    if (frame === undefined) return undefined
    if (typeof frame === "string") LiveDocReply.parse(JSON.parse(frame))
    else decodeLiveDocBinary(Uint8Array.from(frame))
    this.offset++
    return typeof frame === "string" ? frame : Uint8Array.from(frame)
  }

  reconnect(): void { this.offset = 0 }
}
