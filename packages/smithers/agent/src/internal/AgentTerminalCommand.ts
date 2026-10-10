/**
 * Serialized command capture for a registered agent PTY provider.
 *
 * @since 1.0.0
 */

import * as Bash from "@smthrs/std/Bash"
import { StdError } from "@smthrs/std/StdError"

/**
 * Completion must arrive from a supervisor control channel, never by parsing
 * PTY output. The current daemon exposes session exit, not per-command exit;
 * it cannot yet implement this port for a reusable shell. No production host
 * binds this port until that distinction and the install checks are proven.
 * Completion follows drained output; no bytes from an ended command may
 * enter the next command. The provider owns session transport and replay.
 * Output is already attributed to this command by the trusted provider. Echo
 * must likewise be identified there, not removed by matching command text.
 *
 * @private
 * @since 1.0.0
 */
export type CommandFrame =
  | { readonly kind: "output"; readonly bytes: Uint8Array }
  | { readonly kind: "echo"; readonly bytes: Uint8Array }
  | { readonly kind: "exit"; readonly code: number }
  // POSIX signal number, translated from any daemon wire enum by the provider.
  | { readonly kind: "signal"; readonly signal: number }

/**
 * Trusted command lifecycle, supplied only by the registered daemon.
 *
 * @private
 * @since 1.0.0
 */
export interface CommandPort {
  readonly execute: (input: Bash.Input, signal: AbortSignal) => AsyncIterable<CommandFrame>
  /** Resolves only after kill_sessions(run) confirms no children remain. */
  readonly killRun: () => Promise<void>
}

/** Streaming VT removal with bounded state, including split CSI/OSC/DCS. */
class Capture {
  private readonly decoder = new TextDecoder()
  private utf8Remaining = 0
  private utf8Min = 0x80
  private utf8Max = 0xbf

  // PTYs can emit both UTF-8 and raw ECMA-48 C1 bytes. Normalize only
  // standalone C1 controls; a continuation byte inside valid UTF-8 is data.
  private ansiBytes(bytes: Uint8Array): Uint8Array {
    const normalized: number[] = []
    for (const byte of bytes) {
      const continuation = this.utf8Remaining > 0 && byte >= this.utf8Min && byte <= this.utf8Max
      if (continuation) {
        this.utf8Remaining--
        this.utf8Min = 0x80
        this.utf8Max = 0xbf
      } else {
        this.utf8Remaining = byte >= 0xc2 && byte <= 0xdf ?
          1
          : byte >= 0xe0 && byte <= 0xef ?
          2
          : byte >= 0xf0 && byte <= 0xf4
          ? 3
          : 0
        this.utf8Min = byte === 0xe0 ? 0xa0 : byte === 0xf0 ? 0x90 : 0x80
        this.utf8Max = byte === 0xed ? 0x9f : byte === 0xf4 ? 0x8f : 0xbf
      }
      if (!continuation && byte >= 0x80 && byte <= 0x9f) normalized.push(0xc2)
      normalized.push(byte)
    }
    return Uint8Array.from(normalized)
  }
  private state: "text" | "escape" | "csi" | "string" | "stringEscape" = "text"
  private cr = false
  private tail = ""
  private dropped = 0
  private readonly encoder = new TextEncoder()

  write(bytes: Uint8Array, final = false): void {
    let plain = ""
    for (const char of this.decoder.decode(this.ansiBytes(bytes), { stream: !final })) {
      if (this.state === "stringEscape") {
        this.state = char === "\\" ? "text" : char === "\x1b" ? "stringEscape" : "string"
      } else if (this.state === "string") {
        if (char === "\x07" || char === "\x9c") this.state = "text"
        else if (char === "\x1b") this.state = "stringEscape"
      } else if (this.state === "csi") {
        if (char >= "@" && char <= "~") this.state = "text"
        else if (char === "\x1b") this.state = "escape"
      } else if (this.state === "escape") {
        if (char === "[") this.state = "csi"
        else if (char === "]" || char === "P" || char === "^" || char === "_") this.state = "string"
        else if (!(char >= " " && char <= "/")) this.state = "text"
      } else if (char === "\x1b") this.state = "escape"
      else if (char === "\x9b") this.state = "csi"
      else if (char === "\x9d" || char === "\x90" || char === "\x9e" || char === "\x9f") this.state = "string"
      else {
        // PTYs use CRLF. A lone CR is also a line boundary in tool output.
        if (char === "\r") {
          plain += "\n"
          this.cr = true
        } else {
          if (
            !(char === "\n" && this.cr) &&
            (char === "\n" || char === "\t" || char >= " " && !(char >= "\x7f" && char <= "\x9f"))
          ) plain += char
          this.cr = false
        }
      }
    }
    const bytesOut = this.encoder.encode(this.tail + plain)
    if (bytesOut.length <= 30_000) this.tail += plain
    else {
      let start = bytesOut.length - 30_000
      while ((bytesOut[start]! & 0xc0) === 0x80) start++
      this.dropped += start
      this.tail = new TextDecoder().decode(bytesOut.subarray(start))
    }
  }

  result(exitCode: number): Bash.Output {
    this.write(new Uint8Array(), true)
    return {
      exitCode,
      stdout: this.tail,
      stderr: "",
      stdoutTruncated: this.dropped > 0,
      stderrTruncated: false,
      stdoutDroppedBytes: this.dropped,
      stderrDroppedBytes: 0
    }
  }
}

