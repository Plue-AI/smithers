/**
 * The JavaScript runtime seam.
 *
 * A workspace declares which interpreter its tools run under and which version
 * it requires. This module is the service that answers for the host: it reports
 * the platform facts a fetch can vary by, measures the interpreter actually
 * installed, and refuses to proceed when the host does not satisfy the
 * declaration.
 *
 * It exists because the interpreter was previously an ambient fact. The
 * package-manager layer took a `platform` option and every target spelled `node`
 * into its own argv, so nothing in the system could say which interpreter
 * produced a result, and nothing could check that the interpreter on this
 * machine was the one the workspace asked for. Both are now one service that
 * anything needing an interpreter takes as a dependency.
 *
 * Host access is Effect's own: `effect/unstable/process/ChildProcessSpawner`
 * for the version probe. Platform facts arrive as layer construction options.
 * The live service defaults to the host environment when available and forwards
 * only executable-lookup variables. No Node imports are needed, so this module
 * stays browser-bundleable even though the interpreters it measures do not.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as BoundedOutput from "./internal/boundedOutput.ts"
import * as Diagnostics from "./internal/diagnostic.ts"
import { normalizePlatform } from "./internal/platform.ts"
import * as Validate from "./internal/validate.ts"

/**
 * Schema for the supported JavaScript runtimes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Name = Schema.Literals(["node", "bun"])

/**
 * The supported JavaScript runtimes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Name = typeof Name.Type

/**
 * Schema for the host facts a fetch or a build can vary by.
 *
 * This lives with the runtime rather than with the package manager because it
 * describes the machine, not the manager. A manager whose fetch varies by
 * platform asks this service for the facts; it does not carry its own copy.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Platform = Schema.Struct({
  /** The operating system, spelled as Node spells it: `darwin`, `linux`. */
  os: Schema.NonEmptyString,
  /** The CPU architecture, spelled as Node spells it: `arm64`, `x64`. */
  arch: Schema.NonEmptyString,
  /** The C library flavour where one is distinguishable: `glibc`, `musl`. */
  libc: Schema.NullOr(Schema.NonEmptyString)
})

/**
 * The host facts a fetch or a build can vary by.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Platform = typeof Platform.Type

/**
 * Schema for the bounded description of a host failure an error carries.
 *
 * A declared error schema is encoded through `Schema.toCodecJson` before it is
 * journaled, and that encoding refuses a class instance. Attaching the raw
 * platform `Error` therefore turned an ordinary probe failure into a defect
 * that killed the run. These three bounded strings encode.
 *
 * @category models
 * @since 0.1.0
 */
export const Diagnostic = Diagnostics.Diagnostic

/**
 * The bounded description of a host failure an error carries.
 *
 * @category models
 * @since 0.1.0
 */
export type Diagnostic = Diagnostics.Diagnostic

/**
 * Schema for the stable error codes a runtime operation reports.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ErrorCode = Schema.Literals([
  "probe_failed",
  "unsatisfied",
  "unsupported_requirement"
])

/**
 * The stable error codes a runtime operation reports.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ErrorCode = typeof ErrorCode.Type

/**
 * Error raised by a runtime operation.
 *
 * The identity string is frozen: it is journaled and folded into recorded
 * results, so renaming it invalidates cached work.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class RuntimeError extends Schema.TaggedError<RuntimeError>()(
  "smithers-build/RuntimeError",
  {
    code: ErrorCode,
    message: Schema.String,
    cause: Schema.optional(Diagnostic)
  }
) {}

/**
 * Maximum stdout bytes accepted from a version probe.
 *
 * One constant, applied by both probes in this package. It used to be declared
 * here and enforced only on the package manager's independent copy, so a reader
 * importing this name was told a bound existed that nothing applied.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maximumVersionOutputBytes = BoundedOutput.maximumVersionOutputBytes

/**
 * Default and maximum wall-clock deadline for one version probe.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const probeTimeoutMs = 30_000

/**
 * The contract every runtime implements.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Service {
  /** Which runtime this is. */
  readonly name: Name
  /** The executable spawned to run it. */
  readonly executable: string
  /** The version the workspace declared it requires. */
  readonly requirement: string
  /** The host facts this layer was constructed for. */
  readonly platform: Platform
  /** The exact interpreter version, measured once per live service instance. */
  readonly version: Effect.Effect<string, RuntimeError>
  /**
   * Measures the host interpreter and fails when it does not satisfy
   * {@link Service.requirement}.
   *
   * Anything that runs a tool calls this first. A declaration that is never
   * checked is a comment.
   */
  readonly verify: Effect.Effect<string, RuntimeError>
}

