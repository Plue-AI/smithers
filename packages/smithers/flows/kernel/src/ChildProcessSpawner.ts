/**
 * Permission-aware process spawning.
 *
 * Smithers has no shell service of its own — process execution is Effect's
 * `effect/unstable/process`. The only thing the kernel adds is the
 * `proc:spawn` capability check and the host confinement wrapper, applied to
 * the one primitive every other helper is derived from.
 *
 * There is no kernel spawner interface and no kernel spawner tag. Effect owns
 * both, and its tag fixes the error channel to `PlatformError`, so this module
 * is only the middleware: a `Layer` over Effect's own tag. A denied command is
 * projected into `PlatformError` by `Permission.toPlatformError`, which keeps
 * the structured kernel failure on the error's `cause`. Because the channel
 * stays `PlatformError`, the full six-method surface is derived from the one
 * guarded `spawn` through Effect's own `ChildProcessSpawner.make` without a
 * cast.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 1.0.0-rc.0
 */

import { toPlatformError } from "@smthrs/capability/Permission"
import { Effect, FileSystem, Layer, Option, Path, type Scope } from "effect"
import { type PlatformError, systemError } from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as CommandLine from "./CommandLine.ts"
import { GrantStore } from "./GrantStore.ts"
import * as Containment from "./internal/Containment.ts"
import { makeCapability } from "./internal/makeCapability.ts"
import * as ProcessConfinement from "./ProcessConfinement.ts"
import * as Rooted from "./Rooted.ts"
import { Workspace } from "./Workspace.ts"

const data = (value: object, name: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`command ${String(name)} must be a data property`)
  }
  return descriptor.value
}

const optionalData = (value: object, name: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (descriptor === undefined) return undefined
  if (!("value" in descriptor)) throw new TypeError(`command ${String(name)} must be a data property`)
  return descriptor.value
}

const snapshotRecord = (
  value: Readonly<Record<string, string | undefined>> | undefined
): Record<string, string | undefined> | undefined => {
  if (value === undefined) return undefined
  const snapshot: Record<string, string | undefined> = Object.create(null)
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue
    if (!("value" in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== "string")) {
      throw new TypeError("command environment must contain string data properties")
    }
    snapshot[name] = descriptor.value
  }
  return Object.freeze(snapshot)
}

const snapshotStreamConfig = <A>(value: A): A => {
  if (typeof value !== "object" || value === null) return value
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (descriptors.stream === undefined) return value
  if (!("value" in descriptors.stream)) throw new TypeError("command stream must be a data property")
  const snapshot: Record<string, unknown> = { stream: descriptors.stream.value }
  for (const name of ["endOnDone", "encoding"] as const) {
    const descriptor = descriptors[name]
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) throw new TypeError(`command ${name} must be a data property`)
      snapshot[name] = descriptor.value
    }
  }
  return Object.freeze(snapshot) as A
}

const snapshotAdditionalFds = (
  value: ChildProcess.CommandOptions["additionalFds"]
): ChildProcess.CommandOptions["additionalFds"] => {
  if (value === undefined) return undefined
  const snapshot: Record<`fd${number}`, ChildProcess.AdditionalFdConfig> = {}
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue
    if (!("value" in descriptor) || typeof descriptor.value !== "object" || descriptor.value === null) {
      throw new TypeError("additional file descriptors must be data records")
    }
    const config = descriptor.value as ChildProcess.AdditionalFdConfig
    const type = data(config, "type")
    if (type === "input") {
      const stream = Object.getOwnPropertyDescriptor(config, "stream")
      snapshot[name as `fd${number}`] = Object.freeze({
        type,
        ...(stream === undefined ? {} : "value" in stream ? { stream: stream.value } : (() => {
          throw new TypeError("additional fd stream must be a data property")
        })())
      })
    } else if (type === "output") {
      const sink = Object.getOwnPropertyDescriptor(config, "sink")
      snapshot[name as `fd${number}`] = Object.freeze({
        type,
        ...(sink === undefined ? {} : "value" in sink ? { sink: sink.value } : (() => {
          throw new TypeError("additional fd sink must be a data property")
        })())
      })
    } else {
      throw new TypeError("additional file descriptor type is invalid")
    }
  }
  return Object.freeze(snapshot)
}

const snapshotOptions = (options: ChildProcess.CommandOptions): ChildProcess.CommandOptions =>
  Object.freeze({
    killSignal: options.killSignal,
    forceKillAfter: options.forceKillAfter,
    cwd: options.cwd,
    env: snapshotRecord(options.env),
    extendEnv: options.extendEnv,
    shell: options.shell,
    detached: options.detached,
    windowsHide: options.windowsHide,
    stdin: snapshotStreamConfig(options.stdin),
    stdout: snapshotStreamConfig(options.stdout),
    stderr: snapshotStreamConfig(options.stderr),
    additionalFds: snapshotAdditionalFds(options.additionalFds)
  })

