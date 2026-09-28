/**
 * Constructs the Microsandbox microVM provider.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Semaphore from "effect/Semaphore"
import { attemptIn } from "../internal/attempt.ts"
import { elapsed } from "../internal/deadline.ts"
import { environmentCommand } from "../internal/environmentCommand.ts"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { execHandles } from "../internal/execHandles.ts"
import { finalizeWithin } from "../internal/finalizeWithin.ts"
import { parentOf } from "../internal/guestPath.ts"
import { linuxFileSystem } from "../internal/linuxFileSystem.ts"
import { type GuestCommand, runGuest, signalGuest, spawnGuest } from "../internal/microsandboxProcess.ts"
import { removeMachine } from "../internal/microsandboxRemove.ts"
import { rootedAt } from "../internal/rootedPath.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import { warnTeardown } from "../internal/teardownWarning.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import type { ProviderErrorCode } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { type NetworkPolicy as GuestNetworkPolicy, validateNetworkPolicy } from "../Sandbox/NetworkPolicy.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"
import { holderLabel, ownerLabel, providerLabel, providerName } from "./labels.ts"
import type { NetworkPolicy, Sdk } from "./Sdk.ts"

const defaultImage = "oven/bun:1"
const defaultNixImage = "nixos/nix"
const defaultWorkdir = "/workspace"
const defaultShell = "/bin/sh"
const defaultNixExecutable = "nix"
const defaultOwner = "smithers"
const namePrefix = "smthrs-msb-"
/**
 * How long a machine's graceful stop and removal may take before a forced
 * removal is tried. Teardown is additionally observed under
 * `finalizeWithin`'s bound.
 */
const stopGraceMs = 3_000

/**
 * The Nix environment a microVM's commands run under: the workspace's
 * `S.Nix.Environment` flake, carried as text because this package reads no
 * host files. The provider plants the flake and its lock in the guest, warms
 * the closure once with `nix develop --command true`, and runs every
 * command as `nix develop <flake> --command <shell> -c <command>`, so the
 * session holds the declared toolchain rather than what the image shipped.
 *
 * The image must carry `nix`; with an environment and no `image`, the
 * provider boots `nixos/nix`. A sticky session keeps the realised closure in
 * the microVM's store across acquires, and a `snapshot` taken after the warm
 * boots with it already realised.
 *
 * @category models
 * @since 0.1.0
 */
export interface NixEnvironment {
  /** The `flake.nix` text. */
  readonly flake: string
  /** The `flake.lock` text; without it the guest resolves inputs at warm time. */
  readonly lock?: string | undefined
  /** The dev shell attribute; the default dev shell when absent. */
  readonly attr?: string | undefined
  /** The guest directory the flake is planted in. Default `<workdir>/.smithers/nix`. */
  readonly directory?: string | undefined
  /** The `nix` executable in the guest. Default `nix`. */
  readonly nix?: string | undefined
}

/** A declared environment with its guest directory and `nix` executable settled. */
interface PlantedEnvironment {
  readonly directory: string
  readonly executable: string
  readonly environment: NixEnvironment
}

/** The `nix develop` installable for a planted environment. */
const installable = (directory: string, environment: NixEnvironment): string =>
  environment.attr === undefined ? `path:${directory}` : `path:${directory}#${environment.attr}`

/**
 * How the provider reaches its SDK and shapes each session's microVM.
 *
 * @category models
 * @since 0.1.0
 */
