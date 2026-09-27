/**
 * Delivers standard input through a workspace file for transports without an
 * input channel.
 *
 * @since 0.1.0
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { finalizeWithin } from "./finalizeWithin.ts"

/**
 * The slice of a session the redirect needs: somewhere to put the bytes, and
 * a way to take them away again.
 *
 * @category models
 * @since 0.1.0
 */
export interface StdinTarget {
  readonly workdir: string
  readonly writeFile: (path: string, content: Uint8Array) => Effect.Effect<void, ProviderError>
  /**
   * Removes one staged file. Runs as a finalizer of the spawn's scope, even
   * when the command was killed, interrupted, or never reached its own cleanup.
   */
  readonly remove: (path: string) => Effect.Effect<void, ProviderError>
}

/** The session-private directory staged input lives in, below the workspace. */
const stagingDirectory = ".smthrs-stdin"

/**
 * An unguessable file name.
 *
 * A per-session counter was not one. It reset on every acquire, so a
 * reattached machine — a resumed Vercel sandbox, an adopted ECS task, a
 * leftover container — started again at `.smthrs-stdin-0` and could read or
 * overwrite the previous incarnation's staged input. Standard input is where a
 * caller puts a script, a patch, or a credential blob.
 */
const staged = (): string => {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Builds a per-session redirect: hands back a function that stages a
 * command's standard input as a file and rewrites the command to read from
 * it.
 *
 * Most vendor execution APIs take a command line and nothing else, so the
 * only way to satisfy the session contract's "spawn delivers stdin" is to put
 * the bytes where the command can reach them: a file in the workspace, read
 * through an ordinary redirection.
 *
 * The file's lifetime is the spawn's scope, not the command's own good
 * behavior. Removal used to be a `rm` appended to the rewritten command line,
 * which is exactly the cleanup a kill or an interruption skips: the wrapper
 * shell died with the command and the bytes stayed on the machine. It is a
 * scoped resource instead, so removal is attempted on success, failure, kill, and
 * interruption alike.
 *
 * The removal is registered BEFORE the first byte is written, not around the
 * write. `Effect.acquireRelease` registers its release only once its acquire
 * has succeeded, and no bundled provider writes a file atomically:
 * `AwsSandbox` sends one `printf | base64 -d` per `ExecTransport.chunkBytes`
 * bytes over a separate remote round trip and stops at the first non-zero
 * status. A write that dropped partway through therefore left the chunks it
 * had already delivered on the machine with nothing registered to take them
 * away, for the life of the machine and across a reattach.
 *
 * What the staging guarantees is an unguessable name inside the workspace and
 * a removal attempt on scope closure, bounded to five seconds and warned on
 * failure. It does not set a mode or an owner on the directory: the session's
 * own writeFile is the only channel a provider
 * hands this module, so the file is created under the machine's umask like
 * every other file the session writes.
 *
 * The command text is placed verbatim on separate lines inside a subshell,
 * redirected from the staged file. This keeps its exit status and quoting,
 * and lets trailing comments and heredoc terminators end before the closing
 * parenthesis.
 *
 * @category constructors
 * @since 0.1.0
 */
export const stdinRedirect = (target: StdinTarget): (
  command: string,
  stdin: Uint8Array | undefined
) => Effect.Effect<string, ProviderError, Scope.Scope> => {
  const directory = `${target.workdir.replace(/\/+$/, "")}/${stagingDirectory}`
  return (command, stdin) => {
    if (stdin === undefined) return Effect.succeed(command)
    return Effect.gen(function*() {
      const file = `${directory}/${staged()}`
      // The name is claimed, and its removal registered, before anything is
      // written to it: a chunked write that fails partway has already put
      // bytes on the machine.
      yield* Effect.addFinalizer(() =>
        finalizeWithin(
          Effect.ignore(
            target.remove(file).pipe(
              Effect.tapError((error) =>
                Effect.logWarning("sandbox stdin removal failed", { resource: file, code: error.code })
              )
            )
          ),
          `stdin file ${file}`
        )
      )
      yield* target.writeFile(file, stdin)
      return `(\n${command}\n) < ${CommandLine.quote(file)}`
    })
  }
}
