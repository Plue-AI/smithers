/** Private host configuration of the existing Jj service. The helper owns snapshots;
 * the engine keeps immutable preimage references in its existing journal.
 */
import { Cause, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { helperPath } from "./helper.ts"
import type { NativeOptions } from "./native.ts"

const CommitId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const Snapshot = Schema.Struct({ commitId: CommitId, changeId: Schema.String.check(Schema.isPattern(/^[k-z]{32}$/)) })
const Diff = Schema.Struct({ diff: Schema.String })
const NativeError = Schema.Struct({ code: Schema.String, message: Schema.String })
type Method = "snapshot" | "restore" | "diff"

/** Projects a host or guest failure onto the record a `JjError` carries,
 * admitting only a code {@link Jj.JjErrorCode} declares.
 *
 * A cause record is read as a code, not only as prose:
 * `agent/src/internal/FailureSummary.ts` walks a rendered failure to the
 * INNERMOST record carrying a message and prefixes THAT record's `code`, and
 * `apps/app/src/mainview/state/RunCause.ts` picks the sentence a person reads
 * off that one line. `Jj.jjErrorCause` copies any string `code` off any object,
 * and the objects projected here come from outside this repo's vocabulary — a
 * helper's JSON envelope, the host's own errno. Such a word does not
 * land on the record: it is kept in the message, which is prose and is never
 * read as a code.
 */
const declaredCodes = new Set<string>(Jj.JjErrorCode.literals)
const causeOf = (cause: unknown): Jj.JjErrorCause => {
  const projected = Jj.jjErrorCause(cause)
  const code = projected.code
  if (code === undefined || declaredCodes.has(code)) return projected
  const { code: _foreign, ...rest } = projected
  const message = `${rest.message} (${code})`
  return {
    ...rest,
    message: message.length > Jj.causeMessageLimit ? `${message.slice(0, Jj.causeMessageLimit - 1)}…` : message
  }
}
const failure = (method: Method, code: Jj.JjErrorCode, message: string, cause?: unknown) =>
  new Jj.JjError({
    code,
    module: "coding/Snapshots",
    method,
    message,
    ...(cause === undefined ? {} : { cause: causeOf(cause) })
  })

/** Every code the native `--engine` helper is admitted to speak, and the
 * `JjErrorCode` each becomes here.
 *
 * The helper is packaged from this repo, so
 * its code is a string until this table admits it. A word this table does not
 * hold never becomes a code: it would otherwise reach a person as whatever
 * sentence some other vocabulary attaches to it. The mapping is total over its
 * own keys, so a code added here has to be given a `JjErrorCode` to compile —
 * the previous `if` chain silently answered "unknown" instead.
 */
const ENGINE_CODES = {
  invalid_ref: "invalid_ref",
  invalid_request: "invalid_ref",
  unsupported_version: "unsupported_version",
  unsupported_jj: "unsupported_version",
  snapshot_incomplete: "snapshot_refused",
  snapshot_refused: "snapshot_refused",
  operation_conflict: "conflict",
  workspace_busy: "conflict",
  revision_conflict: "conflict"
} as const satisfies Readonly<Record<string, Jj.JjErrorCode>>
const codeFor = (code: string): Jj.JjErrorCode | undefined =>
  Object.hasOwn(ENGINE_CODES, code) ? ENGINE_CODES[code as keyof typeof ENGINE_CODES] : undefined

const capture = <E>(method: Method, stream: Stream.Stream<Uint8Array, E>, limit: number) =>
  Stream.runFoldEffect(stream, () => ({ text: "", bytes: 0, decoder: new TextDecoder() }), (state, chunk) => {
    const bytes = state.bytes + chunk.length
    if (bytes > limit) {
      return Effect.fail(failure(method, "unknown", "Native snapshot response exceeded its bounded size"))
    }
    return Effect.succeed({ ...state, bytes, text: state.text + state.decoder.decode(chunk, { stream: true }) })
  }).pipe(Effect.map((state) => state.text + state.decoder.decode()))

/** Supply the host's existing contained spawner. This same layer runs on Node
 * and Bun; neither it nor the helper owns an execution database.
 *
 * The `snapshot().commitId` is the immutable preimage; `changeId` is the
 * unchanged planned JJ change. Both match the shared Jj.Snapshot contract.
 */
export const layerAt = (options: NativeOptions) =>
  Layer.effect(Jj.Jj)(Effect.gen(function*() {
    const base = yield* Jj.Jj
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const invoke = (method: Method, fields: Record<string, string> = {}) =>
      Effect.gen(function*() {
        const input = JSON.stringify({ ...fields, operation: method, repositoryPath: options.repositoryPath })
        if (new TextEncoder().encode(input).length > 64 * 1024) {
          return yield* failure(method, "invalid_ref", "Native snapshot request exceeds 64 KiB")
        }
        const process = yield* spawner.spawn(
          ChildProcess.make(helperPath(options), ["--engine"], {
            stdin: Stream.make(new TextEncoder().encode(input)),
            cwd: options.repositoryPath
          })
        )
        const [stdout, , exitCode] = yield* Effect.all([
          capture(method, process.stdout, 16 * 1024 * 1024),
          capture(method, process.stderr, 64 * 1024),
          process.exitCode
        ], { concurrency: "unbounded" })
        const result = yield* Effect.try({
          try: () => JSON.parse(stdout) as unknown,
          catch: (error) => failure(method, "unknown", "Native snapshot helper returned no valid result", error)
        })
        if (result !== null && typeof result === "object" && "error" in result) {
          const error = yield* Schema.decodeUnknownEffect(NativeError)(result.error).pipe(
            Effect.mapError((error) =>
              failure(method, "unknown", "Native snapshot helper returned an invalid error envelope", error)
            )
          )
          // The helper's own code and sentence survive either way, in the message
          // and the cause message, where a word from outside this repo belongs.
          const admitted = codeFor(error.code)
          const detail = { code: admitted ?? "unknown", message: `${error.message} (${error.code})` }
          return yield* admitted === undefined
            ? failure(
              method,
              "unknown",
              `Native snapshot helper answered with a code this build does not declare (${error.code}): ${error.message}`,
              detail
            )
            : failure(method, admitted, error.message, detail)
        }
        if (exitCode !== 0) {
          return yield* failure(method, "unknown", "Native snapshot helper exited without a successful result")
        }
        return result
      }).pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: "4 minutes",
          orElse: () =>
            Effect.fail(
              failure(method, "unknown", "Native snapshot operation timed out; its outcome requires inspection")
            )
        }),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
          const error = Cause.squash(cause)
          const detail = error instanceof Error && error.cause !== undefined ? error.cause : error
          return Effect.fail(
            Jj.isJjError(error) ?
              error :
              failure(method, "unknown", "Native snapshot process failed: " + Jj.jjErrorCause(detail).message, detail)
          )
        })
      )
    const exact = (method: Method, value: string) =>
      Schema.decodeUnknownEffect(CommitId)(value).pipe(
        Effect.mapError(() =>
          failure(
            method,
            "invalid_ref",
            "Engine snapshots require full immutable JJ commit IDs; short or mutable references cannot be restored"
          )
        )
      )
    return Jj.make({
      ...base,
      // Labels stay on the existing action/journal; never describe or open a new
      // native change merely to capture a compensable action's preimage.
      snapshot: () =>
        invoke("snapshot").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
          Effect.mapError((error) =>
            Jj.isJjError(error)
              ? error
              : failure("snapshot", "unknown", "Native snapshot returned an invalid immutable reference", error)
          )
        ),
      restore: (reference) =>
        exact("restore", reference).pipe(
          Effect.flatMap((commitId) => invoke("restore", { commitId })),
          Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
          Effect.asVoid,
          Effect.mapError((error) =>
            Jj.isJjError(error)
              ? error
              : failure("restore", "unknown", "Native restore returned an invalid immutable reference", error)
          )
        ),
      diff: (from, to) =>
        Effect.all([exact("diff", from), exact("diff", to)]).pipe(
          Effect.flatMap(([from, to]) => invoke("diff", { from, to })),
          Effect.flatMap(Schema.decodeUnknownEffect(Diff)),
          Effect.map((result) => result.diff),
          Effect.mapError((error) =>
            Jj.isJjError(error) ? error : failure("diff", "unknown", "Native diff returned an invalid result", error)
          )
        )
    })
  })).pipe(Layer.provide(NodeJj.layerSpawnerAt(options.repositoryPath)))