/**
 * One registered run/session port; commands serialize, including failures.
 *
 * @private
 * @since 1.0.0
 */
export class Commands {
  private queue: Promise<void> = Promise.resolve()
  private ended = false
  private killed: Promise<void> | undefined
  private active: AbortController | undefined
  private disposeAfterKill: (() => void) | undefined

  private readonly port: CommandPort

  constructor(port: CommandPort) {
    this.port = port
  }

  private kill(): Promise<void> {
    this.ended = true
    return this.killed ??= Promise.resolve().then(() => this.port.killRun()).then(() => {
      this.dispose()
    }).catch(() => {
      // Only a confirmed kill is reusable. Keep execution fenced, but permit
      // a later end() to obtain the missing cleanup receipt.
      this.killed = undefined
      throw new StdError({ code: "command_failed", message: "Agent terminal cleanup unconfirmed" })
    })
  }

  private dispose(): void {
    const dispose = this.disposeAfterKill
    this.disposeAfterKill = undefined
    dispose?.()
  }

  async end(): Promise<void> {
    this.ended = true
    this.active?.abort()
    await this.kill()
    await this.queue
  }

  run(input: Bash.Input, signal: AbortSignal): Promise<Bash.Output> {
    const result = this.queue.then(() => this.command(input, signal))
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async command(input: Bash.Input, signal: AbortSignal): Promise<Bash.Output> {
    if (this.ended) throw new StdError({ code: "provider_unavailable", message: "Agent terminal run ended" })
    if (signal.aborted) throw new StdError({ code: "command_failed", message: "Agent terminal command cancelled" })
    const controller = new AbortController()
    const limitMillis = input.timeoutMs ?? Bash.DEFAULT_TIMEOUT_MS
    this.active = controller
    let timeout = false
    const abort = () => controller.abort()
    signal.addEventListener("abort", abort, { once: true })
    let rejectAbort!: (error: StdError) => void
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject
    })
    const cancel = () =>
      rejectAbort(
        new StdError({
          code: timeout ? "timeout" : "command_failed",
          ...(timeout ? { limitMillis } : {}),
          message: timeout ? "Agent terminal command timed out" : "Agent terminal command cancelled"
        })
      )
    controller.signal.addEventListener("abort", cancel, { once: true })
    const timer = setTimeout(() => {
      timeout = true
      controller.abort()
    }, limitMillis)
    let frames: AsyncIterator<CommandFrame> | undefined
    let releaseRequested = false
    try {
      const capture = new Capture()
      frames = this.port.execute(input, controller.signal)[Symbol.asyncIterator]()
      while (true) {
        const next = await Promise.race([frames.next(), aborted])
        if (next.done) {
          throw new StdError({ code: "command_failed", message: "Agent terminal closed without command status" })
        }
        const frame = next.value
        if (frame.kind === "output" || frame.kind === "echo") {
          if (frame.bytes.byteLength > 65_536) {
            throw new StdError({ code: "command_failed", message: "Oversized terminal frame" })
          }
          if (frame.kind === "output") capture.write(frame.bytes)
        } else if (frame.kind === "exit") {
          if (!Number.isInteger(frame.code) || frame.code < 0 || frame.code > 255) {
            throw new StdError({ code: "command_failed", message: "Invalid command status" })
          }
          // A generator can hold its subscription or command lock until its
          // finally block runs. Release it before admitting the next command.
          releaseRequested = true
          const released = await Promise.race([frames.return?.(), aborted])
          if (released !== undefined && released.done !== true) {
            throw new StdError({ code: "command_failed", message: "Agent terminal subscription still open" })
          }
          return capture.result(frame.code)
        } else if (frame.kind === "signal") {
          if (!Number.isInteger(frame.signal) || frame.signal < 1 || frame.signal > 64) {
            throw new StdError({ code: "command_failed", message: "Invalid command signal" })
          }
          releaseRequested = true
          const released = await Promise.race([frames.return?.(), aborted])
          if (released !== undefined && released.done !== true) {
            throw new StdError({ code: "command_failed", message: "Agent terminal subscription still open" })
          }
          return capture.result(128 + frame.signal)
        } else throw new StdError({ code: "command_failed", message: "Invalid terminal frame" })
      }
    } catch (error) {
      controller.signal.removeEventListener("abort", cancel)
      controller.abort()
      // A cancellation, timeout or broken framing ends this run. Never queue
      // another command into a shell whose previous children may still exist.
      if (!releaseRequested && frames?.return !== undefined) {
        const subscription = frames
        this.disposeAfterKill = () => {
          // A pending next() may delay return forever. Confirmed process cleanup
          // is the barrier; disposal must not prevent its acknowledgment.
          try {
            void Promise.resolve(subscription.return?.()).catch(() => undefined)
          } catch {
            // Disposal cannot undo confirmed cleanup.
          }
        }
      }
      await this.kill()
      // end() may have confirmed cleanup before this catch retained the iterator.
      this.dispose()
      throw error instanceof StdError
        ? error
        : new StdError({ code: "command_failed", message: "Agent terminal transport failed" })
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      controller.signal.removeEventListener("abort", cancel)
      this.active = undefined
    }
  }
}
