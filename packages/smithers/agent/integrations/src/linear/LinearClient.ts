/**
 * The Linear GraphQL client.
 *
 * Plain `fetch` over raw GraphQL rather than `@linear/sdk`: the behaviors
 * worth keeping are lookup caching, name resolution, and rate-limit handling,
 * and all three are a few dozen lines each once the SDK is not in the way.
 *
 * - **Names, not ids.** Linear's mutations take ids. Humans and workflows
 *   write `ENG`, `In Progress`, `bug`, and `ENG-123`. Every lookup that turns
 *   one into an id is cached per client, so a workflow that touches ten issues
 *   on one team resolves its team, states, and labels once.
 * - **Rate limits.** A 429 is retried up to five attempts for every operation,
 *   waiting the server's `Retry-After` or `X-RateLimit-Requests-Reset`, capped
 *   at 30 s, and falling back to exponential backoff when neither header is
 *   present. A 5xx is retried only for a query: on `issueCreate`,
 *   `issueUpdate`, or `commentCreate` the server may have applied the mutation
 *   and lost the answer, so repeating files a second issue. Those report
 *   `outcomeUnknown` instead.
 * - **Key hygiene.** The API key reaches the `Authorization` header and
 *   nothing else. Errors redact echoed credentials from summaries, details,
 *   and retained cause messages.
 *
 * One `AbortController` spans each attempt's request *and* its body read, so
 * interrupting the fiber during either tears the exchange down. Each attempt
 * also carries its own deadline, `requestTimeout`: the attempt budget counts
 * completed attempts, so without it a peer that answers with headers and then
 * trickles the body forever holds the call open.
 *
 * @since 1.0.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import { Context, Duration, Effect, Layer, Option } from "effect"
import { IntegrationError, isIntegrationError } from "../core/IntegrationError.ts"
import { redactedError } from "../core/RedactedError.ts"
import * as Environment from "../Environment.ts"
import { type LinearConfig, resolve } from "./Config.ts"

/**
 * A Linear priority: `0` none, `1` urgent, `2` high, `3` normal, `4` low, or
 * the name of one.
 *
 * @category models
 * @since 1.0.0
 */
export type Priority = number | "none" | "urgent" | "high" | "normal" | "medium" | "low"

/**
 * A team, by id and optionally by key.
 *
 * @category models
 * @since 1.0.0
 */
export interface TeamRef {
  readonly id: string
  readonly key?: string | undefined
  readonly name?: string | undefined
}

/**
 * An issue, as the mutations and lookups return it.
 *
 * @category models
 * @since 1.0.0
 */
export interface IssueResult {
  readonly id: string
  readonly identifier: string
  readonly title: string
  readonly url: string
  readonly team?: { readonly id: string; readonly key?: string | undefined } | null | undefined
}

/**
 * A comment, as `commentOnIssue` returns it.
 *
 * @category models
 * @since 1.0.0
 */
export interface CommentResult {
  readonly id: string
  readonly body: string
  readonly issue?: { readonly id: string; readonly identifier?: string | undefined } | null | undefined
}

/**
 * The name-or-id fields an issue mutation accepts.
 *
 * @category models
 * @since 1.0.0
 */
export interface IssueFields {
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly priority?: Priority | undefined
  /**
   * Label names, resolved per team and cached. An empty array clears the
   * issue's labels; omit the field to leave them alone. Supply this or
   * `labelIds`, not both; supplying both fails `decode-failed`.
   */
  readonly labels?: ReadonlyArray<string> | undefined
  /** Raw label ids, which skip resolution. Supply this or `labels`, not both. */
  readonly labelIds?: ReadonlyArray<string> | undefined
  /**
   * A workflow-state name such as `In Progress`, resolved per team. Supply
   * this or `stateId`, not both; supplying both fails `decode-failed`.
   */
  readonly stateName?: string | undefined
  /** A raw workflow-state id. Supply this or `stateName`, not both. */
  readonly stateId?: string | undefined
  readonly assigneeId?: string | undefined
  readonly projectId?: string | undefined
  readonly estimate?: number | undefined
  readonly dueDate?: string | undefined
}

