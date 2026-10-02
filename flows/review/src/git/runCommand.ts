import { Effect, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { io, runIo } from "../io.ts"

export interface CommandResult { readonly stdout: string; readonly stderr: string; readonly exitCode: number }
/** Run through the host's guarded spawner. Scope release interrupts and reaps the child. */
export const runCommand = async (command: string, args: string[], cwd: string, timeoutMs = 120_000, input?: string): Promise<CommandResult> => {
  const { spawner } = io()
  return runIo(Effect.scoped(Effect.gen(function*() {
    const child = yield* spawner.spawn(ChildProcess.make(command, args, {
      cwd,
      stdin: input === undefined ? "ignore" : Stream.succeed(new TextEncoder().encode(input))
    }))
    const text = (stream: typeof child.stdout) => stream.pipe(Stream.decodeText(), Stream.mkString)
    return yield* Effect.all({ stdout: text(child.stdout), stderr: text(child.stderr), exitCode: child.exitCode }, { concurrency: "unbounded" })
  })).pipe(
    Effect.timeout(timeoutMs),
    Effect.catch((error) => Effect.succeed({ stdout: "", stderr: error.message, exitCode: error._tag === "TimeoutError" ? 124 : 127 }))
  ))
}
