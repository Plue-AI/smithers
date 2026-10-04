import { decodeLiveDocBinary, LiveDocReply } from "../LiveDoc.ts"

export type LiveDocGoldenFrame = string | readonly number[]

// Scripted byte replay only: no CRDT, persistence, transport or production fallback.
// The consumer supplies checked-in literal fixtures, rather than an encoder.
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
