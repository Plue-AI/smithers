/**
 * Runs a child flow's own code inside a provisioned sandbox machine.
 *
 * `Sandbox.layerHost` places a body's SIDE EFFECTS on a machine: its file
 * operations and child processes go to one held session while its TypeScript
 * keeps running in the engine host. This module is the tier above that. The
 * child flow's code EXECUTES inside the guest: the entry module that declares
 * it is bundled into one self-contained file, the bundle is written into the
 * session's workspace beside a request JSON, the guest runtime runs it with
 * `SMITHERS_SANDBOX_REQUEST_PATH` and `SMITHERS_SANDBOX_RESULT_PATH` naming
 * the two files, and the result JSON comes back through the same session to be
 * validated against the flow's own success schema. Smithers 0.x had this tier
 * as `<Sandbox workflow={child}>`; the 1.0 shape keeps its runner protocol and
 * its env variable names and drops two of its mistakes: a provider is a
 * `Sandbox.Provider` VALUE passed in, never a string looked up in a registry,
 * and the authoring is `Flow.make` and `Action.make`, never a component.
 *
 * The runner protocol, as shipped:
 *
 * 1. The entry module is bundled with esbuild (`platform: "node"`, ESM) into
 *    `.smithers-sandbox/bundle.mjs` under the session's workdir, together with
 *    a small main that imports the entry and hands its exports to the guest
 *    runner in `internal/SandboxedFlowGuest.ts`.
 * 2. `.smithers-sandbox/request.json` carries
 *    `{ attempt, flow, executionId, capabilityCeiling, payload }`, the payload
 *    encoded through `Schema.toCodecJson` of the flow's payload schema.
 *    `attempt` is a fresh nonce for each execution of the effect, and
 *    `capabilityCeiling` is the caller's effective authority intersected with
 *    the flow's own declaration.
 * 3. The guest runtime, `node` unless {@link ExecuteOptions.runtime} says
 *    otherwise, runs the bundle with the workdir as its working directory and
 *    the two env variables set. The runner finds the flow by tag among the
 *    entry's exports, decodes the payload, runs the flow under an in-memory
 *    engine, and writes `.smithers-sandbox/result.json`: either
 *    `{ attempt, capabilityCeiling, status: "succeeded", output }` with the
 *    success value encoded through the success schema's JSON codec, or
 *    `{ attempt, capabilityCeiling, status: "failed", error, denied? }`. The
 *    guest runs the flow under the ceiling it was sent and echoes it.
 * 4. The host reads the result back, refuses a non-zero exit, an unparseable
 *    file, a result for another attempt, a ceiling echo that differs from the
 *    one it sent, or a result the limits reject, fails with the guest's
 *    `PermissionDenied` when a capability refusal failed the child, decodes `output` through the same
 *    codec, and, when {@link ExecuteOptions.captureWork} is set, captures
 *    the workspace's work as a `Sandbox.Work` beside the output.
 *
 * What the guest image must contain is a statement, not code: the runtime the
 * bundle is started with, `node` (22 or later) or `bun`, has to be on the
 * guest's `PATH`. Nothing here installs one. A missing runtime is reported as
 * a `guest_failed` failure that names it.
 *
 * The captured work is DATA, not an applied change. It is the same
 * `Sandbox.Work` that `Sandbox.run` returns, so `SandboxMerge.apply` lands it
 * on the host; gating it behind review the way the 0.x component's
 * `reviewDiffs` did is the caller's.
 *
 * Capturing work requires the session's workdir to be the top of a git work
 * tree and `git` on the guest's `PATH`. This is a deliberate change from the
 * stat-fingerprint snapshot this module used to take, which listed changed
 * files in any directory: the patch git produces covers renames, modes,
 * symlinks and binary contents exactly and applies with `SandboxMerge`, and
 * one capture contract serves every sandbox caller. A workdir that is not a
 * repository fails with `capture_failed` before the guest runs. The base is
 * the workdir's `HEAD` when the session opens, so a provider that refreshes
 * its checkout during acquisition is measured from the commit it refreshed
 * to. The protocol's own `.smithers-sandbox` directory carries a `.gitignore`
 * that excludes it, so its files are never part of the work.
 *
 * @since 1.0.0
 */

