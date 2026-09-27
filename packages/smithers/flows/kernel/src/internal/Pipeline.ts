/**
 * Pipeline wiring around a per-process spawner, so every leg has its own lifecycle.
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { type ChildProcessHandle, makeHandle } from "effect/unstable/process/ChildProcessSpawner"

type Spawn = (
  command: ChildProcess.StandardCommand
) => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope>

const source = (handle: ChildProcessHandle, from: ChildProcess.PipeFromOption | undefined) => {
  if (from === "stderr") return handle.stderr
  if (from === "all") return handle.all
  const fd = from === undefined ? undefined : ChildProcess.parseFdName(from)
  return fd === undefined ? handle.stdout : handle.getOutputFd(fd)
}

/** An edge feeds the first process of its destination, including a nested pipeline. */
const withInput = (
  command: ChildProcess.Command,
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  to: ChildProcess.PipeToOption | undefined
): ChildProcess.Command => {
  if (command._tag === "PipedCommand") {
    return ChildProcess.pipeTo(withInput(command.left, stream, to), command.right, command.options)
  }
  const fd = to === undefined ? undefined : ChildProcess.parseFdName(to)
  if (fd !== undefined) {
    return ChildProcess.make(command.command, command.args, {
      ...command.options,
      additionalFds: {
        ...command.options.additionalFds,
        [ChildProcess.fdName(fd)]: { type: "input", stream }
      }
    })
  }
  const stdin = command.options.stdin
  return ChildProcess.make(command.command, command.args, {
    ...command.options,
    stdin: {
      ...(typeof stdin === "object" && !Stream.isStream(stdin) ? stdin : {}),
      stream
    }
  })
}

/**
 * Preserve Effect's rightmost output/status and reverse-order kill/reref semantics.
 * @private
 * @since 1.0.0
 */
export const spawn = (
  command: ChildProcess.Command,
  standard: Spawn
): Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope> =>
  Effect.gen(function*() {
    if (command._tag === "StandardCommand") return yield* standard(command)
    const left = yield* spawn(command.left, standard)
    const right = yield* spawn(
      withInput(command.right, source(left, command.options.from), command.options.to),
      standard
    )
    return makeHandle({
      ...right,
      kill: (options) =>
        Effect.gen(function*() {
          const rightExit = yield* Effect.exit(right.kill(options))
          const leftExit = yield* Effect.exit(left.kill(options))
          if (Exit.isFailure(rightExit)) return yield* Effect.failCause(rightExit.cause)
          return yield* leftExit
        }),
      unref: Effect.gen(function*() {
        const leftReref = yield* left.unref
        const rightReref = yield* right.unref
        return Effect.andThen(rightReref, leftReref)
      })
    })
  })
