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
 *    codec, and, when {@link ExecuteOptions.collectDiff} is set, reads the
 *    files the guest created or changed in the workspace and returns them,
 *    with the paths it deleted, as data beside the output.
 *
 * What the guest image must contain is a statement, not code: the runtime the
 * bundle is started with, `node` (22 or later) or `bun`, has to be on the
 * guest's `PATH`. Nothing here installs one. A missing runtime is reported as
 * a `guest_failed` failure that names it.
 *
 * The workspace diff is DATA, not an applied change. Applying it on the host,
 * or gating it behind review the way the 0.x component's `reviewDiffs` did, is
 * the caller's, and the review gate is the recorded follow-up of this pass.
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
import type * as FileSystem from "effect/FileSystem"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as PlatformError from "effect/PlatformError"
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
 * - `diff_overflow`: the workspace diff exceeds {@link Limits.files} or
 *   {@link Limits.diffBytes}.
 * - `diff_unsafe`: a created, changed, or deleted path is not a plain
 *   workspace-relative path: it holds a backslash, a `.` or `..` segment, an
 *   empty segment, a leading `/`, or a drive prefix.
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
      "diff_unsafe",
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
 * (the old manifest limit), 100 MB for the collected files (the old bundle
 * total), and 1,000 files (the old patch-file count).
 *
 * @category models
 * @since 1.0.0
 */
export interface Limits {
  /** The largest result JSON accepted, in bytes. Default 5 MiB. */
  readonly resultBytes?: number | undefined
  /** The most workspace-diff bytes collected. Default 100 MiB. */
  readonly diffBytes?: number | undefined
  /** The most created or changed files collected. Default 1,000. */
  readonly files?: number | undefined
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
  readonly files: number
}

/**
 * The limits {@link execute} applies where {@link ExecuteOptions.limits} names none.
 *
 * @category models
 * @since 1.0.0
 */
export const defaultLimits: ResolvedLimits = Object.freeze({
  resultBytes: 5 * 1024 * 1024,
  diffBytes: 100 * 1024 * 1024,
  files: 1000
})

/** The caller's bounds over the defaults, an omitted or undefined bound keeping the default. */
const resolveLimits = (limits: Limits | undefined): ResolvedLimits => ({
  resultBytes: limits?.resultBytes ?? defaultLimits.resultBytes,
  diffBytes: limits?.diffBytes ?? defaultLimits.diffBytes,
  files: limits?.files ?? defaultLimits.files
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
  /** Whether to collect the files the guest created, changed, or deleted. Default `false`. */
  readonly collectDiff?: boolean | undefined
  /** Bounds on the result and the diff; see {@link defaultLimits}. */
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
 * One file the guest created or changed, as it stood when the guest exited.
 *
 * @category models
 * @since 1.0.0
 */
export interface DiffEntry {
  /** The path relative to the session workdir. */
  readonly path: string
  readonly bytes: Uint8Array
}

/**
 * What a sandboxed execution returns: the child's success value, decoded
 * through its own schema, and the workspace diff when it was asked for.
 *
 * @category models
 * @since 1.0.0
 */
export interface Result<A> {
  readonly output: A
  readonly diff: ReadonlyArray<DiffEntry>
  /** Workspace-relative paths that existed before the guest ran and were gone after. */
  readonly deleted: ReadonlyArray<string>
  /**
   * The ceiling the guest enforced, as normalized any-of groups: the receipt
   * the parent journals. No groups is unrestricted authority.
   */
  readonly capabilityCeiling: ReadonlyArray<ReadonlyArray<CapabilityPattern>>
}

/**
 * The schema of a {@link DiffEntry}, JSON-encodable for the journal: the
 * bytes serialize as base64.
 *
 * @category schemas
 * @since 1.0.0
 */
export const DiffEntry = Schema.Struct({ path: Schema.String, bytes: Schema.Uint8Array })

/**
 * The schema of a {@link Result}'s `diff`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Diff = Schema.Array(DiffEntry)

/**
 * The schema of a {@link Result}'s `deleted` paths. A result recorded before
 * the field existed decodes with none.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Deleted = Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))

/**
 * The schema of a {@link Result}'s `capabilityCeiling`. A result recorded
 * before ceilings crossed the machine boundary ran unrestricted and decodes
 * with no groups.
 *
 * @category schemas
 * @since 1.0.0
 */
export const EnforcedCeiling = Guest.Ceiling.pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))

/**
 * The schema of a {@link Result} over a flow's success schema.
 *
 * @category schemas
 * @since 1.0.0
 */
export type ResultSchema<Success extends Schema.Top> = Schema.Struct<{
  readonly output: Success
  readonly diff: typeof Diff
  readonly deleted: typeof Deleted
  readonly capabilityCeiling: typeof EnforcedCeiling
}>

/**
 * Builds the {@link Result} schema over a flow's success schema.
 *
 * @category schemas
 * @since 1.0.0
 */
export const resultSchema = <Success extends Schema.Top>(success: Success): ResultSchema<Success> =>
  Schema.Struct({ output: success, diff: Diff, deleted: Deleted, capabilityCeiling: EnforcedCeiling })

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