import type { CapabilityPattern } from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { PermissionDenied } from "@smthrs/capability/Permission"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import * as RedactedLogger from "@smthrs/journal/RedactedLogger"
import * as Redaction from "@smthrs/journal/Redaction"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import { Sandbox } from "@smthrs/sandbox"
import type { ProviderError } from "@smthrs/sandbox/RemoteChildProcessSpawner"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import * as Guest from "./internal/SandboxedFlowGuest.ts"

/**
 * Why a sandboxed execution did not produce a validated result.
 *
 * - `bundle_failed`: the entry module could not be bundled.
 * - `session_failed`: the provider could not acquire the machine, or a file
 *   or process operation on it failed.
 * - `guest_failed`: the guest runtime exited non-zero, including exit 127 for a
 *   runtime the image does not contain.
 * - `flow_failed`: the child flow ran and reported a failure.
 * - `result_unreadable`: the guest exited 0 but wrote no result, or wrote one
 *   that is not the protocol's JSON, does not match the current attempt, or
 *   does not echo the capability ceiling the host sent.
 * - `result_invalid`: the result's `output` does not decode through the flow's
 *   success schema.
 * - `result_overflow`: the result file exceeds {@link Limits.resultBytes}.
 * - `diff_overflow`: the captured patch exceeds {@link Limits.diffBytes}.
 * - `capture_failed`: the work could not be captured: the workdir is not the
 *   top of a git work tree or the guest has no `git` (`not_a_repository`),
 *   its `HEAD` names no commit (`base_unresolved`), or `git` failed while
 *   diffing (`capture_failed`). The message starts with that reason.
 * - `deadline_exceeded`: the whole session outlived {@link ExecuteOptions.timeout}.
 *
 * @category errors
 * @since 1.0.0
 */
export class SandboxedFlowError extends Schema.TaggedError<SandboxedFlowError>()(
  "@smthrs/flows/SandboxedFlowError",
  {
    code: Schema.Literals([
      "bundle_failed",
      "session_failed",
      "guest_failed",
      "flow_failed",
      "result_unreadable",
      "result_invalid",
      "result_overflow",
      "diff_overflow",
      "capture_failed",
      "deadline_exceeded"
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {}

/**
 * Every typed failure of a sandboxed execution: a {@link SandboxedFlowError},
 * or the kernel's `PermissionDenied` when the child needed a capability the
 * caller's ceiling does not hold. The refusal is the same typed error a local
 * run of the child would fail with.
 *
 * @category errors
 * @since 1.0.0
 */
export const ExecuteError = Schema.Union([SandboxedFlowError, PermissionDenied])

/**
 * The type of {@link ExecuteError}.
 *
 * @category errors
 * @since 1.0.0
 */
export type ExecuteError = typeof ExecuteError.Type

/**
 * Bounds on what comes back from the guest.
 *
 * The defaults mirror the 0.x bundle limits: 5 MB for the structured result
 * (the old manifest limit) and 100 MB for the patch (the old bundle total).
 *
 * @category models
 * @since 1.0.0
 */
export interface Limits {
  /** The largest result JSON accepted, in bytes. Default 5 MiB. */
  readonly resultBytes?: number | undefined
  /**
   * The largest captured patch accepted, in UTF-8 bytes. Default 100 MiB. It
   * bounds what the result carries into the journal; the capture itself is
   * read whole before the bound is checked.
   */
  readonly diffBytes?: number | undefined
}

/**
 * {@link Limits} with every bound decided.
 *
 * @category models
 * @since 1.0.0
 */
export interface ResolvedLimits {
  readonly resultBytes: number
  readonly diffBytes: number
}

/**
 * The limits {@link execute} applies where {@link ExecuteOptions.limits} names none.
 *
 * @category models
 * @since 1.0.0
 */
export const defaultLimits: ResolvedLimits = Object.freeze({
  resultBytes: 5 * 1024 * 1024,
  diffBytes: 100 * 1024 * 1024
})

/** The caller's bounds over the defaults, an omitted or undefined bound keeping the default. */
const resolveLimits = (limits: Limits | undefined): ResolvedLimits => ({
  resultBytes: limits?.resultBytes ?? defaultLimits.resultBytes,
  diffBytes: limits?.diffBytes ?? defaultLimits.diffBytes
})

/**
 * How one child flow execution is placed.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecuteOptions {
  /** The provider that provisions the machine. A value, never a name. */
  readonly provider: Sandbox.Provider
  /**
   * The session key the machine is acquired under. It is an exclusive claim:
   * two live executions with one key share a machine and the first to finish
   * tears it down under the other. Reusing a key is what resume looks like: a
   * crash that left the machine behind is reattached by the next execution
   * with the same key, workspace included.
   */
  readonly session: string
  /**
   * The module to bundle: a `file:` URL or an absolute path. It must export
   * the flow being executed, under any name, and may export `layer`, an
   * Effect `Layer` providing the implementations of the actions the flow's
   * body names.
   */
  readonly entry: URL | string
  /**
   * The guest executable that runs the bundle: `"node"` (default), `"bun"`,
   * or an executable path. The executable and bundle path are each quoted
   * as one shell word; use a wrapper script for runtime flags.
   */
  readonly runtime?: string | undefined
  /**
   * Whether to capture the workspace's work as a `Sandbox.Work`. Default
   * `false`. The workdir must be the top of a git work tree; see the module
   * documentation.
   */
  readonly captureWork?: boolean | undefined
  /** Bounds on the result and the patch; see {@link defaultLimits}. */
  readonly limits?: Limits | undefined
  /**
   * The wall-clock budget for the whole session, acquisition through result
   * readback. Default ten minutes. It is measured on the platform timer, not
   * the ambient `Clock`, so it fires under a frozen test clock too. Infinite
   * durations disable the deadline; long finite durations use timer chunks.
   */
  readonly timeout?: Duration.Input | undefined
}

/**
 * What a sandboxed execution returns: the child's success value, decoded
 * through its own schema, and the workspace's work when it was asked for.
 *
 * @category models
 * @since 1.0.0
 */
export interface Result<A> {
  readonly output: A
  /** The workspace's work, or `null` when {@link ExecuteOptions.captureWork} was off. */
  readonly work: Sandbox.Work | null
  /**
   * The ceiling the guest enforced, as normalized any-of groups: the receipt
   * the parent journals. No groups is unrestricted authority. `null` only on
   * a result recorded before ceilings crossed the machine boundary, which
   * carries no evidence of the authority it ran under.
   */
  readonly capabilityCeiling: ReadonlyArray<ReadonlyArray<CapabilityPattern>> | null
}

/**
 * The schema of a {@link Result}'s `work`. A result recorded without one
 * decodes as `null`, no work captured.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CapturedWork = Schema.NullOr(Sandbox.Work).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)))

/**
 * The schema of a {@link Result}'s `capabilityCeiling`. A result recorded
 * before ceilings crossed the machine boundary has no receipt and decodes as
 * `null`, never as unrestricted.
 *
 * @category schemas
 * @since 1.0.0
 */
export const EnforcedCeiling = Schema.NullOr(Guest.Ceiling).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)))

