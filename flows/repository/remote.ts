/** Reserved repository/gateway credentials stay inside this host-owned service. */
import { Context, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import type { Options as RepositoryBinding } from "../coding/landing.ts"
import { CodingError } from "../coding/schema.ts"
import { approvedText, pinApprovedSubject } from "./approved-text.ts"
import type { Event, Job, Record, SourceStatus } from "./schema.ts"

export interface RemoteOptions extends RepositoryBinding {
  readonly gatewayId: string
  readonly credential: string
}
/** The five reviewed responsibilities, or one repository's own `flow:<slug>`
 * schedule. The prefix keeps the two namespaces disjoint. */
export type JobKey = typeof Job.Type | `flow:${string}`
const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const SourceCommit = Schema.String.check(Schema.isPattern(/^(?!0{40}$)[0-9a-f]{40}$/))
/** The host constructs this only from an admitted push or a resolved PR. */
export const RetainSourceRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pull_request"),
    number: Schema.Int.check(Schema.isGreaterThan(0)),
    head: SourceCommit,
    base: SourceCommit
  }),
  Schema.Struct({
    kind: Schema.Literal("push"),
    head: SourceCommit,
    base: Commit,
    ref: Schema.String.check(Schema.isPattern(/^refs\/(heads|tags)\/[^\s]+$/)),
    delivery_key: Schema.NonEmptyString.check(Schema.isMaxLength(200))
  })
])
export const RetainedSource = Schema.Struct({
  status: Schema.Literal("retained"),
  source: Schema.Literal("github"),
  full_name: Schema.NonEmptyString,
  workspace_id: Schema.NonEmptyString,
  head: SourceCommit,
  base: Commit,
  head_ref: Schema.NonEmptyString,
  base_ref: Schema.optionalKey(Schema.NonEmptyString),
  clone_url: Schema.NonEmptyString
})
export const RetainedMain = Schema.Struct({ ...RetainedSource.fields, source: Schema.Literal("smithers-cloud") })
export class RepositoryRemote extends Context.Service<RepositoryRemote, {
  readonly repo: string
  readonly workspaceId: string
  readonly source?: Effect.Effect<"github" | "smithers-cloud", CodingError>
  readonly registrations: Effect.Effect<Schema.Json, CodingError>
  readonly history: Effect.Effect<
    { records: ReadonlyArray<typeof Record.Type>; sources: ReadonlyArray<typeof SourceStatus.Type> },
    CodingError
  >
  readonly register: (job: JobKey, input: Schema.Json) => Effect.Effect<Schema.Json, CodingError>
  readonly pause: (job: JobKey) => Effect.Effect<Schema.Json, CodingError>
  readonly dispatches: (job: JobKey) => Effect.Effect<Schema.Json, CodingError>
  readonly createTrial: (
    job: typeof Job.Type,
    requestId: string,
    input: Schema.Json
  ) => Effect.Effect<Schema.Json, CodingError>
  readonly manual?: (job: JobKey, requestId: string, input: Schema.Json) => Effect.Effect<Schema.Json, CodingError>
  readonly resolveReview?: (
    event: typeof Event.Type
  ) => Effect.Effect<{ payload: Schema.Json; sourceRevision: string }, CodingError>
  readonly retainMain?: (commitId: string) => Effect.Effect<typeof RetainedMain.Type, CodingError>
  readonly retainSource?: (
    input: typeof RetainSourceRequest.Type
  ) => Effect.Effect<typeof RetainedSource.Type, CodingError>
  readonly comment?: (job: typeof Job.Type, step: string, input: Schema.Json) => Effect.Effect<Schema.Json, CodingError>
  /**
   * One read-only GitHub REST GET for this repository's imported source, through the repository's
   * GitHub proxy addressed by the source's own coordinates. `path` is relative to `/repos/{owner}/{repo}`.
   */
  readonly github?: (path: string) => Effect.Effect<Schema.Json, CodingError>
  /** The GitHub `owner/repo` this repository was imported from. */
  readonly githubSource?: Effect.Effect<string, CodingError>
}>()("repository/Remote") {}
const failed = (message: string) => new CodingError({ code: "unavailable", message })
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown, limit = 16000) => typeof value === "string" ? value.slice(0, limit) : ""
const rows = (value: unknown): Array<unknown> =>
  Array.isArray(value) ? value : Array.isArray(object(value).items) ? object(value).items as Array<unknown> : []
