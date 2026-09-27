/**
 * Two artifact tiers composed into one: local first, remote second, with
 * write-back into the local tier.
 *
 * This is the shape of Bazel's `CombinedCache`
 * (`com.google.devtools.build.lib.remote.CombinedCache`): a read consults the
 * disk cache, falls back to the remote cache only on a miss, and *uploads what it
 * found back into the disk cache* so the next read is local
 * (`downloadActionResultFromRemote`, lines 230-303). A write goes to both.
 *
 * Deviation from Bazel: policy is declared once by the remote tier rather than
 * threaded through every call. `downloadPolicy` controls prefetch and local
 * materialization; composing only the local tier opts out of shared storage.
 *
 * @since 1.0.0-rc.0
 */

import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as ArtifactStore from "./ArtifactStore.ts"
import * as ArtifactStoreMetrics from "./ArtifactStoreMetrics.ts"
import * as RemoteArtifacts from "./RemoteArtifacts.ts"

/**
 * The two tiers to compose.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface Options {
  /** The fast, machine-local tier. Every read tries this one first. */
  readonly local: ArtifactStore.Service
  /** The shared tier. Consulted only on a local miss; written through on put. */
  readonly remote: ArtifactStore.Service
  /**
   * How long a `put` waits for its opportunistic upload to the shared tier
   * before abandoning it. The local digest is already in hand when the upload
   * starts, so the deadline bounds only how long a stalled remote can delay
   * the answer — an abandoned upload is dropped exactly like a refused one.
   * Defaults to 60 seconds, Bazel's `--remote_timeout` default
   * (its `RemoteOptions`).
   */
  readonly uploadTimeout?: Duration.Input | undefined
  /**
   * How long a `get` waits for opportunistic local write-back before
   * interrupting it and returning the verified remote bytes. Defaults to
   * 60 seconds, matching the default upload deadline.
   */
  readonly writeBackTimeout?: Duration.Input | undefined
  /**
   * How eagerly a read materializes a blob into the local tier. Defaults to
   * the policy the remote tier declares (`RemoteArtifacts.Options.downloadPolicy`),
   * and to `all` for a remote tier that declares none.
   *
   * `all` and `toplevel` both write a fetched blob back into the local tier, so
   * the second read is local; they differ only in whether
   * `@smthrs/engine-store`'s `ArtifactSync.hydrate` prefetches. `minimal`
   * serves the bytes without writing them back, so a host that must not
   * accumulate other machines' artifacts never does. `minimal` still repairs a
   * *corrupt* local address, because a rewrite of an address the local tier
   * already claims is repair rather than growth.
   *
   * No policy makes the write-back load-bearing: a local tier that refuses it
   * costs the next read a network round trip, never this read's answer.
   */
  readonly downloadPolicy?: RemoteArtifacts.DownloadPolicy | undefined
}

/**
 * The default deadline on the opportunistic upload. 60 seconds is Bazel's
 * `--remote_timeout` default for its remote cache calls.
 */
const defaultUploadTimeout = Duration.seconds(60)

/** At most one dropped-transfer warning per operation in this window. */
const droppedWarningIntervalMs = 60_000

/** The credential-free reason a dropped transfer failed: its code, never its bytes. */
const reasonOf = (error: ArtifactStore.ArtifactStoreError | Cause.TimeoutError): string =>
  Cause.isTimeoutError(error) ? error._tag : error.code

/**
 * What the local tier answered a read with. A miss and a corrupt address both
 * fall through to the shared tier, but they are not the same fact: only
 * corruption earns a write-back the `minimal` policy would otherwise skip.
 */
type LocalRead =
  | { readonly _tag: "hit"; readonly bytes: Uint8Array }
  | { readonly _tag: "miss" }
  | { readonly _tag: "corrupt" }