export interface MicrosandboxSandboxOptions {
  /** The injected Microsandbox SDK module. */
  readonly sdk: Sdk
  /** Boot from this image. Default `oven/bun:1`. */
  readonly image?: string | undefined
  /** Boot from a snapshot instead of an image. The two options are exclusive. */
  readonly snapshot?: string | undefined
  /** The guest workspace and default command directory. Default `/workspace`. */
  readonly workdir?: string | undefined
  /** The guest shell used for command lines. Default `/bin/sh`. */
  readonly shell?: string | undefined
  /** Static environment delivered to every command. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /**
   * `ephemeral` stops the microVM on release. `sticky` deliberately leaves it
   * running so the next acquire of the same session key can reconnect.
   */
  readonly persistence?: "ephemeral" | "sticky" | undefined
  /** Initial virtual CPU count. */
  readonly cpus?: number | undefined
  /** Maximum hotpluggable virtual CPU count. */
  readonly maxCpus?: number | undefined
  /** Initial memory in MiB. */
  readonly memoryMib?: number | undefined
  /** Maximum hotpluggable memory in MiB. */
  readonly maxMemoryMib?: number | undefined
  /** Maximum microVM lifetime in seconds. */
  readonly maxDurationSecs?: number | undefined
  /** Idle reclamation window in seconds. */
  readonly idleTimeoutSecs?: number | undefined
  /** Guest security profile. */
  readonly security?: "default" | "restricted" | undefined
  /** Vendor image pull policy. */
  readonly pullPolicy?: string | undefined
  /**
   * Labels recorded on the microVM. The ownership keys `smithers.provider`,
   * `smithers.owner`, and `smithers.holder` are the provider's own and
   * override a caller value.
   */
  readonly labels?: Readonly<Record<string, string>> | undefined
  /** Named guest scripts planted at boot. */
  readonly scripts?: Readonly<Record<string, string>> | undefined
  /** Run detached from the host process. Sticky sessions default to detached. */
  readonly detached?: boolean | undefined
  /**
   * The guest network. `"none"` boots without networking; `{ allow }` denies
   * ingress and all egress but DNS to the host resolver and the listed hosts;
   * a `*.` entry also admits its apex. Default: the vendor's own policy. Exclusive with `networkPolicy`.
   */
  readonly network?: GuestNetworkPolicy | undefined
  /**
   * The guest network policy in the vendor's own rule shape, for rules the
   * neutral `network` cannot say. Exclusive with `network`.
   */
  readonly networkPolicy?: NetworkPolicy | undefined
  /**
   * The root disk size in MiB for a machine booted from an image. A machine
   * booted from a snapshot keeps the disk the snapshot captured. Default: the
   * vendor's.
   */
  readonly rootDiskMib?: number | undefined
  /** The Nix environment every command runs under; see {@link NixEnvironment}. */
  readonly environment?: NixEnvironment | undefined
  /**
   * Where machines may run. `local`, the default, refuses to acquire unless
   * the SDK's default backend is local and the machine it opened reports the
   * local backend, so an ambient `MSB_BACKEND`, `MSB_API_KEY`, or
   * `MSB_PROFILE` cannot move guest work off this machine. `any` accepts
   * whatever backend the SDK selected, including the hosted one.
   */
  readonly backend?: "local" | "any" | undefined
  /**
   * The host installation these machines belong to, recorded as the
   * `smithers.owner` label. `reap` sweeps one owner's machines and no other's,
   * so give every installation sharing a Microsandbox home its own. Default
   * `smithers`.
   */
  readonly owner?: string | undefined
  /**
   * The live process holding these machines, recorded as the
   * `smithers.holder` label; `reap` asks whether it is still alive. A
   * reattached machine is relabelled to the current holder. Default: a random
   * token minted per `make` call, which no `isAlive` can vouch for, so a
   * composition that reaps names its own holder.
   */
  readonly holder?: string | undefined
}

type Builder = ReturnType<Sdk["Sandbox"]["builder"]>
type VendorSandbox = Awaited<ReturnType<Builder["create"]>>

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

const failure = (code: ProviderErrorCode, message: string, cause: unknown): ProviderError =>
  new ProviderError({ code, message: `microsandbox: ${message}`, cause })

const attempt = attemptIn("microsandbox")

/** Vendor error codes a fresh attempt may clear. */
const transientCodes = new Set(["runtime", "io", "protocol", "sandboxNotRunning", "execTimeout"])

/** What the vendor says when a machine's guest agent is not reachable, yet or any more. */
const transientText =
  /agent ?client|connection (?:refused|reset|closed)|broken pipe|timed out|did not respond|not responding|os error (?:32|54|60|61)\b/i

