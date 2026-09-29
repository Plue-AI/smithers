/**
 * A Smithers Cloud workspace as the machine a worker's tools run on.
 *
 * The agent loop, the cell harness and the journal stay in this process; only
 * `bash`, `read`, `write`, `edit` and the rest of the filesystem and shell
 * flows reach the box, over the workspace's public SSH endpoint.
 */
import * as NodeControl from "@smthrs/cli/NodeControl"
import { CommandSandbox, Sandbox } from "@smthrs/sandbox"
import { ProviderError } from "@smthrs/sandbox/RemoteChildProcessSpawner"
import { Effect, Layer, Stream } from "effect"
import * as ServiceContext from "effect/Context"
import type * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { instructionNames } from "./context.ts"

export interface Box {
  /** What the worker is told its tools run on. */
  readonly name: string
  /** The box's working tree; relative paths and commands resolve here. */
  readonly workdir: string
  /** The argv that reaches the box; asked before every command. */
  readonly prefix: () => Promise<ReadonlyArray<string>>
}

/**
 * How long one workspace SSH grant is reused. `smthrs workspace exec` reuses
 * its grant for 60 s (`packages/smithers/src/internal/backend/Workspaces.ts`);
 * this stays under that.
 */
export const grantMs = 50_000

/** `OWNER/REPO/WORKSPACE_ID`, reached through the public workspace SSH API. */
export const workspace = (
  environment: Readonly<Record<string, string | undefined>>,
  reference: string,
  fetch: typeof NodeControl.workspaceSshPrefix = NodeControl.workspaceSshPrefix
): Box => {
  let cached: { readonly at: number; readonly prefix: Promise<ReadonlyArray<string>> } | undefined
  return {
    name: reference,
    workdir: "/home/developer/workspace",
    prefix: () => {
      if (cached === undefined || Date.now() - cached.at > grantMs) {
        const prefix = fetch(environment, reference)
        const entry = { at: Date.now(), prefix }
        cached = entry
        prefix.catch(() => {
          if (cached === entry) cached = undefined
        })
      }
      return cached.prefix
    }
  }
}

/** The filesystem, path and spawner of one session on the box, held for a turn. */
export const layer = (box: Box, session: string) =>
  Layer.unwrap(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    return Sandbox.layerHost(
      CommandSandbox.make({
        spawner,
        name: box.name,
        workdir: box.workdir,
        prefix: Effect.tryPromise({
          try: box.prefix,
          catch: (cause) =>
            new ProviderError({
              code: "unavailable",
              // The cause's text is in the message; a nested cause would win the turn's failure line.
              message: `${box.name} could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`
            })
        })
      }),
      { session }
    )
  }))

/** The line a placed worker is taught, so it names paths on the box. */
export const teaching = (box: Box) =>
  `Your filesystem and shell flows run on ${box.name}, not on this machine. Search there with \`rg\` in bash.`

/**
 * The box checkout's own instruction file, the first of `instructionNames`
 * in its workdir, read in one command. None when there is none. A box that
 * cannot answer fails the turn: its rules may forbid what the worker would do.
 */
export const instructions = (
  services: ServiceContext.Context<ChildProcessSpawner>,
  box: Box
): Effect.Effect<
  ReadonlyArray<{ readonly path: string; readonly text: string }>,
  PlatformError.PlatformError | Error
> =>
  Effect.scoped(Effect.gen(function*() {
    const handle = yield* ServiceContext.get(services, ChildProcessSpawner).spawn(
      ChildProcess.make("/bin/sh", [
        "-c",
        `for f in ${
          instructionNames.join(" ")
        }; do if [ -f "$f" ]; then printf '%s\\n' "$f"; cat "$f"; exit 0; fi; done`
      ], { cwd: box.workdir })
    )
    // The exit, not the end of output, says the read finished: a lost box ends
    // the stream early and fails the exit.
    const [out, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
      concurrency: "unbounded"
    })
    if (code !== 0) return yield* Effect.fail(new Error(`${box.name} could not read its rules: exit ${code}`))
    const newline = out.indexOf("\n")
    return newline < 0 ? [] : [{ path: `${box.workdir}/${out.slice(0, newline)}`, text: out.slice(newline + 1) }]
  }))
