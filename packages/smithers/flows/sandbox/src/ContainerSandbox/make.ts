/**
 * Constructs the container-lifecycle sandbox provider.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { configurationFingerprint } from "../internal/configurationFingerprint.ts"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { execSession } from "../internal/execSession.ts"
import { finalizeWithin } from "../internal/finalizeWithin.ts"
import { linuxFileSystem } from "../internal/linuxFileSystem.ts"
import { gather, type GatheredRun, providerFailure } from "../internal/localProcess.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { NetworkPolicy } from "../Sandbox/NetworkPolicy.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import { type ResourceLimits, validateResourceLimits } from "../Sandbox/ResourceLimits.ts"

/**
 * How the provider reaches and shapes its containers.
 *
 * The container CLI runs through the injected spawner, so the module owns no
 * host access: a Node composition passes the platform spawner, and pointing
 * `program` at `podman` or a wrapper script changes the engine without
 * changing the provider.
 *
 * @category models
 * @since 0.1.0
 */
export interface ContainerSandboxOptions {
  /** The spawner the container CLI runs through. */
  readonly spawner: ChildProcessSpawner["Service"]
  /** The image every session's container is created from. */
  readonly image: string
  /** The container CLI. Default `docker`; `podman` speaks the same verbs. */
  readonly program?: string | undefined
  /** The guest workspace path. Default `/workspace`. */
  readonly workdir?: string | undefined
  /** Container-wide environment, sent through /dev/stdin as an env-file. CR, LF, and NUL values are refused. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /**
   * The container's network. `"none"`, the default, gives it none; another
   * string is the engine's network mode, passed verbatim, and explicitly opts
   * in. An engine network mode is not a host firewall, so an allowlist
   * `{ allow }` is refused when `make` is called.
   */
  readonly network?: NetworkPolicy | string | undefined
  /**
   * The container's ceilings: `cpus` is `--cpus`, `memoryMib` is `--memory`,
   * and `timeoutSecs` replaces `sleep infinity` with `sleep <timeoutSecs>`,
   * so the container stops, ending every command in it, once that many
   * seconds have passed since it last started. The limits enter the
   * configuration fingerprint, so a leftover container with other limits is
   * refused rather than reattached. A `createArgs` flag that would override
   * a set ceiling (`--cpus`, `--cpu-quota`, `--cpu-period`, `--memory`,
   * `-m`, or `--entrypoint` beside `timeoutSecs`) is refused when `make` is
   * called. Rootless podman on cgroup v1 ignores `--cpus` and `--memory`.
   */
  readonly limits?: ResourceLimits | undefined
  /** Extra `create` arguments, an escape hatch for engine-specific shaping. */
  readonly createArgs?: ReadonlyArray<string> | undefined
  /**
   * The container-name prefix. Default `smthrs-sbx-`. A name that would start
   * with `-` is refused at acquire: the CLI would read it as an option.
   */
  readonly namePrefix?: string | undefined
}

const fingerprintLabel = "smithers.dev/sandbox-fingerprint"

/**
 * The engine `create` flags that would override each neutral ceiling: a later
 * `--cpus` or `--memory` replaces the earlier one, CPU quota flags set the
 * same CFS bandwidth, and `--entrypoint` wraps the `sleep` the lifetime is.
 */
const ceilingFlags: Record<keyof ResourceLimits, ReadonlyArray<string>> = {
  cpus: ["--cpus", "--cpu-quota", "--cpu-period"],
  memoryMib: ["--memory", "-m"],
  timeoutSecs: ["--entrypoint"]
}

const flagsOf = (arg: string): ReadonlyArray<string> => {
  if (arg.startsWith("--")) return [arg.split("=")[0]!]
  // A single-dash cluster such as `-itm` or `-m512m` carries `-m` too.
  const cluster = /^-([A-Za-z]+)/.exec(arg)?.[1] ?? ""
  return [...cluster].map((letter) => `-${letter}`)
}

