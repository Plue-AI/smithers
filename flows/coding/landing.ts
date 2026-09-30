/**
 * The one `Landing` a host binds: this opinionated Effect adapter over the
 * backend's landing API (Plue composes it; no queue or ledger here), or a local
 * lander from `local-landing.ts` for a host without a repository binding.
 */
import { Cause, Context, Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import {
  AppendObservation,
  AppendPreparation,
  AppendPreparationInput,
  type AppendRequest,
  type Delivery,
  GitHubPull,
  type LandingCandidate,
  type LandingIdentity,
  LaneReceipt,
  LaneSubmission,
  type LocalLander,
  type LocalPull,
  type MergeOutcome,
  type PullChecks,
  type QueuedAppend,
  StackState
} from "./landing-schema.ts"
import { ChangeId, Resolved, SourcePublication } from "./native-schema.ts"
import { CodingError } from "./schema.ts"
import type { VibeCleanup } from "./vibe-schema.ts"

/** Trusted provisioned workspace binding, never workflow or model input. */
export interface Options {
  readonly apiBaseUrl: string
  readonly repositorySlug: string
  readonly repositoryId: number
  readonly workspaceId: string
  readonly token: Redacted.Redacted<string>
}
/** The backend adapter: landing numbers, HTTP receipts, the mythical stack. */
export interface BackendLanding {
  readonly kind: "backend"
  readonly binding: Pick<Options, "repositoryId" | "workspaceId">
  /** Current main, a cheap read for rechecks. */
  readonly readMain: Effect.Effect<string, CodingError>
  /** The base a coding run pins; a `mirror: "pull"` repository first observes GitHub's main fresh. */
  readonly pinMain: Effect.Effect<string, CodingError>
  readonly prepare: (input: AppendPreparationInput) => Effect.Effect<AppendPreparation, CodingError>
  readonly create: (
    requestId: string,
    preparation: AppendPreparation,
    description: string
  ) => Effect.Effect<LandingIdentity, CodingError>
  readonly queue: (
    identity: LandingIdentity,
    preparation: AppendPreparation,
    request: AppendRequest
  ) => Effect.Effect<QueuedAppend, CodingError>
  readonly observe: (queued: QueuedAppend) => Effect.Effect<AppendObservation, CodingError>
  /** The declared GitHub policy on main: `send-upstream` delivers a pull request. */
  readonly readDelivery: Effect.Effect<Delivery, CodingError>
  /** Open, or find again, the GitHub pull request carrying this landing's exact tip. */
  readonly openPull: (
    identity: LandingIdentity,
    commitId: string,
    runId: string
  ) => Effect.Effect<GitHubPull, CodingError>
  /** Whether the repository has an active mythical stack (then vibe hands results to it). */
  readonly readStack?: Effect.Effect<boolean, CodingError>
  /** Hand a validated, cleaned result to the stack service; replaying the same body is idempotent. */
  readonly submitLane?: (submission: LaneSubmission) => Effect.Effect<LaneReceipt, CodingError>
}
/**
 * A lander over the working copy's own jj repository and `gh`: no backend, no
 * retention receipt. `kind` picks the members `coding/LandVibe` runs; every
 * method is one durable action's work and refuses with a typed `CodingError`.
 */
export interface LocalLanding {
  readonly kind: LocalLander
  /** Build the one candidate commit (the cleaned tip merged onto main); a conflict or an empty result is `evicted`. */
  readonly prepare: (cleanup: VibeCleanup, requestId: string) => Effect.Effect<LandingCandidate, CodingError>
  /** Move main to the candidate; main that moved since `prepare` is `evicted`. Answers the new main. */
  readonly fastForward: (prepared: LandingCandidate) => Effect.Effect<string, CodingError>
  /** Drop an evicted candidate from the repository. */
  readonly abandon: (prepared: LandingCandidate) => Effect.Effect<void, CodingError>
  /** Push the candidate as `smithers/landing-<request>` and open, or find again, its pull request. */
  readonly openPull: (prepared: LandingCandidate, requestId: string) => Effect.Effect<LocalPull, CodingError>
  /** One observation of the pull request's required checks. */
  readonly observeChecks: (pull: LocalPull) => Effect.Effect<PullChecks, CodingError>
  /** Squash-merge the candidate with the cleanup summary, or report why GitHub keeps the pull request open. */
  readonly merge: (pull: LocalPull, prepared: LandingCandidate) => Effect.Effect<MergeOutcome, CodingError>
}
export class Landing extends Context.Service<Landing, BackendLanding | LocalLanding>()("coding/Landing") {}
/** The backend adapter when this host has one; a local lander is absent here, so repository automation never lands through it. */
export const backendLanding: Effect.Effect<Option.Option<BackendLanding>> = Effect.map(
  Effect.serviceOption(Landing),
  Option.filter((landing): landing is BackendLanding => landing.kind === "backend")
)
/** The bound landing, refused when it is not the backend adapter. */
export const requireBackend = Effect.flatMap(
  Landing,
  (landing) =>
    landing.kind === "backend" ? Effect.succeed(landing) : Effect.fail(
      new CodingError({
        code: "unavailable",
        message: `This host lands through its ${landing.kind} lander, not the backend's landing API`
      })
    )
)

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const unavailable = (message: string) => new CodingError({ code: "unavailable", message })
const boundedId = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const BookmarkPage = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      target_change_id: Schema.String,
      target_commit_id: Schema.String,
      is_tracking_remote: Schema.Boolean
    })
  ).check(Schema.isMaxLength(100)),
  next_cursor: Schema.String.check(Schema.isMaxLength(4096))
})
const LandingResponse = Schema.Struct({
  request_id: SourcePublication.fields.requestId,
  number: boundedId,
  target_bookmark: Schema.Literal("main"),
  change_ids: Schema.Array(ChangeId).check(Schema.isMaxLength(1024)),
  agent_authored: Schema.Literal(true)
})
const QueueResponse = Schema.Struct({ ...LandingResponse.fields, task_id: boundedId })
/** The repository contents API returns a file as UTF-8 text (backend `RepoContent`). */
const Contents = Schema.Struct({ content: Schema.String, encoding: Schema.Literal("utf-8") })
const Missing = Schema.Struct({ code: Schema.Literal("not_found") })
/** Only the projected policy fields are read; the rest of the projection is not this adapter's contract. */
const DeclaredPolicy = Schema.Struct({
  github: Schema.optionalKey(Schema.Struct({
    changes: Schema.optionalKey(Schema.String),
    mirror: Schema.optionalKey(Schema.String)
  }))
})
/** The GitHub main pull receipt (`/github/main-pull`); only the fields a base pin needs. */
const MainPull = Schema.Struct({
  state: Schema.String,
  smithers_head: Schema.String,
  pending: Schema.Boolean,
  fresh: Schema.Boolean,
  last_error: Schema.String,
  last_checked_at: Schema.NullOr(Schema.String)
})
const mainPullIntervalMs = 2_000
const mainPullAttempts = 150
const errorCode = /^[a-z][a-z0-9_]{0,63}$/
const same = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((value, index) => value === right[index])
const maximumBodyBytes = 2 * 1024 * 1024

