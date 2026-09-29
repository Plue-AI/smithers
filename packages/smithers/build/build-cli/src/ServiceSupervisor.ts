/**
 * Scoped supervisor for `S.Shell.Serve` services.
 *
 * A `services` edge means: acquire the Serve target, await bounded readiness,
 * keep probing its health while consumers run, scope it to them, and always
 * release it through the declared stop contract. This module owns that
 * lifecycle. The executor resolves a Serve target's attrs into a
 * {@link ServiceSpec} and calls {@link ServiceSupervisor.acquire} inside the
 * consumer's scope; the consumer's work runs under
 * {@link ServiceHandle.whileHealthy} so a service that dies or stops answering
 * fails the consumer with the tail of the captured server output instead of
 * hanging it.
 *
 * Lifetime is scope-based throughout (repo rule: no threaded `AbortSignal`s).
 * One supervisor is created per CLI command; services are reference-counted by
 * `key` through an `RcMap`, so two consumers of one Serve target share one
 * spawn and the process group is stopped when the last consumer's scope
 * closes — on success, on failure, and on interruption alike. A separate
 * process owner enforces that deadline after target exit and after the host
 * loses its private connection; raw numeric-PID backstops are unnecessary.
 *
 * @since 0.1.0
 */

import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import { inheritedEnvironmentNames } from "@smthrs/targets/Exec"
import * as Secret from "@smthrs/targets/Secret"
import * as SecretProxy from "@smthrs/targets/SecretProxy"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as RcMap from "effect/RcMap"
import * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { randomUUID } from "node:crypto"
import * as NodeHttp from "node:http"
import * as NodeHttps from "node:https"
import * as NodeNet from "node:net"
import * as NodePath from "node:path"
import * as NodeUtil from "node:util/types"
import type * as OutputStream from "./OutputStream.ts"

/**
 * Optional command-scoped progress observers; service capture and readiness are independent.
 * @category services
 * @since 1.0.0
 */
export const Output = Context.Reference<(spec: ServiceSpec) => OutputStream.Observer | undefined>(
  "smithers-build/ServiceOutput",
  { defaultValue: () => () => undefined }
)

/**
 * The readiness probe of a Serve target: an open TCP port on the loopback
 * interface, or an HTTP GET whose response status below 500 means ready.
 * Structurally identical to the decoded `Attr.Readiness` union, so executor
 * code passes Serve attrs through unchanged.
 *
 * @category models
 * @since 0.1.0
 */
export type Readiness =
  | { readonly port: number }
  | { readonly http: string; readonly timeout: string }
  | { readonly exec: ReadonlyArray<string>; readonly timeout: string }

/**
 * The health contract of a Serve target: the readiness probe repeated on an
 * interval while consumers run, with `failures` consecutive misses marking
 * the service unhealthy. Structurally identical to the decoded `Attr.Health`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Health {
  readonly interval: string
  readonly failures?: number | undefined
}

/**
 * The stop contract of a Serve target: the graceful-exit signal and the grace
 * period applied before the process group is killed. Structurally identical
 * to the decoded `Attr.Stop`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Stop {
  readonly signal: string
  readonly grace: string
}

/**
 * One resolved Serve target as the supervisor consumes it.
 *
 * The executor derives this from a Serve target's decoded attrs at the
 * integration seam: `key` is the target's label (the refcount identity — two
 * consumers naming one label share one spawn), `cwd` is the
 * workspace-resolved absolute package directory, `argv` is the resolved
 * executable and arguments, and `readiness`/`health`/`stop` are the Serve
 * probe attrs passed through unchanged.
 *
 * @category models
 * @since 0.1.0
 */
export interface ServiceSpec {
  readonly key: string
  readonly cwd: string
  readonly argv: readonly [string, ...Array<string>]
  /**
   * Docker container name prefix, scoped to the invocation. When present,
   * argv is the Docker executable followed by create options/image/command;
   * exec readiness and init are container commands. Each shared lifetime gets
   * a unique name, and all operations after creation address its returned ID.
   */
  readonly docker?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Destination-bound credentials exposed only as proxy placeholders. */
  readonly secrets?: ReadonlyArray<Secret.HttpCredential> | undefined
  /**
   * Argv positions that receive loopback egress URLs. The real URL is read
   * from the declaration only when the service requests the loopback URL.
   */
  readonly secretUrls?:
    | ReadonlyArray<{
      readonly index: number
      readonly secret: Secret.Secret
    }>
    | undefined
  readonly readiness?: Readiness | undefined
  readonly health?: Health | undefined
  readonly stop?: Stop | undefined
  /**
   * Best-effort commands run before the process is spawned. Hooks may touch
   * only resources owned by this invocation; a matching target label or
   * working directory does not establish ownership across commands.
   */
  readonly prepare?: ReadonlyArray<readonly [string, ...Array<string>]> | undefined
  /** Commands run after readiness and before the service is handed to consumers. */
  readonly init?: ReadonlyArray<readonly [string, ...Array<string>]> | undefined
  /** Best-effort commands run during finalization after the process stop contract. */
  readonly cleanup?: ReadonlyArray<readonly [string, ...Array<string>]> | undefined
}

/**
 * A service acquisition or supervision failure.
 *
 * `outputTail` carries the trailing captured server output so a consumer
 * failed by its service sees what the server last said.
 *
 * @category errors
 * @since 0.1.0
 */
export class ServiceError extends Data.TaggedError("smithers-build/ServiceError")<{
  readonly key: string
  readonly reason:
    | "invalid-spec"
    | "spec-drift"
    | "spawn-failed"
    | "exited"
    | "readiness-timeout"
    | "init-failed"
    | "unhealthy"
  readonly message: string
  readonly outputTail: string
}> {}

/**
 * A live, ready service held by one consumer's scope.
 *
 * @category models
 * @since 0.1.0
 */