const refuseOverriddenCeilings = (limits: ResourceLimits, createArgs: ReadonlyArray<string>): void => {
  for (const name of Object.keys(ceilingFlags) as Array<keyof ResourceLimits>) {
    if (limits[name] === undefined) continue
    const flag = createArgs.flatMap(flagsOf).find((flag) => ceilingFlags[name].includes(flag))
    if (flag !== undefined) {
      throw new TypeError(`container-sandbox: createArgs ${flag} would override limits.${name}; name one`)
    }
  }
}
const inspectedContainer = Schema.Array(Schema.Struct({
  Config: Schema.Struct({
    Image: Schema.String,
    WorkingDir: Schema.String,
    Labels: Schema.Record(Schema.String, Schema.String)
  }),
  HostConfig: Schema.Struct({
    NetworkMode: Schema.String,
    Privileged: Schema.Boolean,
    Binds: Schema.optional(Schema.NullOr(Schema.Array(Schema.String)))
  }),
  Mounts: Schema.Array(Schema.Struct({ Type: Schema.String })),
  State: Schema.optional(Schema.Struct({ Status: Schema.optional(Schema.String) }))
}))

// A released container is force-removed, but an engine can refuse a later
// create or start of the same name while that removal is still finishing
// ("marked for removal"). The engine reports that phase as State.Status
// `removing`; the wait polls inspect until the name is gone, bounded.
const removalPollMillis = 100
const removalPolls = 300
const removalRetries = 5

