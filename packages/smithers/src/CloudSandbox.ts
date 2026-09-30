/**
 * Scoped Smithers Cloud workspaces for any sandbox-backed flow.
 *
 * @since 1.0.0
 */

import { CommandSandbox, RemoteChildProcessSpawner, type Sandbox } from "@smthrs/sandbox"
import { Duration, Effect } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { createHash } from "node:crypto"
import { Client, object } from "./internal/backend/Client.ts"
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
 * One repository and machine shape, shared by independently named sessions.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** Local host spawner, used to run the SSH client. */
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
  /** Optional workspace transport for alternate hosts and lifecycle tests. */
  readonly api?: WorkspaceApi | undefined
}

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
  const environment = options.environment ?? process.env
  const client = new Client({ environment })
  const api: WorkspaceApi = options.api ?? {
    request: (method, path, body, signal) => client.request(method, path, body, { signal }),
    sshPrefix: (reference, signal) => workspaceSshPrefix(environment, reference, signal)
  }
  const base = `/api/repos/${options.repository.split("/").map(encodeURIComponent).join("/")}/workspaces`
  const request = (method: "POST" | "GET" | "DELETE", path: string, body: unknown, message: string) =>
    Effect.tryPromise({
      try: (signal) => api.request(method, path, body, AbortSignal.any([signal, AbortSignal.timeout(30_000)])),
      catch: () => failure(message)
    })
  return {
    acquire: (session) =>
      Effect.gen(function*() {
        if (!session.trim()) return yield* Effect.fail(failure("session must not be empty", "spawn_error"))
        const name = prefix + createHash("sha256").update(session).digest("hex")
        // Mask interruption until the returned id has a registered finalizer.
        // Aborting a creation after admission would lose the id and leak a VM.
        const id = yield* Effect.acquireRelease(
          request("POST", base, {
            name,
            ...(options.sourceBookmark === undefined ? {} : { source_bookmark: options.sourceBookmark })
          }, "could not create workspace").pipe(Effect.flatMap((response) => {
            const id = object(response).id
            return typeof id === "string" && /^[\w-]+$/.test(id)
              ? Effect.succeed(id)
              : Effect.fail(failure("workspace creation response omitted a valid id"))
          })),
          (id) =>
            request("DELETE", `${base}/${encodeURIComponent(id)}`, undefined, "could not delete workspace").pipe(
              Effect.orDie,
              Effect.asVoid
            )
        )
        yield* Effect.gen(function*() {
          for (;;) {
            const workspace = object(
              yield* request("GET", `${base}/${encodeURIComponent(id)}`, undefined, "could not read workspace status")
            )
            if (workspace.id !== id) return yield* Effect.fail(failure("workspace status response has a different id"))
            if (workspace.status === "running") return
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
          orElse: () => Effect.fail(failure("workspace did not become running", "timeout"))
        }))
        const provider = CommandSandbox.make({
          spawner: options.spawner,
          workdir,
          name: id,
          prefix: Effect.tryPromise({
            try: (signal) => api.sshPrefix(`${options.repository}/${id}`, signal),
            catch: () => failure("could not obtain workspace SSH access")
          }).pipe(Effect.map((prefix) => [...prefix, "env", "HOME=/home/developer"]))
        })
        return yield* provider.acquire(session)
      })
  }
}