export interface ServiceHandle {
  readonly key: string
  /** Process id of the actual shared service child. */
  readonly pid: number
  /** Trailing captured stdout+stderr of the service, for diagnostics. */
  readonly outputTail: () => string
  /**
   * Runs a consumer effect raced against the service's health: when the
   * service exits or its health probe misses `failures` times in a row, the
   * consumer is interrupted and the result fails with a `ServiceError`
   * carrying the output tail.
   */
  readonly whileHealthy: <A, E, R>(
    consumer: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | ServiceError, R>
}

/**
 * The per-command service supervisor.
 *
 * @category models
 * @since 0.1.0
 */
export interface ServiceSupervisor {
  /**
   * Acquires the service for a spec inside the current scope: spawns it in
   * its own process group on first acquisition (subsequent acquisitions of
   * the same `key` share it), awaits bounded readiness, and registers a
   * release on the scope that applies the stop contract when the last
   * consumer lets go.
   */
  readonly acquire: (spec: ServiceSpec) => Effect.Effect<ServiceHandle, ServiceError, Scope.Scope>
}

/**
 * Overall readiness deadline applied to `{port}` probes, which carry no
 * declared timeout of their own.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultReadinessTimeoutMs = 60_000

/**
 * Delay between readiness probe attempts.
 *
 * @category constants
 * @since 0.1.0
 */
export const readinessPollMs = 250

/**
 * Consecutive health-probe misses that mark a service unhealthy when the
 * declaration omits `failures`.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultHealthFailures = 3

/**
 * Graceful-exit signal applied when the declaration omits `stop`.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultStopSignal: NodeJS.Signals = "SIGTERM"

/**
 * Grace period before SIGKILL when the declaration omits `stop`.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultStopGraceMs = 5_000

/**
 * Maximum length of the captured output tail, in UTF-16 code units.
 *
 * @category constants
 * @since 0.1.0
 */
export const outputTailLimit = 8 * 1024

/** Per-attempt timeout of one TCP connect readiness probe. */
const portProbeAttemptMs = 1_000

/** Upper bound on one health-probe attempt regardless of interval. */
const probeAttemptCapMs = 10_000

/** Bound on waiting for a signalled child to actually report closed. */
const stopSettleMs = 5_000

const durationPattern = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/

/**
 * Parses a Serve duration attr such as `"500ms"`, `"15s"`, `"2m"`, or `"1h"`
 * into milliseconds. This module owns the parser because `Attr.ts` validates
 * these values only as non-empty strings; any other format is refused loudly.
 *
 * @category parsing
 * @since 0.1.0
 */
export const parseDurationMs = (text: string, what: string): number => {
  const match = durationPattern.exec(text.trim())
  if (match === null) {
    throw new Error(
      `${what} is not a duration: ${JSON.stringify(text)} (expected a value like "500ms", "15s", "2m", or "1h")`
    )
  }
  const factor = match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000
  const ms = Math.round(Number(match[1]) * factor)
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`${what} must be a positive duration: ${JSON.stringify(text)}`)
  }
  return ms
}

const signalPattern = /^SIG[A-Z0-9]{1,14}$/

/** The spec with every duration parsed and every default applied. */
interface ParsedSpec {
  readonly spec: ServiceSpec
  readonly readinessTimeoutMs: number
  readonly healthIntervalMs: number | undefined
  readonly healthFailures: number
  readonly stopSignal: NodeJS.Signals
  readonly stopGraceMs: number
  /** Canonical rendering of the spec, for same-key drift detection. */
  readonly canonical: string
}

/** Reads one caller field without invoking an accessor. */
const dataMember = (object: object, key: string, what: string): unknown => {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key)
  } catch {
    throw new TypeError(`${what} could not be inspected safely`)
  }
  if (descriptor === undefined) return undefined
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError(`${what} must be an enumerable data property`)
  }
  return descriptor.value
}

/** Returns inert own string keys, rejecting hooks that JSON could execute. */
const dataKeys = (value: object, what: string): ReadonlyArray<string> => {
  if (NodeUtil.isProxy(value)) throw new TypeError(`${what} must not be a proxy`)
  let keys: Array<string | symbol>
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    throw new TypeError(`${what} could not be inspected safely`)
  }
  if (keys.some((key) => typeof key === "symbol")) {
    throw new TypeError(`${what} must not contain symbol properties`)
  }
  const strings = keys as Array<string>
  if (strings.includes("toJSON")) throw new TypeError(`${what} must not define toJSON`)
  return strings
}

/** Rejects nested caller objects that could execute while being inspected. */
const inspectNested = (value: unknown, what: string): unknown => {
  if (typeof value === "object" && value !== null) dataKeys(value, what)
  return value
}

/** Copies one dense caller array through indexed data descriptors only. */
const snapshotArray = (
  value: unknown,
  what: string,
  copy: (entry: unknown, index: number) => unknown = (entry) => inspectNested(entry, what)
): unknown => {
  if (typeof value === "object" && value !== null && NodeUtil.isProxy(value)) {
    throw new TypeError(`${what} must not be a proxy`)
  }
  if (!Array.isArray(value)) return inspectNested(value, what)
  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(value) as object | null
  } catch {
    throw new TypeError(`${what} could not be inspected safely`)
  }
  if (prototype !== Array.prototype) throw new TypeError(`${what} must be an array`)
  const keys = dataKeys(value, what)
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length")
  if (
    lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
  ) {
    throw new TypeError(`${what} has an invalid length`)
  }
  const length = lengthDescriptor.value as number
  if (keys.length !== length + 1) {
    throw new TypeError(`${what} must be a dense array without extra properties`)
  }
  const available = new Set(keys)
  const output: Array<unknown> = []
  for (let index = 0; index < length; index += 1) {
    if (!available.has(String(index))) {
      throw new TypeError(`${what} must be a dense array without extra properties`)
    }
    output.push(copy(dataMember(value, String(index), `${what}[${index}]`), index))
  }
  return Object.freeze(output)
}