/**
 * Whether a vendor failure is one a fresh attempt may clear: the guest agent
 * was not reachable yet or any more, a connection timed out or broke, or the
 * machine was not running. A refused configuration, a missing image, or a
 * guest file error is not.
 */
const isTransient = (cause: unknown): boolean =>
  transientCodes.has(String(Reflect.get(Object(cause), "code"))) || transientText.test(messageOf(cause))

/** The pauses before the second and the third attempt at a transient failure. */
const retryDelaysMs: ReadonlyArray<number> = [500, 2_000]

/**
 * Runs an idempotent machine operation again after a transient vendor
 * failure, at most {@link retryDelaysMs}' length more times.
 */
const retrying = <A>(effect: Effect.Effect<A, ProviderError>): Effect.Effect<A, ProviderError> => {
  const from = (tried: number): Effect.Effect<A, ProviderError> =>
    Effect.catch(effect, (error) =>
      tried < retryDelaysMs.length && isTransient(error.cause)
        ? Effect.andThen(elapsed(retryDelaysMs[tried]!), from(tried + 1))
        : Effect.fail(error))
  return from(0)
}

/**
 * The label recording a machine's requested network, so a reattach under a
 * network option can refuse a machine created with another.
 */
const networkLabel = "smithers.network"

/** The builder network a machine boots with: none, a vendor policy, or the vendor's default. */
type GuestNetwork = "none" | NetworkPolicy | undefined

const guestNetwork = (options: MicrosandboxSandboxOptions): GuestNetwork => {
  if (options.network === undefined) return options.networkPolicy
  if (options.networkPolicy !== undefined) {
    throw new TypeError("microsandbox: network and networkPolicy are exclusive; name one")
  }
  const network = validateNetworkPolicy("microsandbox", options.network)
  if (network === "none") return "none"
  const egress = (destination: NetworkPolicy["rules"][number]["destination"]) => ({
    direction: "egress" as const,
    destination,
    protocols: [],
    ports: [],
    action: "allow" as const
  })
  return {
    defaultEgress: "deny",
    defaultIngress: "deny",
    rules: [
      // Resolving an allowed name needs DNS, and only the host resolver
      // answers it: the vendor's own `Rule.allowDns()` shape. DNS to any other
      // resolver stays denied, so it cannot carry data out.
      { ...egress({ kind: "group", group: "host" }), protocols: ["udp", "tcp"], ports: [{ start: 53, end: 53 }] },
      ...network.allow.map((host) =>
        egress(
          host.startsWith("*.")
            ? { kind: "domainSuffix", suffix: host.slice(2) }
            : { kind: "domain", domain: host }
        )
      )
    ]
  }
}

const configure = (
  builder: Builder,
  options: MicrosandboxSandboxOptions,
  network: GuestNetwork,
  sticky: boolean,
  ownership: Record<string, string>
): Builder => {
  let configured = options.snapshot === undefined
    ? builder.image(options.image ?? (options.environment === undefined ? defaultImage : defaultNixImage))
    : builder.fromSnapshot(options.snapshot)
  if (options.snapshot === undefined && options.rootDiskMib !== undefined) {
    configured = configured.rootDisk(options.rootDiskMib)
  }
  if (options.cpus !== undefined) configured = configured.cpus(options.cpus)
  if (options.maxCpus !== undefined) configured = configured.maxCpus(options.maxCpus)
  if (options.memoryMib !== undefined) configured = configured.memory(options.memoryMib)
  if (options.maxMemoryMib !== undefined) configured = configured.maxMemory(options.maxMemoryMib)
  if (options.security !== undefined) configured = configured.security(options.security)
  if (options.pullPolicy !== undefined) configured = configured.pullPolicy(options.pullPolicy)
  configured = configured.labels({ ...options.labels, ...ownership })
  if (options.scripts !== undefined) configured = configured.scripts({ ...options.scripts })
  if (options.maxDurationSecs !== undefined) configured = configured.maxDuration(options.maxDurationSecs)
  if (options.idleTimeoutSecs !== undefined) configured = configured.idleTimeout(options.idleTimeoutSecs)
  if (network === "none") configured = configured.disableNetwork()
  else if (network !== undefined) configured = configured.network((builder) => builder.policy(network))
  return configured.ephemeral(!sticky).detached(options.detached ?? sticky)
}

