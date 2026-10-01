/**
 * Scoped Smithers Cloud workspaces for any sandbox-backed flow.
 *
 * @since 1.0.0
 */

import { CommandSandbox, RemoteChildProcessSpawner, type Sandbox } from "@smthrs/sandbox"
import { Duration, Effect, Schedule } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { createHash } from "node:crypto"
import { APIError, Client, object } from "./internal/backend/Client.ts"
import { workspaceSshPrefix } from "./internal/backend/WorkspaceSsh.ts"

/**
 * Workspace control transport. Supply a fake for deterministic lifecycle tests;
 * ordinary hosts use the CLI's authenticated API client and pinned SSH prefix.
 * Implementations must honor the supplied abort signal, including time bounds.
 *
 * @category models
 * @since 1.0.0
 */
export interface WorkspaceApi {
  request(method: "POST" | "GET" | "DELETE", path: string, body: unknown, signal: AbortSignal): Promise<unknown>
  sshPrefix(reference: string, signal: AbortSignal): Promise<ReadonlyArray<string>>
}

/**
 * The ordinary workspace transport: the CLI's authenticated control client and
 * pinned SSH prefix, resolved from `environment`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const workspaceApi = (environment: Readonly<Record<string, string | undefined>>): WorkspaceApi => {
  const client = new Client({ environment })
  return {
    request: (method, path, body, signal) => client.request(method, path, body, { signal }),
    sshPrefix: (reference, signal) => workspaceSshPrefix(environment, reference, signal)
  }
}

/**
 * One repository and machine shape, shared by independently named sessions.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** Local host spawner, used to run the SSH client. */
  readonly persistence?: "ephemeral" | "sticky" | undefined
  /** Retained workspace lease, renewed on every attach/probe. Default 900 seconds. */
  readonly clientLeaseSeconds?: number | undefined
  readonly spawner: ChildProcessSpawner["Service"]
  /** Cloud repository, OWNER/REPO. */
  readonly repository: string
  /** The CLI's origin and login settings; defaults to process.env. */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  /** Repository bookmark to check out; defaults to the repository default. */
  readonly sourceBookmark?: string | undefined
  /** Absolute guest checkout path; defaults to /home/developer/workspace. */
  readonly workdir?: string | undefined
  /** Prefix for the SHA-256 session name; defaults to smthrs-. */
  readonly namePrefix?: string | undefined
  /** Provisioning status cadence; defaults to 3 seconds. */
  readonly pollInterval?: Duration.Input | undefined
  /** Maximum wait for running; defaults to 10 minutes. */
  readonly readyTimeout?: Duration.Input | undefined
  /** Requested machine size: vCPUs, memory in MiB, writable disk in GiB. */
  readonly resources?: { readonly vcpu?: number; readonly memory_mib?: number; readonly disk_gib?: number } | undefined
  /** Optional workspace transport for alternate hosts and lifecycle tests. */
  readonly api?: WorkspaceApi | undefined
}

// The deployed workspace image bakes root's per-user locations into every
// session (plue#742, fixed in the image but not yet released), so uid
// developer cannot read its jj config or write npm and bun caches. Pin each
// of those names to the workspace user; a command's own env overrides them.
const guestHome = [
  "HOME=/home/developer",
  "XDG_CONFIG_HOME=/home/developer/.config",
  "XDG_CACHE_HOME=/home/developer/.cache",
  "XDG_DATA_HOME=/home/developer/.local/share",
  "XDG_STATE_HOME=/home/developer/.local/state",
  "NPM_CONFIG_CACHE=/home/developer/.cache/npm",
  "BUN_INSTALL=/home/developer/.bun",
  "BUN_INSTALL_CACHE_DIR=/home/developer/.cache/bun"
]

const failure = (message: string, code: RemoteChildProcessSpawner.ProviderErrorCode = "unavailable") =>
  new RemoteChildProcessSpawner.ProviderError({ code, message: `cloud-sandbox: ${message}` })

