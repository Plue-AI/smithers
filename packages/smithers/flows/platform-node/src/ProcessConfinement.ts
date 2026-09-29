/**
 * The kernel's `ProcessConfinement` seam, filled with this host's native
 * sandbox: bubblewrap on Linux, seatbelt on macOS.
 *
 * `@smthrs/kernel`'s `ChildProcessSpawner.layer` hands every stage that passed
 * its `proc:spawn` check to the confinement in its context, together with the
 * `ProcessConfinement.Profile` the grants in force admit. This module turns
 * that profile into a {@link ProcessSandbox.Request}, plans it against the
 * workspace, and wraps the stage's argv in the mechanism the host has, so an
 * approved `bash` can write only where an `fs:write` grant says and reach the
 * network only when a `net:*` grant says. A stage that asked for the platform
 * shell is spelled out as `/bin/sh -c <line>` first: wrapping a `shell: true`
 * command line would otherwise leave its redirections and pipes to a shell
 * outside the sandbox.
 *
 * A host with no mechanism is the one decision this module leaves to its
 * caller: {@link Options.unavailable} either refuses the spawn, so nothing
 * runs that the profile would not have confined, or runs it unconfined with
 * a warning, the way every host did before this seam existed. A write set
 * the mechanism cannot enforce safely, a symbolic link below the workspace
 * root, is always refused.
 *
 * @since 1.0.0-rc.1
 */

import * as KernelProcessConfinement from "@smthrs/kernel/ProcessConfinement"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { randomUUID } from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as ProcessSandbox from "./ProcessSandbox.ts"

/**
 * How the confinement is built.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Options {
  /**
   * What happens when this host has no mechanism to enforce a profile with.
   * `"refuse"` fails the spawn, so a command never runs with more than the
   * profile allows; `"unconfined"`, the default, runs it as given and logs a
   * warning naming what the host lacks.
   */
  readonly unavailable?: "refuse" | "unconfined" | undefined
  /** The host facts mechanism selection reads; defaults to the real host. */
  readonly host?: ProcessSandbox.Host | undefined
  /** Where each run's private temporary directory is created; defaults to the OS temporary directory. */
  readonly temporaryDirectory?: string | undefined
}

const shellLine = (command: ChildProcess.StandardCommand): string => [command.command, ...command.args].join(" ")

/**
 * The argv a stage executes, with a shell request made explicit.
 *
 * Node runs a `shell: true` stage as `/bin/sh -c <line>` on POSIX, and a
 * string shell as `<shell> -c <line>`; the wrapper needs that program to be
 * the one it confines, so the shell becomes the argv's first token and the
 * spawned stage no longer asks for one.
 */
const argvOf = (command: ChildProcess.StandardCommand): ReadonlyArray<string> => {
  const shell = command.options.shell
  if (shell === undefined || shell === false) return [command.command, ...command.args]
  return [shell === true ? "/bin/sh" : shell, "-c", shellLine(command)]
}

const failure = (
  tag: "NotFound" | "PermissionDenied" | "Unknown",
  command: ChildProcess.StandardCommand,
  description: string,
  cause: unknown
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: tag,
    module: "ProcessConfinement",
    method: "confine",
    pathOrDescriptor: shellLine(command),
    description,
    cause
  })

const messageOf = (cause: unknown): string =>
  ProcessSandbox.isUnenforceable(cause)
    ? cause.message
    : cause instanceof Error
    ? cause.message
    : String(cause)

/**
 * Builds the native confinement.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const make = (options: Options = {}): KernelProcessConfinement.Service => {
  const hostFacts = options.host ?? ProcessSandbox.host()
  const temporaryRoot = options.temporaryDirectory ?? NodeOs.tmpdir()
  const unavailable = options.unavailable ?? "unconfined"
  const confine = Effect.fn("ProcessConfinement.confine")(function*(
    command: ChildProcess.StandardCommand,
    profile: KernelProcessConfinement.Profile
  ): Effect.fn.Return<ChildProcess.StandardCommand, PlatformError.PlatformError, Scope.Scope> {
    const request: ProcessSandbox.Request = {
      network: profile.network,
      reads: profile.reads,
      writes: profile.writes,
      writeFiles: profile.writeFiles,
      readOnly: profile.readOnly
    }
    const selected = ProcessSandbox.select(request, hostFacts)
    if (ProcessSandbox.isUnenforceable(selected)) {
      if (unavailable === "refuse") {
        return yield* failure(
          "NotFound",
          command,
          `${selected.message} This host refuses to spawn unconfined.`,
          selected
        )
      }
      yield* Effect.logWarning(`${selected.message} Running unconfined.`)
      return command
    }
    const tmp = NodePath.join(temporaryRoot, `smithers-confinement-${randomUUID()}`)
    // The stage's directory is absolute: the kernel spawner roots it first.
    const cwd = command.options.cwd ?? profile.workspaceRoot
    const planned = ProcessSandbox.plan(request, { workspaceRoot: profile.workspaceRoot, cwd, tmp }, hostFacts)
    if (ProcessSandbox.isUnenforceable(planned)) {
      return yield* failure("PermissionDenied", command, planned.message, planned)
    }
    // The private tmp lives as long as the spawn's scope, however preparation
    // ends; the declared write directories are created so the mechanism has
    // something to bind, which the grant that opened them already permits.
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => NodeFs.mkdirSync(tmp, { recursive: true }),
        catch: (cause) => failure("Unknown", command, `could not prepare the confinement: ${messageOf(cause)}`, cause)
      }),
      () =>
        Effect.sync(() => {
          try {
            NodeFs.rmSync(tmp, { recursive: true, force: true })
          } catch {
            // Cleanup is best-effort when the host refuses directory removal.
          }
        })
    )
    yield* Effect.try({
      try: () => {
        ProcessSandbox.validateWrites(planned, hostFacts)
        NodeFs.mkdirSync(NodePath.join(tmp, "home"), { recursive: true })
        NodeFs.mkdirSync(NodePath.join(tmp, "cache"), { recursive: true })
        for (const write of planned.writes) NodeFs.mkdirSync(write, { recursive: true })
      },
      catch: (cause) => failure("Unknown", command, `could not prepare the confinement: ${messageOf(cause)}`, cause)
    })
    const visible: Record<string, string> = {}
    for (const [name, value] of Object.entries(command.options.env ?? {})) {
      if (typeof value === "string") visible[name] = value
    }
    const wrapped = yield* Effect.try({
      try: () => ProcessSandbox.wrap(planned, argvOf(command), visible, hostFacts),
      catch: (cause) => failure("Unknown", command, `could not render the confinement: ${messageOf(cause)}`, cause)
    })
    const [executable, ...args] = wrapped.argv
    // A stage with no environment of its own inherits the host's; the
    // wrapper's variables are then an extension of that inheritance rather
    // than a replacement for it.
    return ChildProcess.make(executable!, args, {
      ...command.options,
      shell: false,
      env: { ...command.options.env, ...wrapped.env },
      extendEnv: command.options.env === undefined ? true : command.options.extendEnv
    })
  })
  return KernelProcessConfinement.ProcessConfinement.of({ confine })
}

/**
 * Provides the native confinement.
 *
 * @category layers
 * @since 1.0.0-rc.1
 */
export const layer = (options: Options = {}): Layer.Layer<KernelProcessConfinement.ProcessConfinement> =>
  Layer.succeed(KernelProcessConfinement.ProcessConfinement)(make(options))