/**
 * Composes a local and a remote artifact store.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export const make = (
  options: Options
): Effect.Effect<RemoteArtifacts.Service, ArtifactStore.ArtifactStoreError> =>
  Effect.gen(function*() {
    const { local, remote } = options
    const parsedUploadTimeout = Duration.fromInput(options.uploadTimeout ?? defaultUploadTimeout)
    if (
      Option.isNone(parsedUploadTimeout) ||
      !Number.isFinite(Duration.toMillis(parsedUploadTimeout.value)) ||
      Duration.toMillis(parsedUploadTimeout.value) <= 0
    ) {
      return yield* Effect.fail(
        new ArtifactStore.ArtifactStoreError({
          code: "invalid_configuration",
          message: "invalid combined artifact option: uploadTimeout"
        })
      )
    }
    const uploadTimeout = parsedUploadTimeout.value
    const parsedWriteBackTimeout = Duration.fromInput(options.writeBackTimeout ?? defaultUploadTimeout)
    if (
      Option.isNone(parsedWriteBackTimeout) ||
      !Number.isFinite(Duration.toMillis(parsedWriteBackTimeout.value)) ||
      Duration.toMillis(parsedWriteBackTimeout.value) <= 0
    ) {
      return yield* Effect.fail(
        new ArtifactStore.ArtifactStoreError({
          code: "invalid_configuration",
          message: "invalid combined artifact option: writeBackTimeout"
        })
      )
    }
    const writeBackTimeout = parsedWriteBackTimeout.value
    const downloadPolicy = options.downloadPolicy ?? RemoteArtifacts.downloadPolicyOf(remote) ?? "all"
    if (!Schema.is(RemoteArtifacts.DownloadPolicy)(downloadPolicy)) {
      return yield* Effect.fail(
        new ArtifactStore.ArtifactStoreError({
          code: "invalid_configuration",
          message: "invalid combined artifact option: downloadPolicy"
        })
      )
    }
    /**
     * In-flight uploads, keyed by digest. Two settles in one process that spill
     * the same artifact would otherwise both push the same bytes over the
     * network; the second joins the first's `Deferred` instead. The map holds
     * only in-flight work — the entry is removed before the deferred is
     * completed, so a later `put` of the same digest starts a fresh upload
     * rather than replaying a stale outcome.
     */
    const uploads = new Map<string, Deferred.Deferred<ArtifactStore.Digest, ArtifactStore.ArtifactStoreError>>()
    /**
     * Counts a dropped opportunistic transfer and warns at most once per
     * operation per {@link droppedWarningIntervalMs}, so a shared tier that
     * refuses every request is visible without one log line per artifact.
     */
    const lastWarnedAt = new Map<"put" | "write_back", number>()
    const dropped =
      (operation: "put" | "write_back") => (error: ArtifactStore.ArtifactStoreError | Cause.TimeoutError) =>
        Effect.gen(function*() {
          yield* Metric.update(ArtifactStoreMetrics.remoteFailure[operation], 1)
          const now = yield* Clock.currentTimeMillis
          const last = lastWarnedAt.get(operation)
          if (last !== undefined && now - last < droppedWarningIntervalMs) return
          lastWarnedAt.set(operation, now)
          yield* Effect.logWarning("Combined artifact transfer dropped").pipe(
            Effect.annotateLogs({ operation, reason: reasonOf(error) })
          )
        })
    const uploadInterrupted = (): ArtifactStore.ArtifactStoreError =>
      new ArtifactStore.ArtifactStoreError({
        code: "unavailable",
        message: "the shared upload was interrupted before it settled"
      })
    const uploadOnce = (digest: ArtifactStore.Digest, bytes: Uint8Array) =>
      Effect.suspend(() => {
        const joined = uploads.get(digest)
        if (joined !== undefined) return Deferred.await(joined)
        // Registration and settlement are atomic against interruption. The
        // upload itself stays interruptible — that is how the deadline in `put`
        // cuts it short — but everything around it runs masked: interruption
        // striking between registering the deferred and resolving it would
        // otherwise orphan the entry, and every later `put` of the digest would
        // join a deferred nobody will ever complete.
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function*() {
            const deferred = yield* Deferred.make<ArtifactStore.Digest, ArtifactStore.ArtifactStoreError>()
            uploads.set(digest, deferred)
            return yield* restore(remote.put(bytes)).pipe(
              Effect.onExit((exit) => {
                uploads.delete(digest)
                // An interrupted upload resolves the deferred with a typed
                // failure, never with the interruption itself: interruption
                // would tear down every innocent waiter, while a typed refusal
                // is exactly the outcome `put` already drops. The map entry is
                // gone either way, so the next `put` of the digest retries
                // with a fresh upload.
                return Exit.hasInterrupts(exit)
                  ? Deferred.fail(deferred, uploadInterrupted())
                  : Deferred.done(deferred, exit)
              })
            )
          })
        )
      })

    const put: ArtifactStore.Service["put"] = Effect.fn("CombinedArtifacts.put")((bytes: Uint8Array) =>
      Effect.flatMap(ArtifactStore.snapshotBytes(bytes), (snapshot) =>
        Effect.gen(function*() {
          // Local first, and its digest is the answer: the local tier is the one
          // this machine's replays resolve against, so a remote tier that is down
          // must not stop an artifact from being recorded locally.
          const digest = yield* local.put(snapshot)
          yield* Effect.annotateCurrentSpan({ digest })
          // Which means the upload is opportunistic, and a refusal is dropped
          // rather than propagated. Failing here would fail whatever produced the
          // bytes — a step's `settle`, say — because a *cache* was unreachable,
          // which is the opposite of the line above. Nothing depends on this
          // upload: what actually guarantees a shared cache entry's blobs are
          // durable is the publication protocol's `findMissing` → upload →
          // confirm, run before the entry is published. A dropped upload here
          // costs that protocol one re-upload, never correctness. The deadline
          // keeps it opportunistic in time as well: a remote that stalls instead
          // of refusing must not hold the local answer hostage, so the upload is
          // interrupted after `uploadTimeout` and abandoned like any refusal.
          yield* uploadOnce(digest, snapshot).pipe(
            Effect.timeout(uploadTimeout),
            Effect.asVoid,
            Effect.catch(dropped("put"))
          )
          return digest
        }))
    )

    const get: ArtifactStore.Service["get"] = Effect.fn("CombinedArtifacts.get")((digest: string) =>
      Effect.flatMap(ArtifactStore.validateDigest(digest), (validated) =>
        Effect.gen(function*() {
          yield* Effect.annotateCurrentSpan({ digest: validated })
          // A local miss AND local corruption fall through to the remote tier,
          // and they are kept apart because they earn different write-backs. A
          // local `ArtifactStoreError` deliberately does NOT fall through: a
          // host that refused the read has not answered the question, and
          // silently paying the network for it would hide a broken local tier
          // behind a working shared one.
          const cached = yield* local.get(validated).pipe(
            Effect.map((bytes): LocalRead => ({ _tag: "hit", bytes })),
            Effect.catchTags({
              "@smthrs/artifacts/ArtifactMissing": () => Effect.succeed<LocalRead>({ _tag: "miss" }),
              "@smthrs/artifacts/ArtifactCorruption": () => Effect.succeed<LocalRead>({ _tag: "corrupt" })
            })
          )
          if (cached._tag === "hit") return cached.bytes
          const fetched = yield* remote.get(validated)
          // `minimal` reads through without materializing: the caller gets the
          // bytes, the local tier stays exactly as small as it was, and the next
          // read pays the network again. Corruption is the exception every
          // policy makes. Handing the correct bytes to `local.put` lets its own
          // digest verification rewrite the mismatched blob, and an address the
          // local tier already claims — `has` and `findMissing` both report it
          // as present — must be one it can serve, or the publication protocol
          // is told a lie no later read can correct.
          if (downloadPolicy !== "minimal" || cached._tag === "corrupt") {
            // Opportunistic, exactly like `put`'s upload: the answer is already
            // in hand, so a full disk, a read-only mount, or a refused sync must
            // cost the next read a round trip rather than fail this one. A
            // stalled write is interrupted at the deadline so it cannot hold
            // the verified remote answer indefinitely.
            yield* local.put(fetched).pipe(
              Effect.timeout(writeBackTimeout),
              Effect.asVoid,
              Effect.catch(dropped("write_back"))
            )
          }
          return fetched
        }))
    )

    const has: ArtifactStore.Service["has"] = Effect.fn("CombinedArtifacts.has")((digest: string) =>
      Effect.flatMap(ArtifactStore.validateDigest(digest), (validated) =>
        Effect.annotateCurrentSpan({ digest: validated }).pipe(
          Effect.andThen(
            Effect.flatMap(
              local.has(validated),
              (present) => present ? Effect.succeed(true) : remote.has(validated)
            )
          )
        ))
    )

    const findMissing: ArtifactStore.Service["findMissing"] = Effect.fn("CombinedArtifacts.findMissing")(
      (digests: Iterable<string>) =>
        Effect.gen(function*() {
          // The iterable is materialized once: it may be single-pass, and both the
          // annotation and the local probe need it.
          const requested = [...new Set(digests)]
          const validated: Array<ArtifactStore.Digest> = []
          for (const digest of requested) {
            validated.push(yield* ArtifactStore.validateDigest(digest))
          }
          // Missing means missing from BOTH tiers, and the remote probe is asked
          // only about what the local tier could not answer — one network round
          // trip, over the smallest possible set. The result stays a subset of the
          // input because each stage filters the previous stage's output.
          return yield* Effect.annotateCurrentSpan({ count: validated.length }).pipe(
            Effect.andThen(
              Effect.flatMap(
                local.findMissing(validated),
                (missingLocally) =>
                  missingLocally.length === 0 ? Effect.succeed(missingLocally) : remote.findMissing(missingLocally)
              )
            )
          )
        })
    )

    return { put, get, has, findMissing, downloadPolicy }
  })

