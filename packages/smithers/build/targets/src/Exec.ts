/**
 * Shared tool-execution action for catalog targets.
 *
 * Targets declare tool runs by calling {@link Exec}.call in their pure
 * plan-time bodies. Nothing runs at plan time; the call only records a node
 * requiring the exec implementation. {@link ExecLive} supplies that
 * implementation through `node:child_process` for hosts that execute plans.
 *
 * @since 0.1.0
 */

import { Action, type FlowRuntime } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import * as ProcessSandbox from "@smthrs/platform-node/ProcessSandbox"
import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import * as NodeUtil from "node:util/types"
import * as Config from "./Config.ts"
import * as ExecSandbox from "./ExecSandbox.ts"
import { failureMessage } from "./GeneratedFile.ts"
import * as Input from "./Input.ts"
import * as SafeFs from "./SafeFs.ts"
import * as Secret from "./Secret.ts"
import * as SecretProxy from "./SecretProxy.ts"

/**
 * Placeholder resolved to the absolute host cache directory immediately before spawn.
 *
 * Keeping the real directory out of an action payload prevents workspace
 * placement from becoming step-key material. The substituted path is independent
 * of the child working directory.
 *
 * @category constants
 * @since 0.1.0
 */
export const cacheDirectoryToken = "{smthrs:cache-directory}"

/**
 * Placeholder resolved to the interpreter this build runs under, the argv[0]
 * a `S.Runtime.bin` declaration renders.
 *
 * A declaration names the workspace runtime rather than a host path, so the
 * path stays out of the action payload and the step key. The boundary
 * substitutes `process.execPath`, the same answer the package executor
 * resolves a `RuntimeBin` reference to, immediately before spawn.
 *
 * @category constants
 * @since 0.1.0
 */
export const runtimeBinToken = `{smthrs:tool:${JSON.stringify({ _tag: "RuntimeBin" })}}`

/**
 * Prefix of the placeholder standing for a declared generator script.
 *
 * The declared spelling is workspace-anchored (`//scripts/generate.mjs`); the
 * boundary substitutes the workspace-relative path, which is what a child
 * spawned in the workspace root can open.
 *
 * @category constants
 * @since 0.1.0
 */
export const scriptTokenPrefix = "{smthrs:script:"

/** Resolves a declared-script placeholder to its workspace-relative path. */
const resolveScriptToken = (value: string): string =>
  value.startsWith(scriptTokenPrefix) && value.endsWith("}")
    ? Input.resolvePath("", value.slice(scriptTokenPrefix.length, -1))
    : value

/**
 * Maximum length kept for captured stdout and stderr, in UTF-16 code units.
 *
 * The bound is code units, not bytes, because what is kept is a decoded
 * string: a run whose output is mostly non-ASCII therefore keeps fewer bytes
 * than a run whose output is ASCII. The unit is fixed rather than incidental,
 * so two hosts truncate one tool's output at the same place and the captured
 * result is the same on both.
 *
 * @category constants
 * @since 0.1.0
 */
export const outputLimit = 200 * 1024

/**
 * Maximum length of each stream tail carried by {@link ExecError}, in UTF-16
 * code units.
 *
 * A failing gate has to name what failed. At 8 KiB a test runner's own
 * summary survived while the list of failing test names above it did not, so
 * a red CI target reported "2 tests failed" and nothing else, and the only
 * way to learn which two was to reproduce the run by hand. The tail is the
 * evidence a person acts on, so it holds a runner's failure list.
 *
 * @category constants
 * @since 0.1.0
 */
export const stderrTailLimit = 64 * 1024

/**
 * Default wall-clock duration of one external tool process.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultTimeoutMs = 10 * 60 * 1000
/**
 * Maximum bounded wall-clock duration accepted for one external tool process.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumTimeoutMs = 24 * 60 * 60 * 1000

const maximumArgvEntries = 4_096
const maximumArgvBytes = 2 * 1024 * 1024
const maximumEnvironmentEntries = 4_096
const maximumEnvironmentBytes = 2 * 1024 * 1024
const maximumTextBytes = 1024 * 1024
const maximumExpectedExitCodes = 256
const maximumSecrets = 64

/**
 * A bounded exec wall-clock duration in milliseconds: an integer from 1 to
 * {@link maximumTimeoutMs}. Declarations that forward a timeout to the shared
 * runner reuse it so an out-of-range value fails at construction, not at
 * execution.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TimeoutMs = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(maximumTimeoutMs)
)

/**
 * The exit codes one exec treats as success: at most 256 distinct integers,
 * each in the unsigned 32-bit range. Declarations that forward expected exit codes to
 * the shared runner reuse it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ExpectedExitCodes = Schema.Array(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(0xffff_ffff))
).check(
  Schema.isMaxLength(maximumExpectedExitCodes),
  Schema.makeFilter((codes) =>
    new Set(codes).size === codes.length ? undefined : "expected exit codes contain a duplicate"
  )
)

/**
 * Payload for one declared tool run.
 *
 * `cwd` is resolved against the workspace root at execution time. `argv[0]`
 * is the executable. `env` is merged over a small, documented host bootstrap
 * environment rather than the complete `process.env`.
 * `expectedExitCodes` lists the exit codes treated as success and defaults
 * to `[0]`. `timeoutMs` bounds the process lifetime and defaults to ten
 * minutes. Set `timeoutMs` to `"unbounded"` for a service governed by
 * interruption instead of a deadline. `after` carries the planned result of
 * an upstream step this run must wait for: a planned reference here is a
 * material dependency, so the
 * engine settles the upstream step before it dispatches this one. The spawn
 * never reads it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Payload = Schema.Struct({
  cwd: Schema.NonEmptyString.check(Schema.isMaxLength(maximumTextBytes)),
  argv: Schema.NonEmptyArray(Schema.String.check(Schema.isMaxLength(maximumTextBytes))).check(
    Schema.isMaxLength(maximumArgvEntries)
  ),
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed({}))
  ),
  secrets: Schema.Array(Secret.HttpCredential).check(Schema.isMaxLength(maximumSecrets)).pipe(
    Schema.withConstructorDefault(Effect.succeed([]))
  ),
  expectedExitCodes: ExpectedExitCodes.pipe(
    Schema.withConstructorDefault(Effect.succeed([0]))
  ),
  timeoutMs: Schema.Union([TimeoutMs, Schema.Literal("unbounded")]).pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultTimeoutMs))
  ),
  after: Schema.optional(Schema.Unknown)
})

/**
 * Payload for one declared tool run.
 *
 * @category models
 * @since 0.1.0
 */
export type Payload = typeof Payload.Type

/**
 * Plan-time payload accepted by {@link Exec}.call, with planned
 * placeholders permitted wherever a concrete value is.
 *
 * @category models
 * @since 0.1.0
 */
export type CallPayload = Action.PlannedPayload<(typeof Payload)["~type.make.in"]>