/**
 * How many workspace stats a snapshot keeps in flight.
 *
 * `Sandbox.fileSystem` answers `stat` with one session command per path when
 * the provider exposes no native filesystem, so a serial walk pays one remote
 * round trip per workspace file, twice per diff-enabled execution. The bound
 * exists because the other direction is no better: an unbounded walk of a
 * large workspace opens one guest process per file at once, which is how a
 * provider's command limit is reached and how a machine runs out of process
 * slots. Sixteen overlaps enough round trips to hide their latency while the
 * count of live commands stays a constant the provider can absorb.
 */
const statConcurrency = 16

/**
 * What a snapshot records per file: its size and, where the provider's `stat`
 * reports one, its modification time. A file counts as changed when either
 * differs, so a same-size rewrite is caught wherever the provider knows the
 * time; the portable probe dialect reports none and falls back to size alone.
 */
interface Fingerprint {
  readonly size: number
  readonly mtimeMs: number | undefined
}

const differs = (before: Fingerprint | undefined, after: Fingerprint): boolean =>
  before === undefined || before.size !== after.size || before.mtimeMs !== after.mtimeMs

/** The changed-file count limit an after-walk enforces while it walks. */
interface ChangeBudget {
  readonly before: ReadonlyMap<string, Fingerprint>
  readonly limit: number
}