/**
 * The two tiers as effects, plus the options {@link make} takes.
 *
 * Both tiers are supplied as *effects* rather than layers because they inhabit
 * the same tag: composing two `Layer<ArtifactStore>` would just shadow one
 * with the other. Pair `ArtifactStore.makeFileSystem` (wrapped in
 * `Effect.sync`) or `Effect.map(FileSystem.FileSystem, ...)` with
 * `RemoteArtifacts.make`.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface LayerOptions<EL, RL, ER, RR> {
  readonly local: Effect.Effect<ArtifactStore.Service, EL, RL>
  readonly remote: Effect.Effect<ArtifactStore.Service, ER, RR>
  readonly uploadTimeout?: Duration.Input | undefined
  readonly writeBackTimeout?: Duration.Input | undefined
  readonly downloadPolicy?: RemoteArtifacts.DownloadPolicy | undefined
}

/**
 * Provides a local-first artifact store, backed by local and remote effects, as
 * the `ArtifactStore` tag.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = <EL, RL, ER, RR>(
  options: LayerOptions<EL, RL, ER, RR>
): Layer.Layer<ArtifactStore.ArtifactStore, EL | ER | ArtifactStore.ArtifactStoreError, RL | RR> =>
  Layer.effect(ArtifactStore.ArtifactStore)(
    Effect.flatMap(
      Effect.all({ local: options.local, remote: options.remote }),
      ({ local, remote }) =>
        make({
          local,
          remote,
          uploadTimeout: options.uploadTimeout,
          writeBackTimeout: options.writeBackTimeout,
          downloadPolicy: options.downloadPolicy
        })
    )
  )