/**
 * Result of one completed tool run whose exit code was expected.
 *
 * `stdout` and `stderr` are truncated to {@link outputLimit}. Timing is
 * execution metadata and deliberately is not part of this semantic value.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Result = Schema.Struct({
  exitCode: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  stdout: Schema.String.check(Schema.isMaxLength(outputLimit)),
  stderr: Schema.String.check(Schema.isMaxLength(outputLimit))
})

/**
 * Result of one completed tool run whose exit code was expected.
 *
 * @category models
 * @since 0.1.0
 */
export type Result = typeof Result.Type

/**
 * A tool run failed: it exited with an unexpected code, or it could not be
 * spawned at all, reported as `exitCode` -1.
 *
 * `cwd` is the payload's workspace-relative directory. `stdout` and `stderr`
 * carry the final {@link stderrTailLimit} units of their captured streams.
 * A failure before spawn leaves stdout empty and carries its message in
 * stderr.
 *
 * @category errors
 * @since 0.1.0
 */
export const ExecFailureCode = Schema.Literals([
  "invalid_payload",
  "spawn_failed",
  "timed_out",
  "signaled",
  "stream_failed",
  "secret_proxy_failed",
  "sandbox_unenforceable",
  "exit_status"
])

/**
 * Why one external-tool run failed, as a closed code rather than prose.
 *
 * Every one of these reported `exitCode: -1` with free-form stderr text, so a
 * caller deciding whether to retry a transient spawn, tell the operator an
 * executable is missing, treat a timeout as a budget problem, or escalate a
 * secret-proxy failure had to parse an unstable string.
 *
 * @category models
 * @since 0.1.0
 */
export type ExecFailureCode = typeof ExecFailureCode.Type

/**
 * A typed external-tool failure.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ExecError = Schema.Struct({
  _tag: Schema.Literal("smithers-build/ExecError"),
  argv: Schema.NonEmptyArray(Schema.String),
  cwd: Schema.String,
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
  /**
   * Which failure class this is.
   *
   * Required, not optional: every production branch already assigns one, and
   * an optional field left the exported type admitting the untyped failure
   * this field exists to eliminate. A caller deciding whether to retry a
   * transient spawn, report a missing executable, treat a timeout as a budget
   * problem, or escalate a secret-proxy failure can switch on it exhaustively.
   */
  code: ExecFailureCode,
  /** The signal that terminated the child, when one did. */
  signal: Schema.optional(Schema.NonEmptyString)
})

/**
 * A typed external-tool failure.
 *
 * @category errors
 * @since 0.1.0
 */
export type ExecError = typeof ExecError.Type

const execError = (options: Omit<ExecError, "_tag">): ExecError => ({
  _tag: "smithers-build/ExecError",
  ...options
})

const inspect = <A>(what: string, operation: () => A): A => {
  try {
    return operation()
  } catch {
    throw new TypeError(`${what} could not be inspected safely`)
  }
}

const plainRecord = (value: unknown, what: string): Record<PropertyKey, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || NodeUtil.isProxy(value)) {
    throw new TypeError(`${what} must be a plain object`)
  }
  const prototype = inspect(what, () => Object.getPrototypeOf(value))
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${what} must be a plain object`)
  }
  return value as Record<PropertyKey, unknown>
}

const exactKeys = (value: Record<PropertyKey, unknown>, allowed: ReadonlySet<string>, what: string): void => {
  const keys = inspect(what, () => Reflect.ownKeys(value))
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${what} contains an unknown property`)
    }
  }
}

const requiredDataMember = (value: Record<PropertyKey, unknown>, name: string, what: string): unknown => {
  const descriptor = inspect(`${what}.${name}`, () => Object.getOwnPropertyDescriptor(value, name))
  if (descriptor === undefined) throw new TypeError(`${what}.${name} is missing`)
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError(`${what}.${name} must be an enumerable data property`)
  }
  return descriptor.value
}

const dataArray = (value: unknown, what: string, limit: number): Array<unknown> => {
  if (!Array.isArray(value) || NodeUtil.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${what} must be an array`)
  }
  if (value.length > limit) throw new TypeError(`${what} has more than ${limit} entries`)
  const names = inspect(what, () => Object.getOwnPropertyNames(value))
  if (
    inspect(what, () => Object.getOwnPropertySymbols(value)).length !== 0 ||
    names.length !== value.length + 1 ||
    !names.includes("length")
  ) {
    throw new TypeError(`${what} must be a dense array without extra properties`)
  }
  const nameSet = new Set(names)
  const output: Array<unknown> = []
  for (let index = 0; index < value.length; index += 1) {
    const name = String(index)
    if (!nameSet.has(name)) throw new TypeError(`${what} must be a dense array without extra properties`)
    const descriptor = inspect(`${what}[${name}]`, () => Object.getOwnPropertyDescriptor(value, name))
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${what}[${name}] must be an enumerable data property`)
    }
    output.push(descriptor.value)
  }
  return output
}