const readJson = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function*() {
    const declared = response.headers["content-length"]
    if (
      declared !== undefined &&
      (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximumBodyBytes)
    ) {
      return yield* invalid("Landing API response exceeds its bounded size")
    }
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const captured = yield* Stream.runFoldEffect(response.stream, () => ({ bytes: 0, text: "" }), (state, chunk) =>
      Effect.try({
        try: () => {
          if (state.bytes + chunk.length > maximumBodyBytes) {
            throw new Error("bound")
          }
          return { bytes: state.bytes + chunk.length, text: state.text + decoder.decode(chunk, { stream: true }) }
        },
        catch: () =>
          invalid("Landing API response is invalid or exceeds its bounded size")
      })).pipe(Effect.mapError((error) =>
        error instanceof CodingError ? error : unavailable("Landing API response could not be read")
      ))
    return yield* Effect.try({
      try: () =>
        JSON.parse(captured.text + decoder.decode()) as unknown,
      catch: () =>
        invalid("Landing API returned no valid JSON receipt")
    })
  })

/** Construct over the host's selected Node/Bun HttpClient. Never follows redirects. */
export const make = (options: Options) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const url = yield* Effect.try({
      try: () => new URL(options.apiBaseUrl),
      catch: () => unavailable("Landing API binding is invalid")
    })
    if (
      !/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith("/api") || options.apiBaseUrl !== url.href.replace(/\/$/, "") ||
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(options.repositorySlug) ||
      options.repositorySlug.split("/").some((part) => part === "." || part === "..") ||
      !Schema.is(SourcePublication.fields.workspaceId)(options.workspaceId) ||
      !Schema.is(boundedId)(options.repositoryId) ||
      !Redacted.value(options.token).trim() || /[\r\n]/.test(Redacted.value(options.token))
    ) {
      return yield* unavailable("Landing requires the exact provisioned repository, API and credential binding")
    }
    const base = `${options.apiBaseUrl}/repos/${options.repositorySlug.split("/").map(encodeURIComponent).join("/")}`
    const send = <A>(
      request: HttpClientRequest.HttpClientRequest,
      expectedStatus: ReadonlyArray<number>,
      schema: Schema.Codec<A>
    ) =>
      Effect.gen(function*() {
        const response = yield* HttpClient.withScope(client).execute(
          request.pipe(HttpClientRequest.bearerToken(options.token), HttpClientRequest.acceptJson)
        )
          .pipe(
            Effect.mapError(() =>
              unavailable("Landing API request could not be acknowledged; retry the same durable request")
            )
          )
        if (!expectedStatus.includes(response.status)) {
          // Do not expose remote response bodies, request headers or credential-bearing errors.
          // A bounded API error code is an identifier, not a body.
          const code = yield* readJson(response).pipe(
            Effect.map((value) =>
              typeof value === "object" && value !== null && "code" in value &&
                typeof value.code === "string" && errorCode.test(value.code) ?
                ` ${value.code}` :
                ""
            ),
            Effect.orElseSucceed(() => "")
          )
          if (response.status === 409) {
            return yield* new CodingError({
              code: "stale_revision",
              message:
                `Landing policy or the pinned source/main changed; inspect this exact landing before replanning (HTTP 409${code})`
            })
          }
          return yield* unavailable(
            `Landing API did not acknowledge the required operation (HTTP ${response.status}${code})`
          )
        }
        return yield* readJson(response).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(schema)),
          Effect.mapError((error) =>
            error instanceof CodingError ? error : invalid("Landing API receipt does not match the required protocol")
          )
        )
      }).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: "90 seconds",
          orElse: () =>
            Effect.fail(unavailable("Landing API exceeded its request deadline; retry the same durable request"))
        }),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
          const error = Cause.squash(cause)
          return Effect.fail(
            error instanceof CodingError
              ? error
              : unavailable("Landing API request failed before a receipt could be verified")
          )
        })
      )
    const json = (request: HttpClientRequest.HttpClientRequest, value: object) =>
      HttpClientRequest.bodyJsonUnsafe(request, value)
    const validatePreparation = (value: AppendPreparation, input: AppendPreparationInput) => {
      if (
        value.target_bookmark !== input.target_bookmark || value.expected_commit_id !== input.expected_commit_id ||
        value.source_commit_id !== input.source_commit_id ||
        value.source_base_commit_id !== input.source_base_commit_id ||
        value.changes.at(-1)?.commit_id !== input.source_commit_id || new Set(value.changes.map((change) =>
            change.change_id
          )).size !== value.changes.length ||
        new Set(value.changes.map((change) => change.commit_id)).size !== value.changes.length
      ) return Effect.fail(invalid("Native append preparation does not identify the exact ordered source"))
      return Effect.succeed(value)
    }
    const checkIdentity = (value: typeof LandingResponse.Type, requestId: string, preparation: AppendPreparation) =>
      value.request_id === requestId && same(value.change_ids, preparation.changes.map((change) => change.change_id))
        ? Effect.succeed({ requestId: value.request_id, number: value.number })
        : Effect.fail(invalid("Landing receipt does not identify this exact request and native stack"))
    const readMain = Effect.gen(function*() {
      const cursors = new Set<string>(), candidates: Array<string> = []
      let cursor = ""
      // Existing bookmark pagination, bounded to 10,000 entries. Incomplete pages refuse.
      for (let page = 0; page < 100; page++) {
        const response = yield* send(
          HttpClientRequest.get(`${base}/bookmarks`).pipe(
            HttpClientRequest.setUrlParams({ limit: "100", ...(cursor === "" ? {} : { cursor }) })
          ),
          [200],
          BookmarkPage
        )
        for (const bookmark of response.items) if (bookmark.name === "main") candidates.push(bookmark.target_commit_id)
        if (response.next_cursor === "") {
          if (candidates.length !== 1 || !Schema.is(Resolved.fields.commitId)(candidates[0])) {
            return yield* invalid("Repository must have one unambiguous immutable local main bookmark")
          }
          return candidates[0]
        }
        if (cursors.has(response.next_cursor) || response.items.length === 0) {
          return yield* invalid("Bookmark traversal is incomplete or cyclic")
        }
        cursors.add(response.next_cursor)
        cursor = response.next_cursor
      }
      return yield* invalid("Bookmark traversal exceeded its bounded page count")
    })
    const readPolicy = send(
      HttpClientRequest.get(`${base}/contents/.smithers/factory.json`).pipe(
        HttpClientRequest.setUrlParams({ ref: "main" })
      ),
      [200, 404],
      Schema.Union([Contents, Missing])
    ).pipe(Effect.flatMap((reply) =>
      "code" in reply ?
        Effect.succeed(undefined)
        : Schema.decodeUnknownEffect(Schema.fromJsonString(DeclaredPolicy))(reply.content).pipe(
          Effect.mapError(() => invalid("The declared factory projection on main is not valid JSON")),
          Effect.map((policy) => policy.github)
        )
    ))
    const readDelivery = Effect.map(
      readPolicy,
      (github): Delivery => github?.changes === "send-upstream" ? "pull-request" : "append"
    )
    // GitHub is the only writer of main in a `mirror: "pull"` repository, so a
    // base is pinned only from an observation made after this request: request
    // a pull, wait for it to settle, and refuse unless main equals GitHub's tip.
    const mainPull = `${base}/github/main-pull`
    const awaitFreshMain = Effect.gen(function*() {
      const requested = yield* send(HttpClientRequest.post(mainPull), [202], MainPull)
      for (let attempt = 0; attempt < mainPullAttempts; attempt++) {
        yield* Effect.sleep(mainPullIntervalMs)
        const status = yield* send(HttpClientRequest.get(mainPull), [200], MainPull)
        // A failure finished after the request is refused: it may be a claim that
        // was already running, which is still evidence main is not fresh now. A
        // failure keeps pending (and backing off) until a pull succeeds.
        const failed = status.state === "failed" && status.last_checked_at !== null &&
          status.last_checked_at !== requested.last_checked_at
        if (failed || !status.pending) {
          if (status.fresh && Schema.is(Resolved.fields.commitId)(status.smithers_head)) {
            return status.smithers_head
          }
          return yield* unavailable(
            `GitHub main pull did not observe a fresh main (${status.state}${
              status.last_error ? `: ${status.last_error.slice(0, 500)}` : ""
            }); retry once it is fresh`
          )
        }
      }
      return yield* unavailable("GitHub main pull is still pending; retry once it is fresh")
    })
    const pinMain = Effect.gen(function*() {
      if ((yield* readPolicy)?.mirror !== "pull") return yield* readMain
      const observed = yield* awaitFreshMain, main = yield* readMain
      if (main !== observed) {
        return yield* new CodingError({
          code: "stale_revision",
          message: "Main moved after the GitHub main pull observed it; retry the base pin"
        })
      }
      return main
    })
    // Only a repository without a stack delivers the ordinary way; a frozen or
    // rebuilding stack makes the delivery wait (a retryable refusal).
    const readStack = send(HttpClientRequest.get(`${base}/mythical`), [200, 404], Schema.Union([StackState, Missing]))
      .pipe(
        Effect.flatMap((reply) =>
          !("state" in reply) || reply.state === "absent" ?
            Effect.succeed(false)
            : reply.state === "active" ?
            Effect.succeed(true)
            : Effect.fail(
              unavailable(`The repository's mythical stack is ${reply.state}; deliver again once it is active`)
            )
        )
      )
    const submitLane = (submission: LaneSubmission) =>
      Schema.decodeUnknownEffect(LaneSubmission)(submission).pipe(
        Effect.mapError(() => invalid("A lane submission requires exact commits and this workspace")),
        Effect.flatMap((body) =>
          send(json(HttpClientRequest.put(`${base}/mythical/lanes`), body), [200, 202], LaneReceipt)
        ),
        Effect.flatMap((receipt) =>
          receipt.source === submission.source ?
            Effect.succeed(receipt)
            : Effect.fail(invalid("The stack service acknowledged another source"))
        )
      )
    const service: BackendLanding = {
      kind: "backend",
      binding: { repositoryId: options.repositoryId, workspaceId: options.workspaceId },
      readMain,
      pinMain,
      readDelivery,
      readStack,
      submitLane,
      openPull: (identity, commitId, runId) =>
        Effect.gen(function*() {
          if (
            !Schema.is(Resolved.fields.commitId)(commitId) || !runId || runId.length > 1024 || /[\r\n`]/.test(runId)
          ) {
            return yield* invalid("A pull request requires the exact landing tip and this run's identity")
          }
          const pull = yield* send(
            json(HttpClientRequest.put(`${base}/landings/${identity.number}/github/pull`), {
              commit_id: commitId,
              run_id: runId
            }),
            [200, 201],
            GitHubPull
          )
          if (
            pull.landing_number !== identity.number || pull.head_sha !== commitId ||
            pull.head_ref !== `smithers/landing-${identity.number}`
          ) {
            return yield* invalid("GitHub pull request receipt does not carry this exact landing tip")
          }
          return pull
        }),
      prepare: (input) =>
        Schema.decodeUnknownEffect(AppendPreparationInput)(input).pipe(
          Effect.mapError(() => invalid("Append preparation requires exact immutable commits")),
          Effect.flatMap((request) =>
            send(json(HttpClientRequest.post(`${base}/landings/append/prepare`), request), [200], AppendPreparation)
          ),
          Effect.flatMap((result) => validatePreparation(result, input))
        ),
      create: (requestId, preparation, description) =>
        Effect.gen(function*() {
          if (
            !Schema.is(SourcePublication.fields.requestId)(requestId) || !description.trim() ||
            new TextEncoder().encode(description).length > 32_768
          ) {
            return yield* invalid("Landing creation requires a stable request identity and a bounded final description")
          }
          const title = description.split(/\r?\n/, 1)[0]!
          if (title.length > 255) return yield* invalid("The final landing subject exceeds 255 characters")
          const response = yield* send(
            json(HttpClientRequest.put(`${base}/landings/requests/${requestId}`), {
              title,
              body: description,
              target_bookmark: preparation.target_bookmark,
              change_ids: preparation.changes.map((change) => change.change_id)
            }),
            [200, 201],
            LandingResponse
          )
          return yield* checkIdentity(response, requestId, preparation)
        }),
      queue: (identity, preparation, request) =>
        Effect.gen(function*() {
          if (
            request.commit_id !== preparation.source_commit_id ||
            request.source_base_commit_id !== preparation.source_base_commit_id ||
            request.expected_commit_id !== preparation.expected_commit_id ||
            new TextEncoder().encode(request.description).length > 32_768
          ) {
            return yield* invalid("Append request does not match its recorded preparation")
          }
          const response = yield* send(
            json(HttpClientRequest.put(`${base}/landings/${identity.number}/land/append`), request),
            [202],
            QueueResponse
          )
          yield* checkIdentity(response, identity.requestId, preparation)
          if (response.number !== identity.number) return yield* invalid("Append queue returned another landing")
          return { ...identity, taskId: response.task_id, preparation, request }
        }),
      observe: (queued) =>
        Effect.gen(function*() {
          const observation = yield* send(
            HttpClientRequest.get(`${base}/landings/${queued.number}/land/append`),
            [200],
            AppendObservation
          )
          const request = observation.request
          if (
            observation.task_id !== queued.taskId ||
            !same(request.change_ids, queued.preparation.changes.map((change) => change.commit_id)) ||
            request.expected_commit_id !== queued.request.expected_commit_id ||
            request.append.source_commit_id !== queued.request.commit_id ||
            request.append.source_base_commit_id !== queued.request.source_base_commit_id ||
            request.append.description !== queued.request.description ||
            observation.status === "landed" && observation.result.landed_count !== queued.preparation.changes.length
          ) {
            return yield* invalid("Native append observation does not match this exact queued request")
          }
          return observation
        })
    }
    return service
  })
export const layer = (options: Options) => Layer.effect(Landing)(make(options))