const readJson = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function*() {
    const captured = yield* Stream.runFoldEffect(
      response.stream,
      () => ({ bytes: 0, text: "", decoder: new TextDecoder() }),
      (state, chunk) =>
        state.bytes + chunk.length > 2 * 1024 * 1024 ?
          Effect.fail(failed("Repository response exceeds the bounded inspection size"))
          : Effect.succeed({
            bytes: state.bytes + chunk.length,
            text: state.text + state.decoder.decode(chunk, { stream: true }),
            decoder: state.decoder
          })
    )
    return yield* Effect.try({
      try: () => JSON.parse(captured.text + captured.decoder.decode()) as Schema.Json,
      catch: () => failed("Repository response is not valid JSON")
    })
  })
/** The read-only repository paths registration asks GitHub for; nothing encoded, nothing else. */
export const githubReadable = (path: string): boolean =>
  /^\/(pulls(\/\d+\/(reviews|files))?|actions\/runs)(\?[A-Za-z0-9_=&]*)?$/.test(path)

/** Plain http only reaches this machine; the bearer token and gateway credential never cross a network in clear. */
const loopback = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname)

/** `owner/repo` with no dot segments, so it cannot redirect a credentialed request path. */
const repositoryName = (value: string): boolean =>
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && value.split("/").every((part) => part !== "." && part !== "..")

