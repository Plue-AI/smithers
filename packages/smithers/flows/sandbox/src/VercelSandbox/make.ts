/**
 * Constructs the Vercel Sandbox provider.
 *
 * @since 0.1.0
 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { attemptIn } from "../internal/attempt.ts"
import { checked } from "../internal/checkedExit.ts"
import { concat } from "../internal/concat.ts"
import { environmentCommand } from "../internal/environmentCommand.ts"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { finalizeWithin } from "../internal/finalizeWithin.ts"
import { parentOf } from "../internal/guestPath.ts"
import { machineName } from "../internal/machineName.ts"
import { rootedAt } from "../internal/rootedPath.ts"
import { stdinRedirect } from "../internal/stdinRedirect.ts"
import { warnTeardown } from "../internal/teardownWarning.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { type NetworkPolicy, validateNetworkPolicy } from "../Sandbox/NetworkPolicy.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import { type ResourceLimits, validateResourceLimits } from "../Sandbox/ResourceLimits.ts"
import type { Session } from "../Sandbox/Session.ts"
import type { Credentials } from "./Credentials.ts"
import type { Sdk } from "./Sdk.ts"

/**
 * How the provider authenticates to Vercel and shapes each session's sandbox.
 *
 * @category models
 * @since 0.1.0
 */
export interface VercelSandboxOptions extends Credentials {
  readonly sdk: Sdk
  /** The environment credentials are discovered from. Never `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /** The lifetime each acquired session should reach, in milliseconds. */
  readonly timeoutMs?: number | undefined
  /** A caller-owned cap checked before any vendor request is sent. */
  readonly maxDurationMs?: number | undefined
  /** The guest workspace. Default `/vercel/sandbox`. */
  readonly workdir?: string | undefined
  /** The Vercel runtime used when a named sandbox must be created. */
  readonly runtime?: string | undefined
  /** Environment applied to every command before per-spawn overrides. */
  readonly commandEnv?: Readonly<Record<string, string>> | undefined
  /** Prefix for deterministic Vercel sandbox names. Default `smthrs-`. */
  readonly namePrefix?: string | undefined
  /**
   * The guest network, enforced by Vercel's egress firewall: `"none"` and
   * an empty list are `deny-all`, `{ allow }` its domain allowlist. Default: Vercel's own,
   * full internet access.
   */
  readonly network?: NetworkPolicy | undefined
  /**
   * The sandbox's ceilings. `cpus` is `resources.vcpus`, a whole count;
   * Vercel fixes memory at 2048 MiB per vCPU, so `memoryMib` must be that
   * product, and alone it sizes the vCPUs. `timeoutSecs` is the lifetime
   * `timeoutMs` otherwise sets, and is exclusive with it. A resumed sandbox
   * holding another vCPU count, or a session that would run past
   * `timeoutSecs` from this acquire, is refused rather than used, because
   * `getOrCreate` applies neither to a sandbox that exists and Vercel cannot
   * shorten a session.
   */
  readonly limits?: ResourceLimits | undefined
}

type VendorSandbox = Awaited<ReturnType<Sdk["Sandbox"]["getOrCreate"]>>

const createCeilingMillis = 5 * 60_000
const defaultWorkdir = "/vercel/sandbox"

const attempt = attemptIn("vercel-sandbox")

const output = (
  read: () => Promise<string>,
  description: string
): Stream.Stream<Uint8Array, ProviderError> =>
  Stream.fromEffect(
    Effect.map(attempt(read, "unknown", description), (text) => new TextEncoder().encode(text))
  )

const decodeFile = async (
  stream: NonNullable<Awaited<ReturnType<VendorSandbox["readFile"]>>>
): Promise<Uint8Array> => {
  const chunks: Array<Uint8Array> = []
  for await (const chunk of stream) {
    // An SDK stream may reuse pooled storage after each yield.
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk.slice())
  }
  return concat(chunks)
}

