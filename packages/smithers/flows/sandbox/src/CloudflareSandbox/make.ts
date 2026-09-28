/**
 * Builds a Cloudflare Sandbox provider.
 *
 * @since 0.1.0
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { attemptIn } from "../internal/attempt.ts"
import { decodeBase64, encodeBase64 } from "../internal/base64.ts"
import { environmentCommand } from "../internal/environmentCommand.ts"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { finalizeWithin } from "../internal/finalizeWithin.ts"
import { parentOf } from "../internal/guestPath.ts"
import { rootedAt } from "../internal/rootedPath.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import { stdinRedirect } from "../internal/stdinRedirect.ts"
import { warnTeardown } from "../internal/teardownWarning.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { type NetworkPolicy, refuseNetworkPolicy } from "../Sandbox/NetworkPolicy.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"
import type { Sdk } from "./Sdk.ts"

/**
 * How the provider reaches its Worker binding and shapes each session's
 * Durable Object sandbox.
 *
 * @category models
 * @since 0.1.0
 */
export interface CloudflareSandboxOptions<Binding> {
  /**
   * Refused: egress control lives on the Worker's Sandbox class, outside this provider. Setting it makes `make` throw rather than hand out a
   * machine with a network it did not ask for.
   */
  readonly network?: NetworkPolicy | undefined
  readonly sdk: Sdk<Binding>
  readonly binding: Binding
  readonly execution?: "exec" | "process" | undefined
  readonly workdir?: string | undefined
  readonly sleepAfter?: string | number | undefined
  readonly keepAlive?: boolean | undefined
}

const encoder = new TextEncoder()

const failed = (code: ProviderError["code"], message: string, cause: unknown): ProviderError =>
  new ProviderError({ code, message: `cloudflare sandbox: ${message}`, cause })

const attempt = attemptIn("cloudflare sandbox")

const errorCodeOf = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined

const processOf = (stdout: string, stderr: string, exitCode: number): RemoteProcess => ({
  stdout: Stream.make(encoder.encode(stdout)),
  stderr: Stream.make(encoder.encode(stderr)),
  exitCode: Effect.succeed(exitCode)
})