const diagnosticMember = (value: unknown, name: string): unknown => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || NodeUtil.isProxy(value)) {
    return undefined
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

const declaredDiagnostic = (value: unknown): { readonly argv: [string, ...Array<string>]; readonly cwd: string } => {
  const candidateArgv = diagnosticMember(value, "argv")
  let argv: [string, ...Array<string>] = ["<invalid exec payload>"]
  if (
    Array.isArray(candidateArgv) &&
    !NodeUtil.isProxy(candidateArgv) &&
    candidateArgv.length > 0 &&
    candidateArgv.length <= maximumArgvEntries
  ) {
    const rendered: Array<string> = []
    for (let index = 0; index < candidateArgv.length; index += 1) {
      const entry = diagnosticMember(candidateArgv, String(index))
      rendered.push(typeof entry === "string" ? head(entry, maximumTextBytes) : "<invalid exec argument>")
    }
    argv = rendered as [string, ...Array<string>]
  }
  const candidateCwd = diagnosticMember(value, "cwd")
  const cwd = typeof candidateCwd === "string" ? head(candidateCwd, maximumTextBytes) : "<invalid exec cwd>"
  return { argv, cwd }
}

/**
 * The one shared action every catalog target uses to run a tool.
 *
 * @category actions
 * @since 0.1.0
 */
export const Exec = Action.make("smithers-build/exec", {
  payload: Payload,
  success: Result,
  error: ExecError,
  tier: "sealed"
})

/**
 * Declares one tool run through the shared {@link Exec} action.
 *
 * Target implementations call this in their pure plan-time bodies to record an
 * exec node. Executing the resulting plan requires {@link ExecLive}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const runTool = (
  payload: CallPayload
): Node.Node<Result, ExecError, Action.Requirement<"smithers-build/exec">> => Exec.call(payload)

/**
 * Reports whether slicing `text` at `index` would split a surrogate pair.
 *
 * A bound counted in UTF-16 code units can land between the two halves of an
 * astral code point. Cutting there produces a lone surrogate, which is not
 * valid text and does not survive a round trip through JSON or a cache entry.
 */
const splitsPair = (text: string, index: number): boolean => {
  if (index <= 0 || index >= text.length) return false
  const high = text.charCodeAt(index - 1)
  const low = text.charCodeAt(index)
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
}

/** Keeps the leading `limit` code units without splitting a surrogate pair. */
const head = (text: string, limit: number): string =>
  text.length <= limit ? text : text.slice(0, splitsPair(text, limit) ? limit - 1 : limit)

/** Keeps the trailing `limit` code units without splitting a surrogate pair. */
const keepTail = (text: string, limit: number): string => {
  if (text.length <= limit) return text
  const at = text.length - limit
  return text.slice(splitsPair(text, at) ? at + 1 : at)
}

const tail = (text: string): string => keepTail(text, stderrTailLimit)

/**
 * Host variables needed to find executables and satisfy operating-system
 * process startup, plus `CI` — the cross-tool convention that switches a
 * tool into non-interactive mode. Withholding `CI` made pnpm treat a hosted
 * runner as an interactive terminal and abort on its first would-be prompt;
 * the variable carries a mode, not machine identity, so inheriting it keeps
 * tool behavior aligned with the host the run is actually on.
 *
 * `SDKROOT` and `DEVELOPER_DIR` are the same kind of variable one layer down:
 * they say where the platform's C headers and libraries live, the way `PATH`
 * says where its executables live. A macOS `cc` resolved through `PATH` to an
 * Xcode toolchain clang takes its sysroot from `SDKROOT` and looks nowhere
 * else, so withholding it fails any cargo target with a `-sys` dependency on
 * `'stdlib.h' file not found` — a host configuration problem reported as a
 * compile error three processes down.
 *
 * @category constants
 * @since 0.1.0
 */
export const inheritedEnvironmentNames: ReadonlyArray<string> = Object.freeze([
  "APPDATA",
  "CI",
  "COMSPEC",
  "DEVELOPER_DIR",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SDKROOT",
  "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME"
])

const usableText = (value: string, what: string): string => {
  if (value.includes("\0") || !value.isWellFormed()) throw new TypeError(`${what} is not usable text`)
  return value
}

/**
 * Explains each declared secret audience this payload has no transport for.
 *
 * The loopback proxy cannot substitute inside an HTTPS tunnel, so an HTTPS
 * audience is reachable with its placeholder resolved only through a
 * brokered origin, which the payload names with `S.SecretOrigin(audience)` in
 * argv or env. A loopback HTTP audience may use either that token or the
 * proxy variables. A token naming an origin no declared secret is bound to
 * would broker nothing, so it is refused too. The planner calls this on the
 * planned payload so `--plan` shows the fix before anything spawns; the exec
 * boundary calls it again on the payload it receives.
 *
 * @category validation
 * @since 0.1.0
 */
export const unservableAudiences = (payload: {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly secrets: ReadonlyArray<Secret.HttpCredential>
}): ReadonlyArray<string> => {
  const declared = new Map<string, Array<string>>()
  for (const credential of payload.secrets) {
    for (const audience of credential.audiences) {
      const names = declared.get(audience) ?? []
      names.push(credential.secret.env)
      declared.set(audience, names)
    }
  }
  const referenced = new Set([...payload.argv, ...Object.values(payload.env)].flatMap(Secret.secretOriginsIn))
  const problems: Array<string> = []
  for (const origin of referenced) {
    if (!declared.has(origin)) {
      problems.push(
        `exec names S.SecretOrigin(${JSON.stringify(origin)}), but no declared S.HttpSecret is bound to that audience`
      )
    }
  }
  for (const [audience, names] of declared) {
    if (audience.startsWith("https:") && !referenced.has(audience)) {
      problems.push(
        `the declared secret ${names.join(", ")} is bound to ${audience}, which the tool can reach with the ` +
          `secret substituted only through a brokered origin; point the tool at ` +
          `S.SecretOrigin(${JSON.stringify(audience)}) in argv or env`
      )
    }
  }
  return problems
}

/** Re-decodes and applies aggregate limits at the child-process trust boundary. */
const validatedPayload = (untrusted: Payload): Payload => {
  const record = plainRecord(untrusted, "exec payload")
  const allowed = new Set(["after", "argv", "cwd", "env", "expectedExitCodes", "secrets", "timeoutMs"])
  exactKeys(record, allowed, "exec payload")
  const environment = plainRecord(requiredDataMember(record, "env", "exec payload"), "exec environment")
  const environmentEntries = inspect("exec environment", () => Reflect.ownKeys(environment))
  if (environmentEntries.length > maximumEnvironmentEntries) {
    throw new TypeError(`exec environment has more than ${maximumEnvironmentEntries} entries`)
  }
  const untrustedEnv = Object.create(null) as Record<string, unknown>
  for (const name of environmentEntries) {
    if (typeof name !== "string") throw new TypeError("exec environment contains a symbol property")
    untrustedEnv[name] = requiredDataMember(environment, name, "exec environment")
  }
  const after = Object.getOwnPropertyDescriptor(record, "after")
  const candidate = {
    cwd: requiredDataMember(record, "cwd", "exec payload"),
    argv: dataArray(requiredDataMember(record, "argv", "exec payload"), "exec argv", maximumArgvEntries),
    env: untrustedEnv,
    expectedExitCodes: dataArray(
      requiredDataMember(record, "expectedExitCodes", "exec payload"),
      "exec expected exit codes",
      maximumExpectedExitCodes
    ),
    secrets: dataArray(
      requiredDataMember(record, "secrets", "exec payload"),
      "exec secrets",
      maximumSecrets
    ),
    timeoutMs: requiredDataMember(record, "timeoutMs", "exec payload"),
    ...(after === undefined ? {} : { after: requiredDataMember(record, "after", "exec payload") })
  }
  const payload = Schema.decodeUnknownSync(Payload)(candidate)
  usableText(payload.cwd, "exec cwd")
  let argvBytes = 0
  for (const [index, value] of payload.argv.entries()) {
    usableText(value, `exec argv[${index}]`)
    if (index === 0 && value === "") throw new TypeError("exec argv[0] must name an executable")
    argvBytes += Buffer.byteLength(value, "utf8")
    if (!Number.isSafeInteger(argvBytes) || argvBytes > maximumArgvBytes) {
      throw new TypeError(`exec argv exceeds ${maximumArgvBytes} bytes`)
    }
  }
  const env = Object.create(null) as Record<string, string>
  const folded = new Set<string>()
  let environmentBytes = 0
  const entries = Object.entries(payload.env)
  if (entries.length > maximumEnvironmentEntries) {
    throw new TypeError(`exec environment has more than ${maximumEnvironmentEntries} entries`)
  }
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`exec environment name is not portable: ${JSON.stringify(name)}`)
    }
    usableText(value, `exec environment ${name}`)
    const key = name.toUpperCase()
    if (folded.has(key)) {
      throw new TypeError(`exec environment repeats a case-insensitive name: ${JSON.stringify(name)}`)
    }
    folded.add(key)
    environmentBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8")
    if (!Number.isSafeInteger(environmentBytes) || environmentBytes > maximumEnvironmentBytes) {
      throw new TypeError(`exec environment exceeds ${maximumEnvironmentBytes} bytes`)
    }
    env[name] = value
  }
  if (new Set(payload.expectedExitCodes).size !== payload.expectedExitCodes.length) {
    throw new TypeError("exec expected exit codes contain a duplicate")
  }
  const secretNames = new Set<string>()
  for (const binding of payload.secrets) {
    const secret = binding.secret
    usableText(secret.env, "exec secret name")
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret.env)) {
      throw new TypeError(`exec secret name is not portable: ${JSON.stringify(secret.env)}`)
    }
    // Two declarations of one variable would mint one placeholder and read the
    // same value twice. Refusing says so at the boundary instead of silently
    // collapsing them.
    if (secretNames.has(secret.env.toUpperCase())) {
      throw new TypeError(`exec declares the secret ${JSON.stringify(secret.env)} twice`)
    }
    secretNames.add(secret.env.toUpperCase())
    if (Object.hasOwn(env, secret.env)) {
      throw new TypeError(
        `exec sets ${JSON.stringify(secret.env)} in env and also declares it as a secret`
      )
    }
  }
  const unservable = unservableAudiences({ argv: payload.argv, env, secrets: payload.secrets })
  if (unservable.length > 0) throw new TypeError(unservable[0])
  return {
    ...payload,
    argv: [...payload.argv],
    env,
    secrets: payload.secrets.map((credential) => Secret.HttpSecret(credential.secret, [...credential.audiences])),
    expectedExitCodes: [...payload.expectedExitCodes]
  }
}