/** Copies one nested record through its own enumerable data descriptors. */
const snapshotRecord = (
  value: unknown,
  what: string,
  allowed: ReadonlySet<string> | undefined,
  copy: (key: string, member: unknown) => unknown = (_key, member) => inspectNested(member, what)
): unknown => {
  if (typeof value === "object" && value !== null && NodeUtil.isProxy(value)) {
    throw new TypeError(`${what} must not be a proxy`)
  }
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) throw new TypeError(`${what} must be a plain object`)
  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(value) as object | null
  } catch {
    throw new TypeError(`${what} could not be inspected safely`)
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${what} must be a plain object`)
  }
  const keys = dataKeys(value, what)
  if (allowed !== undefined) {
    for (const key of keys) {
      if (!allowed.has(key)) throw new TypeError(`${what} contains an unknown property: ${key}`)
    }
  }
  return Object.freeze(Object.fromEntries(
    keys.map((key) => [key, copy(key, dataMember(value, key, `${what}.${key}`))])
  ))
}

/**
 * How one `ServiceSpec` field is copied and identified.
 *
 * `snapshot` rebuilds the caller's value from own enumerable data
 * descriptors. `canonical` renders the field into the same-key drift
 * identity, or is `undefined` for a field deliberately left out of it.
 */
interface SpecField {
  readonly snapshot: (value: unknown) => unknown
  readonly canonical: ((spec: ServiceSpec) => unknown) | undefined
}

/** Copies a list of argv lists, such as `prepare`, through data descriptors. */
const commandList = (what: string) => (value: unknown): unknown =>
  snapshotArray(value, what, (argv, index) => snapshotArray(argv, `${what}[${index}]`))

/**
 * Every `ServiceSpec` field, with its snapshot copy and its canonical
 * rendering.
 *
 * The map is keyed by `keyof ServiceSpec` with optionality stripped, so a new
 * field on the public interface does not compile until it states how it is
 * copied and whether it takes part in the same-key identity. The allowed-key
 * set, the frozen snapshot, and the drift identity all read this one table,
 * so a field cannot be validated in one of them and dropped by another.
 */
const serviceSpecFields: { readonly [K in keyof ServiceSpec]-?: SpecField } = {
  // The lookup key is the identity: two specs filed under one key have to
  // differ in some other field to count as drift.
  key: {
    snapshot: (value) => inspectNested(value, "service spec key"),
    canonical: undefined
  },
  cwd: {
    snapshot: (value) => inspectNested(value, "service spec cwd"),
    canonical: (spec) => spec.cwd
  },
  argv: {
    snapshot: (value) => snapshotArray(value, "service spec argv"),
    canonical: (spec) => spec.argv
  },
  docker: {
    snapshot: (value) => inspectNested(value, "service spec docker"),
    canonical: (spec) => spec.docker ?? null
  },
  env: {
    snapshot: (value) => snapshotRecord(value, "service spec env", undefined),
    canonical: (spec) =>
      Object.fromEntries(Object.entries(spec.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  },
  secrets: {
    snapshot: (value) => snapshotArray(value, "service spec secrets"),
    canonical: (spec) =>
      (spec.secrets ?? []).map(({ audiences, secret: { env, fallback } }) => ({
        env,
        fallback: fallback ?? null,
        audiences: [...audiences]
      }))
  },
  secretUrls: {
    snapshot: (value) =>
      snapshotArray(value, "service spec secretUrls", (entry, index) =>
        snapshotRecord(
          entry,
          `service spec secretUrls[${index}]`,
          new Set(["index", "secret"])
        )),
    canonical: (spec) =>
      (spec.secretUrls ?? []).map(({ index, secret: { env, fallback } }) => ({
        index,
        env,
        fallback: fallback ?? null
      }))
  },
  readiness: {
    snapshot: (value) =>
      snapshotRecord(
        value,
        "service spec readiness",
        new Set(["port", "http", "timeout", "exec"]),
        (key, member) =>
          key === "exec" ? snapshotArray(member, "service spec readiness.exec") : inspectNested(
            member,
            `service spec readiness.${key}`
          )
      ),
    canonical: (spec) =>
      spec.readiness === undefined
        ? null
        : "port" in spec.readiness
        ? { port: spec.readiness.port }
        : "http" in spec.readiness
        ? { http: spec.readiness.http, timeout: spec.readiness.timeout }
        : { exec: spec.readiness.exec, timeout: spec.readiness.timeout }
  },
  health: {
    snapshot: (value) => snapshotRecord(value, "service spec health", new Set(["interval", "failures"])),
    canonical: (spec) =>
      spec.health === undefined ? null : { failures: spec.health.failures ?? null, interval: spec.health.interval }
  },
  stop: {
    snapshot: (value) => snapshotRecord(value, "service spec stop", new Set(["signal", "grace"])),
    canonical: (spec) => spec.stop === undefined ? null : { grace: spec.stop.grace, signal: spec.stop.signal }
  },
  prepare: {
    snapshot: commandList("service spec prepare"),
    canonical: (spec) => spec.prepare ?? []
  },
  init: {
    snapshot: commandList("service spec init"),
    canonical: (spec) => spec.init ?? []
  },
  cleanup: {
    snapshot: commandList("service spec cleanup"),
    canonical: (spec) => spec.cleanup ?? []
  }
}

/** The field names a caller may declare, derived from the descriptor map. */
const serviceSpecKeys: ReadonlySet<string> = new Set(Object.keys(serviceSpecFields))

/** Renders the canonicalized fields in a stable order for drift detection. */
const canonicalize = (spec: ServiceSpec): string =>
  JSON.stringify(Object.fromEntries(
    Object.entries(serviceSpecFields)
      .flatMap(([key, field]) => field.canonical === undefined ? [] : [[key, field.canonical(spec)] as const])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  ))

/**
 * A frozen plain-data copy of the caller's spec.
 *
 * `parseSpec` used to validate the caller's object and hand the same reference
 * on, and `startService` then awaited secret resolution and the prepare hook
 * before re-reading argv, env, and readiness off it. A caller could therefore
 * change the command, or its declared capabilities, *after* the canonical
 * same-key identity had been computed from the earlier values, so the identity
 * and the thing it identified could disagree. Every copied container is now
 * rebuilt from own enumerable data descriptors, so validation executes no
 * caller getter, proxy trap, or JSON hook and later awaits read only the frozen
 * snapshot.
 *
 * Secret declarations are carried by reference on purpose: they are validated
 * by `Secret.isHttpCredential`/`Secret.isSecret` and the resolution boundary
 * matches them by identity.
 */
const snapshotSpec = (caller: ServiceSpec): ServiceSpec => {
  if (typeof caller !== "object" || caller === null || Array.isArray(caller) || NodeUtil.isProxy(caller)) {
    throw new TypeError("a service spec must be a plain object")
  }
  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(caller) as object | null
  } catch {
    throw new TypeError("a service spec could not be inspected safely")
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("a service spec must be a plain object")
  }
  for (const key of dataKeys(caller, "a service spec")) {
    if (!serviceSpecKeys.has(key)) throw new TypeError(`a service spec contains an unknown property: ${key}`)
  }
  // Every field is copied through the one descriptor table, so validation and
  // the snapshot cannot disagree about which fields exist. The assertion below
  // is safe because `parseSpec` type-checks each copied field afterwards.
  const snapshot: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(serviceSpecFields)) {
    const value = field.snapshot(dataMember(caller, key, `service spec ${key}`))
    if (value !== undefined) snapshot[key] = value
  }
  return Object.freeze(snapshot) as unknown as ServiceSpec
}

/** Reads a diagnostic key without invoking caller code. */
const diagnosticKey = (caller: ServiceSpec): string => {
  if (typeof caller !== "object" || caller === null || NodeUtil.isProxy(caller)) return "<invalid key>"
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(caller, "key")
  } catch {
    return "<invalid key>"
  }
  return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true &&
      typeof descriptor.value === "string" && descriptor.value !== ""
    ? descriptor.value
    : "<invalid key>"
}

/** Validates one spec and parses its durations, or throws the exact reason. */
const parseSpec = (caller: ServiceSpec): ParsedSpec => {
  const spec = snapshotSpec(caller)
  if (typeof spec.key !== "string" || spec.key === "") {
    throw new Error("a service spec requires a non-empty key")
  }
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || spec.argv.some((entry) => typeof entry !== "string")) {
    throw new Error(`service ${spec.key} requires a non-empty argv of strings`)
  }
  if (spec.argv[0] === "") throw new Error(`service ${spec.key} argv[0] must name an executable`)
  if (
    spec.docker !== undefined && (typeof spec.docker !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(spec.docker))
  ) {
    throw new Error(`service ${spec.key} docker must be a valid container name prefix`)
  }
  if (
    spec.env !== undefined && (
      typeof spec.env !== "object" || spec.env === null || Array.isArray(spec.env) ||
      Object.values(spec.env).some((value) => typeof value !== "string")
    )
  ) {
    throw new Error(`service ${spec.key} env must be a record of strings`)
  }
  if (
    spec.secrets !== undefined && (
      !Array.isArray(spec.secrets) || spec.secrets.some((secret) => !Secret.isHttpCredential(secret))
    )
  ) {
    throw new Error(`service ${spec.key} secrets must contain only secret declarations`)
  }
  if (
    spec.secretUrls !== undefined &&
    (!Array.isArray(spec.secretUrls) ||
      spec.secretUrls.some((entry) =>
        typeof entry !== "object" || entry === null ||
        !Number.isSafeInteger(entry.index) || entry.index < 1 || entry.index >= spec.argv.length ||
        !Secret.isSecret(entry.secret)
      ) || new Set(spec.secretUrls.map((entry) => entry.index)).size !== spec.secretUrls.length)
  ) {
    throw new Error(
      `service ${spec.key} secretUrls must contain unique, non-executable argv indexes and secret declarations`
    )
  }
  if (typeof spec.cwd !== "string" || !NodePath.isAbsolute(spec.cwd)) {
    throw new Error(`service ${spec.key} requires an absolute cwd; received ${JSON.stringify(spec.cwd)}`)
  }
  let readinessTimeoutMs = defaultReadinessTimeoutMs
  if (spec.readiness !== undefined && !("port" in spec.readiness)) {
    readinessTimeoutMs = parseDurationMs(spec.readiness.timeout, `service ${spec.key} readiness.timeout`)
    if ("http" in spec.readiness) {
      let parsed: URL
      try {
        parsed = new URL(spec.readiness.http)
      } catch {
        throw new Error(`service ${spec.key} readiness.http is not a URL: ${JSON.stringify(spec.readiness.http)}`)
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(
          `service ${spec.key} readiness.http must be an http(s) URL: ${JSON.stringify(spec.readiness.http)}`
        )
      }
    } else if (
      !Array.isArray(spec.readiness.exec) || spec.readiness.exec.length === 0 ||
      spec.readiness.exec.some((entry) => typeof entry !== "string" || entry === "")
    ) {
      throw new Error(`service ${spec.key} readiness.exec must be a non-empty argv of strings`)
    }
  }
  if (
    spec.readiness !== undefined && "port" in spec.readiness &&
    (!Number.isSafeInteger(spec.readiness.port) || spec.readiness.port < 1 || spec.readiness.port > 65_535)
  ) {
    throw new Error(`service ${spec.key} readiness.port is not a port: ${JSON.stringify(spec.readiness.port)}`)
  }
  let healthIntervalMs: number | undefined
  let healthFailures = defaultHealthFailures
  if (spec.health !== undefined) {
    if (spec.readiness === undefined) {
      throw new Error(
        `service ${spec.key} declares health but no readiness; health repeats the readiness probe, so declare one`
      )
    }
    healthIntervalMs = parseDurationMs(spec.health.interval, `service ${spec.key} health.interval`)
    if (spec.health.failures !== undefined) {
      if (!Number.isSafeInteger(spec.health.failures) || spec.health.failures < 1) {
        throw new Error(`service ${spec.key} health.failures must be a positive integer`)
      }
      healthFailures = spec.health.failures
    }
  }
  let stopSignal: NodeJS.Signals = defaultStopSignal
  let stopGraceMs = defaultStopGraceMs
  if (spec.stop !== undefined) {
    if (!signalPattern.test(spec.stop.signal)) {
      throw new Error(`service ${spec.key} stop.signal is not a signal name: ${JSON.stringify(spec.stop.signal)}`)
    }
    stopSignal = spec.stop.signal as NodeJS.Signals
    stopGraceMs = parseDurationMs(spec.stop.grace, `service ${spec.key} stop.grace`)
  }
  for (const [name, commands] of [["prepare", spec.prepare], ["init", spec.init], ["cleanup", spec.cleanup]] as const) {
    if (commands !== undefined) {
      if (
        !Array.isArray(commands) ||
        commands.some((argv) =>
          !Array.isArray(argv) || argv.length === 0 || argv.some((entry) => typeof entry !== "string" || entry === "")
        )
      ) {
        throw new Error(`service ${spec.key} ${name} must be an array of non-empty argv arrays`)
      }
    }
  }
  return {
    spec,
    readinessTimeoutMs,
    healthIntervalMs,
    healthFailures,
    stopSignal,
    stopGraceMs,
    canonical: canonicalize(spec)
  }
}

// ---------------------------------------------------------------------------
// Output capture
// ---------------------------------------------------------------------------

/** Whether slicing `text` at `index` would split a surrogate pair. */
const splitsPair = (text: string, index: number): boolean => {
  if (index <= 0 || index >= text.length) return false
  const high = text.charCodeAt(index - 1)
  const low = text.charCodeAt(index)
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
}

/** Keeps the trailing `limit` code units without splitting a surrogate pair. */
const keepTail = (text: string, limit: number): string => {
  if (text.length <= limit) return text
  const at = text.length - limit
  return text.slice(splitsPair(text, at) ? at + 1 : at)
}

/** Bounded, chronological tail of the service's combined output streams. */
interface TailCapture {
  readonly append: (chunk: Uint8Array, decoder: TextDecoder) => void
  readonly read: () => string
}

const tailCapture = (): TailCapture => {
  let text = ""
  return {
    append: (chunk, decoder) => {
      text = keepTail(text + decoder.decode(chunk, { stream: true }), outputTailLimit)
    },
    read: () => text
  }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

type Probe = { readonly ok: true } | { readonly ok: false; readonly reason: string }

const miss = (reason: string): Probe => ({ ok: false, reason })

/**
 * Where an exec probe runs: the service's own working directory and the same
 * resolved environment the service process was given.
 *
 * A probe used to inherit the CLI process's cwd and be handed
 * `serviceEnvironment(undefined)`, so a probe naming a relative executable or
 * reading a declared variable failed even though the identical command worked
 * in the service's own context. `healthLoop` reuses the probe, so a healthy
 * service was then reported unhealthy and torn down.
 */
interface ProbeContext {
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
}

/** Retains the native diagnostic instead of the platform wrapper's generic tag. */
const processError = (cause: unknown): string => {
  const error = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause
  return error instanceof Error ? error.message : String(error)
}

/** Distinguishes an expired bound from the command's own failure. */
class CommandTimeout extends Data.TaggedError("smithers-build/CommandTimeout")<{ readonly message: string }> {}

/** Captures one bounded command; the caller's scope owns process cleanup. */
const serviceCommand = (
  argv: ReadonlyArray<string>,
  context: ProbeContext,
  timeoutMs: number
): Effect.Effect<
  { readonly ok: boolean; readonly detail: string; readonly stdout: string; readonly timedOut: boolean },
  never,
  Scope.Scope
> =>
  Effect.suspend(() => {
    const output: Array<Uint8Array> = []
    const error: Array<Uint8Array> = []
    const program = Effect.gen(function*() {
      const handle = yield* ScopedProcess.spawn({
        command: argv[0]!,
        args: argv.slice(1),
        cwd: context.cwd,
        env: serviceEnvironment(context.environment),
        stdin: "ignore"
      })
      const collect = (source: typeof handle.stdout, chunks: Array<Uint8Array>, name: string) => {
        let size = 0
        return source.pipe(Stream.runForEach((chunk) =>
          Effect.try(() => {
            size += chunk.byteLength
            if (size > 1 << 20) throw new Error(`${name} maxBuffer length exceeded`)
            chunks.push(chunk)
          })
        ))
      }
      const [status] = yield* Effect.all([
        ScopedProcess.status(handle),
        collect(handle.stdout, output, "stdout"),
        collect(handle.stderr, error, "stderr")
      ], { concurrency: "unbounded" })
      const detail = `${Buffer.concat(output).toString("utf8")}${Buffer.concat(error).toString("utf8")}`.trim()
      return {
        ok: status.code === 0,
        timedOut: false,
        stdout: Buffer.concat(output).toString("utf8"),
        detail: detail || (status.signal === null
          ? status.code === 0 ? "" : `command exited with code ${status.code}`
          : `command terminated by ${status.signal}`)
      }
    })
    return program.pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(new CommandTimeout({ message: `the command timed out after ${timeoutMs}ms` }))
      }),
      Effect.catch((cause) =>
        Effect.succeed({
          ok: false,
          // Whatever the command managed to print can read like an ordinary
          // refusal, so the caller has to be able to say the bound expired.
          timedOut: cause instanceof CommandTimeout,
          stdout: Buffer.concat(output).toString("utf8"),
          detail: `${Buffer.concat(output).toString("utf8")}${Buffer.concat(error).toString("utf8")}`.trim() ||
            processError(cause)
        })
      )
    )
  })

/** Runs one hook/probe with bounded pipes and verified scoped process cleanup. */
const runServiceCommand = (argv: ReadonlyArray<string>, context: ProbeContext, timeoutMs: number) =>
  serviceCommand(argv, context, timeoutMs).pipe(Effect.scoped)

/** Runs one readiness probe attempt; never fails, reports the miss reason. */
const probeOnce = (
  readiness: Readiness,
  attemptTimeoutMs: number,
  context: ProbeContext
): Effect.Effect<Probe> =>
  "exec" in readiness
    ? runServiceCommand(readiness.exec, context, Math.max(attemptTimeoutMs, 1)).pipe(
      Effect.map((result) => result.ok ? { ok: true } : miss(`exec failed: ${result.detail}`))
    )
    : Effect.callback<Probe>((resume) => {
      let settled = false
      let cleanup: () => void = () => {}
      const settle = (result: Probe): void => {
        if (settled) return
        settled = true
        cleanup()
        resume(Effect.succeed(result))
      }
      if ("port" in readiness) {
        const socket = NodeNet.connect({ host: "127.0.0.1", port: readiness.port })
        cleanup = () => {
          socket.destroy()
        }
        socket.on("connect", () => settle({ ok: true }))
        socket.on("error", (error: NodeJS.ErrnoException) => settle(miss(`connect failed: ${error.message}`)))
      } else {
        const url = new URL(readiness.http)
        const get = url.protocol === "https:" ? NodeHttps.get : NodeHttp.get
        const request = get(url, (response) => {
          response.resume()
          const status = response.statusCode ?? 0
          settle(status > 0 && status < 500 ? { ok: true } : miss(`GET ${readiness.http} answered ${status}`))
        })
        cleanup = () => {
          request.destroy()
        }
        request.on(
          "error",
          (error: NodeJS.ErrnoException) => settle(miss(`GET ${readiness.http} failed: ${error.message}`))
        )
      }
      return Effect.sync(() => {
        settled = true
        cleanup()
      })
    }).pipe(Effect.timeoutOrElse({
      duration: Math.max(attemptTimeoutMs, 1),
      orElse: () => Effect.succeed(miss(`the probe timed out after ${attemptTimeoutMs}ms`))
    }))

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

/** One running, supervised service shared by every consumer of its key. */
interface RunningService {
  readonly key: string
  readonly pid: number
  readonly unhealthy: Deferred.Deferred<never, ServiceError>
  readonly tail: () => string
}

/** Mutable lifecycle flags shared between listeners and the finalizer. */
interface ServiceState {
  stopping: boolean
}

/**
 * Minimal child environment: the documented host bootstrap names plus the
 * spec's declared variables, mirroring the exec boundary rather than the
 * whole ambient `process.env`.
 */
const serviceEnvironment = (declared: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv => {
  const env = Object.create(null) as NodeJS.ProcessEnv
  for (const name of inheritedEnvironmentNames) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  for (const [name, value] of Object.entries(declared ?? {})) env[name] = value
  return env
}

/**
 * Gives a service only unguessable placeholders and keeps the substituting
 * proxy scoped to the service process. Real values are read only when the
 * proxy forwards an outbound request.
 */
interface ServiceSecretBoundary {
  readonly environment: Readonly<Record<string, string>>
  readonly argv: readonly [string, ...Array<string>]
}

const serviceSecretBoundary = (
  spec: ServiceSpec
): Effect.Effect<ServiceSecretBoundary, ServiceError, Scope.Scope> => {
  if (
    (spec.secrets === undefined || spec.secrets.length === 0) &&
    (spec.secretUrls === undefined || spec.secretUrls.length === 0)
  ) {
    return Effect.succeed({ environment: {}, argv: spec.argv })
  }
  const vault = SecretProxy.makeVault()
  const minted: Record<string, string> = {}
  for (const credential of spec.secrets ?? []) minted[credential.secret.env] = vault.mint(credential)
  const boundaryFailed = (what: string) => (cause: unknown) =>
    new ServiceError({
      key: spec.key,
      reason: "spawn-failed",
      message: `service ${spec.key} ${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
      outputTail: ""
    })
  return Effect.flatMap(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () => SecretProxy.startProxy(vault),
        catch: boundaryFailed("secret boundary could not start")
      }),
      (proxy) => Effect.promise(() => proxy.close())
    ),
    (proxy) =>
      Effect.tryPromise({
        try: async () => {
          // `S.SecretOrigin(audience)` tokens resolve to the loopback origin
          // brokering that audience, exactly as the exec boundary does.
          const origins = new Map<string, string>()
          const declared = [...spec.argv, ...Object.values(spec.env ?? {})]
          for (const origin of declared.flatMap(Secret.secretOriginsIn)) {
            if (!origins.has(origin)) origins.set(origin, await proxy.originFor(origin))
          }
          const brokered = (value: string): string =>
            value.replace(Secret.secretOriginPattern, (_token, origin: string) => origins.get(origin)!)
          const environment: Record<string, string> = {
            ...minted,
            HTTP_PROXY: proxy.endpoint,
            HTTPS_PROXY: proxy.endpoint
          }
          for (const [name, value] of Object.entries(spec.env ?? {})) {
            if (brokered(value) !== value) environment[name] = brokered(value)
          }
          if (process.platform !== "win32") {
            environment["http_proxy"] = proxy.endpoint
            environment["https_proxy"] = proxy.endpoint
          }
          const argv = spec.argv.map(brokered) as [string, ...Array<string>]
          for (const { index, secret } of spec.secretUrls ?? []) argv[index] = proxy.urlFor(secret)
          return { environment, argv }
        },
        catch: boundaryFailed("secret boundary could not bind a brokered origin")
      })
  )
}