/**
 * Builds a provider backed by Cloudflare Sandbox Durable Objects.
 *
 * The Worker binding is the credential and infrastructure handle. Acquiring a
 * session resolves its key-derived Durable Object id, disables the SDK's
 * implicit default shell session, and registers `destroy()` on the acquiring
 * scope. `exec` mode uses the completed command result. `process` mode waits
 * for the detached handle and fetches its logs before it reports an outcome,
 * and a handle that reports no exit status at all is a provider failure, not
 * an invented one.
 *
 * The SDK's command options carry no input channel, so `spawn` stages
 * `options.stdin` as a workspace file and redirects the command from it, and
 * a relative `cwd` is rooted at the session workdir. File payloads use the
 * SDK's base64 encoding and the text is read from the result's `content`
 * field. This preserves arbitrary bytes without importing host modules.
 *
 * Command output is not byte-exact here. The SDK reports a command's stdout
 * and stderr as strings, so what this provider streams is those strings
 * re-encoded as UTF-8: a command whose output is not valid UTF-8, such as a
 * tarball or a compiled binary written to stdout, comes back changed. File
 * transfer is byte-exact regardless, so a caller that needs bytes has the
 * command write a file and reads it back with `readFile`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <Binding>(options: CloudflareSandboxOptions<Binding>): Provider => {
  refuseNetworkPolicy("cloudflare-sandbox", options.network)
  const workdir = options.workdir ?? "/workspace"

  return {
    acquire: (sessionKey) =>
      Effect.gen(function*() {
        const remoteId = sessionSlug(sessionKey)
        const sandbox = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              options.sdk.getSandbox(options.binding, remoteId, {
                enableDefaultSession: false,
                ...options.keepAlive === undefined ? {} : { keepAlive: options.keepAlive },
                ...options.sleepAfter === undefined ? {} : { sleepAfter: options.sleepAfter }
              }),
            catch: (cause) => failed("unavailable", `could not resolve ${remoteId}`, cause)
          }),
          (sandbox) =>
            finalizeWithin(
              Effect.ignore(
                attempt(() => sandbox.destroy(), "unknown", `could not destroy ${remoteId}`).pipe(
                  Effect.tapError((error) => warnTeardown("cloudflare", "destroy", error))
                )
              ),
              `cloudflare sandbox ${remoteId}`
            )
        )
        yield* attempt(
          () => sandbox.mkdir(workdir, { recursive: true }),
          "unavailable",
          `could not create ${workdir}`
        )

        const writeFile: Session["writeFile"] = (path, content) =>
          Effect.gen(function*() {
            const parent = parentOf(path)
            if (parent !== undefined) {
              yield* attempt(
                () => sandbox.mkdir(parent, { recursive: true }),
                "unknown",
                `could not create the parent of ${path}`
              )
            }
            yield* attempt(
              () => sandbox.writeFile(path, encodeBase64(content), { encoding: "base64" }),
              "unknown",
              `could not write ${path}`
            )
          })

        // The SDK's exec and process options carry no standard input, so the
        // bytes are staged as a workspace file and the command reads from it.
        const redirect = stdinRedirect({
          workdir,
          writeFile,
          remove: (path) =>
            Effect.flatMap(
              attempt(() => sandbox.exec(`rm -f ${CommandLine.quote(path)}`), "unknown", `could not remove ${path}`),
              (result) =>
                result.exitCode === 0 ? Effect.void : Effect.fail(
                  failed("unknown", `could not remove ${path}: command exited ${result.exitCode}`, undefined)
                )
            )
        })
        const resolveCwd = rootedAt(workdir)

        const spawn: Session["spawn"] = (command, spawnOptions) =>
          Effect.flatMap(
            Effect.andThen(checkEnvironmentNames(spawnOptions.env), redirect(command, spawnOptions.stdin)),
            (fed) => {
              const guest = environmentCommand(fed, spawnOptions.env)
              const commandOptions = {
                cwd: resolveCwd(spawnOptions.cwd ?? ""),
                env: guest.env
              }
              return options.execution === "process"
                ? Effect.flatMap(
                  attempt(
                    async () => {
                      const started = await sandbox.startProcess(guest.command, commandOptions)
                      const exit = await started.waitForExit()
                      const logs = await started.getLogs()
                      return {
                        ...logs,
                        exitCode: exit.exitCode ?? started.exitCode
                      }
                    },
                    "spawn_error",
                    `process failed for ${command}`
                  ),
                  (result) =>
                    result.exitCode === undefined
                      ? Effect.fail(
                        failed("spawn_error", `the sandbox reported no exit status for \`${command}\``, result)
                      )
                      : Effect.succeed(processOf(result.stdout, result.stderr, result.exitCode))
                )
                : Effect.map(
                  attempt(
                    () => sandbox.exec(guest.command, commandOptions),
                    "spawn_error",
                    `exec failed for ${command}`
                  ),
                  (result) => processOf(result.stdout, result.stderr, result.exitCode)
                )
            }
          )

        const session: Session = {
          id: sessionKey,
          remoteId,
          workdir,
          spawn,
          readFile: (path) =>
            Effect.flatMap(
              Effect.tryPromise({
                try: () => sandbox.readFile(path, { encoding: "base64" }),
                catch: (cause) =>
                  errorCodeOf(cause) === "FILE_NOT_FOUND"
                    ? failed("not_found", `nothing exists at ${path}`, cause)
                    : failed("unknown", `could not read ${path}`, cause)
              }),
              (result) => decodeBase64(result.content, `for ${path}`)
            ),
          writeFile,
          ping: Effect.flatMap(
            attempt(() => sandbox.exec("true", { cwd: workdir }), "unavailable", `could not ping ${remoteId}`),
            (result) =>
              result.exitCode === 0
                ? Effect.void
                : Effect.fail(failed("unavailable", `${remoteId} failed its ping`, result))
          )
        }
        return session
      })
  }
}
