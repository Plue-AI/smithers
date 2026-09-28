/**
 * Constructs the Daytona Sandbox provider.
 *
 * @since 0.1.0
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { attemptIn } from "../internal/attempt.ts"
import { checked } from "../internal/checkedExit.ts"
import { environmentCommand } from "../internal/environmentCommand.ts"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { finalizeWithin } from "../internal/finalizeWithin.ts"
import { parentOf } from "../internal/guestPath.ts"
import { providerFailure } from "../internal/localProcess.ts"
import { machineName } from "../internal/machineName.ts"
import { rootedAt } from "../internal/rootedPath.ts"
import { stdinRedirect } from "../internal/stdinRedirect.ts"
import { warnTeardown } from "../internal/teardownWarning.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { type NetworkPolicy, validateNetworkPolicy } from "../Sandbox/NetworkPolicy.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"
import type { Sdk } from "./Sdk.ts"

/**
 * How the provider reaches Daytona and shapes each session's sandbox.
 *
 * @category models
 * @since 0.1.0
 */
export interface DaytonaSandboxOptions {
  /**
   * The guest network. `"none"` and an empty allowlist send
   * `networkBlockAll`; `{ allow }` sends `domainAllowList`. A reattached
   * sandbox gets the same settings through `updateNetworkSettings` before any
   * guest command. Default: Daytona's own network.
   */
  readonly network?: NetworkPolicy | undefined
  /** A configured `Daytona` client instance. */
  readonly sdk: Sdk
  /** An explicit absolute guest workspace, otherwise `getWorkDir()` is used. */
  readonly workdir?: string | undefined
  /** Environment applied to every command before per-spawn overrides. */
  readonly commandEnv?: Readonly<Record<string, string>> | undefined
  /** Prefix for deterministic Daytona sandbox names. Default `smthrs-`. */
  readonly namePrefix?: string | undefined
  /** Timeout used when starting an attached sandbox, in seconds. */
  readonly startTimeoutSeconds?: number | undefined
  /** SDK deletion timeout in seconds; scope release still waits at most five seconds. */
  readonly deleteTimeoutSeconds?: number | undefined
}

type VendorSandbox = Awaited<ReturnType<Sdk["get"]>>
type ExecuteResponse = Awaited<ReturnType<VendorSandbox["process"]["executeCommand"]>>

const encoder = new TextEncoder()

const field = (cause: unknown, name: string): unknown =>
  typeof cause === "object" && cause !== null ? Reflect.get(cause, name) : undefined

// The `@daytonaio/sdk` 0.207.0 typings document `DaytonaNotFoundError` with
// `statusCode: 404` for a `get` of a missing sandbox. The shape is taken from
// the published typings; it has not been verified against the live service.
const missingSandbox = (cause: unknown): boolean => field(cause, "statusCode") === 404

// The `@daytonaio/sdk` 0.207.0 typings document `DaytonaFileNotFoundError`
// ("The file does not exist in the sandbox") with `code: "FILE_NOT_FOUND"`
// for a download of a missing file. The shape is taken from the published
// typings; it has not been verified against the live service.
const missingFile = (cause: unknown): boolean => field(cause, "code") === "FILE_NOT_FOUND"

const attempt = attemptIn("daytona-sandbox")

const networkSettings = (network: NetworkPolicy | undefined) => {
  if (network === undefined) return undefined
  const policy = validateNetworkPolicy("daytona-sandbox", network)
  return policy === "none" || policy.allow.length === 0
    ? { networkBlockAll: true }
    : { domainAllowList: policy.allow.join(",") }
}