/** Polls the readiness probe until it passes or the deadline expires. */
const awaitReadiness = (
  parsed: ParsedSpec,
  readiness: Readiness,
  tail: () => string,
  context: ProbeContext
): Effect.Effect<void, ServiceError> =>
  Effect.suspend(() => {
    const attemptMs = "port" in readiness
      ? portProbeAttemptMs
      : Math.min(parsed.readinessTimeoutMs, probeAttemptCapMs)
    let lastMiss = "the probe did not complete"
    const timeout = () =>
      new ServiceError({
        key: parsed.spec.key,
        reason: "readiness-timeout",
        message: `service ${parsed.spec.key} was not ready within ${parsed.readinessTimeoutMs}ms: ${lastMiss}`,
        outputTail: tail()
      })
    return probeOnce(readiness, attemptMs, context).pipe(
      Effect.flatMap((result) => {
        if (result.ok) return Effect.void
        lastMiss = result.reason
        return Effect.fail(timeout())
      }),
      Effect.retry(Schedule.spaced(readinessPollMs)),
      Effect.timeoutOrElse({ duration: parsed.readinessTimeoutMs, orElse: () => Effect.fail(timeout()) })
    )
  })

/** Re-runs the readiness probe on the declared interval until unhealthy. */
const healthLoop = (
  parsed: ParsedSpec,
  readiness: Readiness,
  intervalMs: number,
  state: ServiceState,
  unhealthy: Deferred.Deferred<never, ServiceError>,
  tail: () => string,
  context: ProbeContext
): Effect.Effect<void> => {
  const attemptMs = Math.min(intervalMs, probeAttemptCapMs)
  const step = (misses: number): Effect.Effect<void> =>
    Effect.gen(function*() {
      yield* Effect.sleep(intervalMs)
      if (state.stopping || Deferred.isDoneUnsafe(unhealthy)) return
      const result = yield* probeOnce(readiness, attemptMs, context)
      if (state.stopping || Deferred.isDoneUnsafe(unhealthy)) return
      if (result.ok) return yield* step(0)
      const next = misses + 1
      if (next >= parsed.healthFailures) {
        Deferred.doneUnsafe(
          unhealthy,
          Effect.fail(
            new ServiceError({
              key: parsed.spec.key,
              reason: "unhealthy",
              message: `service ${parsed.spec.key} failed ${next} consecutive health probes: ${result.reason}`,
              outputTail: tail()
            })
          )
        )
        return
      }
      return yield* step(next)
    })
  return step(0)
}