const snapshotCommand = (command: ChildProcess.Command): ChildProcess.Command => {
  const tag = data(command, "_tag")
  if (tag === "StandardCommand") {
    const executable = data(command, "command")
    const args = data(command, "args")
    const options = data(command, "options")
    if (typeof executable !== "string" || !Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
      throw new TypeError("standard command executable and arguments are invalid")
    }
    if (typeof options !== "object" || options === null) throw new TypeError("command options are invalid")
    return ChildProcess.make(
      executable,
      Object.freeze([...args]),
      snapshotOptions(options)
    )
  }
  if (tag === "PipedCommand") {
    const left = data(command, "left")
    const right = data(command, "right")
    const options = data(command, "options")
    if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
      throw new TypeError("pipeline commands are invalid")
    }
    if (typeof options !== "object" || options === null) throw new TypeError("pipeline options are invalid")
    const from = optionalData(options, "from")
    const to = optionalData(options, "to")
    return ChildProcess.pipeTo(
      snapshotCommand(right as ChildProcess.Command),
      Object.freeze({
        ...(from === undefined ? {} : { from: from as ChildProcess.PipeFromOption }),
        ...(to === undefined ? {} : { to: to as ChildProcess.PipeToOption })
      })
    )(snapshotCommand(left as ChildProcess.Command))
  }
  throw new TypeError("unsupported command shape")
}

const maximumEnvironmentNames = 64

/**
 * The environment this process holds, which a child built with
 * `ChildProcessEnvironment.make` inherits its bootstrap names from. Empty on a
 * host with no process environment, so every declared bootstrap name counts
 * as an override there.
 */
const ambientEnvironment = (): Readonly<Record<string, string | undefined>> =>
  (globalThis as { readonly process?: { readonly env?: Record<string, string | undefined> } }).process?.env ?? {}

const environmentNames = (command: ChildProcess.StandardCommand): ReadonlyArray<string> | undefined => {
  const environment = command.options.env
  if (environment === undefined) return undefined
  const names = Object.entries(environment)
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name)
    .sort()
  if (names.length === 0) return undefined
  return names.length <= maximumEnvironmentNames
    ? names
    : [...names.slice(0, maximumEnvironmentNames), `+${names.length - maximumEnvironmentNames} more`]
}