/**
 * The schema of a {@link Result} over a flow's success schema.
 *
 * @category schemas
 * @since 1.0.0
 */
export type ResultSchema<Success extends Schema.Top> = Schema.Struct<{
  readonly output: Success
  readonly work: typeof CapturedWork
  readonly capabilityCeiling: typeof EnforcedCeiling
}>

/**
 * Builds the {@link Result} schema over a flow's success schema.
 *
 * @category schemas
 * @since 1.0.0
 */
export const resultSchema = <Success extends Schema.Top>(success: Success): ResultSchema<Success> =>
  Schema.Struct({ output: success, work: CapturedWork, capabilityCeiling: EnforcedCeiling })

/** The workspace-relative directory the runner protocol's files live in. */
const controlDirectory = ".smithers-sandbox"

/** The most bytes of guest stdout or stderr a failure message quotes. */
const quotedOutputBytes = 4096

/** Diagnostic copies take the diagnostic rules, as engine logs do. */
const redact = Redaction.redactDiagnostic

/** Redact before taking a tail: the credential prefix may lie outside the bound. */
const tail = (text: string): string => {
  const redacted = String(redact(text))
  return redacted.length > quotedOutputBytes ? `…${redacted.slice(redacted.length - quotedOutputBytes)}` : redacted
}

/**
 * Drain continuously, retaining a byte ring of redacted text. The line
 * redactor owns the line still arriving: it holds a value that spans lines (a
 * private key block, a string `util.inspect` split with `+`) until it closes,
 * bounds an overlong line itself, and returns only what is safe to keep.
 */
