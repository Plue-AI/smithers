/** Claude's borrowed remote login never enters an action payload or the captured checkout. */
import type { Sandbox } from "@smthrs/sandbox"
import { Duration, Effect, FileSystem, Path, Schema, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { type makeAccountPicker, reserveAccount } from "../accounts.ts"
import { guestCheckout, guestHome } from "../vm.ts"

export class ClaudeFailed extends Schema.TaggedError<ClaudeFailed>()("issue-sweep/ClaudeFailed", {
  message: Schema.String
}) {}

export interface LoginOptions {
  readonly accountsDirectory?: string
  readonly platform?: string
  readonly now?: number
  readonly keychain?: (service: string) => Promise<string>
}

const keychain = async (service: string): Promise<string> =>
  (await promisify(execFile)("security", ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
    timeout: 10_000
  })).stdout

/**
 * Save the token from `claude setup-token` in the account's `oauth-token`
 * file (mode 0600) to use a long-lived remote login. Otherwise borrow the
 * unexpired macOS Keychain access token. Never copy a refresh token into a VM.
 * An invalid configured file fails closed instead of silently changing login.
 */
export const readClaudeLogin = (account: string, options: LoginOptions = {}) =>
  Effect.tryPromise({
    try: async () => {
      if (!/^claude-[A-Za-z0-9_-]+$/.test(account)) throw new Error("invalid account")
      const directory = resolve(options.accountsDirectory ?? join(homedir(), ".smithers/accounts"), account)
      const token = await readFile(join(directory, "oauth-token"), "utf8").catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return undefined
        throw cause
      })
      if (token !== undefined) {
        if (!token.trim() || /\s/.test(token.trim())) throw new Error("invalid token file")
        return token.trim()
      }
      if ((options.platform ?? process.platform) !== "darwin") throw new Error("no token file")
      const service = `Claude Code-credentials-${createHash("sha256").update(directory).digest("hex").slice(0, 8)}`
      const credentials = JSON.parse(await (options.keychain ?? keychain)(service))
      const oauth = credentials?.claudeAiOauth
      if (
        typeof oauth?.accessToken !== "string" || !oauth.accessToken || /\s/.test(oauth.accessToken) ||
        typeof oauth.expiresAt !== "number" || !Number.isFinite(oauth.expiresAt) ||
        oauth.expiresAt <= (options.now ?? Date.now())
      ) throw new Error("expired or invalid Keychain login")
      return oauth.accessToken as string
    },
    // execFile errors can contain credential stdout. Expose only this fixed message.
    catch: () => new ClaudeFailed({ message: `${account}: no usable oauth-token file or unexpired Keychain login` })
  })

/** Remote eligibility checks do not change the local pool or the shared reservation counts. */
export const reserveRemoteAccount = (
  issue: number,
  options: {
    readonly picker?: ReturnType<typeof makeAccountPicker>
    readonly login?: typeof readClaudeLogin
  } = {}
) =>
  Effect.gen(function*() {
    const logins = new Map<string, string>()
    const reserved = yield* (options.picker ?? reserveAccount)(issue, (pools) =>
      Effect.gen(function*() {
        logins.clear()
        const checked = yield* Effect.forEach(pools.claude.ready, (account) =>
          (options.login ?? readClaudeLogin)(account).pipe(
            Effect.map((login) => {
              logins.set(account, login)
              return account
            }),
            Effect.catch(() => Effect.succeed(undefined))
          ), { concurrency: 4 })
        const ready = checked.filter((account): account is string =>
          account !== undefined
        )
        return {
          ...pools,
          claude: {
            ...pools.claude,
            ready,
            unavailable: [
              ...pools.claude.unavailable,
              ...pools.claude.ready.filter((account) =>
                !logins.has(account)
              )
                .map((label) => ({ label, state: "no usable remote login" }))
            ]
          }
        }
      }))
    return { ...reserved, login: reserved.agent === "claude" ? logins.get(reserved.account)! : undefined }
  })

export const guestClaudeHome = `${guestHome}/.claude-sweep`