/**
 * Effect's own process spawner tag, unchanged. Re-exported so the kernel
 * namespace stays one-stop; it is the *same* tag, never a second one.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

/**
 * Derives the full six-method surface from one `spawn`, so `exitCode`,
 * `string`, `lines`, and both `stream*` helpers can never bypass whatever
 * `spawn` was given.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export { make } from "effect/unstable/process/ChildProcessSpawner"

/**
 * Constructs an unavailable spawner stub.
 *
 * Every derived helper reports the missing host as a `NotFound`
 * `PlatformError` naming the command line, so an unconfigured capability
 * answers rather than vanishing.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const makeNoop = (
  overrides: Partial<ChildProcessSpawner["Service"]> = {}
): ChildProcessSpawner["Service"] => ({
  ...makeSpawner((command) =>
    Effect.fail(
      systemError({
        _tag: "NotFound",
        module: "ChildProcessSpawner",
        method: "spawn",
        description: `no process host for \`${CommandLine.render(command)}\``
      })
    )
  ),
  ...overrides
})

/**
 * Provides an unavailable spawner stub.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerNoop = (
  overrides: Partial<ChildProcessSpawner["Service"]> = {}
): Layer.Layer<ChildProcessSpawner> => Layer.succeed(ChildProcessSpawner)(makeNoop(overrides))

/**
 * Decorates the process spawner in place with a `proc:spawn` capability check.
 *
 * The check is suspended into the spawn itself, so building a `Command` or a
 * stream neither requests permission nor starts a process; only running one
 * does. Every pipeline stage is checked as its own capability, left to right,
 * and no stage starts until all pass. A stage's resource is
 * `CommandLine.resource`: the command line `CommandLine.render` produces, with
 * a `shell: true` line that holds shell control syntax marked as
 * `sh -c '<line>'`, any environment variable the child would not inherit from
 * this process named in an `env <NAME>… -- ` prefix, and a working directory
 * outside `Workspace.root` named in a `cwd <path> -- ` prefix. Custom shell
 * paths are included explicitly in the resource; browser and remote adapters
 * reject them rather than silently substituting a different shell.
 *
 * Every approved stage requires `ProcessConfinement` in the host context.
 * A missing service refuses spawning; its `layerNoop` is the explicit choice
 * for an unconfined host.
 *
 * Pipeline `from`/`to` routing remains outside the grant. The working
 * directory and overridden environment names also reach attended surfaces as
 * display metadata; environment values never leave the command.
 *
 * The layer provides the tag it also requires: compose it over a host spawner
 * layer with `Layer.provide` and a `ChildProcess.Command` run as a plain
 * `Effect` is checked too.
 *
 * A command with no `cwd`, or a relative one, runs in `Workspace.root`, never
 * the process's own directory; the check sees that resolved directory. When
 * the host filesystem is in the layer's context, the working directory and
 * `Workspace.root` are compared by real path, so a symlink inside the
 * workspace that leads out of it is named, as its target, in the `cwd` prefix.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer: Layer.Layer<
  ChildProcessSpawner,
  never,
  ChildProcessSpawner | GrantStore | Path.Path | Workspace
> = Layer.effect(
  ChildProcessSpawner,
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const grants = yield* GrantStore
    const confinement = yield* Effect.serviceOption(ProcessConfinement.ProcessConfinement)
    const path = yield* Path.Path
    const rooted = Rooted.path(path, path.resolve((yield* Workspace).root))
    const root = rooted.resolve(".")
    // The raw host filesystem this layer is composed over, when there is one.
    // A symlink inside the workspace can lead out of it, so containment is
    // judged on real paths; a directory that cannot be resolved (it does not
    // exist, or the host has no filesystem) is judged lexically.
    const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem)
    const real = (directory: string) =>
      Option.match(fileSystem, {
        onNone: () => Effect.succeed(directory),
        onSome: (fs) => fs.realPath(directory).pipe(Effect.orElseSucceed(() => directory))
      })
    const within = (base: string) => (directory: string) => {
      const relative = path.relative(base, directory)
      return relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative)
    }
    const checkStage = (stage: ChildProcess.StandardCommand) =>
      Effect.gen(function*() {
        // Rooted.command gives every stage an absolute cwd.
        const cwd = stage.options.cwd!
        const realRoot = yield* real(root)
        const resolvedCwd = yield* real(cwd)
        const contains = resolvedCwd === cwd
          ? (directory: string) => within(root)(directory) || within(realRoot)(directory)
          : within(realRoot)
        return yield* checkResolved(
          stage,
          CommandLine.resource(stage, {
            ambient: ambientEnvironment(),
            contains,
            resolvedCwd
          })
        )
      })
    const checkResolved = (stage: ChildProcess.StandardCommand, rendered: string) => {
      const environment = environmentNames(stage)
      return makeCapability("proc:spawn", rendered).pipe(
        Effect.flatMap((capability) =>
          grants.check(capability, {
            cwd: stage.options.cwd,
            ...(environment === undefined ? {} : { env: environment })
          })
        ),
        Effect.mapError((error) =>
          toPlatformError({
            module: "ChildProcessSpawner",
            method: "spawn",
            pathOrDescriptor: rendered,
            error
          })
        )
      )
    }
    const check = (command: ChildProcess.Command) =>
      Effect.forEach(CommandLine.stages(command), checkStage, { discard: true })
    const confine = (
      command: ChildProcess.Command
    ): Effect.Effect<
      ChildProcess.Command,
      PlatformError,
      Scope.Scope
    > =>
      Option.match(confinement, {
        onNone: () =>
          Effect.fail(systemError({
            _tag: "NotFound",
            module: "ProcessConfinement",
            method: "confine",
            description:
              "process confinement is required; use ProcessConfinement.layerNoop to explicitly run unconfined"
          })),
        onSome: (service) =>
          Effect.gen(function*() {
            const profile = yield* ProcessConfinement.profile(grants, root, path).pipe(
              Effect.mapError((error) => toPlatformError({ module: "ChildProcessSpawner", method: "spawn", error }))
            )
            const wrap = (
              command: ChildProcess.Command
            ): Effect.Effect<
              ChildProcess.Command,
              PlatformError,
              Scope.Scope
            > =>
              command._tag === "StandardCommand"
                ? service.confine(command, profile)
                : Effect.gen(function*() {
                  const left = yield* wrap(command.left)
                  const right = yield* wrap(command.right)
                  return ChildProcess.pipeTo(right, command.options)(left)
                })
            return yield* wrap(command)
          })
      })
    return Containment.inherit(
      spawner,
      makeSpawner(
        Effect.fn("ChildProcessSpawner.spawn")((command: ChildProcess.Command) =>
          Effect.try({
            try: () => snapshotCommand(command),
            catch: () =>
              systemError({
                _tag: "InvalidData",
                module: "ChildProcessSpawner",
                method: "spawn",
                description: "command must be an immutable supported process description"
              })
          }).pipe(
            Effect.map((snapshot) => Rooted.command(snapshot, rooted)),
            Effect.flatMap((rooted) =>
              check(rooted).pipe(Effect.andThen(confine(rooted)), Effect.flatMap(spawner.spawn))
            )
          )
        )
      )
    )
  })
)