const drainTail = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Effect.gen(function*() {
    const ring = new Uint8Array(quotedOutputBytes)
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const lines = Redaction.lineRedactor(Redaction.diagnosticRules)
    let cursor = 0
    let retained = 0
    let truncated = false
    const append = (text: string) => {
      for (const byte of encoder.encode(text)) {
        ring[cursor] = byte
        cursor = (cursor + 1) % ring.length
        if (retained < ring.length) retained++
        else truncated = true
      }
    }
    const accept = (text: string) => {
      const segments = text.split("\n")
      const last = segments.pop()!
      for (const segment of segments) for (const clean of lines.line(segment)) append(`${clean}\n`)
      if (last !== "") lines.part(last)
    }
    yield* Stream.runForEach(stream, (chunk) =>
      Effect.sync(() => {
        // Never decode an arbitrarily large provider chunk into a host string.
        for (let offset = 0; offset < chunk.length; offset += quotedOutputBytes) {
          accept(decoder.decode(chunk.subarray(offset, offset + quotedOutputBytes), { stream: true }))
        }
      }))
    accept(decoder.decode())
    append(lines.flush().join("\n"))
    const bytes = new Uint8Array(retained)
    const start = retained === ring.length ? cursor : 0
    for (let index = 0; index < retained; index++) bytes[index] = ring[(start + index) % ring.length]!
    let offset = 0
    // A ring wrap can discard the start of a UTF-8 code point.
    while (offset < bytes.length && (bytes[offset]! & 0xC0) === 0x80) offset++
    return `${truncated ? "…" : ""}${new TextDecoder().decode(bytes.subarray(offset))}`
  })

const failure = (
  code: SandboxedFlowError["code"],
  message: string,
  cause?: unknown
): SandboxedFlowError =>
  new SandboxedFlowError({
    code,
    message: String(redact(message)),
    ...(cause === undefined ? {} : { cause: RedactedLogger.redactArgument(cause, redact) })
  })

const sessionFailure = (context: string) => (cause: ProviderError): SandboxedFlowError =>
  failure("session_failed", `${context}: ${cause.message}`, cause)

/** A transport failure stays `session_failed`; git's own verdict is `capture_failed`, led by its reason. */
const captureFailure = (context: string) => (cause: ProviderError | Sandbox.CaptureError): SandboxedFlowError =>
  cause instanceof Sandbox.CaptureError
    ? failure("capture_failed", `${cause.reason}: ${context}: ${cause.message}`, cause)
    : sessionFailure(context)(cause)

/**
 * The bundler's surface this module uses.
 *
 * `esbuild` is a dependency of this package, and the import is nonetheless a
 * dynamic one with a non-literal specifier. The browser contract gate bundles
 * every documented Node-only entry point for the browser and accepts only
 * unresolvable `node:` built-ins as the reason it fails; esbuild's own entry
 * resolves bare `fs` and `child_process`, which the gate would report as a
 * foreign failure. A specifier the bundler cannot analyze is left in place,
 * and the deferral also keeps the bundler unloaded until the first execution.
 */
interface Bundler {
  readonly build: (options: {
    readonly stdin: {
      readonly contents: string
      readonly resolveDir: string
      readonly loader: "ts"
      readonly sourcefile: string
    }
    readonly bundle: true
    readonly platform: "node"
    readonly format: "esm"
    readonly target: string
    readonly write: false
    readonly logLevel: "silent"
  }) => Promise<{ readonly outputFiles: ReadonlyArray<{ readonly contents: Uint8Array }> }>
}

const bundlerSpecifier = "esbuild"

const loadBundler = (): Promise<Bundler> => import(bundlerSpecifier) as Promise<Bundler>

/**
 * The source runner in development, and the built ESM runner in a release.
 * The guest is always bundled as ESM, including when its host uses CommonJS;
 * feeding the CJS runner to that bundle would leave Node built-in requires
 * without a require function in the isolated guest.
 */
const runnerPath = (): string => {
  const here = import.meta.url
  /* v8 ignore next -- release smoke executes the built arm through both module conditions */
  const runner = here.endsWith(".ts") ? "./internal/SandboxedFlowGuest.ts" : "../esm/internal/SandboxedFlowGuest.js"
  return fileURLToPath(new URL(runner, here))
}

/** The bundle's main: the entry's exports and the guest environment, handed to the runner. */
const main = (entryPath: string): string =>
  `import * as entry from ${JSON.stringify(entryPath)}\n` +
  `import { run } from ${JSON.stringify(runnerPath())}\n` +
  "await run(entry, process.env)\n"