const validatedSensitiveNames = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (names.length > maximumEnvironmentEntries) throw new TypeError("too many sensitive environment names")
  const output: Array<string> = []
  const seen = new Set<string>()
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`sensitive environment name is not portable: ${JSON.stringify(name)}`)
    }
    const key = process.platform === "win32" ? name.toUpperCase() : name
    if (!seen.has(key)) {
      seen.add(key)
      output.push(name)
    }
  }
  return output
}

const hostValue = (name: string): string | undefined => {
  if (process.platform !== "win32") return process.env[name]
  const found = Object.keys(process.env).find((entry) => entry.toUpperCase() === name)
  return found === undefined ? undefined : process.env[found]
}

/**
 * The executable lookup environment a resolved Nix closure supplies.
 *
 * `path` replaces the host `PATH`; `variables` are the closure's other
 * exported variables that tools need to run from it, such as the certificate
 * bundle its `curl` and `git` read. Neither is key material here: the planner
 * folds the closure's store hash into the target's `layers`, and this record
 * only tells the spawn where the tools that hash names live.
 *
 * @category models
 * @since 0.1.0
 */
export interface ToolEnvironment {
  readonly path: string
  readonly variables: Readonly<Record<string, string>>
}

/**
 * Constructs the deliberately narrow ambient environment visible to a tool.
 *
 * `secretEnv` is applied last, after withholding, because a declared secret is
 * the one case where a variable is meant to reach the child. What reaches it is
 * a minted placeholder and the loopback proxy endpoint, never a credential, so
 * ordering it after the withholding pass grants no ambient authority.
 * Planning uses the same environment to key inherited and declared values.
 *
 * @category environment
 * @since 0.1.0
 */
export const toolEnvironment = (
  declared: Readonly<Record<string, string>>,
  sensitiveEnv: ReadonlyArray<string>,
  secretEnv: Readonly<Record<string, string>> = {},
  base: ToolEnvironment | undefined = undefined
): NodeJS.ProcessEnv => {
  const env = Object.create(null) as NodeJS.ProcessEnv
  for (const name of inheritedEnvironmentNames) {
    const value = hostValue(name)
    if (value !== undefined) env[name] = value
  }
  // A declared environment replaces the host's executable lookup entirely: the
  // closure's PATH is the whole PATH, so a tool the closure lacks is absent
  // rather than found on the host by accident.
  if (base !== undefined) {
    for (const [name, value] of Object.entries(base.variables)) env[name] = value
    env["PATH"] = base.path
  }
  env["CLICOLOR"] = "0"
  env["FORCE_COLOR"] = "0"
  env["LANG"] = "C"
  env["LC_ALL"] = "C"
  env["NO_COLOR"] = "1"
  for (const [name, value] of Object.entries(declared)) env[name] = value
  const withheld = new Set(
    ["SMITHERS_CACHE_URL", "SMITHERS_CACHE_TOKEN", ...sensitiveEnv].map((name) =>
      process.platform === "win32" ? name.toUpperCase() : name
    )
  )
  for (const name of Object.keys(env)) {
    const key = process.platform === "win32" ? name.toUpperCase() : name
    if (withheld.has(key)) delete env[name]
  }
  for (const [name, value] of Object.entries(secretEnv)) env[name] = value
  return env
}

const inside = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate)
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative))
}

/** Resolves symlinks through the nearest existing ancestor of one path. */
const realpath = (absolute: string): string => {
  let current = absolute
  const suffix: Array<string> = []
  while (true) {
    try {
      return NodePath.resolve(NodeFs.realpathSync(current), ...suffix)
    } catch (cause) {
      const code = SafeFs.errorCode(cause)
      if (code !== "ENOENT" && code !== "ENOTDIR") throw cause
      const parent = NodePath.dirname(current)
      if (parent === current) throw cause
      suffix.unshift(NodePath.basename(current))
      current = parent
    }
  }
}

/**
 * Resolves a path against a workspace and refuses lexical or symlink escapes.
 *
 * The returned path keeps its lexical spelling so a generated-file rename can
 * replace an in-workspace symlink rather than unexpectedly writing through it.
 * Validation resolves the nearest existing ancestor, so a missing output below
 * a symlinked directory is checked against the symlink's real destination.
 *
 * @category validation
 * @since 0.1.0
 */
export const resolveWorkspacePath = (workspaceRoot: string, value: string): string => {
  const root = NodeFs.realpathSync(NodePath.resolve(workspaceRoot))
  const absolute = NodePath.resolve(root, value)
  if (!inside(root, absolute) || !inside(root, realpath(absolute))) {
    throw new Error(`path leaves the workspace: ${value}`)
  }
  return absolute
}

/**
 * The extensions Windows appends to a bare command name when the host sets no
 * `PATHEXT`, in the order `cmd.exe` tries them.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultPathExtensions = ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC"

/**
 * The extensions `CreateProcess` cannot launch: a batch file is script text
 * that only `cmd.exe` knows how to run.
 *
 * libuv searches `PATH` for a bare command name itself, but its walk appends
 * only `.com` and `.exe` — deliberately, because the other `PATHEXT` entries
 * are not executable images. That is the whole of the Windows defect: pnpm
 * installs as `pnpm.cmd`, the walk finds no `pnpm.exe`, and every rule that
 * spelled `["pnpm", "exec", …]` died with `spawn pnpm ENOENT`.
 */
const cmdInterpretedExtensions: ReadonlySet<string> = new Set([".BAT", ".CMD"])

/**
 * Reads one environment value the way Windows does: by folded name.
 *
 * `process.env` already folds on a Windows host, but a record handed in by a
 * caller — a resolved Nix closure, a test — does not, and `Path` beside
 * `PATH` is what a real Windows environment block holds.
 */