/**
 * The runtime service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class Runtime extends Context.Service<Runtime, Service>()(
  "smithers-build/Runtime"
) {}

/**
 * Layer construction options.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  /** The version the workspace declared. */
  readonly requirement: string
  /**
   * The host facts. An option rather than a read of `globalThis.process` so
   * this module never touches the host outside a service call.
   */
  readonly platform: Platform
  /**
   * Host environment capability. A version probe selects only the four
   * executable-lookup names. When omitted, the live service selects those names
   * from `globalThis.process?.env`, or uses an empty environment without a host.
   *
   * Because it is the host's environment, its names are held to the host's own
   * rule rather than to the portable one. Windows names `ProgramFiles(x86)`,
   * and a lookup table is not a declaration.
   */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  /** The interpreter executable, when it is not on `PATH` under its own name. */
  readonly executable?: string | undefined
  /** Version-probe deadline in milliseconds, an integer from 1 to 30,000. Defaults to 30,000. */
  readonly probeTimeoutMs?: number | undefined
}

/** The comparators a declared requirement may use. */
const comparators = [">=", "<=", ">", "<", "="] as const

/**
 * Splits a dotted numeric version into comparable parts.
 *
 * A trailing prerelease or build suffix is dropped, so `1.3.0-canary.2` and
 * `1.3.0+build.7` both compare as `1.3.0`. Ordering prereleases correctly is a
 * semver problem this seam does not need. What it does need is that an exact
 * stable pin never accepts one, and {@link satisfies} states that separately rather
 * than by pretending the suffix was not there.
 */
const numericParts = (value: string): ReadonlyArray<number> | undefined => {
  const token = value.trim()
  if (!versionToken.test(token)) return undefined
  const core = token.replace(/^v/, "").split(/[-+]/)[0]
  if (core === undefined || core === "") return undefined
  const parts = core.split(".")
  const numbers: Array<number> = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined
    const parsed = Number(part)
    if (!Number.isSafeInteger(parsed)) return undefined
    numbers.push(parsed)
  }
  return numbers
}

/**
 * The prerelease identity of a version string, or `""` when it names a release.
 *
 * Build metadata (`+build.7`) is not a prerelease: semver defines it as ignored
 * for precedence, so `1.3.0+build.7` is the release `1.3.0`. Only the `-` form
 * marks a build that came before the release it is named after.
 */
const prereleaseOf = (value: string): string => {
  const trimmed = value.trim().replace(/^v/, "")
  const build = trimmed.indexOf("+")
  const core = build < 0 ? trimmed : trimmed.slice(0, build)
  const dash = core.indexOf("-")
  return dash < 0 ? "" : core.slice(dash + 1)
}