const bundle = (entry: URL | string): Effect.Effect<Uint8Array, SandboxedFlowError> =>
  Effect.tryPromise({
    try: async () => {
      const entryPath = typeof entry === "string" ? entry : fileURLToPath(entry)
      const bundler = await loadBundler()
      const built = await bundler.build({
        stdin: {
          contents: main(entryPath),
          resolveDir: dirname(entryPath),
          loader: "ts",
          sourcefile: "sandboxed-flow-main.ts"
        },
        bundle: true,
        platform: "node",
        format: "esm",
        target: "es2022",
        write: false,
        logLevel: "silent"
      })
      return built.outputFiles[0]!.contents
    },
    catch: (cause) =>
      failure(
        "bundle_failed",
        `the entry ${typeof entry === "string" ? entry : entry.href} could not be bundled: ${
          (cause as { readonly errors?: ReadonlyArray<{ readonly text: string }> }).errors?.[0]?.text ??
            String(cause)
        }`,
        cause
      )
  })

/**
 * A deadline on the wall clock, not the ambient `Clock`, for the reason
 * `SandboxConformance` states: `it.effect` runs under a frozen test clock
 * where `Effect.timeout` never fires, and a hang guard that depends on the
 * layer a host may freeze fails exactly when it is needed.
 */
const expired = (deadline: Duration.Input): Effect.Effect<never, SandboxedFlowError> =>
  Effect.flatMap(
    Effect.callback<void>((resume) => {
      const budget = Duration.toMillis(deadline)
      if (!Number.isFinite(budget)) return Effect.void
      const started = performance.now()
      let timer: ReturnType<typeof setTimeout>
      const schedule = () => {
        const remaining = budget - (performance.now() - started)
        if (remaining <= 0) resume(Effect.void)
        else timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647))
      }
      schedule()
      return Effect.sync(() => clearTimeout(timer))
    }),
    () =>
      Effect.fail(
        failure(
          "deadline_exceeded",
          `the sandboxed execution did not finish within ${Duration.toMillis(deadline)} milliseconds`
        )
      )
  )

/** Read at most the budget plus one byte, without the unbounded readFile transport. */
const readBounded = (
  session: Sandbox.Session,
  path: string,
  limit: number,
  context: string
): Effect.Effect<Uint8Array, SandboxedFlowError> =>
  Effect.scoped(Effect.gen(function*() {
    const chunks: Array<Uint8Array> = []
    let total = 0
    const consume = (stream: Stream.Stream<Uint8Array, SandboxedFlowError>) =>
      Stream.runForEach(stream, (bytes) => {
        total += bytes.length
        if (total > limit) {
          return Effect.fail(
            failure("result_overflow", `the read exceeds its remaining byte budget; the limit is ${limit}`)
          )
        }
        chunks.push(new Uint8Array(bytes))
        return Effect.void
      })
    if (session.files?.stream !== undefined) {
      yield* consume(
        session.files.stream(path, { bytesToRead: limit + 1, chunkSize: Math.min(limit + 1, 64 * 1024) }).pipe(
          Stream.mapError((cause) => failure("session_failed", `${context}: ${cause.message}`, cause))
        )
      )
    } else {
      // Bound output in the guest too: some remote transports buffer a whole
      // command response before exposing stdout as a stream.
      const process = yield* session.spawn(
        `head -c ${CommandLine.quote(String(limit + 1))} ${CommandLine.quote(path)}`,
        {}
      )
        .pipe(Effect.mapError(sessionFailure(context)))
      const [, stderr, exitCode] = yield* Effect.all([
        consume(process.stdout.pipe(Stream.mapError(sessionFailure(context)))),
        drainTail(process.stderr).pipe(Effect.mapError(sessionFailure(context))),
        process.exitCode.pipe(Effect.mapError(sessionFailure(context)))
      ], { concurrency: "unbounded" })
      if (exitCode !== 0) return yield* Effect.fail(failure("session_failed", `${context}: ${tail(stderr)}`))
    }
    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  }))

/** Whether two normalized ceilings name the same groups of the same patterns. */
const sameCeiling = (
  left: ReadonlyArray<ReadonlyArray<CapabilityPattern>>,
  right: ReadonlyArray<ReadonlyArray<CapabilityPattern>>
): boolean =>
  left.length === right.length &&
  left.every((group, index) => {
    const other = right[index]!
    return group.length === other.length &&
      group.every((pattern, at) => pattern.action === other[at]!.action && pattern.resource === other[at]!.resource)
  })