/** Runs service init commands sequentially after readiness. */
const runInit = (
  parsed: ParsedSpec,
  tail: () => string,
  environment: Readonly<Record<string, string>>
): Effect.Effect<void, ServiceError> =>
  Effect.gen(function*() {
    for (const argv of parsed.spec.init ?? []) {
      const result = yield* runServiceCommand(argv, {
        cwd: parsed.spec.cwd,
        environment
      }, parsed.readinessTimeoutMs)
      if (!result.ok) {
        return yield* Effect.fail(
          new ServiceError({
            key: parsed.spec.key,
            reason: "init-failed",
            message: `service ${parsed.spec.key} init command failed: ${argv.join(" ")}${
              result.detail === "" ? "" : `: ${result.detail}`
            }`,
            outputTail: tail()
          })
        )
      }
    }
    return yield* Effect.void
  })

/** Runs one list of best-effort commands to completion, ignoring their exit status. */
const runBestEffort = (
  parsed: ParsedSpec,
  commands: ReadonlyArray<readonly [string, ...Array<string>]> | undefined,
  environment: Readonly<Record<string, string>>
): Effect.Effect<void> =>
  Effect.gen(function*() {
    for (const argv of commands ?? []) {
      yield* runServiceCommand(argv, {
        cwd: parsed.spec.cwd,
        environment
      }, parsed.stopGraceMs + stopSettleMs)
    }
  }).pipe(Effect.asVoid)