/** Refuse credential-bearing agent edits before the action journals the captured work. */
export const assertNoClaudeLogin = (work: Sandbox.Work, login: string) =>
  work._tag === "Changed" && login !== "" && work.patch.includes(login)
    ? Effect.fail(new ClaudeFailed({ message: "Claude's captured work contains its borrowed login" }))
    : Effect.void

const budget = Duration.hours(2)

/** The brief is one argv element; neither it nor the token is shell source. */
export const claudeCommand = (
  prompt: string,
  checkout = guestCheckout,
  home = guestClaudeHome
): readonly [string, ReadonlyArray<string>] => ["sh", [
  "-c",
  `set -eu; export CLAUDE_CONFIG_DIR=${home}; ` +
  `CLAUDE_CODE_OAUTH_TOKEN=$(cat ${home}/oauth-token); export CLAUDE_CODE_OAUTH_TOKEN; ` +
  // The VM is the sandbox, including on local images that run as root.
  `export IS_SANDBOX=1; cd ${checkout}; ` +
  `exec claude -p "$1" --model claude-opus-5-5 --output-format json --dangerously-skip-permissions </dev/null`,
  "sh",
  prompt
]]

const Result = Schema.fromJsonString(Schema.Struct({
  result: Schema.optional(Schema.String),
  is_error: Schema.optional(Schema.Boolean),
  subtype: Schema.optional(Schema.String)
}))

/** Copy in, run, then remove the complete guest login directory before work capture. */
export const claudeInGuest = (
  account: string,
  login: string,
  where: string,
  prompt: string,
  onExit: (stdout: string, stderr: string, code: number) => Effect.Effect<void, { readonly message: string }> = () =>
    Effect.void
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const checkout = path.resolve(".")
    const guestClaudeHome = path.resolve("../.claude-sweep")
    const guestToken = `${guestClaudeHome}/oauth-token`
    const redact = (text: string) => login === "" ? text : text.replaceAll(login, "[redacted]")
    return yield* Effect.gen(function*() {
      yield* fs.makeDirectory(guestClaudeHome, { recursive: true })
      yield* fs.chmod(guestClaudeHome, 0o700)
      yield* fs.writeFileString(guestToken, login, { flag: "wx", mode: 0o600 })
      const [command, args] = claudeCommand(prompt, checkout, guestClaudeHome)
      const [stdout, stderr, code] = yield* Effect.scoped(Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make(command, args))
        return yield* Effect.all([
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode
        ], { concurrency: "unbounded" })
      })).pipe(Effect.timeoutOrElse({
        duration: budget,
        orElse: () =>
          Effect.fail(new ClaudeFailed({ message: `claude on ${where}: no answer within ${Duration.format(budget)}` }))
      }))
      const decoded = Schema.decodeUnknownOption(Result)(stdout.trim().split("\n").at(-1)!)
      const failedResult = decoded._tag === "Some" &&
        (decoded.value.is_error === true ||
          (decoded.value.subtype !== undefined && decoded.value.subtype !== "success"))
      yield* onExit(redact(stdout), redact(stderr), code === 0 && failedResult ? 1 : Number(code))
      if (
        code !== 0 || decoded._tag === "None" || decoded.value.is_error === true ||
        (decoded.value.subtype !== undefined && decoded.value.subtype !== "success") ||
        !decoded.value.result?.trim()
      ) {
        return yield* new ClaudeFailed({
          message: `${account} on ${where}: Claude failed (exit ${code}): ${
            redact((stderr || stdout).trim().split("\n").slice(-5).join("\n"))
          }`
        })
      }
      return { agent: "claude" as const, account, report: redact(decoded.value.result.trim()) }
    }).pipe(
      Effect.mapError((cause) => new ClaudeFailed({ message: redact(cause.message) })),
      Effect.ensuring(
        fs.remove(guestClaudeHome, { recursive: true, force: true }).pipe(
          Effect.mapError(() => new ClaudeFailed({ message: `${account}: could not remove the guest Claude login` })),
          Effect.orDie
        )
      )
    )
  })