const isAlreadyExists = (cause: unknown): boolean => Reflect.get(Object(cause), "code") === "sandboxAlreadyExists"

const openMachine = (
  options: MicrosandboxSandboxOptions,
  network: GuestNetwork,
  name: string,
  sticky: boolean,
  ownership: Record<string, string>
): Effect.Effect<{ readonly sandbox: VendorSandbox; readonly created: boolean }, ProviderError> =>
  retrying(attempt(
    async () => {
      try {
        return {
          sandbox: await configure(options.sdk.Sandbox.builder(name), options, network, sticky, ownership).create(),
          created: true
        }
      } catch (cause) {
        if (!isAlreadyExists(cause)) throw cause
        const handle = await options.sdk.Sandbox.get(name)
        // A reattached machine keeps the network it booted with.
        if (
          ownership[networkLabel] !== undefined &&
          Reflect.get(Object(Reflect.get(Object(JSON.parse(handle.configJson)), "labels")), networkLabel) !==
            ownership[networkLabel]
        ) {
          throw new Error(`${name} was created with another network; remove it or acquire another session`)
        }
        // The machine now belongs to this holder. Microsandbox cannot relabel
        // a running machine live, but a next-start modification is recorded
        // at once, and the recorded labels are what `reap` reads, so a sweep
        // does not take the dead creator's label as this holder's.
        const plan = await handle.modify({ labels: ownership, policy: "next_start" })
        if (!plan.applied) throw new Error(`the ownership labels of ${name} were not recorded`)
        const detached = options.detached ?? sticky
        return {
          sandbox: handle.status === "running"
            ? await handle.connect()
            : detached
            ? await handle.startDetached()
            : await handle.start(),
          created: false
        }
      }
    },
    "unavailable",
    `the microVM ${name} could not be opened`
  ))

/**
 * Brings back a sticky machine whose guest stopped answering, on its own
 * disk: a fresh connection when the guest answers it, otherwise a restart,
 * stopping first a machine still recorded as running. The workspace survives
 * because a sticky machine's disk outlives its guest.
 */
const revive = (
  options: MicrosandboxSandboxOptions,
  name: string,
  workdir: string,
  detached: boolean
): Effect.Effect<VendorSandbox, ProviderError> =>
  retrying(attempt(
    async () => {
      let handle = await options.sdk.Sandbox.get(name)
      if (handle.status === "running") {
        // Finished commands the guest still holds sessions for are given back
        // first; a guest that then answers a command needs no restart.
        execHandles.release()
        try {
          const connected = await handle.connect()
          await connected.fs().mkdir(workdir)
          const probe = await connected.execStreamWith("/bin/sh", (builder) => builder.args(["-c", "true"]))
          while ((await probe.recv()) !== null) {
            // Drained: the guest ran a command.
          }
          return connected
        } catch (cause) {
          if (!isTransient(cause)) throw cause
        }
        // The guest is gone but the machine is still recorded as running.
        await handle.stop().catch(() => undefined)
        handle = await handle.refresh()
      }
      const started = detached ? await handle.startDetached() : await handle.start()
      await started.fs().mkdir(workdir)
      return started
    },
    "unavailable",
    `the microVM ${name} stopped answering and could not be restarted`
  ))