/** The result file, checked against the size limit and the protocol's shape. */
const readResult = (
  session: Sandbox.Session,
  resultPath: string,
  attempt: string,
  capabilityCeiling: ReadonlyArray<ReadonlyArray<CapabilityPattern>>,
  limits: ResolvedLimits,
  run: { readonly code: number; readonly stdout: string; readonly stderr: string }
): Effect.Effect<typeof Guest.Result.Type, SandboxedFlowError> =>
  Effect.gen(function*() {
    const outputs = `stdout: ${tail(run.stdout).trim() || "(empty)"}; stderr: ${tail(run.stderr).trim() || "(empty)"}`
    const info = yield* Sandbox.fileSystem(session).stat(resultPath).pipe(
      Effect.mapError((cause) =>
        cause.reason._tag === "NotFound"
          ? failure("result_unreadable", `the guest exited 0 without writing a result; ${outputs}`, cause)
          : failure("session_failed", `the result could not be read back: ${cause.message}`, cause)
      )
    )
    if (Number(info.size) > limits.resultBytes) {
      return yield* Effect.fail(
        failure("result_overflow", `the result holds ${info.size} bytes; the limit is ${limits.resultBytes}`)
      )
    }
    const bytes = yield* readBounded(
      session,
      resultPath,
      limits.resultBytes,
      "the result could not be read back"
    )
    const result = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Guest.Result)(JSON.parse(new TextDecoder().decode(bytes))),
      catch: (cause) =>
        failure("result_unreadable", `the guest wrote a result that is not the protocol's JSON; ${outputs}`, cause)
    })
    if (result.attempt !== attempt) {
      return yield* Effect.fail(
        failure("result_unreadable", `the guest wrote a result for a different attempt; ${outputs}`)
      )
    }
    // A runner that dropped or rewrote the ceiling may have run the child
    // with more authority than the caller holds; nothing it reports is used.
    if (!sameCeiling(result.capabilityCeiling, capabilityCeiling)) {
      return yield* Effect.fail(
        failure(
          "result_unreadable",
          `the guest enforced a capability ceiling other than the one the host sent; ${outputs}`
        )
      )
    }
    return result
  })

/**
 * Runs `flow` with `payload` inside a machine `options.provider` provisions.
 *
 * The child's code executes in the guest; see the module documentation for
 * the runner protocol. The session is acquired for the duration of the call
 * and released when it returns, so a normal completion tears the machine
 * down, and only a host crash leaves one behind for a later execution with the
 * same session key to reattach.
 *
 * `payload` is the decoded payload, and it is encoded through the flow's
 * payload schema for the wire. A value the schema's own JSON codec refuses
 * is a programmer error and dies, the same posture `Flow.executionId` takes.
 *
 * With {@link ExecuteOptions.captureWork}, the base is resolved with
 * `Sandbox.resolveBase` as soon as the session is acquired, before anything
 * is written into the workspace, and the work is captured with
 * `Sandbox.capture` after the output decodes and before the session is
 * released. A failed child captures nothing.
 *
 * @category constructors
 * @since 1.0.0
 */