/** Runs best-effort prepare commands before the service process is spawned. */
const runPrepare = (parsed: ParsedSpec, environment: Readonly<Record<string, string>>): Effect.Effect<void> =>
  runBestEffort(parsed, parsed.spec.prepare, environment)

/** Runs best-effort cleanup commands during scope finalization. */
const runCleanup = (parsed: ParsedSpec, environment: Readonly<Record<string, string>>): Effect.Effect<void> =>
  runBestEffort(parsed, parsed.spec.cleanup, environment)

/** Owns container removal before closing the create client's process scope. */
const createDockerService = (
  parsed: ParsedSpec,
  environment: Readonly<Record<string, string>>
): Effect.Effect<ParsedSpec, ServiceError, Scope.Scope> =>
  Effect.gen(function*() {
    const spec = parsed.spec
    const docker = spec.argv[0]
    const name = `${spec.docker}-${randomUUID().replaceAll("-", "")}`
    const context = { cwd: spec.cwd, environment }
    // Only the create client uses this inner scope. acquireRelease registers
    // removal in the surrounding service scope before the client scope closes,
    // so even a defect in client cleanup cannot leave a returned ID unowned.
    // Acquisition and registration stay atomic with respect to interruption.
    const created = yield* Effect.scopedWith((clientScope) =>
      Effect.acquireRelease(
        serviceCommand(
          [docker, "create", "--rm", "--name", name, ...spec.argv.slice(1)],
          context,
          parsed.readinessTimeoutMs
        ).pipe(
          Scope.provide(clientScope),
          Effect.map((result) => {
            const id = result.stdout.trim()
            return { ...result, id, target: /^[0-9a-f]{64}$/.test(id) ? id : name }
          })
        ),
        (result) =>
          // Failed commands can still return an ID. If it is unreadable, only
          // this acquisition's unique name is safe; unparsed output is never
          // a removal target. Late daemon completion remains best effort.
          runServiceCommand([docker, "rm", "-f", result.target], context, parsed.stopGraceMs + stopSettleMs).pipe(
            Effect.asVoid
          )
      )
    )
    const id = created.id
    if (!created.ok || !/^[0-9a-f]{64}$/.test(id)) {
      return yield* Effect.fail(
        new ServiceError({
          key: spec.key,
          reason: "spawn-failed",
          message: `service ${spec.key} container creation failed${
            created.timedOut ? ` after ${parsed.readinessTimeoutMs}ms` : ""
          }: ${created.detail || "Docker returned no container ID"}`,
          outputTail: ""
        })
      )
    }
    return {
      ...parsed,
      spec: {
        ...spec,
        argv: [docker, "start", "--attach", id],
        readiness: spec.readiness !== undefined && "exec" in spec.readiness
          ? { ...spec.readiness, exec: [docker, "exec", id, ...spec.readiness.exec] }
          : spec.readiness,
        init: (spec.init ?? []).map((command) => [docker, "exec", id, ...command])
      }
    }
  })