/**
 * What `createIssue` needs beyond {@link IssueFields}.
 *
 * @category models
 * @since 1.0.0
 */
export interface CreateIssueInput extends IssueFields {
  /** A team key such as `ENG`, resolved to an id. Case-insensitive. */
  readonly teamKey?: string | undefined
  /**
   * A team id, which skips the lookup. Exactly one of the two is required:
   * supplying both fails `decode-failed` rather than silently filing on the
   * team `teamId` names.
   */
  readonly teamId?: string | undefined
  readonly title: string
}

/**
 * The client service.
 *
 * @category services
 * @since 1.0.0
 */
export interface LinearClient {
  /**
   * A raw GraphQL request, resolving with the `data` payload.
   *
   * `retryServerErrors` says whether a 5xx may be repeated. It defaults to
   * false for a document containing a mutation, because a repeated
   * `issueCreate` files a second issue, and to true otherwise.
   */
  readonly query: (
    gql: string,
    variables?: Record<string, unknown>,
    options?: { readonly retryServerErrors?: boolean | undefined }
  ) => Effect.Effect<Record<string, any>, IntegrationError>
  /**
   * Resolves a team by key, or passes an explicit id through. Cached, and the
   * key is uppercased for both the cache and the query, so the same key
   * decides the same way on a cold client and a warm one.
   */
  readonly resolveTeam: (
    ref: { readonly teamId?: string | undefined; readonly teamKey?: string | undefined }
  ) => Effect.Effect<TeamRef, IntegrationError>
  /** Resolves a workflow-state name to its id for a team. Cached. */
  readonly resolveStateId: (teamId: string, stateName: string) => Effect.Effect<string, IntegrationError>
  /** Resolves label names to ids for a team. Cached. */
  readonly resolveLabelIds: (
    teamId: string,
    names: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<string>, IntegrationError>
  /** Fetches an issue by UUID or by `ENG-123` identifier. */
  readonly getIssue: (idOrIdentifier: string) => Effect.Effect<IssueResult, IntegrationError>
  readonly createIssue: (input: CreateIssueInput) => Effect.Effect<IssueResult, IntegrationError>
  readonly updateIssue: (idOrIdentifier: string, fields: IssueFields) => Effect.Effect<IssueResult, IntegrationError>
  readonly commentOnIssue: (idOrIdentifier: string, body: string) => Effect.Effect<CommentResult, IntegrationError>
}

/**
 * Service tag for the Linear GraphQL client.
 *
 * @category services
 * @since 1.0.0
 */
export const LinearClient: Context.Service<LinearClient, LinearClient> = Context.Service(
  "@smthrs/integrations/LinearClient"
)

// Linear's priority vocabulary: 1 urgent, 2 high, 3 normal, 4 low.
const PRIORITY_BY_NAME: Readonly<Record<string, number>> = {
  none: 0,
  urgent: 1,
  high: 2,
  normal: 3,
  medium: 3,
  low: 4
}

/** An issue identifier such as `ENG-123`, as opposed to a UUID. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-\d+$/

const MAX_ATTEMPTS = 5
const MAX_RETRY_DELAY_MS = 30_000

/**
 * Normalizes a priority name or number onto Linear's 0-4 scale.
 *
 * Throws an `IntegrationError` with reason `decode-failed` for a number
 * outside 0 to 4 or an unrecognized name. Callers inside an Effect use
 * {@link requirePriority}, because a throw inside `Effect.gen` is a defect
 * that a `catchAll` on `IntegrationError` will not see.
 *
 * @category constructors
 * @since 1.0.0
 */
export const normalizePriority = (priority: Priority | undefined): number | undefined => {
  if (priority === undefined) return undefined
  if (typeof priority === "number") {
    if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
      throw new IntegrationError("decode-failed", `Invalid Linear priority number: ${priority} (expected 0-4).`, {
        priority
      })
    }
    return priority
  }
  const mapped = PRIORITY_BY_NAME[String(priority).toLowerCase()]
  if (mapped === undefined) {
    throw new IntegrationError("decode-failed", `Unknown Linear priority name: "${priority}".`, { priority })
  }
  return mapped
}