export const execute = <
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
>(
  flow: Flow.Flow<Tag, Payload, Success, Error, Requires>,
  payload: Payload["Type"],
  options: ExecuteOptions
): Effect.Effect<Result<Success["Type"]>, ExecuteError> =>
  Effect.gen(function*() {
    const attempt = randomUUID()
    // The caller's ambient authority intersected with the child's own
    // declaration, exactly what a local run of the child would hold. The
    // guest only ever intersects with it.
    const capabilityCeiling = (yield* Flow.attenuateCapabilities(Flow.capabilityCeilings(flow.annotations))(
      CapabilitySet.current
    )).groups
    const limits = resolveLimits(options.limits)
    const runtime = options.runtime ?? "node"
    // The wire codecs of a flow's schemas are service-free for the same reason
    // a body's payload placeholders are: a JSON codec that needs a service to
    // encode has no way to be satisfied on the other side of a machine
    // boundary, so the dynamic schema-service parameters are erased here the
    // way the interpreter erases them for a handoff.
    const encodedPayload =
      yield* (Schema.encodeEffect(Schema.toCodecJson(flow.payloadSchema))(payload) as Effect.Effect<
        unknown,
        Schema.SchemaError
      >).pipe(Effect.orDie)
    const built = yield* bundle(options.entry)
    return yield* Effect.raceFirst(
      Effect.scoped(
        Effect.gen(function*() {
          const session = yield* options.provider.acquire(options.session).pipe(
            Effect.mapError(sessionFailure(`the session ${options.session} could not be acquired`))
          )
          const workdir = session.workdir.replace(/\/+$/, "")
          const base = options.captureWork === true
            ? yield* Sandbox.resolveBase(session).pipe(
              Effect.mapError(captureFailure("the base of the workspace could not be resolved"))
            )
            : undefined
          const control = `${workdir}/${controlDirectory}`
          const bundlePath = `${control}/bundle.mjs`
          const requestPath = `${control}/request.json`
          const resultPath = `${control}/result.json`
          const request: typeof Guest.Request.Type = {
            attempt,
            flow: flow._tag,
            executionId: options.session,
            capabilityCeiling,
            payload: encodedPayload
          }
          yield* session.writeFile(bundlePath, built).pipe(
            Effect.mapError(sessionFailure("the bundle could not be written into the workspace"))
          )
          // `*` matches the ignore file too, so git sees nothing of the directory.
          yield* session.writeFile(`${control}/.gitignore`, new TextEncoder().encode("*\n")).pipe(
            Effect.mapError(sessionFailure("the control directory could not be excluded from the work"))
          )
          yield* session.writeFile(
            requestPath,
            new TextEncoder().encode(JSON.stringify(Schema.encodeSync(Guest.Request)(request)))
          ).pipe(
            Effect.mapError(sessionFailure("the request could not be written into the workspace"))
          )
          yield* Sandbox.fileSystem(session).remove(resultPath, { force: true }).pipe(
            Effect.mapError((cause) =>
              failure("session_failed", `the previous result could not be removed: ${cause.message}`, cause)
            )
          )
          const command = `${CommandLine.quote(runtime)} ${CommandLine.quote(bundlePath)}`
          const run = yield* Effect.scoped(
            Effect.gen(function*() {
              const process = yield* session.spawn(command, {
                env: {
                  SMITHERS_SANDBOX_REQUEST_PATH: requestPath,
                  SMITHERS_SANDBOX_RESULT_PATH: resultPath
                }
              })
              const [stdout, stderr, code] = yield* Effect.all(
                [
                  drainTail(process.stdout),
                  drainTail(process.stderr),
                  process.exitCode
                ],
                { concurrency: "unbounded" }
              )
              return { stdout, stderr, code }
            })
          ).pipe(Effect.mapError(sessionFailure(`\`${command}\` could not be run in the session`)))
          if (run.code !== 0) {
            const reason = run.code === 127 || run.code === 126
              ? `the guest image has no runnable \`${runtime}\`; SandboxedFlow starts the runtime it is told to and installs none`
              : `the guest runtime exited ${run.code}`
            return yield* Effect.fail(
              failure("guest_failed", `${reason}; stderr: ${tail(run.stderr).trim() || "(empty)"}`)
            )
          }
          const result = yield* readResult(session, resultPath, attempt, capabilityCeiling, limits, run)
          if (result.status === "failed" && result.denied !== undefined) {
            return yield* Effect.fail(result.denied)
          }
          if (result.status === "failed") {
            return yield* Effect.fail(
              failure(
                "flow_failed",
                `the child flow ${flow._tag} failed in the guest: ${result.error}; stdout: ${
                  tail(run.stdout).trim() || "(empty)"
                }; stderr: ${tail(run.stderr).trim() || "(empty)"}`
              )
            )
          }
          const output = yield* (Schema.decodeUnknownEffect(Schema.toCodecJson(flow.successSchema))(
            result.output
          ) as Effect.Effect<Success["Type"], Schema.SchemaError>).pipe(
            Effect.mapError((cause) =>
              failure(
                "result_invalid",
                `the guest's output does not decode through the success schema of ${flow._tag}: ${cause.message}`,
                cause
              )
            )
          )
          const work = base === undefined ? null : yield* Sandbox.capture(session, { base }).pipe(
            Effect.mapError(captureFailure("the work could not be captured"))
          )
          if (work?._tag === "Changed") {
            const bytes = new TextEncoder().encode(work.patch).length
            if (bytes > limits.diffBytes) {
              return yield* Effect.fail(
                failure("diff_overflow", `the patch holds ${bytes} bytes; the limit is ${limits.diffBytes}`)
              )
            }
          }
          return { output, work, capabilityCeiling }
        })
      ),
      expired(options.timeout ?? Duration.minutes(10))
    )
  })