// Vercel documents `deny-all` as the mode that blocks DNS, so an empty
// allowlist says it outright.
const vendorPolicy = (policy: NetworkPolicy): "deny-all" | { allow: Array<string> } =>
  policy === "none" || policy.allow.length === 0 ? "deny-all" : { allow: [...policy.allow] }

const memoryPerVcpuMib = 2048

const vcpusOf = (limits: ResourceLimits): number | undefined => {
  const vcpus = limits.cpus ?? (limits.memoryMib === undefined ? undefined : limits.memoryMib / memoryPerVcpuMib)
  if (vcpus === undefined) return undefined
  if (!Number.isInteger(vcpus)) {
    throw new TypeError(
      `vercel-sandbox: cannot enforce limits.${limits.cpus === undefined ? "memoryMib" : "cpus"}; ` +
        `Vercel allocates whole vCPUs at ${memoryPerVcpuMib} MiB each`
    )
  }
  if (limits.memoryMib !== undefined && limits.memoryMib !== vcpus * memoryPerVcpuMib) {
    throw new TypeError(
      `vercel-sandbox: cannot enforce limits.memoryMib ${limits.memoryMib}; ` +
        `Vercel fixes ${vcpus} vCPU at ${vcpus * memoryPerVcpuMib} MiB`
    )
  }
  return vcpus
}

const resolveCredentials = (
  input: Credentials,
  env: Readonly<Record<string, string | undefined>>
): { readonly token?: string; readonly teamId?: string; readonly projectId?: string } => {
  const oidcToken = input.oidcToken ?? env["VERCEL_OIDC_TOKEN"]
  if (oidcToken !== undefined && oidcToken !== "") return { token: oidcToken }
  const token = input.token ?? env["VERCEL_TOKEN"]
  const teamId = input.teamId ?? env["VERCEL_TEAM_ID"]
  const projectId = input.projectId ?? env["VERCEL_PROJECT_ID"]
  if (
    token !== undefined && token !== "" && teamId !== undefined && teamId !== "" &&
    projectId !== undefined && projectId !== ""
  ) {
    return { token, teamId, projectId }
  }
  return {}
}