/**
 * Creates or resumes a Cloud workspace by its stable session name, waits until
 * running, and projects CommandSandbox over freshly acquired SSH grants.
 * Closing the acquiring scope deletes the workspace, including when readiness
 * or SSH setup fails or the caller is interrupted. Concurrent holders must use
 * distinct session keys; reusing a key is an exclusive resume claim.
 *
 * Credentials are resolved locally by the existing CLI transport, never placed
 * in workspace creation metadata or provider failures. Agent credentials are
 * supplied separately by the caller to each command.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options): Sandbox.Provider => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository)) throw new TypeError("cloud-sandbox: expected OWNER/REPO")
  const workdir = options.workdir ?? "/home/developer/workspace"
  if (!workdir.startsWith("/") || workdir.includes("\0")) {
    throw new TypeError("cloud-sandbox: workdir must be an absolute guest path")
  }
  const prefix = options.namePrefix ?? "smthrs-"
  if (!/^[\w-]{0,64}$/.test(prefix)) throw new TypeError("cloud-sandbox: namePrefix must be at most 64 safe characters")
  const poll = Duration.fromInputUnsafe(options.pollInterval ?? "3 seconds")
  const timeout = Duration.fromInputUnsafe(options.readyTimeout ?? "10 minutes")
  if (
    !Number.isFinite(Duration.toMillis(poll)) || Duration.toMillis(poll) <= 0 ||
    !Number.isFinite(Duration.toMillis(timeout)) || Duration.toMillis(timeout) <= 0
  ) {
    throw new TypeError("cloud-sandbox: polling and readiness durations must be finite and positive")
  }
  const resources = options.resources === undefined ? undefined : {
    ...(options.resources.vcpu === undefined ? {} : { vcpu: options.resources.vcpu }),
    ...(options.resources.memory_mib === undefined ? {} : { memory_mib: options.resources.memory_mib }),
    ...(options.resources.disk_gib === undefined ? {} : { disk_gib: options.resources.disk_gib })
  }
  for (const [field, value] of Object.entries(resources ?? {})) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`cloud-sandbox: resources.${field} must be a positive integer`)
    }
  }
  const resourceKey = resources && Object.keys(resources).length ? JSON.stringify(resources) : ""
  const api = options.api ?? workspaceApi(options.environment ?? process.env)
  const base = `/api/repos/${options.repository.split("/").map(encodeURIComponent).join("/")}/workspaces`
  const request = (method: "POST" | "GET" | "DELETE", path: string, body: unknown, message: string) =>
    Effect.tryPromise({
      try: (signal) => api.request(method, path, body, AbortSignal.any([signal, AbortSignal.timeout(30_000)])),
      catch: (error) =>
        error instanceof APIError && error.detail.code === "workspace_resources_exceeded"
          ? failure(`${message}: workspace_resources_exceeded`, "spawn_error")
          : failure(message, error instanceof APIError && error.status === 404 ? "not_found" : "unavailable")
    })
  const sticky = options.persistence === "sticky"
  const lease = options.clientLeaseSeconds ?? 900
  if (!Number.isInteger(lease) || lease < 60 || lease > 86400) {
    throw new TypeError("cloud-sandbox: clientLeaseSeconds must be between 60 and 86400")
  }
  const remove = (id: string) =>
    Effect.tryPromise({
      try: (signal) =>
        api.request(
          "DELETE",
          `${base}/${encodeURIComponent(id)}`,
          undefined,
          AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        ),
      catch: (cause) => cause
    }).pipe(
      Effect.catch((cause) =>
        cause instanceof APIError && cause.status === 404
          ? Effect.void
          : Effect.fail(failure("could not delete workspace"))
      ),
      Effect.asVoid
    )
  const acquire = (session: string, existing?: string) =>
    Effect.gen(function*() {
      if (!session.trim()) return yield* Effect.fail(failure("session must not be empty", "spawn_error"))
      const name = prefix +
        createHash("sha256").update(resourceKey ? JSON.stringify([session, resourceKey]) : session).digest("hex")
      // Mask interruption until the returned id has a registered finalizer.
      // Aborting a creation after admission would lose the id and leak a VM.
      const create = request("POST", base, {
        name,
        ...sticky ? { client_lease_seconds: lease } : {},
        ...(resourceKey ? { resources } : {}),
        ...(options.sourceBookmark === undefined ? {} : { source_bookmark: options.sourceBookmark })
      }, "could not create workspace").pipe(Effect.flatMap((response) => {
        const id = object(response).id
        return typeof id === "string" && /^[\w-]+$/.test(id)
          ? Effect.succeed(id)
          : Effect.fail(failure("workspace creation response omitted a valid id"))
      }))
      const id = existing !== undefined
        ? existing
        : yield* Effect.acquireRelease(create, (id) => sticky ? Effect.void : remove(id).pipe(Effect.orDie))
      if (sticky) {
        yield* request("POST", `${base}/${encodeURIComponent(id)}/lease`, undefined, "could not renew workspace lease")
      }
      let lastReadFailure: string | undefined
      // A failed read does not prove provisioning failed. Retry transient
      // control-plane failures within the existing readiness deadline.
      const readStatus = Effect.suspend(() => {
        const deadline = AbortSignal.timeout(30_000)
        return Effect.tryPromise({
          try: (signal) =>
            api.request("GET", `${base}/${encodeURIComponent(id)}`, undefined, AbortSignal.any([signal, deadline])),
          catch: (error) => {
            const status = error instanceof APIError ? error.status : undefined
            const code = object(error).code
            const timedOut = deadline.aborted || error instanceof Error && error.name === "TimeoutError"
            const transient = timedOut || status === 408 || status === 429 ||
              status !== undefined && status >= 500 && status <= 599 ||
              code === "backend_unavailable" || code === "backend_timed_out"
            const category = timedOut ? "timeout" : status !== undefined ?
              `HTTP ${status}` :
              code === "backend_unavailable" || code === "backend_timed_out"
              ? String(code)
              : undefined
            lastReadFailure = `could not read workspace status${category ? ` (${category})` : ""}`
            return {
              transient,
              error: failure(lastReadFailure, status === 404 ? "not_found" : timedOut ? "timeout" : "unavailable")
            }
          }
        })
      }).pipe(
        Effect.retry({
          while: (error) => error.transient,
          schedule: Schedule.spaced(poll)
        }),
        Effect.mapError((error) => error.error)
      )
      yield* Effect.gen(function*() {
        for (;;) {
          const workspace = object(yield* readStatus)
          lastReadFailure = undefined
          if (workspace.id !== id) return yield* Effect.fail(failure("workspace status response has a different id"))
          if (workspace.status === "running") return
          if (existing !== undefined) {
            return yield* Effect.fail(
              failure(
                `workspace ${id} is ${workspace.status}`,
                ["failed", "error", "deleted", "stopped"].includes(String(workspace.status))
                  ? "not_found"
                  : "unavailable"
              )
            )
          }
          if (["failed", "error", "deleted"].includes(String(workspace.status))) {
            return yield* Effect.fail(failure(`workspace ${id} became ${workspace.status}`))
          }
          if (
            !["pending", "creating", "provisioning", "starting", "stopped", "suspended"].includes(
              String(workspace.status)
            )
          ) {
            return yield* Effect.fail(failure("workspace status response omitted a valid status"))
          }
          yield* Effect.sleep(poll)
        }
      }).pipe(Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(failure(
            `workspace did not become running${lastReadFailure ? `; ${lastReadFailure}` : ""}`,
            "timeout"
          ))
      }))
      const provider = CommandSandbox.make({
        spawner: options.spawner,
        workdir,
        name: id,
        prefix: Effect.tryPromise({
          try: (signal) => api.sshPrefix(`${options.repository}/${id}`, signal),
          catch: () => failure("could not obtain workspace SSH access")
        }).pipe(Effect.map((prefix) => [...prefix, "env", ...guestHome]))
      })
      return yield* provider.acquire(session)
    })
  return {
    acquire: (session) => acquire(session),
    ...sticky ?
      {
        retained: true as const,
        jobDirectory: "/home/developer/.local/state/smthrs-jobs",
        attach: (session: { readonly id: string; readonly remoteId: string }) => acquire(session.id, session.remoteId),
        destroy: (session: { readonly id: string; readonly remoteId: string }) => remove(session.remoteId)
      } :
      {}
  }
}