/**
 * A durable action whose implementation is one sandboxed execution of `flow`.
 *
 * Its payload schema is the flow's, its success schema is {@link resultSchema}
 * over the flow's, and its error schema is {@link ExecuteError}. The
 * parent flow's body calls it like any other action; {@link toLayer} supplies
 * the implementation.
 *
 * @category models
 * @since 1.0.0
 */
export type SandboxedAction<
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top
> = Action.Declared<Tag, Payload, ResultSchema<Success>, typeof ExecuteError>

/**
 * Declares the durable action a parent flow calls to run `flow` in a sandbox.
 *
 * From the parent's point of view the whole sandboxed execution is ONE
 * action: the engine journals one attempt, applies one retry policy, and
 * replays one recorded result. The action's tag is `<flow tag>/sandboxed`
 * unless `options.name` says otherwise.
 *
 * @category constructors
 * @since 1.0.0
 */
export function action<
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires,
  const Name extends string
>(
  flow: Flow.Flow<Tag, Payload, Success, Error, Requires>,
  options: { readonly name: Name }
): SandboxedAction<Name, Payload, Success>
export function action<
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires,
  const Name extends string = never
>(
  flow: Flow.Flow<Tag, Payload, Success, Error, Requires>,
  options?: { readonly name?: Name | undefined }
): SandboxedAction<Name | `${Tag}/sandboxed`, Payload, Success>
export function action<
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
>(
  flow: Flow.Flow<Tag, Payload, Success, Error, Requires>,
  options: { readonly name?: string | undefined } = {}
): SandboxedAction<string, Payload, Success> {
  // `Action.make` answers with `Payload extends Fields ? Struct<Payload> :
  // Payload`, which is `Payload` itself for a schema rather than a field
  // record. The compiler defers that conditional while the type parameter is
  // unresolved, so the identity is asserted here, as `Action.make` itself
  // does for the flow form of a declaration.
  return Action.make(options.name ?? `${flow._tag}/sandboxed`, {
    payload: flow.payloadSchema,
    success: resultSchema(flow.successSchema),
    error: ExecuteError
  }) as unknown as SandboxedAction<string, Payload, Success>
}

/**
 * What {@link toLayer} hands an options function: the decoded payload of the
 * call, the parent execution's id, and the engine's stable invocation key.
 * Combine `executionId` and `callId` for a session key exclusive to this call,
 * including identical parallel calls, and stable across retries and resume.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecuteContext<Payload> {
  readonly payload: Payload
  readonly executionId: string
  /** The engine's invocation key for this call, unchanged by retry or resume. */
  readonly callId: string
}

/**
 * Implements a {@link action} declaration with {@link execute}.
 *
 * `options` is either the placement itself or a function of the call's
 * {@link ExecuteContext}, for a session key derived from the parent execution and call:
 *
 * ```ts
 * SandboxedFlow.toLayer(RunChild, Child, ({ executionId, callId }) => ({
 *   provider,
 *   session: `child:${executionId}:${callId}`,
 *   entry: new URL("./child.ts", import.meta.url)
 * }))
 * ```
 *
 * Compose the returned layer beside `Interpreter.layer(parent)` over one
 * `Action.layerImplementations`, exactly as any other action implementation.
 *
 * @category layers
 * @since 1.0.0
 */
export const toLayer = <
  ActionTag extends string,
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
>(
  declared: SandboxedAction<ActionTag, Payload, Success>,
  flow: Flow.Flow<Tag, Payload, Success, Error, Requires>,
  options: ExecuteOptions | ((context: ExecuteContext<Payload["Type"]>) => ExecuteOptions)
): Layer.Layer<
  Action.Requirement<ActionTag>,
  never,
  | FlowRuntime.FlowRuntime
  | Payload["DecodingServices"]
  | Payload["EncodingServices"]
  | Success["DecodingServices"]
  | Success["EncodingServices"]
> =>
  declared.toLayer((payload) =>
    Effect.gen(function*() {
      const instance = yield* FlowRuntime.FlowInstance
      const callId = yield* Action.CurrentInvocationKey
      if (callId === undefined) {
        return yield* Effect.die(
          "SandboxedFlow.toLayer requires a runtime that supplies Action.CurrentInvocationKey " +
            "to identify each sandboxed action call."
        )
      }
      const placement = typeof options === "function"
        ? options({ payload, executionId: instance.executionId, callId })
        : options
      return yield* execute(flow, payload, placement)
    })
  )