export const makeRemote = (options: RemoteOptions) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const api = yield* Effect.try({
      try: () => new URL(options.apiBaseUrl),
      catch: () => failed("Invalid repository binding")
    })
    if (
      !(api.protocol === "https:" || (api.protocol === "http:" && loopback(api.hostname))) || api.username ||
      api.password || api.search || api.hash ||
      !api.pathname.endsWith("/api") ||
      !repositoryName(options.repositorySlug)
    ) {
      return yield* failed("Repository automation requires the provisioned repository API binding")
    }
    const base = `${options.apiBaseUrl}/repos/${options.repositorySlug.split("/").map(encodeURIComponent).join("/")}`
    const send = (
      request: HttpClientRequest.HttpClientRequest,
      gateway = false,
      source = false,
      conflicting?: string
    ) =>
      Effect.gen(function*() {
        const response = yield* HttpClient.withScope(client).execute(request.pipe(
          HttpClientRequest.bearerToken(gateway ? Redacted.make(options.credential) : options.token),
          HttpClientRequest.acceptJson
        ))
        if (response.status < 200 || response.status >= 300) {
          // A bare status is not something the reader can act on. Name the refused
          // operation and carry the repository's own reason; the repository refuses
          // one endpoint for several reasons, so the cause is never ours to name.
          if (response.status === 409 && conflicting !== undefined) {
            const body = object(yield* readJson(response).pipe(Effect.orElseSucceed(() => null)))
            const reason = string(body.message ?? object(body.error).message, 200).replace(/\s+/g, " ").trim()
            return yield* failed(reason ? `${conflicting}: ${reason}` : conflicting)
          }
          if (source) {
            const refusal = response.status === 404 ?
              ["source_missing", "The selected repository source is no longer available"] as const
              : response.status === 409 ?
              ["source_changed", "The selected repository source changed; capture its latest event"] as const
              : response.status === 400 || response.status === 401 || response.status === 403 ?
              ["source_refused", "The repository refused this source identity or workspace binding"] as const
              : ["source_unavailable", "The selected repository source could not be retained"] as const
            return yield* new CodingError({ code: refusal[0], message: refusal[1] })
          }
          return yield* failed(`Repository operation returned HTTP ${response.status}`)
        }
        return yield* readJson(response)
      }).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: "45 seconds",
          orElse: () => Effect.fail(failed("Repository operation timed out"))
        }),
        Effect.mapError((error) =>
          error instanceof CodingError ? error : failed("Repository operation did not return a verified response")
        )
      )
    const history = Effect.gen(function*() {
      const records: Array<typeof Record.Type> = [], sources: Array<typeof SourceStatus.Type> = []
      const read = (
        path: string,
        effect: Effect.Effect<Schema.Json, CodingError>,
        source: "github" | "smithers-cloud",
        kind: "issue" | "pr"
      ) =>
        effect.pipe(
          Effect.match({
            onFailure: (error) => {
              sources.push({ path, status: "failed", summary: error.message })
            },
            onSuccess: (value) => {
              const list = rows(value)
              sources.push({ path, status: "read", summary: `${list.length} records` })
              for (const item of list.slice(0, 30)) {
                const row = object(item), number = row.number
                if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) continue
                records.push({
                  source,
                  kind: row.pull_request ? "pr" : kind,
                  number,
                  title: string(row.title, 1000),
                  body: string(row.body),
                  state: string(row.state, 100),
                  url: string(row.html_url ?? row.url, 2000),
                  ...(typeof row.updated_at === "string" ? { revision: row.updated_at } : {})
                })
              }
            }
          })
        )
      yield* read(
        `${base}/issues`,
        send(HttpClientRequest.get(`${base}/issues?state=all&per_page=30`)),
        "smithers-cloud",
        "issue"
      )
      // The proxy binds its imported GitHub source to the repository credential.
      const provenance = yield* send(HttpClientRequest.get(`${base}/repository-source`)).pipe(
        Effect.orElseSucceed(() => null)
      )
      const metadata = object(provenance), fullName = metadata.source === "github" ? metadata.full_name : undefined
      if (provenance === null) {
        sources.push({
          path: "repository:source",
          status: "failed",
          summary: "Repository provenance could not be read"
        })
      }
      if (typeof fullName === "string" && repositoryName(fullName)) {
        for (const kind of ["issues", "pulls"] as const) {
          const path = `/repos/${fullName}/${kind}?state=all&per_page=30`
          yield* read(
            `github:${path}`,
            send(
              HttpClientRequest.post(`${base}/github-proxy`).pipe(
                HttpClientRequest.bodyJsonUnsafe({ method: "GET", path })
              )
            ),
            "github",
            kind === "pulls" ? "pr" : "issue"
          )
        }
      }
      return { records, sources }
    })
    // The source is read once it answers; a failed read is not remembered.
    let resolvedSource: string | undefined
    const source = Effect.suspend(() =>
      resolvedSource !== undefined ?
        Effect.succeed(resolvedSource) :
        send(HttpClientRequest.get(`${base}/repository-source`)).pipe(
          Effect.flatMap((value) => {
            const metadata = object(value), fullName = metadata.full_name
            return metadata.source === "github" && typeof fullName === "string" &&
                repositoryName(fullName)
              ? Effect.succeed(fullName)
              : Effect.fail(failed("This repository has no GitHub source"))
          }),
          Effect.tap((fullName) => Effect.sync(() => (resolvedSource = fullName)))
        )
    )
    return RepositoryRemote.of({
      repo: options.repositorySlug,
      workspaceId: options.workspaceId,
      githubSource: source,
      github: (path) =>
        githubReadable(path)
          ? Effect.flatMap(source, (fullName) =>
            send(
              HttpClientRequest.post(`${options.apiBaseUrl}/repos/${fullName}/github-proxy`).pipe(
                HttpClientRequest.bodyJsonUnsafe({ method: "GET", path: `/repos/${fullName}${path}` })
              )
            ))
          : Effect.fail(failed("Refused a GitHub path outside this repository")),
      history,
      source: send(HttpClientRequest.get(`${base}/repository-source`)).pipe(Effect.flatMap((value) => {
        const source = object(value).source
        return source === "github" || source === "smithers-cloud"
          ? Effect.succeed(source)
          : Effect.fail(failed("The repository source could not be verified"))
      })),
      retainMain: (commitId) =>
        Effect.gen(function*() {
          const commit = yield* Schema.decodeUnknownEffect(SourceCommit)(commitId).pipe(
            Effect.mapError(() =>
              new CodingError({ code: "source_refused", message: "Main retention requires an exact immutable commit" })
            )
          )
          const retained = yield* send(
            HttpClientRequest.post(`${base}/repository-source/retain`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                kind: "main",
                workspace_id: options.workspaceId,
                head: commit,
                base: commit
              })
            ),
            false,
            true
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(RetainedMain)),
            Effect.mapError((error) =>
              error instanceof CodingError
                ? error
                : new CodingError({
                  code: "invalid_receipt",
                  message: "Native main retention returned an invalid receipt"
                })
            )
          )
          const ref = `refs/smithers/workspaces/${options.workspaceId}/sources/${commit}`
          if (
            retained.workspace_id !== options.workspaceId || retained.full_name !== options.repositorySlug ||
            retained.head !== commit || retained.base !== commit || retained.head_ref !== ref ||
            retained.base_ref !== ref
          ) {
            return yield* new CodingError({
              code: "invalid_receipt",
              message: "Main retention did not acknowledge this exact repository, workspace and commit"
            })
          }
          return retained
        }),
      retainSource: (request) =>
        Effect.gen(function*() {
          const input = yield* Schema.decodeUnknownEffect(RetainSourceRequest)(request).pipe(
            Effect.mapError(() =>
              new CodingError({
                code: "source_refused",
                message: "Source retention needs the exact admitted push or PR identity"
              })
            )
          )
          const metadata = object(yield* send(HttpClientRequest.get(`${base}/repository-source`), false, true))
          if (
            metadata.source !== "github" || typeof metadata.full_name !== "string" ||
            !repositoryName(metadata.full_name)
          ) {
            return yield* new CodingError({
              code: "source_refused",
              message: "This repository has no verified GitHub source"
            })
          }
          const retained = yield* send(
            HttpClientRequest.post(`${base}/repository-source/retain`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ ...input, workspace_id: options.workspaceId })
            ),
            false,
            true
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(RetainedSource)),
            Effect.mapError((error) =>
              error instanceof CodingError
                ? error
                : new CodingError({ code: "invalid_receipt", message: "Source retention returned an invalid receipt" })
            )
          )
          const ref = (commit: string) => `refs/smithers/workspaces/${options.workspaceId}/sources/${commit}`
          if (
            retained.workspace_id !== options.workspaceId || retained.full_name !== metadata.full_name ||
            retained.head !== input.head || retained.base !== input.base ||
            retained.head_ref !== ref(input.head) ||
            (input.base === "0".repeat(40) ? retained.base_ref !== undefined : retained.base_ref !== ref(input.base))
          ) {
            return yield* new CodingError({
              code: "invalid_receipt",
              message: "Source retention did not acknowledge this exact repository, workspace and commits"
            })
          }
          // clone_url is display metadata. The native importer uses its provisioned
          // origin and credential socket, never a response-provided URL or token.
          return retained
        }),
      resolveReview: (event) =>
        Effect.gen(function*() {
          const original = object(event.payload), direct = object(original.pull_request)
          if (
            event.source !== "github" && (event.type === "pull_request" || event.manualStep !== undefined) &&
            typeof object(direct.head).sha === "string" && typeof object(direct.base).sha === "string"
          ) {
            return { payload: event.payload, sourceRevision: object(direct.head).sha as string }
          }
          const body = string(object(original.issue).body),
            link = body.match(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/)
          const specified = yield* Effect.try({
            try: () => object(JSON.parse(body)),
            catch: () => failed("Select a real PR for the review trial")
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- tsc needs it for inference
          }).pipe(Effect.orElseSucceed(() => ({} as Record<string, unknown>)))
          const nativeManual = event.manualStep !== undefined && typeof direct.number === "number"
          const githubEvent = event.source === "github" &&
            (event.type === "pull_request" || event.manualStep !== undefined)
          const source = githubEvent ? "github" : nativeManual ? event.source : link ? "github" : specified.source,
            number = githubEvent
              ? direct.number ?? event.issueNumber
              : nativeManual
              ? direct.number
              : link
              ? Number(link[2])
              : specified.number
          if (!Number.isSafeInteger(number) || Number(number) < 1) {
            return yield* failed("Select a real PR number and source for the review trial")
          }
          if (source === "github") {
            const metadata = object(yield* send(HttpClientRequest.get(`${base}/repository-source`)))
            const fullName = metadata.source === "github" ? metadata.full_name : undefined
            if (
              typeof fullName !== "string" || !repositoryName(fullName) ||
              (link && link[1] !== fullName)
            ) return yield* failed("The selected PR is not from this imported repository")
            const eventRepository = object(original.repository).full_name ?? object(object(direct.base).repo).full_name
            if (githubEvent && eventRepository !== undefined && eventRepository !== fullName) {
              return yield* failed("The PR event belongs to a different GitHub repository")
            }
            const pr = object(
              yield* send(
                HttpClientRequest.post(`${base}/github-proxy`).pipe(
                  HttpClientRequest.bodyJsonUnsafe({ method: "GET", path: `/repos/${fullName}/pulls/${number}` })
                )
              )
            )
            const head = object(pr.head).sha, baseSHA = object(pr.base).sha
            if (
              pr.number !== Number(number) || object(object(pr.base).repo).full_name !== fullName ||
              typeof head !== "string" || !/^[0-9a-f]{40}$/.test(head) || typeof baseSHA !== "string" ||
              !/^[0-9a-f]{40}$/.test(baseSHA)
            ) return yield* failed("The PR has no verified repository, immutable base and candidate")
            if (
              githubEvent && (object(direct.head).sha !== head || object(direct.base).sha !== baseSHA)
            ) return yield* failed("The selected PR changed; capture its latest event before review")
            return {
              payload: {
                ...original,
                // Only the event's own PR carries its snapshot; a PR a trial's
                // issue links to is read as it is.
                pull_request: githubEvent && original.issue === undefined && direct.number === pr.number
                  ? pinApprovedSubject(approvedText(event), { ...pr, source: "github" })
                  : { ...pr, source: "github" }
              } as Schema.Json,
              sourceRevision: head
            }
          }
          if (source !== "smithers-cloud") return yield* failed("Select GitHub or Smithers as the PR source")
          const landing = object(yield* send(HttpClientRequest.get(`${base}/landings/${number}`))),
            ids = landing.change_ids
          if (
            !Array.isArray(ids) || !ids.length || ids.length > 100 ||
            ids.some((id) => typeof id !== "string" || !/^[k-z]{32}$/.test(id))
          ) return yield* failed("The native PR has no ordered change stack")
          const first = object(yield* send(HttpClientRequest.get(`${base}/changes/${ids[0]}`))),
            last = object(yield* send(HttpClientRequest.get(`${base}/changes/${ids.at(-1)}`)))
          const check = object(yield* send(HttpClientRequest.get(`${base}/changes/${ids.at(-1)}`)))
          if (
            typeof first.parent_commit_id !== "string" || typeof last.commit_id !== "string" ||
            check.commit_id !== last.commit_id
          ) return yield* failed("The native PR changed while its source was being captured")
          return {
            payload: {
              ...original,
              pull_request: {
                number,
                base: { sha: first.parent_commit_id },
                head: { sha: last.commit_id },
                source: "smithers-cloud"
              }
            } as Schema.Json,
            sourceRevision: last.commit_id
          }
        }),
      comment: (job, step, input) =>
        send(
          HttpClientRequest.put(
            `${options.apiBaseUrl}/gateways/${encodeURIComponent(options.gatewayId)}/repository-jobs/${job}/comments/${
              encodeURIComponent(step)
            }`
          ).pipe(HttpClientRequest.bodyJsonUnsafe(input)),
          true
        ),
      manual: (job, requestId, input) =>
        send(
          HttpClientRequest.put(
            `${options.apiBaseUrl}/gateways/${encodeURIComponent(options.gatewayId)}/repository-jobs/${job}/manual/${
              encodeURIComponent(requestId)
            }`
          ).pipe(HttpClientRequest.bodyJsonUnsafe(input)),
          true
        ),
      register: (job, input) =>
        send(
          HttpClientRequest.put(
            `${options.apiBaseUrl}/gateways/${encodeURIComponent(options.gatewayId)}/repository-jobs/${job}`
          ).pipe(HttpClientRequest.bodyJsonUnsafe(input)),
          true,
          false,
          `The ${job} ${object(input).mode === "trial" ? "trial " : ""}registration was refused`
        ),
      pause: (job) => send(HttpClientRequest.post(`${base}/repository-jobs/${job}/pause`)),
      dispatches: (job) => send(HttpClientRequest.get(`${base}/repository-jobs/${job}/dispatches`)),
      createTrial: (job, requestId, input) =>
        send(
          HttpClientRequest.put(
            `${options.apiBaseUrl}/gateways/${encodeURIComponent(options.gatewayId)}/repository-jobs/${job}/trials/${
              encodeURIComponent(requestId)
            }`
          ).pipe(HttpClientRequest.bodyJsonUnsafe(input)),
          true,
          false,
          `The ${job} trial issue was refused`
        ),
      registrations: send(HttpClientRequest.get(`${base}/repository-jobs`))
    })
  })
export const remoteLayer = (options: RemoteOptions) => Layer.effect(RepositoryRemote)(makeRemote(options))