/**
 * Builds a provider backed by Daytona sandboxes.
 *
 * A name derived from the session key is looked up first. A
 * missing sandbox is created with that name, while an existing one is started
 * before use. Creation or attachment is registered as a scoped resource before
 * start and workspace preparation, so any later failure still runs the
 * blocking delete finalizer; a delete that fails is logged at Warn rather
 * than swallowed. Daytona's byte-native download and stream-upload operations
 * serve file transfer; shell execution creates missing parents.
 *
 * `process.executeCommand` answers with a single `result` string and an exit
 * code — the wire response carries no stderr field, and the execution
 * endpoint merges standard error into that one output (Daytona's own
 * error-handling documentation prints `result` as the error output). The
 * merged text is delivered on stdout, so text a command writes to stderr
 * still reaches the caller there, and the stderr stream stays empty rather
 * than fabricating a second copy of it.
 *
 * A relative spawn `cwd` is rooted at the session workdir per the session
 * contract, and `options.stdin` is delivered through a workspace file —
 * `executeCommand` takes a command line and nothing else, so the redirect in
 * `internal/stdinRedirect` is the only honest route.
 *
 * Command output is not byte-exact here. That `result` is a string, so what
 * this provider streams is the string re-encoded as UTF-8: a command whose
 * output is not valid UTF-8, such as a tarball or a compiled binary written to
 * stdout, comes back changed. File transfer is byte-exact regardless, so a
 * caller that needs bytes has the command write a file and reads it back with
 * `readFile`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: DaytonaSandboxOptions): Provider => {
  const network = networkSettings(options.network)
  return {
    acquire: (sessionKey) =>
      Effect.gen(function*() {
        if (options.workdir !== undefined && !options.workdir.startsWith("/")) {
          return yield* Effect.fail(
            new ProviderError({
              code: "spawn_error",
              message: `daytona-sandbox: workdir must be absolute: ${options.workdir}`
            })
          )
        }
        const name = machineName(options.namePrefix ?? "smthrs-", sessionKey)
        const held = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              try {
                return { sandbox: await options.sdk.get(name), attached: true }
              } catch (cause) {
                if (!missingSandbox(cause)) throw cause
                return { sandbox: await options.sdk.create({ name, ...network }), attached: false }
              }
            },
            catch: providerFailure("unavailable", `daytona-sandbox: could not acquire ${name}`)
          }),
          ({ sandbox }) =>
            finalizeWithin(
              Effect.ignore(
                attempt(
                  () => options.sdk.delete(sandbox, options.deleteTimeoutSeconds ?? 60, true),
                  "unknown",
                  `could not delete ${name}`
                ).pipe(Effect.tapError((error) => warnTeardown("daytona", "delete", error)))
              ),
              `daytona sandbox ${name}`
            )
        )
        if (held.attached) {
          yield* attempt(
            () => options.sdk.start(held.sandbox, options.startTimeoutSeconds),
            "unavailable",
            `could not start ${name}`
          )
          // A reattached sandbox keeps the network it was created with until
          // told otherwise; the runner applies these to the running container.
          if (network !== undefined) {
            yield* attempt(
              () => held.sandbox.updateNetworkSettings(network),
              "unavailable",
              `could not apply the network policy to ${name}`
            )
          }
        }
        const discovered = options.workdir === undefined
          ? yield* attempt(() => held.sandbox.getWorkDir(), "unavailable", `could not discover ${name}'s workdir`)
          : options.workdir
        if (discovered === undefined || !discovered.startsWith("/")) {
          return yield* Effect.fail(
            new ProviderError({
              code: "unavailable",
              message: `daytona-sandbox: ${name} did not report an absolute workdir`
            })
          )
        }
        const workdir = discovered
        const execute = (
          command: string,
          cwd?: string,
          env?: Record<string, string>
        ): Effect.Effect<ExecuteResponse, ProviderError> =>
          attempt(
            () => held.sandbox.process.executeCommand(command, cwd, env),
            "spawn_error",
            `could not execute ${command}`
          )
        const prepare = yield* execute(`mkdir -p ${CommandLine.quote(workdir)}`)
        yield* checked(prepare, "unavailable", `daytona-sandbox: could not prepare ${workdir}`)

        const writeFile: Session["writeFile"] = (path, content) =>
          Effect.gen(function*() {
            const parent = parentOf(path)
            if (parent !== undefined) {
              const result = yield* execute(`mkdir -p ${CommandLine.quote(parent)}`)
              yield* checked(result, "unknown", `daytona-sandbox: could not create ${parent}`)
            }
            yield* attempt(
              // The SDK may retain or mutate its upload buffer after accepting it.
              () => held.sandbox.fs.uploadFileStream(content.slice(), path),
              "unknown",
              `could not upload ${path}`
            )
          })
        // `executeCommand` takes a command line and nothing else, so a
        // command's standard input is staged as a workspace file and the line
        // is rewritten to read from it.
        const redirect = stdinRedirect({
          workdir,
          writeFile,
          remove: (path) =>
            Effect.asVoid(Effect.flatMap(execute(`rm -f ${CommandLine.quote(path)}`), (result) =>
              checked(result, "unknown", `daytona-sandbox: could not remove ${path}`)))
        })
        const resolveCwd = rootedAt(workdir)
        const session: Session = {
          id: sessionKey,
          remoteId: held.sandbox.id,
          workdir,
          spawn: (command, spawnOptions) =>
            Effect.flatMap(
              Effect.andThen(checkEnvironmentNames(spawnOptions.env), redirect(command, spawnOptions.stdin)),
              (fed) => {
                const guest = environmentCommand(fed, { ...options.commandEnv, ...spawnOptions.env })
                return Effect.map(
                  execute(
                    guest.command,
                    resolveCwd(spawnOptions.cwd ?? ""),
                    guest.env
                  ),
                  (result) => ({
                    // `result` is the command's combined output: the wire
                    // response has no stderr field and the endpoint merges
                    // standard error into it, so the merged text is delivered on
                    // stdout and stderr stays honestly empty.
                    stdout: Stream.make(encoder.encode(result.result)),
                    stderr: Stream.empty,
                    exitCode: Effect.succeed(result.exitCode)
                  })
                )
              }
            ),
          readFile: (path) =>
            Effect.tryPromise({
              try: () =>
                held.sandbox.fs.downloadFile(path).then((content) => new Uint8Array(content)),
              catch: (cause) =>
                missingFile(cause)
                  ? new ProviderError({
                    code: "not_found",
                    message: `daytona-sandbox: no file exists at ${path}`,
                    cause
                  })
                  : providerFailure("unknown", `daytona-sandbox: could not download ${path}`)(cause)
            }),
          writeFile,
          ping: Effect.gen(function*() {
            const result = yield* execute("true", workdir)
            yield* checked(result, "unavailable", `daytona-sandbox: ${name} did not answer`)
          })
        }
        return session
      })
  }
}