const windowsEnvironmentValue = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined => {
  const folded = name.toUpperCase()
  const found = Object.keys(environment).find((entry) => entry.toUpperCase() === folded)
  return found === undefined ? undefined : environment[found]
}

/** The file names one Windows command may have, in the order the host tries them. */
const executableNames = (
  name: string,
  environment: Readonly<Record<string, string | undefined>>
): ReadonlyArray<string> => {
  const declared = windowsEnvironmentValue(environment, "PATHEXT")
  const extensions = (declared === undefined || declared.trim() === "" ? defaultPathExtensions : declared)
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
  // A command that already spells an extension is tried as written first, the
  // way `cmd.exe` does; only then are the `PATHEXT` extensions appended.
  const names = NodePath.extname(name) === "" ? [] : [name]
  for (const extension of extensions) names.push(`${name}${extension}`)
  return [...new Set(names)]
}

/** Whether one directory entry is a file this host would run. */
const isExecutableFile = (candidate: string): boolean => {
  try {
    NodeFs.accessSync(candidate, NodeFs.constants.X_OK)
    return NodeFs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** The POSIX search, unchanged: one candidate name, matched exactly. */
const findAllOnPosixPath = (
  name: string,
  environment: Readonly<Record<string, string | undefined>>
): ReadonlyArray<string> => {
  const found: Array<string> = []
  const environmentPath = environment["PATH"] ?? ""
  for (const entry of environmentPath.split(NodePath.delimiter)) {
    if (entry === "") continue
    const candidate = NodePath.join(entry, name)
    if (isExecutableFile(candidate) && !found.includes(candidate)) found.push(candidate)
  }
  return found
}

/**
 * The Windows search: `PATHEXT` candidates matched case-insensitively.
 *
 * The directory is listed rather than probed name by name because Windows
 * folds case in both halves of the answer — pnpm ships `pnpm.cmd` while the
 * default `PATHEXT` spells `.CMD` — and a probe would depend on the host
 * filesystem's own folding to agree. Listing gives the same answer on every
 * filesystem, which is what lets a POSIX host compute this at all.
 */
const findAllOnWindowsPath = (
  name: string,
  environment: Readonly<Record<string, string | undefined>>
): ReadonlyArray<string> => {
  const found: Array<string> = []
  const environmentPath = windowsEnvironmentValue(environment, "PATH") ?? ""
  const names = executableNames(name, environment)
  for (const entry of environmentPath.split(";")) {
    if (entry === "") continue
    let listing: ReadonlyArray<string>
    try {
      listing = NodeFs.readdirSync(entry)
    } catch {
      continue
    }
    // NTFS preserves case and refuses two entries that differ only in it, so
    // one folded name has one directory entry on any host that can be Windows.
    const byFoldedName = new Map<string, string>()
    for (const file of listing) byFoldedName.set(file.toUpperCase(), file)
    for (const candidate of names) {
      const actual = byFoldedName.get(candidate.toUpperCase())
      if (actual === undefined) continue
      const path = NodePath.join(entry, actual)
      if (!isExecutableFile(path)) continue
      if (!found.includes(path)) found.push(path)
      break
    }
  }
  return found
}

/**
 * Every `PATH` entry holding an executable named `name`, in `PATH` order.
 *
 * `platform` and `environment` are parameters rather than ambient reads so a
 * POSIX host can compute the Windows answer, which is the only way this is
 * testable off Windows. POSIX behaviour is unchanged: one candidate name,
 * matched exactly, no `PATHEXT` and no folding.
 *
 * @category tools
 * @since 0.1.0
 */
export const findAllOnPath = (
  name: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options?: { readonly platform?: NodeJS.Platform | undefined }
): ReadonlyArray<string> =>
  (options?.platform ?? process.platform) === "win32"
    ? findAllOnWindowsPath(name, environment)
    : findAllOnPosixPath(name, environment)

/**
 * The absolute path of one executable on `PATH`, or undefined.
 *
 * @category tools
 * @since 0.1.0
 */
export const findOnPath = (
  name: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options?: { readonly platform?: NodeJS.Platform | undefined }
): string | undefined => findAllOnPath(name, environment, options)[0]

/**
 * The file, arguments, and Windows quoting mode one argv spawns with.
 *
 * @category models
 * @since 0.1.0
 */
export interface SpawnShape {
  /** The executable image handed to `CreateProcess` or `execvp`. */
  readonly file: string
  /** The arguments handed alongside it. */
  readonly args: ReadonlyArray<string>
  /** Whether the host must pass the command line through unquoted. */
  readonly windowsVerbatimArguments: boolean
}

/**
 * Characters no `cmd.exe` command line can carry faithfully.
 *
 * A quote toggles cmd's own quoting state before the target program's parser
 * ever sees it, `%` is expanded inside quotes as well as outside, and a line
 * break ends the command. There is no escape for any of them inside the
 * quoted region a batch shim needs, so an argument holding one is refused by
 * name rather than silently executed as something else.
 */
const unencodableForCmd = /["%\r\n]/

/** Quotes one argument for the CRT parser inside a `cmd.exe` command line. */
const quoteForCmd = (value: string): string => {
  if (unencodableForCmd.test(value)) {
    throw new TypeError(
      `argument ${JSON.stringify(value)} cannot reach a Windows .cmd shim: ` +
        "a quote, percent sign, or line break has no faithful encoding through cmd.exe"
    )
  }
  // Backslashes are only special before a quote, so only a trailing run — the
  // run that would escape the closing quote — has to be doubled.
  return `"${value.replace(/(\\*)$/, "$1$1")}"`
}

/**
 * The spawn one argv needs on this host.
 *
 * POSIX spawns `argv[0]` exactly as declared, which is what every host did
 * before Windows was in the matrix. Windows resolves a bare command name on
 * the child's own `PATH` first, so a `PATHEXT` extension libuv does not walk
 * is found, and routes a batch shim through `ComSpec` — Node has refused to
 * spawn `.bat` and `.cmd` without a shell since the v18 hardening, and a
 * shell that quotes for us is a shell that decides our quoting. The line is
 * built here instead: every argument is quoted for the CRT parser, the whole
 * line is wrapped for `/s`, and the host is told to pass it through verbatim.
 *
 * @category execution
 * @since 0.1.0
 */
export const spawnShape = (
  argv: readonly [string, ...Array<string>],
  options?: {
    readonly platform?: NodeJS.Platform | undefined
    readonly env?: Readonly<Record<string, string | undefined>> | undefined
  }
): SpawnShape => {
  const [executable, ...args] = argv
  const platform = options?.platform ?? process.platform
  if (platform !== "win32") return { file: executable, args, windowsVerbatimArguments: false }
  const environment = options?.env ?? process.env
  const located = /[\\/:]/.test(executable)
    ? executable
    // An unresolvable name stays as declared so the host still reports the
    // `ENOENT` naming the command, rather than a second, invented diagnostic.
    : findOnPath(executable, environment, { platform }) ?? executable
  if (!cmdInterpretedExtensions.has(NodePath.extname(located).toUpperCase())) {
    return { file: located, args, windowsVerbatimArguments: false }
  }
  const line = [located, ...args].map(quoteForCmd).join(" ")
  return {
    file: windowsEnvironmentValue(environment, "ComSpec") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true
  }
}

/**
 * Bounded head and tail of one decoded stream.
 *
 * The decoder is per stream and stateful. `Buffer.toString("utf8")` on each
 * chunk independently is wrong for the same reason reading a stream one packet
 * at a time is: a code point split across a chunk boundary decodes as two
 * replacement characters, so the captured text depends on how the kernel
 * happened to break the pipe up. That made one tool's output differ between
 * runs, and a cached result differ from the run that produced it. A streaming
 * decoder holds the partial sequence until the rest of it arrives.
 *
 * @category models
 * @since 0.1.0
 */
interface Capture {
  readonly decoder: TextDecoder
  head: string
  headComplete: boolean
  tail: string
}

const capture = (): Capture => ({ decoder: new TextDecoder("utf-8"), head: "", headComplete: false, tail: "" })

/** Adds decoded text to the bounded prefix exactly until its first overflow. */
const appendHead = (target: Capture, text: string): void => {
  if (target.headComplete) return
  const remaining = outputLimit - target.head.length
  if (text.length <= remaining) {
    target.head += text
    return
  }
  target.head += head(text, remaining)
  // When the boundary splits a pair, `head` deliberately leaves one code unit
  // unused. That slot may not be filled from a later chunk: doing so would make
  // the captured prefix depend on where the kernel split the pipe.
  target.headComplete = true
}

/** Adds one stream chunk while keeping only bounded head and tail buffers. */
const append = (target: Capture, chunk: Uint8Array): void => {
  const text = target.decoder.decode(chunk, { stream: true })
  if (text === "") return
  appendHead(target, text)
  target.tail = keepTail(target.tail + text, stderrTailLimit)
}

/** Flushes any trailing partial sequence as the replacement character. */
const finish = (target: Capture): void => {
  const text = target.decoder.decode()
  if (text === "") return
  appendHead(target, text)
  target.tail = keepTail(target.tail + text, stderrTailLimit)
}

interface Spawned {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTail: string
  readonly stderrTail: string
}

/**
 * Spawns argv in the resolved directory through the shape {@link spawnShape}
 * settles. The supervisor keeps cleanup independent of target exit and pipe
 * EOF; native Windows batch arguments retain their exact existing quoting.
 */
const spawnTool = (
  cwd: string,
  payload: Payload,
  sensitiveEnv: ReadonlyArray<string>,
  secretEnv: Readonly<Record<string, string>>,
  onStdout?: ((chunk: Uint8Array) => void) | undefined,
  onStderr?: ((chunk: Uint8Array) => void) | undefined,
  base?: ToolEnvironment | undefined
): Effect.Effect<Spawned, ExecError> =>
  Effect.suspend(() => {
    const stdout = capture()
    const stderr = capture()
    const failure = (message: string, code: ExecFailureCode, signal?: string) => {
      finish(stdout)
      finish(stderr)
      return execError({
        argv: payload.argv,
        cwd: payload.cwd,
        exitCode: -1,
        code,
        ...(signal === undefined ? {} : { signal }),
        stdout: stdout.tail,
        stderr: tail(message)
      })
    }
    const program = Effect.gen(function*() {
      const env = toolEnvironment(payload.env, sensitiveEnv, secretEnv, base)
      const shape = yield* Effect.try({
        try: () => spawnShape(payload.argv, { env }),
        catch: (cause) => failure(failureMessage(cause), "spawn_failed")
      })
      const handle = yield* ScopedProcess.spawn({
        command: shape.file,
        args: shape.args,
        cwd,
        env,
        stdin: "ignore",
        killSignal: "SIGKILL",
        forceKillAfter: 0,
        windowsVerbatimArguments: shape.windowsVerbatimArguments
      }).pipe(Effect.mapError((cause) => {
        // ENOENT can describe the cwd as well as the executable. Check the cwd
        // explicitly so the first-run diagnostic identifies the missing input.
        const detail = failureMessage(cause.cause ?? cause)
        return failure(
          !NodeFs.existsSync(cwd)
            ? `${detail} (the working directory ${cwd} does not exist)`
            : detail,
          "spawn_failed"
        )
      }))
      const consume = (
        source: typeof handle.stdout,
        capture: Capture,
        name: "stdout" | "stderr",
        observer: ((chunk: Uint8Array) => void) | undefined
      ) =>
        source.pipe(
          Stream.runForEach((chunk) =>
            Effect.try({
              try: () => {
                append(capture, chunk)
                try {
                  observer?.(chunk)
                } catch {
                  // Optional progress output cannot change the captured result.
                }
              },
              catch: (cause) => failure(`${name} could not be read: ${failureMessage(cause)}`, "stream_failed")
            })
          ),
          Effect.mapError((cause) =>
            cause._tag === "smithers-build/ExecError" ?
              cause :
              failure(`${name} could not be read: ${failureMessage(cause.cause ?? cause)}`, "stream_failed")
          )
        )
      const [status] = yield* Effect.all([
        ScopedProcess.status(handle).pipe(
          Effect.mapError((cause) => failure(failureMessage(cause.cause ?? cause), "stream_failed"))
        ),
        consume(handle.stdout, stdout, "stdout", onStdout),
        consume(handle.stderr, stderr, "stderr", onStderr)
      ], { concurrency: "unbounded" })
      finish(stdout)
      finish(stderr)
      if (status.signal !== null) {
        return yield* Effect.fail(failure(
          `${stderr.tail}\nthe tool was terminated by ${status.signal}`,
          "signaled",
          status.signal
        ))
      }
      return {
        exitCode: status.code ?? -1,
        stdout: stdout.head,
        stderr: stderr.head,
        stdoutTail: stdout.tail,
        stderrTail: stderr.tail
      }
    })
    return Effect.scoped(
      payload.timeoutMs === "unbounded" ? program : program.pipe(
        Effect.timeoutOrElse({
          duration: payload.timeoutMs,
          orElse: () => {
            finish(stderr)
            return Effect.fail(failure(
              `${stderr.tail}\nthe tool timed out after ${payload.timeoutMs}ms`,
              "timed_out"
            ))
          }
        })
      )
    )
  })

/**
 * Mints placeholders for one run's declared secrets and brackets the spawn with
 * the substituting proxy.
 *
 * The vault lives exactly as long as the child. Nothing is minted when the
 * payload declares no secret, so the ordinary tool run starts no server and
 * pays nothing.
 *
 * The child receives the placeholder under the declared variable name and the
 * proxy endpoint under the conventional proxy variables. It never receives the
 * credential, so a tool that dumps its environment, writes it to a log, or
 * passes it to a subprocess leaks a value that is worthless off this host.
 * Each `S.SecretOrigin(audience)` token in argv or env is replaced with the
 * loopback origin the proxy brokers for that audience, and `use` receives the
 * payload with those replacements.
 */
const withSecretEnvironment = <A, E>(
  payload: Payload,
  diagnostic: { readonly argv: readonly [string, ...Array<string>]; readonly cwd: string },
  use: (secretEnv: Readonly<Record<string, string>>, payload: Payload) => Effect.Effect<A, E>
): Effect.Effect<A, E | ExecError> => {
  if (payload.secrets.length === 0) return use({}, payload)
  const vault = SecretProxy.makeVault()
  const minted: Record<string, string> = {}
  for (const binding of payload.secrets) minted[binding.secret.env] = vault.mint(binding)
  const proxyFailed = (what: string) => (cause: unknown) =>
    execError({
      argv: diagnostic.argv,
      cwd: diagnostic.cwd,
      exitCode: -1,
      code: "secret_proxy_failed",
      stdout: "",
      stderr: tail(`${what}: ${failureMessage(cause)}`)
    })
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => SecretProxy.startProxy(vault),
      catch: proxyFailed("the secret substitution proxy did not start")
    }),
    (proxy) =>
      Effect.flatMap(
        Effect.tryPromise({
          try: async () => {
            // Each brokered-origin token becomes the loopback origin that
            // forwards to its audience. The port exists only now, which is why
            // the plan carries the token and not the address.
            const origins = new Map<string, string>()
            for (const value of [...payload.argv, ...Object.values(payload.env)]) {
              for (const origin of Secret.secretOriginsIn(value)) {
                if (!origins.has(origin)) origins.set(origin, await proxy.originFor(origin))
              }
            }
            const brokered = (value: string): string =>
              value.replace(Secret.secretOriginPattern, (_token, origin: string) => origins.get(origin)!)
            const [executable, ...args] = payload.argv
            const env: Record<string, string> = {}
            for (const [name, value] of Object.entries(payload.env)) env[name] = brokered(value)
            return { ...payload, argv: [brokered(executable), ...args.map(brokered)], env } satisfies Payload
          },
          catch: proxyFailed("the secret substitution proxy could not bind a brokered origin")
        }),
        (resolved) => {
          const secretEnv: Record<string, string> = {
            ...minted,
            HTTP_PROXY: proxy.endpoint,
            HTTPS_PROXY: proxy.endpoint
          }
          // NODE_USE_ENV_PROXY stays unset: with it, Node rejects a request a
          // tool addresses to the proxy in absolute form itself. Node and Go
          // clients skip the proxy for loopback, so they reach a loopback
          // audience through S.SecretOrigin like any HTTPS audience.
          // Tools split on which spelling they read, and a host with
          // case-insensitive environment variables would see the two as one name.
          if (process.platform !== "win32") {
            secretEnv["http_proxy"] = proxy.endpoint
            secretEnv["https_proxy"] = proxy.endpoint
          }
          return use(secretEnv, resolved)
        }
      ),
    (proxy) => Effect.promise(() => proxy.close())
  )
}

