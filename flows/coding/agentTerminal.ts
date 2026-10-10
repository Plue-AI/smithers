/**
 * The coding agent's own terminal on its machine (T-TRM-05, spec §8.11.2a).
 *
 * Each `bash` call runs `smithers-machined client pty`, which opens one PTY
 * session on the agent-only local socket under this run's registered cgroup.
 * The broker starts the command once the host's Terminal card is watching, so
 * members see the echo line and every output byte live; the command's output
 * reaches this process on the client's stdout, and its exit status comes from
 * the broker's waitpid on the client's last stderr line. ADR 0004's installed
 * client owns the codec: no frame is parsed here.
 */
import type * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as Bash from "@smthrs/std/Bash"
import { StdError } from "@smthrs/std/StdError"
import { Effect, Fiber, Stream } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process"
import { existsSync } from "node:fs"

/** The installed client and the agent-only socket it dials (spec §9.5.3). */
export const CLIENT = "/opt/smithers/bin/smithers-machined"
export const SOCKET = "/run/smithers/machined.sock"

/** The client's final stderr line. */
export type Status =
  | { readonly exit: number }
  | { readonly signal: number }
  | { readonly cancelled: true; readonly clean: boolean }
  | { readonly error: { readonly code: string } }

const MAX_FRAME = 65_536
const MAX_STDERR = 64 * 1024

const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max

/** Parse only the client's documented shapes; anything else is no status. */
export const parseStatus = (text: string): Status | undefined => {
  const line = text.trimEnd().split("\n").at(-1)
  if (line === undefined || line === "") return undefined
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(",")
  if (keys === "exit" && integer(record.exit, 0, 255)) return { exit: record.exit }
  if (keys === "signal" && integer(record.signal, 1, 64)) return { signal: record.signal }
  if (keys === "cancelled,clean" && record.cancelled === true && typeof record.clean === "boolean") {
    return { cancelled: true, clean: record.clean }
  }
  if (keys === "error" && typeof record.error === "object" && record.error !== null) {
    const code = (record.error as Record<string, unknown>).code
    if (typeof code === "string" && /^[a-z_]{1,32}$/.test(code)) return { error: { code } }
  }
  return undefined
}

/** One planned call as the client's stdin: argv, cwd, env, stdin, display. */
export const request = (input: Bash.Input): string | StdError => {
  const invocation = Bash.invocation(input)
  if (invocation instanceof StdError) return invocation
  // A command line runs in the platform shell, exactly as Bash.run's spawn.
  const argv = invocation.args === undefined
    ? ["/bin/sh", "-c", invocation.file]
    : [invocation.file, ...invocation.args]
  return JSON.stringify({
    argv,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    env: invocation.env ?? {},
    ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
    display: invocation.quoted
  })
}

/** A single-consumer frame channel: the client's output in arrival order. */
class Channel {
  private readonly frames: Array<StandardFlows.TerminalFrame> = []
  private failure: StdError | undefined
  private done = false
  private wake: (() => void) | undefined

  push(frame: StandardFlows.TerminalFrame): void {
    this.frames.push(frame)
    this.notify()
  }
  end(failure?: StdError): void {
    this.failure = failure
    this.done = true
    this.notify()
  }
  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
  async *iterate(): AsyncGenerator<StandardFlows.TerminalFrame> {
    while (true) {
      const frame = this.frames.shift()
      if (frame !== undefined) {
        yield frame
        continue
      }
      if (this.done) {
        if (this.failure !== undefined) throw this.failure
        return
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }
}

const failure = (status: Status | undefined): StdError => {
  if (status !== undefined && "error" in status) {
    const code = status.error.code
    return code === "runner" || code === "closed"
      ? new StdError({
        code: "command_failed",
        message: `Agent terminal command ${code === "runner" ? "did not start" : "closed without status"}`
      })
      : new StdError({ code: "provider_unavailable", message: `Agent terminal unavailable: ${code}` })
  }
  return new StdError({ code: "command_failed", message: "Agent terminal transport failed" })
}

/**
 * The agent terminal port for this machine. `killRun` resolves once the last
 * command's client confirmed that nothing it started is still running.
 */
export const port = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  client: string = CLIENT
): StandardFlows.TerminalPort => {
  let last: Promise<Status | undefined> = Promise.resolve({ exit: 0 })
  return {
    execute: (input, signal) => {
      const channel = new Channel()
      const body = request(input)
      if (body instanceof StdError) {
        channel.end(body)
        return channel.iterate()
      }
      const program = Effect.scoped(
        Effect.gen(function*() {
          const child = yield* spawner.spawn(
            ChildProcess.make(client, ["client", "pty"], {
              stdin: Stream.make(new TextEncoder().encode(body))
            })
          )
          // Cancellation is the client's SIGTERM: it kills the command's
          // process group, closes the session and confirms an empty cgroup.
          const cancel = () => {
            Effect.runFork(Effect.ignore(child.kill({ killSignal: "SIGTERM" })))
          }
          if (signal.aborted) cancel()
          else signal.addEventListener("abort", cancel, { once: true })
          const errors = yield* Effect.forkChild(
            Stream.runFold(
              child.stderr,
              () => "",
              (text, bytes) => text.length > MAX_STDERR ? text : text + new TextDecoder().decode(bytes)
            )
          )
          yield* Stream.runForEach(child.stdout, (bytes) =>
            Effect.sync(() => {
              for (let at = 0; at < bytes.byteLength; at += MAX_FRAME) {
                channel.push({ kind: "output", bytes: bytes.subarray(at, at + MAX_FRAME) })
              }
            }))
          yield* child.exitCode
          signal.removeEventListener("abort", cancel)
          return parseStatus(yield* Fiber.join(errors))
        })
      )
      last = Effect.runPromise(program).then(
        (status) => {
          if (status !== undefined && "exit" in status) {
            channel.push({ kind: "exit", code: status.exit })
            channel.end()
          } else if (status !== undefined && "signal" in status) {
            channel.push({ kind: "signal", signal: status.signal })
            channel.end()
          } else if (status !== undefined && "cancelled" in status) {
            channel.end(new StdError({ code: "command_failed", message: "Agent terminal command cancelled" }))
          } else {
            channel.end(failure(status))
          }
          return status
        },
        () => {
          channel.end(failure(undefined))
          return undefined
        }
      )
      return channel.iterate()
    },
    killRun: async () => {
      const status = await last
      // A refused open or a finished command left nothing running; only an
      // unconfirmed cancellation or a lost client cannot prove cleanup.
      if (status === undefined || ("cancelled" in status && !status.clean)) {
        throw new StdError({ code: "command_failed", message: "Agent terminal cleanup unconfirmed" })
      }
    }
  }
}

/**
 * The port where this process runs as the coding agent on a machine: the
 * installed client and the broker's socket both exist. Elsewhere `bash`
 * refuses with a typed error; it never falls back to a spawn here.
 */
export const installed = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
): StandardFlows.TerminalPort | undefined =>
  existsSync(CLIENT) && existsSync(SOCKET) && process.getuid?.() === 19999 ? port(spawner) : undefined