/** Whether a workdir is a native Windows path, whose listings use backslashes. */
const windows = (workdir: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(workdir)

/**
 * Whether a diff path could name something other than one file under the
 * workspace when a caller writes it back. After the Windows listing is
 * normalized, a backslash is a literal POSIX filename byte that a Windows
 * applier would read as a separator, so it is refused along with `..`, `.`,
 * empty segments, a leading `/`, and a drive prefix.
 */
const unsafeDiffPath = (path: string): boolean =>
  path.includes("\\") || /^[A-Za-z]:/.test(path) ||
  path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")

const unlistable = (cause: PlatformError.PlatformError): SandboxedFlowError =>
  failure("session_failed", `the workspace could not be listed: ${cause.message}`, cause)

/**
 * Fingerprints by workspace-relative path of every regular file outside the
 * control directory.
 *
 * One listing, then the stats with bounded concurrency. The results keep the
 * listing's order, so the diff a caller receives does not depend on which
 * stat answered first.
 *
 * `changed` makes this the AFTER walk of a diff: an entry whose fingerprint
 * differs from `changed.before` counts, and the walk fails as soon as more than
 * `changed.limit` of them have been seen rather than statting the rest of a
 * workspace whose diff is already refused.
 */
const snapshot = (
  files: FileSystem.FileSystem,
  workdir: string,
  changed?: ChangeBudget
): Effect.Effect<ReadonlyMap<string, Fingerprint>, SandboxedFlowError> =>
  Effect.gen(function*() {
    const listed = yield* files.readDirectory(workdir, { recursive: true }).pipe(Effect.mapError(unlistable))
    // Native Windows listings use backslashes. Normalize that guest dialect
    // before excluding protocol files or exposing workspace-relative diffs.
    // Backslashes in a POSIX guest remain literal filename characters.
    const relative = windows(workdir) ? listed.map((entry) => entry.replace(/\\/g, "/")) : listed
    const entries = relative.filter((entry) => entry !== controlDirectory && !entry.startsWith(`${controlDirectory}/`))
    let over = 0
    const measure = (entry: string): Effect.Effect<Fingerprint | undefined, SandboxedFlowError> =>
      Effect.flatMap(files.stat(entry).pipe(Effect.mapError(unlistable)), (info) => {
        if (info.type !== "File") return Effect.succeed(undefined)
        const fingerprint: Fingerprint = {
          size: Number(info.size),
          mtimeMs: Option.match(info.mtime, { onNone: () => undefined, onSome: (mtime) => mtime.getTime() })
        }
        if (changed !== undefined && differs(changed.before.get(entry), fingerprint) && ++over > changed.limit) {
          return Effect.fail(
            failure(
              "diff_overflow",
              `the guest changed more than ${changed.limit} files; the limit is ${changed.limit}`
            )
          )
        }
        return Effect.succeed(fingerprint)
      })
    const measured = yield* Effect.forEach(entries, measure, { concurrency: statConcurrency })
    const fingerprints = new Map<string, Fingerprint>()
    for (const [index, fingerprint] of measured.entries()) {
      if (fingerprint !== undefined) fingerprints.set(entries[index]!, fingerprint)
    }
    return fingerprints
  })

/** Read at most the budget plus one byte, without the unbounded readFile transport. */
const readBounded = (
  session: Sandbox.Session,
  path: string,
  limit: number,
  code: "result_overflow" | "diff_overflow",
  context: string
): Effect.Effect<Uint8Array, SandboxedFlowError> =>
  Effect.scoped(Effect.gen(function*() {
    const chunks: Array<Uint8Array> = []
    let total = 0
    const consume = (stream: Stream.Stream<Uint8Array, SandboxedFlowError>) =>
      Stream.runForEach(stream, (bytes) => {
        total += bytes.length
        if (total > limit) {
          return Effect.fail(failure(code, `the read exceeds its remaining byte budget; the limit is ${limit}`))
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

/**
 * Reads every file the guest created or changed, within the limits, and lists
 * the files it deleted.
 *
 * The reads stay sequential on purpose, unlike the stats the walk overlaps.
 * Each one is bounded by the budget the reads before it did NOT spend, which
 * is what keeps a file that grew after the walk from carrying the aggregate
 * past `diffBytes`. Concurrent reads would each have to start from the whole
 * remaining budget, so the bytes a host can hold at once would become the
 * budget times the concurrency rather than the budget.
 */
const collect = (
  session: Sandbox.Session,
  files: FileSystem.FileSystem,
  workdir: string,
  before: ReadonlyMap<string, Fingerprint>,
  after: ReadonlyMap<string, Fingerprint>,
  limits: ResolvedLimits
): Effect.Effect<
  { readonly diff: ReadonlyArray<DiffEntry>; readonly deleted: ReadonlyArray<string> },
  SandboxedFlowError
> =>
  Effect.gen(function*() {
    // The count limit is spent during the after walk, which refuses an
    // oversized diff without statting the workspace to its end.
    const touched = [...after].filter(([path, fingerprint]) => differs(before.get(path), fingerprint))
    const deleted = [...before.keys()].filter((path) => !after.has(path))
    const unsafe = [...touched.map(([path]) => path), ...deleted].find(unsafeDiffPath)
    if (unsafe !== undefined) {
      return yield* Effect.fail(
        failure("diff_unsafe", `the guest left ${JSON.stringify(unsafe)}, which is not a plain workspace-relative path`)
      )
    }
    // `stat` follows links, so the walk counts a link to a file as that file.
    // Only a path that resolves to itself under the workspace is a regular
    // file the guest wrote; anything else would read the link's target, which
    // on a provider whose files are the host's can sit outside the workspace.
    const resolved = (path: string) =>
      files.realPath(path).pipe(
        Effect.map((real) => windows(workdir) ? real.replace(/\\/g, "/") : real),
        Effect.mapError((cause) =>
          failure("session_failed", `the path ${path} could not be resolved: ${cause.message}`, cause)
        )
      )
    const root = touched.length === 0 ? workdir : yield* resolved(workdir)
    const changed: Array<readonly [string, Fingerprint]> = []
    for (const entry of touched) {
      if ((yield* resolved(`${workdir}/${entry[0]}`)) === `${root}/${entry[0]}`) changed.push(entry)
    }
    const total = changed.reduce((sum, [, fingerprint]) => sum + fingerprint.size, 0)
    if (total > limits.diffBytes) {
      return yield* Effect.fail(
        failure("diff_overflow", `the changed files hold ${total} bytes; the limit is ${limits.diffBytes}`)
      )
    }
    const diff: Array<DiffEntry> = []
    let collected = 0
    for (const [path] of changed) {
      const bytes = yield* readBounded(
        session,
        `${workdir}/${path}`,
        limits.diffBytes - collected,
        "diff_overflow",
        `the changed file ${path} could not be read back`
      )
      collected += bytes.length
      // readBounded owns these plain bytes; the diff is data the caller keeps.
      diff.push({ path, bytes })
    }
    return { diff, deleted }
  })

/** The result file, checked against the size limit and the protocol's shape. */
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
      "result_overflow",
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
 * Change detection for the diff compares each file's size and modification
 * time by path against a snapshot taken before the guest ran: a created file
 * and a changed file are collected, and a file present before and absent
 * after is listed in `deleted`. A provider whose `stat` reports no
 * modification time, such as the portable probe dialect, falls back to size
 * alone, so on it a same-size rewrite of a file that existed before the guest
 * ran, which only a REATTACHED workspace holds, is missed. A fresh workspace
 * holds nothing but the protocol's own files, so every file the child writes
 * there is a creation.
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
          const control = `${workdir}/${controlDirectory}`
          const bundlePath = `${control}/bundle.mjs`
          const requestPath = `${control}/request.json`
          const resultPath = `${control}/result.json`
          const files = Sandbox.fileSystem(session)
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
          yield* session.writeFile(
            requestPath,
            new TextEncoder().encode(JSON.stringify(Schema.encodeSync(Guest.Request)(request)))
          ).pipe(
            Effect.mapError(sessionFailure("the request could not be written into the workspace"))
          )
          yield* files.remove(resultPath, { force: true }).pipe(
            Effect.mapError((cause) =>
              failure("session_failed", `the previous result could not be removed: ${cause.message}`, cause)
            )
          )
          const before = options.collectDiff === true
            ? yield* snapshot(files, workdir)
            : new Map<string, Fingerprint>()
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
          const changes = options.collectDiff === true
            ? yield* collect(
              session,
              files,
              workdir,
              before,
              yield* snapshot(files, workdir, { before, limit: limits.files }),
              limits
            )
            : { diff: [], deleted: [] }
          return {
            output,
            diff: changes.diff,
            deleted: changes.deleted,
            capabilityCeiling
          }
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