/** Compares two dotted numeric versions, shorter treated as zero-padded. */
const compare = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): number => {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/**
 * Orders two prerelease suffixes by semver precedence: no suffix sorts above
 * any suffix, and dot-separated fields compare numerically when both are
 * numeric, numeric below alphanumeric, and lexically otherwise.
 */
const comparePrerelease = (left: string, right: string): number => {
  if (left === right) return 0
  if (left === "") return 1
  if (right === "") return -1
  const a = left.split(".")
  const b = right.split(".")
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = a[index]!
    const y = b[index]!
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x < y ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/**
 * Reports whether a measured version satisfies a declared requirement.
 *
 * The supported forms are an exact version and one comparator: `24.9.0`,
 * `=24.9.0`, `>=26.4.0`, `>22`, `<=24`, `<25`. Ranges, unions, and the `^`
 * and `~` operators are deliberately unsupported rather than approximated: a
 * half-implemented caret would accept versions the author meant to exclude.
 * An unsupported requirement is an error at verification, not a silent pass.
 *
 * An exact pin matches on prerelease identity as well as on the numbers, so
 * `=1.3.0` is not satisfied by `1.3.0-canary.2` and `=1.3.0-canary.2` is
 * satisfied by exactly that canary and by no other. A canary is not the build
 * an author pinning the release asked for, and it is exactly the build an
 * author pinning the canary asked for.
 *
 * A comparator whose bound is a release compares the release version and
 * ignores the measured suffix, so `>=1.3.0` accepts `1.3.0-canary.2`: refusing
 * every prerelease under every comparator would fail a workspace that
 * deliberately runs one. A comparator whose bound names a prerelease asked for
 * prerelease ordering, so semver precedence breaks a tie on the release
 * version: `>=1.0.0-rc.2` refuses `1.0.0-rc.1` and accepts `1.0.0`.
 *
 * @category validation
 * @since 0.1.0
 * @slop
 */
export const satisfies = (
  requirement: string,
  version: string
): boolean | "unsupported_requirement" => {
  const measured = numericParts(version)
  if (measured === undefined) return "unsupported_requirement"
  const trimmed = requirement.trim()
  const comparator = comparators.find((candidate) => trimmed.startsWith(candidate))
  const boundText = comparator === undefined ? trimmed : trimmed.slice(comparator.length)
  const bound = numericParts(boundText)
  if (bound === undefined) return "unsupported_requirement"
  const boundPrerelease = prereleaseOf(boundText)
  const core = compare(measured, bound)
  const ordering = core !== 0 || boundPrerelease === ""
    ? core
    : comparePrerelease(prereleaseOf(version), boundPrerelease)
  switch (comparator) {
    case ">=":
      return ordering >= 0
    case "<=":
      return ordering <= 0
    case ">":
      return ordering > 0
    case "<":
      return ordering < 0
    default:
      return core === 0 && boundPrerelease === prereleaseOf(version)
  }
}

/**
 * The refusal a declaration and a measured version produce, or `null`.
 *
 * One function, called by both the measuring implementation and the double, so
 * the two cannot disagree about which of the three outcomes a pair produces.
 * They used to: the double collapsed `unsupported_requirement` into
 * `unsatisfied` and reported "this host runs node 24.9.0, and the workspace
 * declares ^24.0.0", which is a false sentence pointing the operator at the
 * host when the declaration is what needs fixing.
 *
 * @private
 */
const refusal = (name: Name, requirement: string, measured: string): RuntimeError | null => {
  const outcome = satisfies(requirement, measured)
  if (outcome === "unsupported_requirement") {
    return new RuntimeError({
      code: "unsupported_requirement",
      message: `the declared ${name} version ${
        JSON.stringify(requirement)
      } is not an exact version or a single comparator, and ${JSON.stringify(measured)} cannot be checked against it`
    })
  }
  return outcome ? null : new RuntimeError({
    code: "unsatisfied",
    message: `this host runs ${name} ${measured}, and the workspace declares ${requirement}`
  })
}

/** @private */
const probeFailed = (label: string, cause: unknown): RuntimeError =>
  new RuntimeError({
    code: "probe_failed",
    message: `${label} failed: ${
      typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
        ? cause.message
        : "unknown failure"
    }`,
    cause: Diagnostics.diagnostic(cause)
  })

/**
 * The names a child needs to resolve a bare executable through `PATH`.
 *
 * Nothing else is forwarded. A `--version` run needs no proxy, no certificate
 * bundle, and no temporary directory, so it is given none.
 *
 * Exported so a composition root can supply these names explicitly through
 * {@link Options.environment} without maintaining a separate lookup list.
 *
 * @category constants
 * @since 0.1.0
 */
export const lookupEnvironmentNames = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR"] as const

interface NormalizedOptions {
  readonly requirement: string
  readonly platform: Platform
  /** Absent, not empty, when the composition supplied no environment. */
  readonly environment: ReadonlyMap<string, string> | undefined
  readonly executable: string | undefined
  readonly probeTimeoutMs: number
}

/**
 * Snapshots and validates construction options before any service exists.
 *
 * The sibling `PackageManager` seam has done this since it shipped, and this
 * one did not: it stored `options` and re-read it, so a caller that mutated the
 * object afterwards left the service reporting one requirement while `verify`
 * enforced another, and a shared `platform` object could be edited through the
 * service into every store manifest minted from it.
 */
const normalizeOptions = (value: Options, extraKeys: ReadonlyArray<string> = []): NormalizedOptions => {
  const options = Validate.plainRecord(value, "runtime options")
  Validate.exactKeys(
    options,
    new Set(["requirement", "platform", "environment", "executable", "probeTimeoutMs", ...extraKeys]),
    "runtime options"
  )
  const requirement = Validate.ownData(options, "requirement", "runtime options")
  if (!Validate.usableText(requirement, 256)) {
    throw new TypeError("runtime requirement must be non-empty usable text no longer than 256 bytes")
  }
  const platform = normalizePlatform(Validate.ownData(options, "platform", "runtime options"), "runtime platform")
  const executable = Validate.ownData(options, "executable", "runtime options")
  if (executable !== undefined && !Validate.usableText(executable, 32 * 1024)) {
    throw new TypeError("runtime executable must be usable non-empty text")
  }
  const timeout = Validate.ownData(options, "probeTimeoutMs", "runtime options") ?? probeTimeoutMs
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > probeTimeoutMs) {
    throw new TypeError(`runtime probe timeout must be an integer from 1 to ${probeTimeoutMs}`)
  }
  const environment = Validate.ownData(options, "environment", "runtime options")
  return Object.freeze({
    requirement,
    platform,
    environment: environment === undefined
      ? undefined
      : Validate.normalizeEnvironment(environment, platform.os === "win32", "runtime environment"),
    executable,
    probeTimeoutMs: timeout
  })
}

/** Selects the executable-lookup names out of a normalized host environment. */
const probeEnvironment = (options: NormalizedOptions): Record<string, string> => {
  const windows = options.platform.os === "win32"
  const environment = options.environment ?? Validate.normalizeEnvironment(
    globalThis.process?.env ?? {},
    windows,
    "runtime environment"
  )
  const selected: Record<string, string> = Object.create(null)
  for (const name of lookupEnvironmentNames) {
    const value = Validate.sourceValue(environment, name, windows)
    if (value !== undefined) selected[name] = value
  }
  return selected
}

/**
 * The shape of a version a probe accepts from an interpreter's own output.
 *
 * Dotted numbers with an optional leading `v`, an optional `-prerelease`, and
 * an optional `+build` suffix. The suffixes are here because {@link satisfies}
 * reads them: an exact pin matches on prerelease identity, so a parser that
 * refused `1.3.0-canary.2` as unparsable made `=1.3.0-canary.2` a requirement
 * no real interpreter could ever satisfy. Every quantifier is over a single
 * character class, so a long hostile token costs one linear scan.
 */
const versionToken = /^v?\d+(?:\.\d+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * Measures the interpreter version by running it.
 *
 * The child receives only executable-lookup names from the supplied environment
 * or the live host's environment. An explicit `env` and `extendEnv: false`
 * prevent the spawner from inheriting unrelated ambient variables.
 *
 * Standard output is collected under {@link maximumVersionOutputBytes} and
 * decoded afterwards, so an executable that prints megabytes is refused at the
 * bound instead of buffered in full.
 *
 * @private
 */
const measureVersion = (
  spawner: ChildProcessSpawner["Service"],
  executable: string,
  environment: Record<string, string>,
  timeoutMs: number
): Effect.Effect<string, RuntimeError> => {
  const label = `${executable} --version`
  const shape = {
    extendEnv: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    killSignal: "SIGKILL"
  } as const
  const command = ChildProcess.make(executable, ["--version"], { ...shape, env: environment })
  const captured = Effect.scoped(
    Effect.flatMap(spawner.spawn(command), (handle) =>
      Effect.all(
        [BoundedOutput.boundedOutput(handle.stdout), handle.exitCode],
        { concurrency: "unbounded" }
      ))
  )
  return captured.pipe(
    Effect.mapError((cause) => probeFailed(label, cause)),
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new RuntimeError({
            code: "probe_failed",
            message: `${label} did not finish within ${timeoutMs}ms`
          })
        )
    }),
    Effect.flatMap(([bytes, status]) => {
      // A non-zero exit is reported as an exit, not as unparsable output. The
      // spawner returns whatever the tool printed regardless of status, so
      // without this check a probe that failed outright would be reported as a
      // tool that printed no version.
      if (status !== 0) {
        return Effect.fail(
          new RuntimeError({
            code: "probe_failed",
            message: `${label} exited with status ${status}`
          })
        )
      }
      return Effect.try({
        try: () => BoundedOutput.decodedText(bytes, `${label} stdout`),
        catch: (cause) => probeFailed(label, cause)
      })
    }),
    Effect.flatMap((output) => {
      // Node prints `v24.9.0` and Bun prints `1.3.0`. Taking the first
      // version-shaped token on the first line covers both without a
      // per-runtime parser.
      const first = output.split("\n", 1)[0] ?? ""
      const token = first.trim().split(/\s+/).find((word) => versionToken.test(word))
      return token === undefined
        ? Effect.fail(
          new RuntimeError({
            code: "probe_failed",
            message: `${label} printed no version: ${JSON.stringify(first.slice(0, 200))}`
          })
        )
        : Effect.succeed(token.replace(/^v/, ""))
    })
  )
}