/**
 * Spawns one service in its own process group, awaits readiness, and starts
 * the health loop, all inside the scope the `RcMap` provides for its key.
 */
const startService = (initial: ParsedSpec): Effect.Effect<RunningService, ServiceError, Scope.Scope> =>
  Effect.gen(function*() {
    let parsed = initial
    const key = parsed.spec.key
    const unhealthy = yield* Deferred.make<never, ServiceError>()
    const state: ServiceState = { stopping: false }
    const tail = tailCapture()
    const stdoutDecoder = new TextDecoder("utf-8")
    const stderrDecoder = new TextDecoder("utf-8")
    const failWith = (reason: "spawn-failed" | "exited", message: string): void => {
      Deferred.doneUnsafe(
        unhealthy,
        Effect.fail(new ServiceError({ key, reason, message, outputTail: tail.read() }))
      )
    }
    const secretBoundary = yield* serviceSecretBoundary(parsed.spec)
    const environment = { ...parsed.spec.env, ...secretBoundary.environment }
    const observer = (yield* Output)(parsed.spec)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          observer?.close()
        } catch {
          // Optional progress output cannot change service cleanup or its result.
        }
      })
    )
    // Every hook and the service itself run in the declared cwd under this
    // environment; the probes run there too.
    const probeContext: ProbeContext = { cwd: parsed.spec.cwd, environment }
    yield* runPrepare(parsed, environment)
    // Cleanup hooks run after the owned process scope closes, including when
    // readiness or startup fails. They use the same bounded process adapter.
    yield* Effect.addFinalizer(() => runCleanup(parsed, environment))
    if (parsed.spec.docker !== undefined) {
      parsed = yield* createDockerService(
        { ...parsed, spec: { ...parsed.spec, argv: secretBoundary.argv } },
        environment
      )
    }
    const argv = parsed.spec.docker === undefined ? secretBoundary.argv : parsed.spec.argv
    const handle = yield* ScopedProcess.spawn({
      command: argv[0],
      args: argv.slice(1),
      cwd: parsed.spec.cwd,
      env: serviceEnvironment(environment),
      stdin: "ignore",
      killSignal: parsed.stopSignal,
      forceKillAfter: parsed.stopGraceMs
    }).pipe(Effect.mapError((cause) =>
      new ServiceError({
        key,
        reason: "spawn-failed",
        message: `service ${key} could not be spawned: ${processError(cause)}`,
        outputTail: ""
      })
    ))
    const consume = (source: typeof handle.stdout, decoder: TextDecoder, write: (chunk: Uint8Array) => void) =>
      source.pipe(Stream.runForEach((chunk) =>
        Effect.sync(() => {
          tail.append(chunk, decoder)
          try {
            write(chunk)
          } catch {
            // Keep draining and capturing after a progress observer fails.
          }
        })
      ))
    yield* Effect.all([
      consume(handle.stdout, stdoutDecoder, (chunk) => observer?.onStdout(chunk)),
      consume(handle.stderr, stderrDecoder, (chunk) => observer?.onStderr(chunk))
    ], { concurrency: "unbounded" }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          if (!state.stopping) failWith("exited", `service ${key} output could not be read: ${processError(cause)}`)
        })
      ),
      Effect.forkScoped
    )
    // A descendant can inherit stdout without being the service. Observe the
    // actual service's exit independently so an open pipe cannot report it as
    // healthy during the owner's cleanup grace.
    yield* ScopedProcess.status(handle).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          if (!state.stopping) {
            failWith(
              "exited",
              `service ${key} exited ${
                status.signal === null ? `with code ${status.code}` : `on ${status.signal}`
              } while supervised`
            )
          }
        })
      ),
      Effect.catch((cause) =>
        Effect.sync(() => {
          if (!state.stopping) failWith("exited", `service ${key} could not be observed: ${processError(cause)}`)
        })
      ),
      Effect.forkScoped
    )
    // Stop while observers are still attached. The shared lifecycle waits for
    // the owned group, even when the target has already exited successfully.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        state.stopping = true
      }).pipe(
        Effect.andThen(handle.kill({ killSignal: parsed.stopSignal, forceKillAfter: parsed.stopGraceMs })),
        Effect.orDie
      )
    )
    if (parsed.spec.readiness !== undefined) {
      yield* Effect.raceFirst(
        awaitReadiness(parsed, parsed.spec.readiness, tail.read, probeContext),
        Deferred.await(unhealthy)
      )
    } else {
      // No probe: liveness is process liveness. A brief settle window lets an
      // immediate spawn failure (a missing executable) surface as the typed
      // error instead of a ready handle.
      yield* Effect.raceFirst(Effect.sleep(50), Deferred.await(unhealthy))
    }
    yield* runInit(parsed, tail.read, environment)
    if (parsed.healthIntervalMs !== undefined && parsed.spec.readiness !== undefined) {
      yield* Effect.forkScoped(
        healthLoop(parsed, parsed.spec.readiness, parsed.healthIntervalMs, state, unhealthy, tail.read, probeContext)
      )
    }
    return { key, pid: handle.targetPid, unhealthy, tail: tail.read }
  })

