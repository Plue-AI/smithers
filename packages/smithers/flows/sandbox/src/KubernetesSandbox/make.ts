/**
 * Constructs the Kubernetes Pod sandbox provider.
 *
 * @since 0.1.0
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { configurationFingerprint } from "../internal/configurationFingerprint.ts"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { execSession } from "../internal/execSession.ts"
import { finalizeWithin } from "../internal/finalizeWithin.ts"
import { gather, type GatheredRun, providerFailure } from "../internal/localProcess.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { type NetworkPolicy, refuseNetworkPolicy } from "../Sandbox/NetworkPolicy.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import { type ResourceLimits, validateResourceLimits } from "../Sandbox/ResourceLimits.ts"

interface ResourceValues {
  readonly cpu?: string | undefined
  readonly memory?: string | undefined
}

/**
 * The Pod's CPU and memory requests and limits, as Kubernetes names them.
 *
 * @category models
 * @since 0.1.0
 */
export interface KubernetesSandboxResources {
  readonly requests?: ResourceValues | undefined
  readonly limits?: ResourceValues | undefined
}

/**
 * How the provider reaches its cluster and shapes each session's Pod.
 *
 * @category models
 * @since 0.1.0
 */
export interface KubernetesSandboxOptions {
  /**
   * Refused: a Pod NetworkPolicy depends on the cluster's network plugin and matches no host names. Setting it makes `make` throw rather than hand out a
   * machine with a network it did not ask for.
   */
  readonly network?: NetworkPolicy | undefined
  readonly spawner: ChildProcessSpawner["Service"]
  readonly image: string
  readonly namespace?: string | undefined
  readonly program?: string | undefined
  readonly context?: string | undefined
  readonly kubeconfig?: string | undefined
  readonly workdir?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly labels?: Readonly<Record<string, string>> | undefined
  readonly resources?: KubernetesSandboxResources | undefined
  /**
   * The Pod's ceilings. `cpus` and `memoryMib` become the container's
   * `resources.limits.cpu` and `resources.limits.memory` (in `Mi`), each
   * exclusive with the same field in `resources`; `timeoutSecs` is the Pod's
   * `activeDeadlineSeconds`, after which Kubernetes fails it. The limits
   * enter the configuration fingerprint, so a leftover Pod with others is
   * refused rather than reattached. A `createArgs` `--overrides` or
   * `--override-type` beside any of them is refused when `make` is called,
   * because kubectl keeps only the last override.
   */
  readonly limits?: ResourceLimits | undefined
  readonly serviceAccount?: string | undefined
  readonly nodeSelector?: Readonly<Record<string, string>> | undefined
  readonly createArgs?: ReadonlyArray<string> | undefined
  readonly namePrefix?: string | undefined
  /**
   * An operator secret that lets a later process reattach a Pod this one
   * left behind. Each fresh Pod is labelled with an HMAC of its fingerprint
   * and its server-assigned `metadata.uid` under this key, and only a leftover
   * carrying a valid seal is adopted. Without it, and for any leftover whose
   * seal is missing or wrong, the leftover is deleted and a fresh Pod created.
   * Keep the same value across restarts that should resume a session.
   */
  readonly reattachKey?: string | undefined
}

const decoder = new TextDecoder()
const readyTimeout = "300s"
const maximumPodNameLength = 63
const fingerprintLabel = "smithers.dev/sandbox-fingerprint"
const sealLabel = "smithers.dev/sandbox-seal"
const inspectedPod = Schema.Struct({
  metadata: Schema.Struct({
    uid: Schema.optional(Schema.String),
    labels: Schema.Record(Schema.String, Schema.String)
  }),
  spec: Schema.Struct({
    hostNetwork: Schema.optional(Schema.Boolean),
    hostPID: Schema.optional(Schema.Boolean),
    hostIPC: Schema.optional(Schema.Boolean),
    serviceAccountName: Schema.optional(Schema.String),
    containers: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        image: Schema.String,
        securityContext: Schema.optional(Schema.Struct({ privileged: Schema.optional(Schema.Boolean) }))
      })
    ),
    volumes: Schema.optional(Schema.Array(Schema.Struct({ hostPath: Schema.optional(Schema.Unknown) })))
  }),
  status: Schema.Struct({ phase: Schema.String })
})

/**
 * The phases in which a Pod will never run another command. A leftover in one
 * of these is a corpse wearing the session's name, not a machine to reattach:
 * `kubectl wait --for=condition=Ready` would block on it for the full timeout
 * and `exec` would refuse it, so it is deleted and replaced instead.
 */
const terminalPhases = new Set(["Succeeded", "Failed"])

/**
 * The seal a Pod created by a holder of `key` carries: an HMAC-SHA256 of the
 * configuration fingerprint and the Pod's server-assigned uid, as a label
 * value (`s1-` and 60 hex digits). Binding the uid means a seal copied off a
 * deleted Pod does not validate a new Pod created under the same name.
 */