/**
 * Builds a runtime implementation that measures the host.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (
  name: Name,
  options: Options
): Effect.Effect<Service, never, ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const normalized = normalizeOptions(options)
    const executable = normalized.executable ?? name
    const version = yield* Effect.cached(
      measureVersion(spawner, executable, probeEnvironment(normalized), normalized.probeTimeoutMs)
    )
    return Object.freeze(
      {
        name,
        executable,
        requirement: normalized.requirement,
        platform: normalized.platform,
        version,
        verify: Effect.flatMap(version, (measured) => {
          const refused = refusal(name, normalized.requirement, measured)
          return refused === null ? Effect.succeed(measured) : Effect.fail(refused)
        })
      } satisfies Service
    )
  })

/**
 * Provides Node as the workspace runtime.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNode = (
  options: Options
): Layer.Layer<Runtime, never, ChildProcessSpawner> => Layer.effect(Runtime)(make("node", options))

/**
 * Provides Bun as the workspace runtime.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerBun = (
  options: Options
): Layer.Layer<Runtime, never, ChildProcessSpawner> => Layer.effect(Runtime)(make("bun", options))

/**
 * Builds a runtime that reports a fixed version and never spawns anything.
 *
 * Tests and browser compositions use it. `verify` applies the same comparison
 * the measuring implementation does, through the same function, so a test can
 * assert any of the three refusal outcomes without a host interpreter.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (
  name: Name,
  options: Options & { readonly version: string }
): Service => {
  const normalized = normalizeOptions(options, ["version"])
  const measured = Validate.ownData(
    Validate.plainRecord(options, "runtime options"),
    "version",
    "runtime options"
  )
  if (!Validate.usableText(measured, 256)) {
    throw new TypeError("runtime version must be non-empty usable text no longer than 256 bytes")
  }
  const version = Effect.succeed(measured)
  const refused = refusal(name, normalized.requirement, measured)
  return Object.freeze(
    {
      name,
      executable: normalized.executable ?? name,
      requirement: normalized.requirement,
      platform: normalized.platform,
      version,
      verify: refused === null ? version : Effect.fail(refused)
    } satisfies Service
  )
}

/**
 * Provides a runtime that reports a fixed version and never spawns anything.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (
  name: Name,
  options: Options & { readonly version: string }
): Layer.Layer<Runtime> => Layer.effect(Runtime)(Effect.sync(() => makeNoop(name, options)))