/**
 * Executes one payload with workspace confinement and bounded stream capture.
 *
 * This shared implementation backs both sealed and irreversible exec actions.
 * It strips the remote-cache credential after merging the payload environment,
 * so a PACKAGE.ts declaration cannot add the credential back to a child.
 *
 * @category execution
 * @since 0.1.0
 */
export const run = (
  options: {
    readonly workspaceRoot: string
    readonly cacheDirectory?: string | undefined
    readonly sensitiveEnv?: ReadonlyArray<string> | undefined
    /** The resolved Nix closure whose PATH replaces the host's, when one is declared. */
    readonly environment?: ToolEnvironment | undefined
    /**
     * The confinement this run executes under. Absent, the tool runs
     * unconfined; present, the host enforces it or the run fails closed with
     * `sandbox_unenforceable`.
     */
    readonly sandbox?: ExecSandbox.Request | undefined
    /** Receives stdout bytes as the child produces them. */
    readonly onStdout?: ((chunk: Uint8Array) => void) | undefined
    /** Receives stderr bytes as the child produces them. */
    readonly onStderr?: ((chunk: Uint8Array) => void) | undefined
  },
  untrustedPayload: Payload
): Effect.Effect<Result, ExecError> => {
  const diagnostic = declaredDiagnostic(untrustedPayload)
  return Effect.flatMap(
    Effect.try({
      try: () => {
        const payload = validatedPayload(untrustedPayload)
        const sensitiveEnv = validatedSensitiveNames(options.sensitiveEnv ?? [])
        const cacheDirectory = options.cacheDirectory === undefined
          ? Config.defaultCacheDirectory
          : Config.normalizeCacheDirectory(options.cacheDirectory)
        // The token is replaced by a real host directory that a tool will then
        // write into, so the directory gets the same confinement check every
        // other path crossing this boundary gets. `normalizeCacheDirectory`
        // settles the lexical question only: a `.flows` that is a symbolic
        // link to somewhere else entirely is refused here.
        const cacheRoot = resolveWorkspacePath(options.workspaceRoot, cacheDirectory)
        const substitute = (value: string): string =>
          resolveScriptToken(
            value.replaceAll(cacheDirectoryToken, cacheRoot).replaceAll(runtimeBinToken, process.execPath)
          )
        const [executable, ...args] = payload.argv
        const resolved: Payload = {
          ...payload,
          argv: [substitute(executable), ...args.map(substitute)]
        }
        const cwd = resolveWorkspacePath(options.workspaceRoot, resolved.cwd)
        const confinement = options.sandbox === undefined
          ? undefined
          : ExecSandbox.plan(
            options.sandbox,
            {
              workspaceRoot: NodeFs.realpathSync(NodePath.resolve(options.workspaceRoot)),
              cwd,
              tmp: NodePath.join(cacheRoot, "sandbox", sandboxRunId())
            },
            ProcessSandbox.host()
          )
        return { resolved, sensitiveEnv, cwd, confinement }
      },
      catch: (cause) =>
        execError({
          argv: diagnostic.argv,
          cwd: diagnostic.cwd,
          exitCode: -1,
          code: "invalid_payload",
          stdout: "",
          stderr: tail(failureMessage(cause))
        })
    }),
    ({ confinement, cwd, resolved, sensitiveEnv }) => {
      if (ProcessSandbox.isUnenforceable(confinement)) {
        return Effect.fail(
          execError({
            argv: resolved.argv,
            cwd: resolved.cwd,
            exitCode: -1,
            code: "sandbox_unenforceable",
            stdout: "",
            stderr: tail(confinement.message)
          })
        )
      }
      if (confinement !== undefined && confinement.mechanism._tag === "docker" && resolved.secrets.length > 0) {
        return Effect.fail(
          execError({
            argv: resolved.argv,
            cwd: resolved.cwd,
            exitCode: -1,
            code: "sandbox_unenforceable",
            stdout: "",
            stderr: tail(
              "sandbox: the docker mechanism cannot reach the loopback secret proxy, so a target that declares " +
                "secrets needs the native mechanism (bubblewrap on Linux, seatbelt on macOS)"
            )
          })
        )
      }
      if (confinement !== undefined && confinement.network === "none" && resolved.secrets.length > 0) {
        return Effect.fail(
          execError({
            argv: resolved.argv,
            cwd: resolved.cwd,
            exitCode: -1,
            code: "sandbox_unenforceable",
            stdout: "",
            stderr: tail(
              "sandbox: a closed network cannot reach the loopback secret proxy, so a target that declares " +
                "secrets needs sandbox: { network: \"loopback\" } on macOS or sandbox: { network: true } on Linux"
            )
          })
        )
      }
      return withSecretEnvironment(resolved, diagnostic, (secretEnv, brokered) =>
        Effect.flatMap(
          confined(confinement, cwd, brokered, sensitiveEnv, secretEnv, options),
          (output) =>
            resolved.expectedExitCodes.includes(output.exitCode)
              ? Effect.succeed({
                exitCode: output.exitCode,
                stdout: output.stdout,
                stderr: output.stderr
              })
              : Effect.fail(
                execError({
                  argv: resolved.argv,
                  cwd: resolved.cwd,
                  exitCode: output.exitCode,
                  code: "exit_status",
                  stdout: output.stdoutTail,
                  stderr: tail(annotate(confinement, output.stderrTail))
                })
              )
        ))
    }
  )
}