/**
 * Builds a provider backed by named, persistent Vercel sandboxes.
 *
 * A session key becomes a sandbox name carrying a 64-bit digest of the key, and
 * `Sandbox.getOrCreate` resumes that machine when it already exists. Closing
 * the acquisition scope stops the current session; a stop that fails is
 * logged at Warn rather than swallowed, because teardown runs for its side
 * effect and its failure is the only trace an operator gets. Vercel persists
 * the named sandbox by default, so a later acquire restores its filesystem.
 *
 * Commands run through `sh -c`, never `sh -lc`: a login shell sources
 * profile scripts, and anything those print lands ahead of the command's own
 * standard output, which callers parse as data. A relative `cwd` is rooted
 * at the session workdir per the session contract, and `options.stdin` is
 * delivered through a workspace file — the `@vercel/sandbox` 3.2.1
 * `RunCommandParams` carries no input channel (its `stdout`/`stderr` fields
 * are Writables for output), so the redirect in `internal/stdinRedirect` is
 * the only honest route.
 *
 * Command output is not byte-exact here. `runCommand` hands back stdout and
 * stderr as strings, so what this provider streams is those strings re-encoded
 * as UTF-8: a command whose output is not valid UTF-8, such as a tarball or a
 * compiled binary written to stdout, comes back changed. File transfer is
 * byte-exact regardless, so a caller that needs bytes has the command write a
 * file and reads it back with `readFile`.
 *
 * Vercel limits the timeout accepted by one create request to five minutes.
 * Longer requested lifetimes create at that ceiling, then call
 * `extendTimeout` with the gap between the session's reported deadline and
 * the requested one, because that API extends by its argument rather than
 * setting an absolute target and a resumed session runs on the sandbox's own
 * timeout rather than the one this acquire asked for.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: VercelSandboxOptions): Provider => {
  const networkPolicy = options.network === undefined
    ? undefined
    : vendorPolicy(validateNetworkPolicy("vercel-sandbox", options.network))
  const limits = options.limits === undefined ? {} : validateResourceLimits("vercel-sandbox", options.limits)
  if (limits.timeoutSecs !== undefined && options.timeoutMs !== undefined) {
    throw new TypeError("vercel-sandbox: timeoutMs and limits.timeoutSecs are exclusive; name one")
  }
  const vcpus = vcpusOf(limits)
  return {
    acquire: (sessionKey) =>
      Effect.gen(function*() {
        const desiredMs = options.timeoutMs ??
          (limits.timeoutSecs === undefined ? createCeilingMillis : limits.timeoutSecs * 1000)
        if (!Number.isFinite(desiredMs) || desiredMs <= 0) {
          return yield* Effect.fail(
            new ProviderError({
              code: "spawn_error",
              message: "vercel-sandbox: timeoutMs must be a positive number of milliseconds"
            })
          )
        }
        if (options.maxDurationMs !== undefined && desiredMs > options.maxDurationMs) {
          return yield* Effect.fail(
            new ProviderError({
              code: "spawn_error",
              message:
                `vercel-sandbox: requested duration ${desiredMs}ms exceeds maxDurationMs ${options.maxDurationMs}ms`
            })
          )
        }
        const workdir = options.workdir ?? defaultWorkdir
        if (!workdir.startsWith("/")) {
          return yield* Effect.fail(
            new ProviderError({ code: "spawn_error", message: `vercel-sandbox: workdir must be absolute: ${workdir}` })
          )
        }
        const createMs = Math.min(desiredMs, createCeilingMillis)
        const name = machineName(options.namePrefix ?? "smthrs-", sessionKey)
        const credentials = resolveCredentials(options, options.env ?? {})
        const sandbox = yield* Effect.acquireRelease(
          attempt(
            () =>
              options.sdk.Sandbox.getOrCreate({
                ...credentials,
                name,
                timeout: createMs,
                persistent: true,
                resume: true,
                ...options.runtime === undefined ? {} : { runtime: options.runtime },
                ...vcpus === undefined ? {} : { resources: { vcpus } },
                ...networkPolicy === undefined ? {} : { networkPolicy }
              }),
            "unavailable",
            `could not acquire ${name}`
          ),
          (sandbox) =>
            finalizeWithin(
              Effect.ignore(
                attempt(() => sandbox.stop(), "unknown", `could not stop ${name}`).pipe(
                  Effect.tapError((error) => warnTeardown("vercel", "stop", error))
                )
              ),
              `vercel sandbox ${name}`
            )
        )
        // `getOrCreate` sizes only a sandbox it creates; a resumed one keeps
        // the vCPUs it was made with, which is not the ceiling asked for.
        if (vcpus !== undefined && sandbox.vcpus !== vcpus) {
          return yield* Effect.fail(
            new ProviderError({
              code: "unavailable",
              message: `vercel-sandbox: ${name} holds ${sandbox.vcpus ?? "an unreported number of"} vCPU, ` +
                `not the requested ${vcpus}`
            })
          )
        }
        // Nor does it time a session it resumes: a running one keeps its
        // deadline and a stopped one restarts on the sandbox's own timeout.
        // Vercel can extend a session but never shorten it, so a deadline
        // past the requested lifetime is refused.
        const deadline = (yield* Clock.currentTimeMillis) + desiredMs
        const expiresAt = sandbox.expiresAt?.getTime()
        if (limits.timeoutSecs !== undefined && (expiresAt === undefined || expiresAt > deadline)) {
          return yield* Effect.fail(
            new ProviderError({
              code: "unavailable",
              message: expiresAt === undefined
                ? `vercel-sandbox: ${name} reports no session deadline, so limits.timeoutSecs cannot be enforced`
                : `vercel-sandbox: ${name} runs ${expiresAt - deadline}ms past limits.timeoutSecs ${limits.timeoutSecs}`
            })
          )
        }
        // `getOrCreate` applies a policy only when it creates; a resumed
        // sandbox keeps its own until updated, so the policy is set again
        // before any guest command runs.
        if (networkPolicy !== undefined) {
          yield* attempt(
            () => sandbox.update({ networkPolicy }),
            "unavailable",
            `could not apply the network policy to ${name}`
          )
        }
        const extension = expiresAt === undefined ? desiredMs - createMs : deadline - expiresAt
        if (desiredMs > createMs && extension > 0) {
          yield* attempt(
            () => sandbox.extendTimeout(extension),
            "unavailable",
            `could not extend ${name}`
          )
        }
        const prepare = yield* attempt(
          () => sandbox.runCommand({ cmd: "mkdir", args: ["-p", workdir] }),
          "unavailable",
          `could not prepare ${workdir}`
        )
        yield* checked(prepare, "unavailable", `vercel-sandbox: could not prepare ${workdir}`)

        const run = (params: Parameters<VendorSandbox["runCommand"]>[0]) =>
          attempt(() => sandbox.runCommand(params), "spawn_error", `could not run ${params.cmd}`)
        const writeFile: Session["writeFile"] = (path, content) =>
          Effect.gen(function*() {
            const parent = parentOf(path)
            if (parent !== undefined) {
              const result = yield* run({ cmd: "mkdir", args: ["-p", parent] })
              yield* checked(result, "unknown", `vercel-sandbox: could not create ${parent}`)
            }
            yield* attempt(
              // The SDK may retain or mutate its upload buffer after accepting it.
              () => sandbox.writeFiles([{ path, content: content.slice() }]),
              "unknown",
              `could not write ${path}`
            )
          })
        // `runCommand` takes no standard input (verified against the
        // `@vercel/sandbox` 3.2.1 typings), so a command's input is staged as
        // a workspace file and the command line is rewritten to read from it.
        const redirect = stdinRedirect({
          workdir,
          writeFile,
          remove: (path) =>
            Effect.asVoid(
              Effect.flatMap(
                run({ cmd: "rm", args: ["-f", path] }),
                (result) => checked(result, "unknown", `vercel-sandbox: could not remove ${path}`)
              )
            )
        })
        const resolveCwd = rootedAt(workdir)
        const session: Session = {
          id: sessionKey,
          remoteId: sandbox.name,
          workdir,
          spawn: (command, spawnOptions) =>
            Effect.flatMap(
              Effect.andThen(checkEnvironmentNames(spawnOptions.env), redirect(command, spawnOptions.stdin)),
              (fed) => {
                const guest = environmentCommand(fed, { ...options.commandEnv, ...spawnOptions.env })
                return Effect.map(
                  run({
                    cmd: "sh",
                    // `-c`, never `-lc`: profile output from a login shell would
                    // precede the command's own stdout on this transport.
                    args: ["-c", guest.command],
                    cwd: resolveCwd(spawnOptions.cwd ?? ""),
                    env: guest.env
                  }),
                  (result) => ({
                    stdout: output(() => result.stdout(), "could not read command stdout"),
                    stderr: output(() => result.stderr(), "could not read command stderr"),
                    exitCode: Effect.succeed(result.exitCode)
                  })
                )
              }
            ),
          readFile: (path) =>
            Effect.flatMap(
              attempt(() => sandbox.readFile({ path }), "unknown", `could not read ${path}`),
              (stream) =>
                stream === null
                  ? Effect.fail(
                    new ProviderError({ code: "not_found", message: `vercel-sandbox: no file exists at ${path}` })
                  )
                  : attempt(() => decodeFile(stream), "unknown", `could not drain ${path}`)
            ),
          writeFile,
          ping: Effect.gen(function*() {
            const result = yield* run({ cmd: "true", cwd: workdir })
            yield* checked(result, "unavailable", `vercel-sandbox: ${name} did not answer`)
          })
        }
        return session
      })
  }
}