const sealOf = (key: string, fingerprint: string, uid: string) =>
  Effect.tryPromise({
    try: async () => {
      const subtle = globalThis.crypto.subtle
      const hmacKey = await subtle.importKey(
        "raw",
        new TextEncoder().encode(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      )
      const mac = await subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`${fingerprint}\0${uid}`))
      return "s1-" + Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 60)
    },
    catch: providerFailure("unavailable", "could not seal the sandbox pod")
  })

const podNameOf = (prefix: string, sessionKey: string): string => {
  const slug = sessionSlug(sessionKey).toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")
  const candidate = `${prefix.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}${slug}`
    .replaceAll(/^-+|-+$/g, "")
  if (candidate.length <= maximumPodNameLength) return candidate
  const digest = slug.slice(slug.lastIndexOf("-"))
  return `${candidate.slice(0, maximumPodNameLength - digest.length).replace(/-+$/, "")}${digest}`
}

const withLimits = (options: KubernetesSandboxOptions): KubernetesSandboxOptions => {
  if (options.limits === undefined) return options
  const limits = validateResourceLimits("kubernetes-sandbox", options.limits)
  if (limits.cpus !== undefined && options.resources?.limits?.cpu !== undefined) {
    throw new TypeError("kubernetes-sandbox: resources.limits.cpu and limits.cpus are exclusive; name one")
  }
  if (limits.memoryMib !== undefined && options.resources?.limits?.memory !== undefined) {
    throw new TypeError("kubernetes-sandbox: resources.limits.memory and limits.memoryMib are exclusive; name one")
  }
  if (limits.cpus === undefined && limits.memoryMib === undefined) return options
  return {
    ...options,
    resources: {
      ...options.resources,
      limits: {
        ...options.resources?.limits,
        ...limits.cpus === undefined ? {} : { cpu: String(limits.cpus) },
        ...limits.memoryMib === undefined ? {} : { memory: `${limits.memoryMib}Mi` }
      }
    }
  }
}

const overrideArgs = (name: string, options: KubernetesSandboxOptions): ReadonlyArray<string> => {
  const spec = {
    ...options.limits?.timeoutSecs === undefined ? {} : { activeDeadlineSeconds: options.limits.timeoutSecs },
    ...options.serviceAccount === undefined ? {} : { serviceAccountName: options.serviceAccount },
    ...options.nodeSelector === undefined ? {} : { nodeSelector: options.nodeSelector },
    ...options.resources === undefined
      ? {}
      : {
        containers: [{
          name,
          resources: {
            ...options.resources.requests === undefined ? {} : { requests: options.resources.requests },
            ...options.resources.limits === undefined ? {} : { limits: options.resources.limits }
          }
        }]
      }
  }
  return Object.keys(spec).length === 0
    ? []
    : ["--override-type", "strategic", "--overrides", JSON.stringify({ apiVersion: "v1", spec })]
}