/** A name for one confined run's private host directory. */
const sandboxRunId = (): string => `${process.pid.toString(36)}-${Date.now().toString(36)}-${runCounter++}`
let runCounter = 0

/** Appends the sandbox's reading of a failed run's output, when it has one. */
const annotate = (confinement: ExecSandbox.Plan | undefined, stderr: string): string => {
  if (confinement === undefined) return stderr
  const note = ProcessSandbox.diagnose(confinement, stderr)
  return note === undefined ? stderr : `${stderr}\n${note}`
}

/**
 * Spawns the tool inside its confinement. The host directory the run may
 * scribble in is created first and removed however the run ends; the declared
 * write directories are created so the mechanism has something to bind. The
 * wrapper's argv never reaches a diagnostic: an error carries the tool's own
 * argv, the way an unconfined run reports it.
 */
const confined = (
  confinement: ExecSandbox.Plan | undefined,
  cwd: string,
  resolved: Payload,
  sensitiveEnv: ReadonlyArray<string>,
  secretEnv: Readonly<Record<string, string>>,
  options: {
    readonly environment?: ToolEnvironment | undefined
    readonly onStdout?: ((chunk: Uint8Array) => void) | undefined
    readonly onStderr?: ((chunk: Uint8Array) => void) | undefined
  }
): Effect.Effect<Spawned, ExecError> => {
  if (confinement === undefined) {
    return spawnTool(cwd, resolved, sensitiveEnv, secretEnv, options.onStdout, options.onStderr, options.environment)
  }
  const preparationError = (cause: unknown): ExecError =>
    execError({
      argv: resolved.argv,
      cwd: resolved.cwd,
      exitCode: -1,
      code: "spawn_failed",
      stdout: "",
      stderr: tail(`sandbox: could not prepare the confinement: ${failureMessage(cause)}`)
    })
  const prepare = Effect.try({
    try: () => {
      ProcessSandbox.validateWrites(confinement)
      NodeFs.mkdirSync(NodePath.join(confinement.tmp, "home"), { recursive: true })
      NodeFs.mkdirSync(NodePath.join(confinement.tmp, "cache"), { recursive: true })
      for (const write of confinement.writes) NodeFs.mkdirSync(write, { recursive: true })
      const base = toolEnvironment(resolved.env, sensitiveEnv, secretEnv, options.environment)
      const visible: Record<string, string> = {}
      for (const [name, value] of Object.entries(base)) if (typeof value === "string") visible[name] = value
      const wrapped = ProcessSandbox.wrap(confinement, resolved.argv, visible)
      return {
        containerName: wrapped.containerName,
        payload: {
          ...resolved,
          argv: wrapped.argv as [string, ...Array<string>],
          env: { ...resolved.env, ...wrapped.env }
        }
      }
    },
    catch: preparationError
  })
  return Effect.scoped(Effect.gen(function*() {
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => NodeFs.mkdirSync(confinement.tmp, { recursive: true }),
        catch: preparationError
      }),
      () =>
        Effect.sync(() => {
          try {
            NodeFs.rmSync(confinement.tmp, { recursive: true, force: true })
          } catch {
            // Cleanup is best-effort when the host refuses directory removal.
          }
        })
    )
    const { containerName, payload } = yield* prepare
    if (containerName !== undefined && confinement.mechanism._tag === "docker") {
      const executable = confinement.mechanism.executable
      // Register before spawning, including interrupted/failed startup. The
      // nested client scope closes first; removal finishes before scratch cleanup.
      yield* Effect.addFinalizer(() =>
        spawnTool(
          cwd,
          {
            ...payload,
            argv: [executable, "rm", "--force", containerName],
            timeoutMs: 5000
          },
          sensitiveEnv,
          secretEnv,
          undefined,
          undefined,
          options.environment
        ).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.logWarning(`sandbox: could not remove docker container ${containerName}: ${error.code}`),
            onSuccess: (output) =>
              output.exitCode === 0
                ? Effect.void
                : Effect.logWarning(
                  `sandbox: could not remove docker container ${containerName}: exit ${output.exitCode}`
                )
          })
        )
      )
    }
    return yield* spawnTool(
      cwd,
      payload,
      sensitiveEnv,
      secretEnv,
      options.onStdout,
      options.onStderr,
      options.environment
    ).pipe(
      Effect.mapError((error) => ({
        ...error,
        argv: resolved.argv,
        stderr: tail(annotate(confinement, error.stderr))
      }))
    )
  }))
}