/**
 * Builds a sandbox provider whose machines are containers this host's
 * container engine runs.
 *
 * `acquire` creates a deterministically named container from the configured
 * image (`create` then `start`, holding it on `sleep infinity`) and serves
 * the session contract over `exec`: commands run under the guest's `sh`,
 * reads stream bytes out through `cat`, writes stream bytes in through the
 * exec's stdin, and closing the scope removes the container with force,
 * which also ends everything running inside it. A container the name already
 * holds — a crashed run's leftover — is reattached only when its ownership and configuration match, so
 * resuming a session key lands in the machine it had.
 *
 * `spawn` honors the whole session contract, not just the command line. A
 * command's `stdin` bytes travel on the exec's own input channel
 * (`--interactive`), a relative `cwd` is resolved under {@link Session.workdir}
 * before it reaches `--workdir` (which requires an absolute path), and both
 * shells in the chain name `/bin/sh` absolutely, because the engine resolves a
 * bare `sh` through the exec environment's `PATH` and a caller's `env`
 * override would otherwise break the wrapper before the command ever ran. For
 * the same reason the caller's variables travel through stdin to an `env(1)` prefix on the
 * inner shell rather than as `--env` on the exec: they belong to the command,
 * not to the plumbing that starts it. Closing a
 * spawn's scope is the process's lifetime ending: the local CLI client is torn
 * down and, unless the command was already observed to end, the guest process
 * is signalled through the same pid-walk `kill` uses, so a scope cannot close
 * on a still-running guest.
 *
 * Per-command `kill` is real, and it has to be indirect: signalling the local
 * CLI client does not reach the guest process (Docker's exec client detaches
 * from it), which is exactly the silent-no-op kill the conformance suite
 * exists to catch. So every spawned command records its own pid in a
 * session-private guest directory first, and `kill` execs a second command
 * that signals that pid and every descendant found under `/proc`. The pidfile
 * directory is wiped on acquire, so a reattached container cannot mis-target
 * a previous incarnation's pids.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: ContainerSandboxOptions): Provider => {
  const program = options.program ?? "docker"
  const workdir = options.workdir ?? "/workspace"
  if (typeof options.network === "object") {
    throw new TypeError(
      "container-sandbox: cannot enforce a network allowlist; the engine network mode is not a host firewall"
    )
  }
  const network = options.network ?? "none"
  const limits = options.limits === undefined ? {} : validateResourceLimits("container-sandbox", options.limits)
  refuseOverriddenCeilings(limits, options.createArgs ?? [])
  const prefix = options.namePrefix ?? "smthrs-sbx-"
  const run = (args: ReadonlyArray<string>, stdin?: Uint8Array): Effect.Effect<GatheredRun, ProviderError> =>
    Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* options.spawner.spawn(
          ChildProcess.make(program, [...args], stdin === undefined ? {} : { stdin: Stream.make(stdin) })
        ).pipe(
          Effect.mapError(providerFailure("spawn_error", `\`${program} ${args[0]}\` could not start`))
        )
        return yield* gather(handle, `${program} ${args[0]}`)
      })
    )
  const step = (
    what: string,
    args: ReadonlyArray<string>
  ): Effect.Effect<GatheredRun, ProviderError> =>
    Effect.flatMap(run(args), (result) =>
      result.code === 0 ? Effect.succeed(result) : Effect.fail(
        new ProviderError({
          code: "unavailable",
          message: `${what}: \`${program} ${args[0]}\` exited ${result.code}: ${result.stderr.trim()}`
        })
      ))
  return {
    acquire: (sessionKey) =>
      Effect.gen(function*() {
        yield* checkEnvironmentNames(options.env)
        const creationEnv = Object.entries(options.env ?? {})
        if (creationEnv.some(([, value]) => /[\r\n\0]/.test(value))) {
          return yield* Effect.fail(
            new ProviderError({
              code: "spawn_error",
              message:
                "container creation environment values must not contain CR, LF, or NUL: the CLI env-file format cannot carry them"
            })
          )
        }
        const envFile = creationEnv.length === 0 ? undefined : new TextEncoder().encode(
          creationEnv.map(([key, value]) => `${key}=${value}\n`).join("")
        )
        const name = `${prefix}${sessionSlug(sessionKey)}`
        // The name is a positional argument of `start`, `exec`, and `rm`; one
        // that starts with `-` would be parsed as an option instead.
        if (name.startsWith("-")) {
          return yield* Effect.fail(
            new ProviderError({
              code: "spawn_error",
              message: `the container name ${JSON.stringify(name)} starts with "-"; set a namePrefix that does not`
            })
          )
        }
        const fingerprint = yield* configurationFingerprint({
          provider: "ContainerSandbox/v1",
          owner: sessionKey,
          name,
          image: options.image,
          workdir,
          network,
          env: options.env ?? {},
          createArgs: options.createArgs ?? [],
          ...options.limits === undefined ? {} : { limits }
        })
        // CREATION IS ITS OWN RESOURCE, and starting and preparing come after
        // it rather than inside it. `acquireRelease` registers a finalizer only
        // once its acquire SUCCEEDS, so folding `start` and the workspace
        // preparation into the acquire meant a container that was created and
        // then failed to start was never removed: the run reported an honest
        // failure and left a machine behind on the engine, which the next
        // acquire of that key would silently reattach to.
        yield* Effect.acquireRelease(
          Effect.gen(function*() {
            const create = run([
              "create",
              "--name",
              name,
              "--workdir",
              workdir,
              "--network",
              network,
              ...envFile === undefined ? [] : ["--env-file", "/dev/stdin"],
              ...limits.cpus === undefined ? [] : ["--cpus", String(limits.cpus)],
              ...limits.memoryMib === undefined ? [] : ["--memory", `${limits.memoryMib}m`],
              ...options.createArgs ?? [],
              "--label",
              `${fingerprintLabel}=${fingerprint}`,
              options.image,
              "sleep",
              limits.timeoutSecs === undefined ? "infinity" : String(limits.timeoutSecs)
            ], envFile)
            const awaitRemoval = Effect.gen(function*() {
              for (let poll = 0; poll < removalPolls; poll++) {
                if ((yield* run(["container", "inspect", name])).code !== 0) return
                yield* Effect.sleep(removalPollMillis)
              }
              return yield* Effect.fail(
                new ProviderError({
                  code: "unavailable",
                  message: `the container ${name} is still being removed after ${removalPolls * removalPollMillis} ms`
                })
              )
            })
            let vanished = false
            for (let attempt = 0; attempt < removalRetries; attempt++) {
              const created = yield* create
              if (created.code === 0) return
              // A refused create is either a name already taken, which is the
              // reattach this provider is built around, or anything else, which
              // is a failure. The engine says which in English prose, and the
              // prose is not a contract: podman words the conflict differently
              // from docker and a localized daemon differently again. The
              // question goes to the engine as a question instead.
              const existing = yield* run(["container", "inspect", name])
              if (existing.code !== 0) {
                // A conflict whose holder is already gone means its removal
                // finished between the two calls: create once more. A second
                // refusal with nothing holding the name is a real failure.
                if (!vanished) {
                  vanished = true
                  continue
                }
                return yield* Effect.fail(
                  new ProviderError({
                    code: "unavailable",
                    message:
                      `the container ${name} could not be created from ${options.image}: ${created.stderr.trim()}`
                  })
                )
              }
              const inspected = yield* Effect.try({
                try: () =>
                  Schema.decodeUnknownSync(inspectedContainer)(JSON.parse(new TextDecoder().decode(existing.stdout))),
                catch: providerFailure("unavailable", `the container ${name} has no verifiable configuration`)
              })
              const held = inspected[0]
              if (held?.State?.Status === "removing") {
                yield* awaitRemoval
                continue
              }
              if (
                held === undefined || inspected.length !== 1 ||
                held.Config.Labels[fingerprintLabel] !== fingerprint ||
                held.Config.Image !== options.image || held.Config.WorkingDir !== workdir ||
                held.HostConfig.NetworkMode !== network ||
                ((options.createArgs?.length ?? 0) === 0 && (held.HostConfig.Privileged ||
                  (held.HostConfig.Binds?.length ?? 0) > 0 || held.Mounts.some((mount) => mount.Type === "bind")))
              ) {
                return yield* Effect.fail(
                  new ProviderError({
                    code: "unavailable",
                    message: `the container ${name} does not match the requested configuration or owner`
                  })
                )
              }
              return
            }
            return yield* Effect.fail(
              new ProviderError({
                code: "unavailable",
                message: `the container ${name} was still being removed after ${removalRetries} attempts`
              })
            )
          }),
          () =>
            finalizeWithin(
              Effect.flatMap(run(["rm", "--force", name]), (result) =>
                result.code === 0 ? Effect.void : Effect.logWarning("sandbox removal failed", {
                  resource: `container ${name}`,
                  exitCode: result.code
                })).pipe(Effect.catch(() =>
                  Effect.logWarning("sandbox removal failed", {
                    resource: `container ${name}`
                  })
                )),
              `container ${name}`
            )
        )
        yield* step(`the container ${name} could not be started`, ["start", name])
        const session = yield* execSession({
          id: sessionKey,
          name,
          noun: "container",
          program,
          workdir,
          encode: "raw",
          run: (args) => run(args),
          launch: (args, stdin) =>
            options.spawner.spawn(ChildProcess.make(program, [...args], stdin === undefined ? {} : { stdin })),
          shell: (
            script,
            interactive
          ) => ["exec", ...interactive ? ["--interactive"] : [], name, "/bin/sh", "-c", script],
          spawn: ({ command, cwd, record, stdin }) => [
            "exec",
            // The exec has a real input channel; it is asked for only when
            // there is input to carry, so an input-less command sees EOF.
            ...stdin === undefined ? [] : ["--interactive"],
            // `--workdir` requires an absolute guest path, so a relative
            // cwd is rooted at the session workdir before it gets here.
            "--workdir",
            cwd,
            name,
            // Absolute on purpose: the engine resolves the exec's argv
            // through the exec environment's PATH, so a caller's PATH
            // override would keep a bare `sh` from ever starting.
            "/bin/sh",
            "-c",
            [...record, command].join("; ")
          ],
          ping: ["exec", name, "true"]
        })
        return { ...session, files: linuxFileSystem(session, "container") }
      })
  }
}