/**
 * Builds a sandbox provider whose machines are Kubernetes Pods driven through
 * an injected `kubectl` spawner.
 *
 * The provider creates or reattaches a deterministically named Pod, waits for
 * it to become Ready, and registers forced deletion as the acquiring scope's
 * finalizer. On `AlreadyExists` the provider inspects the leftover. One whose
 * configuration or fingerprint differs is refused without being touched. One
 * that matches is adopted only when it is live and carries a valid
 * {@link KubernetesSandboxOptions.reattachKey} seal; otherwise it is deleted
 * and replaced. The fingerprint is a hash of configuration anyone who knows
 * the flow can compute, so a principal with `pods/create` but not
 * `pods/exec` could otherwise pre-create a Pod under the session's name,
 * label, and image with its own command, and receive the session's exec'd
 * commands, stdin, and environment. A terminal leftover (Succeeded or
 * Failed) is always replaced, because `kubectl wait` would block on it. Commands and file transfers use
 * `kubectl exec`, so no host filesystem or platform module is required. File
 * contents cross the text boundary as base64 — written through the exec's
 * stdin, read back with `base64 < path`, a redirect every guest `base64`
 * accepts — and remain byte exact.
 *
 * `spawn` honors the whole session contract. A command's `stdin` bytes travel
 * on the exec's own input channel (`--stdin`), a relative `cwd` is rooted at
 * {@link Session.workdir} before the script's `cd`, and the environment is
 * applied with `env(1)` rather than `export`, because `export` is a special
 * builtin and a name it refuses would abort the whole script instead of one
 * assignment. Names that are not shell identifiers never reach either form:
 * `spawn` refuses them, because the guest `sh -c` that runs the command
 * would drop them. Closing a spawn's scope is the process's lifetime ending:
 * unless the command was already observed to end, the guest process is
 * signalled through the same pid-walk `kill` uses, so a scope cannot close on
 * a still-running guest.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (input: KubernetesSandboxOptions): Provider => {
  refuseNetworkPolicy("kubernetes-sandbox", input.network)
  const options = withLimits(input)
  // kubectl keeps only the last `--overrides`, so a caller's would silently
  // replace the one carrying the Pod's resources and deadline.
  const overriding = (options.createArgs ?? []).find((arg) => /^--override(?:s|-type)(?:=|$)/.test(arg))
  if (overriding !== undefined && overrideArgs("", options).length > 0) {
    throw new TypeError(
      `kubernetes-sandbox: createArgs ${overriding.split("=")[0]} would replace the Pod override carrying ` +
        "limits, resources, serviceAccount, and nodeSelector; name those through the options"
    )
  }
  const program = options.program ?? "kubectl"
  const workdir = options.workdir ?? "/workspace"
  const prefix = options.namePrefix ?? "smthrs-sbx-"
  const globals = [
    ...options.context === undefined ? [] : ["--context", options.context],
    ...options.namespace === undefined ? [] : ["--namespace", options.namespace],
    ...options.kubeconfig === undefined ? [] : ["--kubeconfig", options.kubeconfig]
  ]
  const run = (args: ReadonlyArray<string>, stdin?: Uint8Array): Effect.Effect<GatheredRun, ProviderError> =>
    Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* options.spawner.spawn(
          ChildProcess.make(program, [...globals, ...args], stdin === undefined ? {} : { stdin: Stream.make(stdin) })
        ).pipe(
          Effect.mapError(providerFailure("spawn_error", `\`${program} ${args[0]}\` could not start`))
        )
        return yield* gather(handle, `${program} ${args[0]}`)
      })
    )
  const step = (what: string, args: ReadonlyArray<string>): Effect.Effect<GatheredRun, ProviderError> =>
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
        const environment = options.env ?? {}
        const name = podNameOf(prefix, sessionKey)
        const fingerprint = yield* configurationFingerprint({
          provider: "KubernetesSandbox/v1",
          owner: sessionKey,
          name,
          image: options.image,
          workdir,
          namespace: options.namespace,
          context: options.context,
          kubeconfig: options.kubeconfig,
          env: environment,
          labels: options.labels ?? {},
          resources: options.resources,
          serviceAccount: options.serviceAccount,
          nodeSelector: options.nodeSelector,
          createArgs: options.createArgs ?? [],
          ...options.limits?.timeoutSecs === undefined ? {} : { timeoutSecs: options.limits.timeoutSecs }
        })
        const labels = Object.entries({ ...options.labels, [fingerprintLabel]: fingerprint })
        const createArgs = [
          "run",
          name,
          "--image",
          options.image,
          "--restart",
          "Never",
          "--labels",
          labels.map(([key, value]) => `${key}=${value}`).join(","),
          ...overrideArgs(name, options),
          ...options.createArgs ?? [],
          "--command",
          "--",
          "sleep",
          "infinity"
        ]
        // Let kubectl render all run flags, then add environment values to
        // the manifest sent over stdin rather than its local argv.
        const create = Effect.gen(function*() {
          if (Object.keys(environment).length === 0) return yield* run(createArgs)
          yield* checkEnvironmentNames(environment)
          const commandIndex = createArgs.indexOf("--command")
          const rendered = yield* run([
            ...createArgs.slice(0, commandIndex),
            "--dry-run=client",
            "-o",
            "json",
            ...createArgs.slice(commandIndex)
          ])
          if (rendered.code !== 0) return rendered
          const manifest = yield* Effect.try({
            try: () => {
              const pod = JSON.parse(decoder.decode(rendered.stdout))
              const container = pod.spec.containers.find((entry: { name: string }) => entry.name === name)
              container.env = [
                ...(container.env ?? []).filter((entry: { name: string }) => !Object.hasOwn(environment, entry.name)),
                ...Object.entries(environment).map(([name, value]) => ({ name, value }))
              ]
              return new TextEncoder().encode(JSON.stringify(pod))
            },
            catch: providerFailure("spawn_error", "kubectl did not render a valid Pod manifest")
          })
          return yield* run(["create", "-f", "-"], manifest)
        })
        const origin = yield* Effect.acquireRelease(
          Effect.gen(function*() {
            const created = yield* create
            if (created.code === 0) return "fresh" as const
            if (!/(?:AlreadyExists|already exists)/i.test(created.stderr)) {
              return yield* Effect.fail(
                new ProviderError({
                  code: "unavailable",
                  message: `the pod ${name} could not be created from ${options.image}: ${created.stderr.trim()}`
                })
              )
            }
            // The name is held by a previous acquire's leftover. A live one
            // is reattached; one in a terminal phase is replaced, because the
            // Ready wait below would otherwise block on it until its timeout.
            // Validate ownership before adopting OR deleting a terminal Pod.
            const inspected = yield* step(`the pod ${name} could not be inspected`, ["get", "pod", name, "-o", "json"])
            const held = yield* Effect.try({
              try: () => Schema.decodeUnknownSync(inspectedPod)(JSON.parse(decoder.decode(inspected.stdout))),
              catch: providerFailure("unavailable", `the pod ${name} has no verifiable configuration`)
            })
            if (
              held.metadata.labels[fingerprintLabel] !== fingerprint ||
              !held.spec.containers.some((container) => container.name === name && container.image === options.image) ||
              (options.serviceAccount !== undefined && held.spec.serviceAccountName !== options.serviceAccount) ||
              ((options.createArgs?.length ?? 0) === 0 && (held.spec.hostNetwork === true ||
                held.spec.hostPID === true || held.spec.hostIPC === true ||
                held.spec.containers.some((container) => container.securityContext?.privileged === true) ||
                held.spec.volumes?.some((volume) => volume.hostPath !== undefined)))
            ) {
              return yield* Effect.fail(
                new ProviderError({
                  code: "unavailable",
                  message: `the pod ${name} does not match the requested configuration or owner`
                })
              )
            }
            const sealed = options.reattachKey !== undefined && held.metadata.uid !== undefined &&
              held.metadata.labels[sealLabel] === (yield* sealOf(options.reattachKey, fingerprint, held.metadata.uid))
            if (sealed && !terminalPhases.has(held.status.phase)) return "adopted" as const
            // An unsealed leftover is not trusted with the session: anyone who
            // may create Pods here can build one that matches every check
            // above. It is replaced, and a replacement that loses a race for
            // the name fails below instead of being adopted.
            yield* step(`the leftover pod ${name} could not be replaced`, [
              "delete",
              `pod/${name}`,
              "--force",
              "--grace-period=0"
            ])
            const recreated = yield* create
            if (recreated.code !== 0) {
              return yield* Effect.fail(
                new ProviderError({
                  code: "unavailable",
                  message: `the pod ${name} could not be recreated from ${options.image}: ${recreated.stderr.trim()}`
                })
              )
            }
            return "fresh" as const
          }),
          () =>
            finalizeWithin(
              Effect.flatMap(run(["delete", `pod/${name}`, "--force", "--grace-period=0"]), (result) =>
                result.code === 0 ? Effect.void : Effect.logWarning("sandbox removal failed", {
                  resource: `pod ${name}`,
                  exitCode: result.code
                })).pipe(Effect.catch(() =>
                  Effect.logWarning("sandbox removal failed", {
                    resource: `pod ${name}`
                  })
                )),
              `pod ${name}`
            )
        )
        // Seal a fresh Pod after the finalizer is registered, so a failed
        // seal still deletes it. A crash before the seal leaves an unsealed
        // Pod, which the next acquire replaces rather than adopts.
        if (origin === "fresh" && options.reattachKey !== undefined) {
          const uid = decoder.decode(
            (yield* step(`the pod ${name} could not be inspected`, [
              "get",
              "pod",
              name,
              "-o",
              "jsonpath={.metadata.uid}"
            ])).stdout
          ).trim()
          if (uid === "") {
            return yield* Effect.fail(
              new ProviderError({ code: "unavailable", message: `the pod ${name} reported no uid to seal` })
            )
          }
          yield* step(`the pod ${name} could not be sealed`, [
            "label",
            `pod/${name}`,
            "--overwrite",
            `${sealLabel}=${yield* sealOf(options.reattachKey, fingerprint, uid)}`
          ])
        }
        yield* step(`the pod ${name} did not become Ready`, [
          "wait",
          "--for=condition=Ready",
          `pod/${name}`,
          `--timeout=${readyTimeout}`
        ])
        return yield* execSession({
          id: sessionKey,
          name,
          noun: "pod",
          program,
          workdir,
          encode: "base64",
          run: (args) => run(args),
          launch: (args, stdin) =>
            options.spawner.spawn(
              ChildProcess.make(program, [...globals, ...args], stdin === undefined ? {} : { stdin })
            ),
          shell: (script, interactive) => ["exec", ...interactive ? ["-i"] : [], name, "--", "/bin/sh", "-c", script],
          spawn: ({ command, cwd, record, stdin }) => [
            "exec",
            // The exec has a real input channel; it is asked for only when
            // there is input to carry.
            ...stdin === undefined ? [] : ["--stdin"],
            name,
            "--",
            "/bin/sh",
            "-c",
            [`cd ${CommandLine.quote(cwd)}`, ...record, command].join(" && ")
          ],
          ping: ["exec", name, "--", "true"]
        })
      })
  }
}