/**
 * Implements {@link Exec} with `node:child_process` spawn.
 *
 * The payload `cwd` resolves inside the real workspace root. The payload `env`
 * merges over only the host variables needed for executable lookup, temporary
 * files, and operating-system startup; arbitrary ambient variables are not
 * exposed. Fixed locale and no-color values make output stable. The boundary
 * then drops both built-in remote-cache variables and every name in
 * `sensitiveEnv`, even when the payload tried to add one back. Any
 * {@link cacheDirectoryToken} in an argument is replaced by the host directory
 * immediately before spawn, keeping the real path out of the action payload
 * and step key. That directory is confined to the workspace first, symbolic
 * links included, so substitution can never hand a tool a path outside it.
 * Killing the fiber or reaching `timeoutMs` kills the child's process group.
 *
 * @category layers
 * @since 0.1.0
 */
export const ExecLive = (options: {
  readonly workspaceRoot: string
  readonly cacheDirectory?: string | undefined
  readonly sensitiveEnv?: ReadonlyArray<string> | undefined
  /** The resolved Nix closure whose PATH replaces the host's, when one is declared. */
  readonly environment?: ToolEnvironment | undefined
  /** The confinement every exec of this target runs under; see {@link ExecSandbox}. */
  readonly sandbox?: ExecSandbox.Request | undefined
  /** Observer-only progress; result capture and failure tails are unchanged. */
  readonly onStdout?: ((chunk: Uint8Array) => void) | undefined
  /** Observer-only progress; result capture and failure tails are unchanged. */
  readonly onStderr?: ((chunk: Uint8Array) => void) | undefined
}): Layer.Layer<Action.Requirement<"smithers-build/exec">, never, FlowRuntime.FlowRuntime> =>
  Exec.toLayer((payload) => run(options, payload))