const environment = (
  base: Readonly<Record<string, string>> | undefined,
  override: Readonly<Record<string, string | undefined>> | undefined
): Record<string, string> =>
  Object.fromEntries(
    Object.entries({ ...base, ...override }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )

/**
 * The program and arguments one command line runs as: the shell itself, or
 * `nix develop` of the planted environment around the shell.
 *
 * `-c`, not `-lc`: a login shell runs the image's profile scripts, and
 * anything those print lands ahead of the command's own output.
 */
const commandLine = (
  shell: string,
  command: string,
  nix: PlantedEnvironment | undefined
): { readonly program: string; readonly args: Array<string> } =>
  nix === undefined
    ? { program: shell, args: ["-c", command] }
    : {
      program: nix.executable,
      args: ["develop", installable(nix.directory, nix.environment), "--command", shell, "-c", command]
    }

/**
 * The SDK wraps every guest filesystem failure in one error kind, so absence
 * is recognized by the guest's own ENOENT text riding in the message.
 */
const isMissingFile = (cause: unknown): boolean =>
  Reflect.get(Object(cause), "code") === "sandboxFsOps" &&
  /no such file or directory/i.test(messageOf(cause))

/**
 * Refuses a hosted backend: the SDK's own default must be local.
 */
const requireLocalBackend = (sdk: Sdk): Effect.Effect<void, ProviderError> =>
  Effect.flatMap(
    Effect.try({
      try: () => sdk.defaultBackendKind(),
      catch: (cause) => failure("unavailable", "the SDK could not name its default backend", cause)
    }),
    (kind) =>
      kind === "local" ? Effect.void : Effect.fail(
        new ProviderError({
          code: "unavailable",
          message: `microsandbox: the SDK's default backend is ${kind}, and this provider runs local microVMs; ` +
            `pin it with setDefaultBackend("local") or accept it with backend: "any"`
        })
      )
  )

/**
 * Builds a sandbox provider backed by local Microsandbox microVMs.
 *
 * Machine creation is registered as a scoped resource before guest setup, so
 * a microVM that boots but cannot prepare its workspace is removed. Commands
 * apply the workdir per execution because Microsandbox validates a builder
 * workdir before the selected image has booted; a relative `cwd` is rooted at
 * the session workdir and standard input rides the exec builder's own byte
 * channel. File transfer in both directions uses the SDK's byte-typed
 * operations. The session's `files` serve real `stat`, exclusive creation,
 * modes, and ownership through guest commands, so the image needs GNU or
 * BusyBox `stat`, `mktemp`, and `ln -T`.
 *
 * `spawn` returns once the guest command has started and streams its output
 * as the guest writes it; `exitCode` settles on the exit. `kill` signals the
 * command and every process it started, and closing a spawn's scope before
 * the exit was observed — an interrupted caller — does the same with
 * `SIGTERM`, then `SIGKILL` after a two-second grace, all under a five-second
 * teardown bound. A machine that goes away mid-command fails that command's
 * `exitCode` and streams with `unavailable` at once rather than leaving them
 * pending.
 *
 * Every machine carries the ownership labels `smithers.provider`,
 * `smithers.owner`, and `smithers.holder`, which `reap` sweeps by. With the
 * default `backend: "local"`, acquisition refuses a hosted backend before
 * provisioning anything.
 *
 * Opening a machine is tried again, twice, after a transient vendor failure
 * (an unreachable guest agent, a connection that timed out or broke, a
 * machine not running). A sticky machine whose guest stops answering — its
 * process died, or it was stopped by its lifetime or idle bounds — is brought
 * back on its own disk: reconnected when the guest answers, otherwise stopped
 * and started again. Only operations that did nothing when they failed are
 * run again after that: preparing the workspace, a command's start, and file
 * reads and writes, never a started command's stream. Unflushed guest writes
 * do not survive a guest that died.
 *
 * Ephemeral persistence is the default and removes the machine when the scope
 * closes, crashed or not: a graceful stop bounded at three seconds, then a
 * forced removal when that fails. Sticky persistence leaves a
 * successfully prepared machine running and reconnects to its deterministic
 * name on the next acquire. With an `environment`, the flake is planted and
 * warmed before the session is returned and every command runs under
 * `nix develop` of it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MicrosandboxSandboxOptions): Provider => {
  const network = guestNetwork(options)
  const ownership: Record<string, string> = {
    [providerLabel]: providerName,
    [ownerLabel]: options.owner ?? defaultOwner,
    [holderLabel]: options.holder ?? globalThis.crypto.randomUUID(),
    ...network === undefined ? {} : { [networkLabel]: network === "none" ? "none" : JSON.stringify(network) }
  }
  const local = options.backend !== "any"
  return {
    acquire: (sessionKey) =>
      Effect.gen(function*() {
        const name = `${namePrefix}${sessionSlug(sessionKey)}`
        const sticky = options.persistence === "sticky"
        const workdir = options.workdir ?? defaultWorkdir
        const shell = options.shell ?? defaultShell
        if (options.image !== undefined && options.snapshot !== undefined) {
          return yield* Effect.fail(
            new ProviderError({
              code: "unavailable",
              message: "microsandbox: image and snapshot are exclusive; name one"
            })
          )
        }
        if (local) yield* requireLocalBackend(options.sdk)

        let prepared = false
        const opened = yield* Effect.acquireRelease(
          openMachine(options, network, name, sticky, ownership),
          ({ created, sandbox }) =>
            !sticky || created && !prepared
              ? finalizeWithin(
                Effect.ignore(
                  attempt(
                    () => removeMachine(sandbox, stopGraceMs),
                    "unavailable",
                    `the microVM ${name} could not be removed`
                  ).pipe(Effect.tapError((error) => warnTeardown("microsandbox", "destroy", error)))
                ),
                `microsandbox machine ${name}`
              )
              : Effect.void
        )
        // The default backend is read before provisioning, but it is process
        // state another caller can change in between; the opened machine
        // reports the backend it actually runs on.
        if (local && opened.sandbox.backendKind !== "local") {
          return yield* Effect.fail(
            new ProviderError({
              code: "unavailable",
              message: `microsandbox: the microVM ${name} runs on the ${opened.sandbox.backendKind} backend, ` +
                `and this provider runs local microVMs`
            })
          )
        }

        const detached = options.detached ?? sticky
        // The machine commands reach: replaced when a sticky machine's guest
        // stops answering and is brought back.
        let live = opened.sandbox
        const reviving = yield* Semaphore.make(1)
        /** Brings the machine back once for every caller that saw `seen` stop answering. */
        const revived = (seen: VendorSandbox) =>
          reviving.withPermit(Effect.suspend(() =>
            live !== seen ? Effect.void : Effect.map(revive(options, name, workdir, detached), (sandbox) => {
              live = sandbox
            })
          ))
        /**
         * Runs `operation` on the live machine; on a sticky machine, a transient
         * failure brings the machine back and runs it once more. Only
         * operations that did nothing when they failed go through here: a
         * command's start, never its stream.
         */
        const resilient = <A, E extends ProviderError, R>(
          operation: (sandbox: VendorSandbox) => Effect.Effect<A, E, R>
        ): Effect.Effect<A, E | ProviderError, R> =>
          Effect.suspend(() => {
            const seen = live
            return Effect.catch(operation(seen), (error) =>
              sticky && isTransient(error.cause)
                ? Effect.andThen(
                  revived(seen),
                  Effect.suspend(() =>
                    operation(live)
                  )
                )
                : Effect.fail(error))
          })

        yield* resilient((sandbox) =>
          attempt(
            () => sandbox.fs().mkdir(workdir),
            "unavailable",
            `the workspace ${workdir} could not be prepared in ${name}`
          )
        )

        // The Nix environment is planted and warmed before the session is
        // handed out, so the first command never pays for realising the
        // closure and a flake that does not evaluate fails the acquire, not a
        // later spawn. The warm failure carries the guest's own words.
        const nix: PlantedEnvironment | undefined = options.environment === undefined
          ? undefined
          : {
            directory: options.environment.directory ?? `${workdir}/.smithers/nix`,
            executable: options.environment.nix ?? defaultNixExecutable,
            environment: options.environment
          }
        if (nix !== undefined) {
          const files: Array<readonly [string, string]> = [[`${nix.directory}/flake.nix`, nix.environment.flake]]
          if (nix.environment.lock !== undefined) files.push([`${nix.directory}/flake.lock`, nix.environment.lock])
          yield* attempt(
            async () => {
              await live.fs().mkdir(nix.directory)
              for (const [path, text] of files) await live.fs().write(path, text)
            },
            "unavailable",
            `the Nix environment could not be planted at ${nix.directory} in ${name}`
          )
          const warmed = yield* runGuest(
            live,
            {
              program: nix.executable,
              args: ["develop", installable(nix.directory, nix.environment), "--command", "true"],
              cwd: workdir,
              env: environment(options.env, undefined),
              stdin: undefined
            },
            `the Nix environment at ${nix.directory} could not be realised in ${name}`
          )
          if (warmed.code !== 0) {
            return yield* Effect.fail(
              new ProviderError({
                code: "unavailable",
                message: `microsandbox: the Nix environment at ${nix.directory} could not be realised in ${name} ` +
                  `(nix develop exited ${warmed.code}): ${warmed.stderr.trim()}`
              })
            )
          }
        }
        prepared = true

        const resolveCwd = rootedAt(workdir)
        const commands = new WeakMap<RemoteProcess, GuestCommand>()

        const session: Session = {
          id: sessionKey,
          remoteId: name,
          workdir,
          spawn: (command, spawnOptions) =>
            Effect.gen(function*() {
              yield* checkEnvironmentNames(spawnOptions.env)
              if (!shell.startsWith("/") && Object.values(spawnOptions.env ?? {}).includes(undefined)) {
                return yield* Effect.fail(
                  new ProviderError({
                    code: "spawn_error",
                    message: "microsandbox: environment deletion requires an absolute shell path"
                  })
                )
              }
              const guest = environmentCommand(command, { ...options.env, ...spawnOptions.env }, shell)
              const line = commandLine(shell, guest.command, nix)
              // A start that failed ran nothing, so it may be tried again.
              const spawned = yield* resilient((sandbox) =>
                spawnGuest(
                  sandbox,
                  {
                    program: line.program,
                    args: line.args,
                    cwd: resolveCwd(spawnOptions.cwd ?? ""),
                    env: guest.env,
                    stdin: spawnOptions.stdin
                  },
                  { machine: name, command }
                )
              )
              commands.set(spawned.process, spawned.command)
              return spawned.process
            }),
          kill: (process, signal) =>
            Effect.suspend(() => {
              const command = commands.get(process)
              /* v8 ignore next 3 -- `spawn` records every process it returns and a `RemoteProcess` has no other source, so the guard only discharges the optional a map read carries */
              if (command === undefined) {
                return Effect.fail(new ProviderError({ code: "unknown", message: "unrecognized process" }))
              }
              return signalGuest(command, signal, name)
            }),
          readFile: (path) =>
            resilient((sandbox) =>
              Effect.tryPromise({
                try: () => sandbox.fs().read(path),
                catch: (cause) =>
                  isMissingFile(cause)
                    ? new ProviderError({
                      code: "not_found",
                      message: `the microVM holds nothing at ${path}`,
                      cause
                    })
                    : failure("unknown", `the microVM could not read ${path}`, cause)
              })
            ),
          writeFile: (path, content) =>
            Effect.gen(function*() {
              const parent = parentOf(path)
              if (parent !== undefined) {
                yield* resilient((sandbox) =>
                  attempt(
                    () => sandbox.fs().mkdir(parent),
                    "unknown",
                    `the parent of ${path} could not be created in ${name}`
                  )
                )
              }
              yield* resilient((sandbox) =>
                attempt(
                  () => sandbox.fs().write(path, content),
                  "unknown",
                  `the microVM could not write ${path}`
                )
              )
            }),
          ping: Effect.asVoid(
            attempt(
              () => live.fs().readToString("/etc/hostname"),
              "unavailable",
              `the microVM ${name} did not answer`
            )
          )
        }
        return { ...session, files: linuxFileSystem(session, "microVM") }
      })
  }
}