/**
 * {@link normalizePriority} in the Effect channel.
 *
 * @category constructors
 * @since 1.0.0
 */
export const requirePriority = (
  priority: Priority | undefined
): Effect.Effect<number | undefined, IntegrationError> =>
  Effect.try({ try: () => normalizePriority(priority), catch: (cause) => cause as IntegrationError })

/**
 * How long to wait before retrying, from `Retry-After` (seconds) or
 * `X-RateLimit-Requests-Reset` (epoch milliseconds), capped at 30 seconds.
 *
 * @category getters
 * @since 1.0.0
 */
export const retryDelayMs = (headers: Headers, nowMs: number = Date.now()): number | undefined => {
  const retryAfter = headers.get("retry-after")
  if (retryAfter !== null && retryAfter.length > 0) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS)
  }
  const reset = headers.get("x-ratelimit-requests-reset")
  if (reset !== null && reset.length > 0) {
    const resetMs = Number(reset)
    if (Number.isFinite(resetMs) && resetMs > 0) return Math.min(Math.max(resetMs - nowMs, 0), MAX_RETRY_DELAY_MS)
  }
  return undefined
}

const ISSUE_FIELDS = "id identifier title url team { id key }"

const TEAM_BY_KEY = `query TeamByKey($key: String!) {
  teams(filter: { key: { eq: $key } }, first: 1) { nodes { id key name } }
}`
const WORKFLOW_STATES = `query WorkflowStates($teamId: ID!) {
  workflowStates(filter: { team: { id: { eq: $teamId } } }, first: 100) { nodes { id name type } }
}`
const ISSUE_LABELS = `query IssueLabels($teamId: ID!) {
  issueLabels(filter: { team: { id: { eq: $teamId } } }, first: 100) { nodes { id name } }
}`
const ISSUE = `query Issue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`
const ISSUE_CREATE = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
}`
const ISSUE_UPDATE = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
}`
const COMMENT_CREATE = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id body issue { id identifier } } }
}`

interface NamedNode {
  readonly id: string
  readonly name?: string | undefined
}

const decodeFailed = (path: string, expected: string): IntegrationError =>
  new IntegrationError(
    "decode-failed",
    `Linear response field ${path} is not ${expected}.`,
    { path, expected }
  )

/**
 * The members of a GraphQL connection, checked rather than cast.
 *
 * `query` returns `Record<string, any>`, so `data.teams.nodes.find(...)` on a
 * wrong-shaped answer throws a raw `TypeError` inside `Effect.gen`, which dies
 * as a defect instead of failing `decode-failed`. Every read of a connection
 * goes through here, and the failure names the field path and nothing of the
 * body.
 */
const connectionNodes = (
  connection: unknown,
  field: string
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, IntegrationError> => {
  if (connection === undefined || connection === null) return Effect.succeed([])
  if (!isRecord(connection)) return Effect.fail(decodeFailed(field, "an object"))
  const raw = connection["nodes"]
  if (raw === undefined || raw === null) return Effect.succeed([])
  if (!Array.isArray(raw)) return Effect.fail(decodeFailed(`${field}.nodes`, "an array"))
  const members: Array<Record<string, unknown>> = []
  for (const [index, node] of raw.entries()) {
    if (!isRecord(node)) return Effect.fail(decodeFailed(`${field}.nodes[${index}]`, "an object"))
    members.push(node)
  }
  return Effect.succeed(members)
}

/** The same, narrowed to nodes carrying a string `id`. */
const namedNodes = (connection: unknown, field: string): Effect.Effect<ReadonlyArray<NamedNode>, IntegrationError> =>
  connectionNodes(connection, field).pipe(
    Effect.flatMap((members) => {
      const named: Array<NamedNode> = []
      for (const [index, node] of members.entries()) {
        if (typeof node["id"] !== "string") return Effect.fail(decodeFailed(`${field}.nodes[${index}].id`, "a string"))
        const name = node["name"]
        // Erasing a wrong-typed name silently turned "Linear changed this
        // field" into "no state by that name", which reads as a caller error.
        if (name !== undefined && name !== null && typeof name !== "string") {
          return Effect.fail(decodeFailed(`${field}.nodes[${index}].name`, "a string"))
        }
        named.push({ id: node["id"], name: typeof name === "string" ? name : undefined })
      }
      return Effect.succeed(named)
    })
  )

/** An issue, checked for the fields every caller of this client reads. */
const requireIssue = (value: unknown, field: string): Effect.Effect<IssueResult, IntegrationError> => {
  if (!isRecord(value)) return Effect.fail(decodeFailed(field, "an object"))
  for (const key of ["id", "identifier", "title", "url"]) {
    if (typeof value[key] !== "string") return Effect.fail(decodeFailed(`${field}.${key}`, "a string"))
  }
  const team = value["team"]
  if (team !== undefined && team !== null && !isRecord(team)) {
    return Effect.fail(decodeFailed(`${field}.team`, "an object"))
  }
  if (isRecord(team)) {
    if (typeof team["id"] !== "string") return Effect.fail(decodeFailed(`${field}.team.id`, "a string"))
    const key = team["key"]
    if (key !== undefined && key !== null && typeof key !== "string") {
      return Effect.fail(decodeFailed(`${field}.team.key`, "a string"))
    }
  }
  return Effect.succeed(value as unknown as IssueResult)
}

// Whether a GraphQL document contains a mutation operation. Comments and
// string literals are stripped first so neither can hide or fake the keyword.
// A field literally named `mutation` reads as a mutation, which errs toward
// not repeating a request.
const isMutationDocument = (gql: string): boolean =>
  /\bmutation\b/.test(
    gql.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"/g, "\"\"").replace(/#[^\n\r]*/g, "")
  )

/**
 * Builds a Linear client bound to `config`.
 *
 * `env` is the fallback source for anything `config` omits. Passing one
 * replaces the ambient environment rather than layering over it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  config: LinearConfig = {},
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): LinearClient => {
  const { apiBaseUrl, apiKey, requestTimeout: configuredTimeout } = resolve(config, env)
  const integrationError = redactedError([apiKey, apiKey?.replace(/^Bearer\s+/i, "")])

  // A zero or infinite deadline is not a deadline: the first would fail every
  // request and the second is the unbounded wait this option exists to close.
  const requestTimeout = Option.getOrUndefined(Duration.fromInput(configuredTimeout))
  if (
    requestTimeout === undefined || !Duration.isFinite(requestTimeout) || Duration.toMillis(requestTimeout) <= 0
  ) {
    throw integrationError(
      "invalid-config",
      "Linear requestTimeout must be a finite, positive duration.",
      { requestTimeout: String(configuredTimeout) }
    )
  }
  const requestTimeoutMs = Duration.toMillis(requestTimeout)

  const teamByKey = new Map<string, TeamRef>()
  const statesByTeam = new Map<string, ReadonlyArray<NamedNode>>()
  const labelsByTeam = new Map<string, ReadonlyArray<NamedNode>>()

  const query: LinearClient["query"] = (gql, variables, queryOptions) =>
    Effect.gen(function*() {
      const retryServerErrors = queryOptions?.retryServerErrors ?? !isMutationDocument(gql)
      if (apiKey === undefined) {
        return yield* Effect.fail(
          integrationError(
            "credentials-missing",
            "Linear API key is not configured. Pass config.apiKey or set SMITHERS_LINEAR_API_KEY.",
            { apiBaseUrl }
          )
        )
      }
      // Serialized before the first attempt: a cyclic or BigInt variable is a
      // caller error with a known outcome, since nothing was sent.
      const requestBody = yield* Effect.try({
        try: () => JSON.stringify({ query: gql, variables: variables ?? {} }),
        catch: (cause) =>
          integrationError(
            "invalid-config",
            "Linear request body could not be serialized as JSON.",
            { retryable: false, outcomeUnknown: false },
            { cause }
          )
      })
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        yield* Effect.annotateCurrentSpan("http.attempts", attempt)
        // Finalize the exchange before backing off, failing, or returning.
        const controller = new AbortController()
        const abortWith = (signal: AbortSignal) => {
          if (signal.aborted) controller.abort(signal.reason)
          else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
        }
        let pendingResponse: Response | undefined
        let consumed = false
        const result = yield* Effect.gen(function*() {
          const response = yield* Effect.tryPromise({
            try: (signal) => {
              abortWith(signal)
              return fetch(apiBaseUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  // Personal API keys go raw; OAuth tokens arrive pre-prefixed.
                  Authorization: apiKey
                },
                body: requestBody,
                signal: controller.signal
              })
            },
            catch: (cause) =>
              integrationError(
                "delivery-failed",
                retryServerErrors
                  ? "Linear API request failed (network error)."
                  : "Linear API request for a write failed (network error), so its outcome is unknown.",
                // A dropped connection on a mutation is the same ambiguity a 5xx
                // is: Linear may have applied it and lost the answer.
                { apiBaseUrl, outcomeUnknown: !retryServerErrors },
                { cause }
              )
          })
          pendingResponse = response
          // A 429 was refused, so repeating it is safe for any operation. A 5xx
          // is ambiguous: Linear may have committed the mutation and lost the
          // answer, so a write stops here and says the outcome is unknown.
          if (response.status >= 500 && !retryServerErrors) {
            return yield* Effect.fail(
              integrationError(
                "delivery-failed",
                `Linear API responded ${response.status} to a write, so its outcome is unknown and it was not repeated.`,
                { status: response.status, apiBaseUrl, outcomeUnknown: true }
              )
            )
          }
          if (response.status === 429 || response.status >= 500) {
            if (attempt >= MAX_ATTEMPTS) {
              return yield* Effect.fail(
                integrationError(
                  "delivery-failed",
                  `Linear API responded ${response.status} after ${attempt} attempts.`,
                  { status: response.status, apiBaseUrl }
                )
              )
            }
            const delayMs = retryDelayMs(response.headers) ??
              Math.min(250 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS)
            return { _tag: "Retry" as const, delayMs }
          }
          const body = yield* Effect.tryPromise({
            try: (signal) => {
              abortWith(signal)
              return response.text()
            },
            catch: (cause) =>
              integrationError(
                "delivery-failed",
                `Linear API response body could not be read (status ${response.status}).`,
                {
                  status: response.status,
                  outcomeUnknown: !retryServerErrors && response.ok,
                  cause: cause instanceof Error ? cause.message : String(cause)
                },
                { cause }
              )
          })
          consumed = true
          const json = yield* Effect.try({
            try: () => JSON.parse(body) as Record<string, any>,
            catch: (cause) =>
              integrationError(
                "decode-failed",
                `Linear API returned a non-JSON response (status ${response.status}).`,
                { status: response.status },
                { cause }
              )
          })
          const errors = (Array.isArray(json?.["errors"]) ? (json["errors"] as Array<{ message?: unknown }>) : [])
            .map((error) => typeof error?.message === "string" ? error.message : "unknown")
          if (!response.ok) {
            return yield* Effect.fail(
              integrationError("delivery-failed", `Linear API responded ${response.status}.`, {
                status: response.status,
                errors
              })
            )
          }
          if (errors.length > 0) {
            return yield* Effect.fail(
              integrationError(
                "delivery-failed",
                `Linear GraphQL error: ${errors.join("; ")}`,
                { errors }
              )
            )
          }
          return { _tag: "Done" as const, data: (json?.["data"] ?? {}) as Record<string, any> }
        }).pipe(
          Effect.ensuring(Effect.promise(async () => {
            controller.abort()
            if (!consumed) await pendingResponse?.body?.cancel().catch(() => {})
          })),
          // The deadline spans the whole exchange, headers and body alike. The
          // timeout interrupts the attempt, whose finalizer aborts the
          // controller and closes the socket. On a mutation it is the same
          // ambiguity a 5xx is, so the outcome is reported as unknown rather
          // than the write repeated.
          Effect.timeoutOrElse({
            duration: requestTimeout,
            orElse: () =>
              Effect.fail(integrationError(
                "delivery-failed",
                retryServerErrors
                  ? `Linear API request timed out after ${requestTimeoutMs} ms.`
                  : `Linear API request for a write timed out after ${requestTimeoutMs} ms, so its outcome is unknown.`,
                { apiBaseUrl, outcomeUnknown: !retryServerErrors, timedOut: true, requestTimeoutMs }
              ))
          })
        )
        if (result._tag === "Done") return result.data
        yield* Effect.sleep(`${result.delayMs} millis`)
      }
      // Unreachable: the loop returns or fails on every path.
      return yield* Effect.fail(
        integrationError("delivery-failed", "Linear API retry loop exhausted.", { apiBaseUrl })
      )
    }).pipe(
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan({
          "integration.reason": error.reason,
          "http.response.status_code": error.details?.["status"] ?? null,
          "integration.outcome_unknown": error.details?.["outcomeUnknown"] === true
        })
      ),
      Effect.withSpan("LinearClient.query", { attributes: { "graphql.mutation": isMutationDocument(gql) } })
    )

  const resolveTeam: LinearClient["resolveTeam"] = (ref) =>
    Effect.gen(function*() {
      // Documented as exactly one of the two. Accepting both and silently
      // preferring `teamId` files the issue on a team the caller did not name,
      // on an action whose tier is irreversible.
      if (ref.teamId !== undefined && ref.teamKey !== undefined) {
        return yield* Effect.fail(
          integrationError(
            "decode-failed",
            "Linear team is over-specified: pass teamId or teamKey, not both.",
            { teamId: ref.teamId, teamKey: ref.teamKey }
          )
        )
      }
      if (ref.teamId !== undefined) return Object.freeze({ id: ref.teamId })
      const key = ref.teamKey?.trim()
      if (key === undefined || key.length === 0) {
        return yield* Effect.fail(
          integrationError("decode-failed", "Linear team is required: pass teamId or teamKey.")
        )
      }
      // Linear team keys are uppercase, and the cache is keyed that way, so
      // the query has to be too. Sending the raw key made `resolveTeam("eng")`
      // succeed or fail depending on whether some earlier call had warmed the
      // cache with `ENG`.
      const normalized = key.toUpperCase()
      const cached = teamByKey.get(normalized)
      if (cached !== undefined) return cached
      const data = yield* query(TEAM_BY_KEY, { key: normalized })
      const team = (yield* connectionNodes(data?.["teams"], "teams"))[0]
      if (team === undefined || typeof team["id"] !== "string") {
        return yield* Effect.fail(
          integrationError("decode-failed", `Linear team with key "${key}" not found.`, { teamKey: key })
        )
      }
      // The same rule `namedNodes` follows: erasing a wrong-typed member turns
      // "Linear changed this field" into "this team has no key", which reads as
      // a caller error and hides the contract change. Absent stays absent.
      for (const member of ["key", "name"] as const) {
        const value = team[member]
        if (value !== undefined && value !== null && typeof value !== "string") {
          return yield* Effect.fail(decodeFailed(`teams.nodes[0].${member}`, "a string"))
        }
      }
      // Frozen, because the cache hands the same object to every later call on
      // this client: a consumer that mutated it would change the identity the
      // next mutation runs against.
      const found: TeamRef = Object.freeze({
        id: team["id"],
        key: typeof team["key"] === "string" ? team["key"] : undefined,
        name: typeof team["name"] === "string" ? team["name"] : undefined
      })
      teamByKey.set(normalized, found)
      return found
    })

  const listStates = (teamId: string): Effect.Effect<ReadonlyArray<NamedNode>, IntegrationError> =>
    Effect.gen(function*() {
      const cached = statesByTeam.get(teamId)
      if (cached !== undefined) return cached
      const data = yield* query(WORKFLOW_STATES, { teamId })
      const states = yield* namedNodes(data?.["workflowStates"], "workflowStates")
      statesByTeam.set(teamId, states)
      return states
    })

  const resolveStateId: LinearClient["resolveStateId"] = (teamId, stateName) =>
    Effect.gen(function*() {
      const states = yield* listStates(teamId)
      const match = states.find((state) => state.name?.toLowerCase() === stateName.toLowerCase())
      if (match === undefined) {
        return yield* Effect.fail(
          integrationError("decode-failed", `Linear workflow state "${stateName}" not found for team.`, {
            teamId,
            stateName,
            known: states.map((state) => state.name)
          })
        )
      }
      return match.id
    })

  const resolveLabelIds: LinearClient["resolveLabelIds"] = (teamId, names) =>
    Effect.gen(function*() {
      let labels = labelsByTeam.get(teamId)
      if (labels === undefined) {
        const data = yield* query(ISSUE_LABELS, { teamId })
        labels = yield* namedNodes(data?.["issueLabels"], "issueLabels")
        labelsByTeam.set(teamId, labels)
      }
      const ids: Array<string> = []
      const missing: Array<string> = []
      for (const name of names) {
        const match = labels.find((label) => label.name?.toLowerCase() === name.toLowerCase())
        if (match === undefined) missing.push(name)
        else ids.push(match.id)
      }
      if (missing.length > 0) {
        return yield* Effect.fail(
          integrationError("decode-failed", `Linear label(s) not found for team: ${missing.join(", ")}.`, {
            teamId,
            missing
          })
        )
      }
      return ids
    })

  const getIssue: LinearClient["getIssue"] = (idOrIdentifier) =>
    Effect.gen(function*() {
      const data = yield* query(ISSUE, { id: idOrIdentifier })
      const issue = data?.["issue"]
      if (issue === undefined || issue === null) {
        return yield* Effect.fail(
          integrationError("decode-failed", `Linear issue "${idOrIdentifier}" not found.`, { idOrIdentifier })
        )
      }
      return yield* requireIssue(issue, "issue")
    })

  const buildIssueInput = (
    teamId: string | undefined,
    fields: IssueFields
  ): Effect.Effect<Record<string, unknown>, IntegrationError> =>
    Effect.gen(function*() {
      if (fields.stateId !== undefined && fields.stateName !== undefined) {
        return yield* Effect.fail(
          integrationError(
            "decode-failed",
            "Linear issue state is over-specified: pass stateId or stateName, not both.",
            { stateId: fields.stateId, stateName: fields.stateName }
          )
        )
      }
      if (fields.labelIds !== undefined && fields.labels !== undefined) {
        return yield* Effect.fail(
          integrationError(
            "decode-failed",
            "Linear issue labels are over-specified: pass labelIds or labels, not both.",
            { labelIds: fields.labelIds, labels: fields.labels }
          )
        )
      }
      const input: Record<string, unknown> = {}
      if (fields.title !== undefined) input["title"] = fields.title
      if (fields.description !== undefined) input["description"] = fields.description
      if (fields.assigneeId !== undefined) input["assigneeId"] = fields.assigneeId
      if (fields.projectId !== undefined) input["projectId"] = fields.projectId
      if (fields.estimate !== undefined) input["estimate"] = fields.estimate
      if (fields.dueDate !== undefined) input["dueDate"] = fields.dueDate
      const priority = yield* requirePriority(fields.priority)
      if (priority !== undefined) input["priority"] = priority
      if (fields.stateId !== undefined) {
        input["stateId"] = fields.stateId
      } else if (fields.stateName !== undefined) {
        if (teamId === undefined) {
          return yield* Effect.fail(
            integrationError("decode-failed", "Resolving a Linear state name requires the issue's team.", {
              stateName: fields.stateName
            })
          )
        }
        input["stateId"] = yield* resolveStateId(teamId, fields.stateName)
      }
      if (fields.labelIds !== undefined) {
        input["labelIds"] = fields.labelIds
      } else if (fields.labels !== undefined) {
        // An explicit empty array is a request to clear the labels, not an
        // absent field. Treating it as absent left a caller with no way to
        // remove a label through the name path at all.
        if (fields.labels.length === 0) input["labelIds"] = []
        else if (teamId === undefined) {
          return yield* Effect.fail(
            integrationError("decode-failed", "Resolving Linear label names requires the issue's team.", {
              labels: fields.labels
            })
          )
        } else input["labelIds"] = yield* resolveLabelIds(teamId, fields.labels)
      }
      return input
    })

  const createIssue: LinearClient["createIssue"] = (input) =>
    Effect.gen(function*() {
      const team = yield* resolveTeam({ teamId: input.teamId, teamKey: input.teamKey })
      const issueInput = yield* buildIssueInput(team.id, input)
      issueInput["teamId"] = team.id
      const data = yield* query(ISSUE_CREATE, { input: issueInput }, { retryServerErrors: false })
      const payload = data?.["issueCreate"]
      if (!isRecord(payload) || payload["success"] !== true || payload["issue"] == null) {
        return yield* Effect.fail(
          integrationError("delivery-failed", "Linear issueCreate did not return an issue.", {
            success: isRecord(payload) ? payload["success"] ?? false : false
          })
        )
      }
      return yield* requireIssue(payload["issue"], "issueCreate.issue")
    })

  const updateIssue: LinearClient["updateIssue"] = (idOrIdentifier, fields) =>
    Effect.gen(function*() {
      const needsTeam = (fields.stateName !== undefined && fields.stateId === undefined) ||
        (fields.labels !== undefined && fields.labelIds === undefined)
      let issueId = idOrIdentifier
      let teamId: string | undefined
      if (IDENTIFIER.test(idOrIdentifier) || needsTeam) {
        const issue = yield* getIssue(idOrIdentifier)
        issueId = issue.id
        teamId = issue.team?.id
      }
      const input = yield* buildIssueInput(teamId, fields)
      const data = yield* query(ISSUE_UPDATE, { id: issueId, input }, { retryServerErrors: false })
      const payload = data?.["issueUpdate"]
      if (!isRecord(payload) || payload["success"] !== true || payload["issue"] == null) {
        return yield* Effect.fail(
          integrationError("delivery-failed", "Linear issueUpdate did not return an issue.", {
            success: isRecord(payload) ? payload["success"] ?? false : false,
            idOrIdentifier
          })
        )
      }
      return yield* requireIssue(payload["issue"], "issueUpdate.issue")
    })

  const commentOnIssue: LinearClient["commentOnIssue"] = (idOrIdentifier, body) =>
    Effect.gen(function*() {
      // Mutations need the UUID; lookups accept an `ENG-123` identifier.
      const issueId = IDENTIFIER.test(idOrIdentifier)
        ? (yield* getIssue(idOrIdentifier)).id
        : idOrIdentifier
      const data = yield* query(COMMENT_CREATE, { input: { issueId, body } }, { retryServerErrors: false })
      const payload = data?.["commentCreate"]
      if (!isRecord(payload) || payload["success"] !== true || payload["comment"] == null) {
        return yield* Effect.fail(
          integrationError("delivery-failed", "Linear commentCreate did not return a comment.", {
            success: isRecord(payload) ? payload["success"] ?? false : false,
            idOrIdentifier
          })
        )
      }
      const comment = payload["comment"]
      if (!isRecord(comment)) return yield* Effect.fail(decodeFailed("commentCreate.comment", "an object"))
      for (const key of ["id", "body"]) {
        if (typeof comment[key] !== "string") {
          return yield* Effect.fail(decodeFailed(`commentCreate.comment.${key}`, "a string"))
        }
      }
      // The optional `issue` is typed as a record with a string id, so a
      // wrong-typed one must fail rather than reach the caller under that type.
      const issue = comment["issue"]
      if (issue !== undefined && issue !== null) {
        if (!isRecord(issue)) return yield* Effect.fail(decodeFailed("commentCreate.comment.issue", "an object"))
        if (typeof issue["id"] !== "string") {
          return yield* Effect.fail(decodeFailed("commentCreate.comment.issue.id", "a string"))
        }
      }
      return comment as unknown as CommentResult
    })

  return LinearClient.of({
    query,
    resolveTeam,
    resolveStateId,
    resolveLabelIds,
    getIssue,
    createIssue,
    updateIssue,
    commentOnIssue
  })
}

/**
 * Layer for a client bound to `config`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  config: LinearConfig = {},
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): Layer.Layer<LinearClient, IntegrationError> =>
  Layer.effect(LinearClient)(Effect.suspend(() => {
    // A config error is a typed layer failure. Anything else make throws is a
    // defect and stays one.
    try {
      return Effect.succeed(make(config, env))
    } catch (error) {
      if (isIntegrationError(error)) return Effect.fail(error)
      throw error
    }
  }))