/**
 * Creates a per-command supervisor whose services live at most as long as
 * the provided scope. Consumers acquire services in their own scopes; a
 * service is spawned on its first acquisition, shared by refcount while any
 * consumer holds it, and released through its stop contract when the last
 * consumer scope closes.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<ServiceSupervisor, never, Scope.Scope> = Effect.gen(function*() {
  const specs = new Map<string, ParsedSpec>()
  const services = yield* RcMap.make({
    lookup: (key: string): Effect.Effect<RunningService, ServiceError, Scope.Scope> => {
      const parsed = specs.get(key)
      return parsed === undefined
        ? Effect.die(new Error(`service ${key} was looked up before its spec was registered`))
        : startService(parsed)
    }
  })
  const acquire = (spec: ServiceSpec): Effect.Effect<ServiceHandle, ServiceError, Scope.Scope> =>
    Effect.gen(function*() {
      const parsed = yield* Effect.try({
        try: () => parseSpec(spec),
        catch: (cause) =>
          new ServiceError({
            key: diagnosticKey(spec),
            reason: "invalid-spec",
            message: cause instanceof Error ? cause.message : String(cause),
            outputTail: ""
          })
      })
      const key = parsed.spec.key
      // Registration and the drift check are one synchronous step, so two
      // concurrent acquires cannot interleave between check and set.
      yield* Effect.suspend(() => {
        const existing = specs.get(key)
        if (existing === undefined) {
          specs.set(key, parsed)
          return Effect.void
        }
        return existing.canonical === parsed.canonical
          ? Effect.void
          : Effect.fail(
            new ServiceError({
              key,
              reason: "spec-drift",
              message: `service ${key} was acquired twice with different specs; ` +
                `one key must resolve to one command per supervisor`,
              outputTail: ""
            })
          )
      })
      const service = yield* RcMap.get(services, key)
      // A service that already went unhealthy fails new consumers immediately
      // rather than handing out a dead handle.
      if (Deferred.isDoneUnsafe(service.unhealthy)) {
        yield* Deferred.await(service.unhealthy)
      }
      return {
        key: service.key,
        pid: service.pid,
        outputTail: service.tail,
        whileHealthy: <A, E, R>(consumer: Effect.Effect<A, E, R>): Effect.Effect<A, E | ServiceError, R> =>
          Effect.raceFirst(consumer, Deferred.await(service.unhealthy))
      }
    })
  return { acquire }
})
