import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { ServerConfig } from "./Config"
import type { WorkerFailureCode } from "@smthrs/rpc/WorkerFailureCodes"
import { routeRefusal } from "./Responses"
import type { BodyFailure } from "./Failures"
import { readBoundedJson } from "./Http"
import type { Transport } from "./Http"
import { JEV_DEFAULT_MODEL, jevEvaluate } from "./jev"
import type { JevQuestion } from "./jev"
import { paidBy } from "./modelPayer"
import {
  jevFailureDetail,
  jevFailureMessage,
  RECOMMEND_ALL_CEILING,
  RECOMMEND_ALL_KEY,
  RECOMMEND_BODY_MAX_BYTES,
  RECOMMEND_CEILING,
  RECOMMEND_JEV_COMMANDS_MAX,
  RECOMMEND_JEV_TIMEOUT_MS,
  recommendKey
} from "./recommend"
import { TurnLimits, turnLimitResponse } from "./turnLimit"

/**
 * POST /api/jev: one Jev evaluation, relayed.
 *
 * The browser holds no gateway key and must not: the key is the
 * deployment's. Every in-app decision whose answer set can be enumerated is
 * Jev's, so the browser needs one door to the same client the recommender
 * and the front door already call, and this is it. The route carries a
 * request and its answers through unchanged; it decides nothing, stores
 * nothing, and logs nothing.
 *
 * The body is `{ state, questions }` — a `JevRequest` without its model,
 * because the model is the deployment's to choose. Bounds are the
 * recommender's: the same byte cap before parsing, the same 255 options in
 * one choice question, and the same deadline, so a timeout message here
 * names the number it actually waited.
 *
 * The ceiling is the recommender's too, spent under `recommendKey`, so every
 * Jev decision an address or a login asks for comes out of one daily budget
 * rather than one budget per caller. The route is open to a signed-out
 * visitor, as the recommender is, because a visitor's first minutes in the
 * product are exactly when its decisions matter.
 *
 * A Jev that refuses, misses its deadline or answers something unreadable is
 * a `service_temporarily_unavailable` 503 naming the reason, and an unset
 * key is a `seam_not_configured` 503. There is no second model and no
 * heuristic behind this route: a caller reads the refusal and fails.
 */

/** The request body's byte cap, checked before parsing. The recommender's cap, for the same reason. */
export const JEV_BODY_MAX_BYTES = RECOMMEND_BODY_MAX_BYTES

/**
 * The most questions one relayed request may carry. The gateway answers a
 * request's questions in parallel, so a caller asking two or three costs one
 * question's latency; a caller asking dozens is not asking about one state.
 */
export const JEV_QUESTIONS_MAX = 8

/** The most options ONE choice question may offer, as the recommender caps its catalog. */
export const JEV_OPTIONS_MAX = RECOMMEND_JEV_COMMANDS_MAX

/** The most levels one score question's rubric may carry. */
export const JEV_SCORE_LEVELS_MAX = 16

/**
 * The most characters the encoded state may carry. The body cap already
 * bounds the transfer; this bounds what one decision is allowed to read, so
 * a caller shipping a whole collection is refused rather than billed.
 */
export const JEV_STATE_MAX_CHARS = 32 * 1024

/** The deadline one relayed evaluation gets, shared with the recommender so its failure message stays true. */
export const JEV_TIMEOUT_MS = RECOMMEND_JEV_TIMEOUT_MS

/** A relayed evaluation: the state to read and the questions to answer about it. */
export interface JevRelayRequest {
  readonly state: unknown
  readonly questions: Readonly<Record<string, JevQuestion>>
}

/** What reading a body decided: a request, or the refusal it earns. */
export type ParsedJevRequest =
  | { readonly ok: true; readonly body: JevRelayRequest }
  | { readonly ok: false; readonly code: WorkerFailureCode; readonly message: string }

const invalid = (message: string): ParsedJevRequest => ({ ok: false, code: "request_invalid", message })
const tooLarge = (message: string): ParsedJevRequest => ({ ok: false, code: "request_body_too_large", message })

const isText = (value: unknown): value is string => typeof value === "string"

/** A refused question: malformed is 400, well-formed but past a bound is 413. */
type QuestionRefusal = { readonly code: WorkerFailureCode; readonly message: string }
const malformed = (message: string): QuestionRefusal => ({ code: "request_invalid", message })
const oversize = (message: string): QuestionRefusal => ({ code: "request_body_too_large", message })

/**
 * One question, validated leniently: the shape `jev.ts` sends is accepted and
 * anything else is refused. Nothing is rewritten — a question the gateway
 * would reject is the caller's to fix, not this route's to repair.
 */
const checkQuestion = (key: string, value: unknown): QuestionRefusal | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed(`${key} must be a question object.`)
  const { type, instructions, criteria } = value as { type?: unknown; instructions?: unknown; criteria?: unknown }
  if (!isText(instructions) || instructions === "") return malformed(`${key} needs instructions.`)
  switch (type) {
    case "boolean": {
      if (criteria === undefined) return undefined
      if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria)) {
        return malformed(`${key} criteria must name true and false.`)
      }
      const { true: yes, false: no } = criteria as { true?: unknown; false?: unknown }
      return isText(yes) && isText(no) ? undefined : malformed(`${key} criteria must name true and false.`)
    }
    case "choice": {
      if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria)) {
        return malformed(`${key} criteria must be an option map.`)
      }
      const options = Object.entries(criteria as Record<string, unknown>)
      if (options.length === 0) return malformed(`${key} must offer at least one option.`)
      if (options.length > JEV_OPTIONS_MAX) return oversize(`${key} may offer at most ${JEV_OPTIONS_MAX} options.`)
      return options.every(([, description]) => description === null || isText(description))
        ? undefined
        : malformed(`${key} options describe themselves with a string or null.`)
    }
    case "score": {
      if (!Array.isArray(criteria) || criteria.length < 2) return malformed(`${key} needs a rubric of at least two levels.`)
      if (criteria.length > JEV_SCORE_LEVELS_MAX) return oversize(`${key} may carry at most ${JEV_SCORE_LEVELS_MAX} levels.`)
      return criteria.every(isText) ? undefined : malformed(`${key} rubric levels are strings.`)
    }
    default:
      return malformed(`${key} must be a boolean, choice, or score question.`)
  }
}

/** Validate a decoded body. Malformed is 400; well-formed but past a bound is 413. */
export const validateJevRequest = (value: unknown): ParsedJevRequest => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("The evaluation must be a JSON object.")
  }
  const { state, questions } = value as { state?: unknown; questions?: unknown }
  if (state === undefined) return invalid("state is required.")
  if (typeof questions !== "object" || questions === null || Array.isArray(questions)) {
    return invalid("questions must be a map of named questions.")
  }
  const entries = Object.entries(questions as Record<string, unknown>)
  if (entries.length === 0) return invalid("An evaluation asks at least one question.")
  if (entries.length > JEV_QUESTIONS_MAX) return tooLarge(`An evaluation asks at most ${JEV_QUESTIONS_MAX} questions.`)
  for (const [key, question] of entries) {
    const failure = checkQuestion(key, question)
    if (failure !== undefined) return { ok: false, ...failure }
  }
  // The encoded size is what the gateway reads, and a state that cannot be
  // encoded is not a state Jev could have read either.
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(state)
  } catch {
    encoded = undefined
  }
  if (encoded === undefined) return invalid("state must be JSON.")
  if (encoded.length > JEV_STATE_MAX_CHARS) {
    return tooLarge(`state may carry at most ${JEV_STATE_MAX_CHARS} characters.`)
  }
  return { ok: true, body: { state, questions: questions as Record<string, JevQuestion> } }
}

const bodyRefusal = (failure: BodyFailure): { readonly code: WorkerFailureCode; readonly message: string } => {
  switch (failure._tag) {
    case "BodyTooLarge":
      return { code: "request_body_too_large", message: "The evaluation is too large." }
    case "BodyUnreadable":
      return { code: "request_body_unreadable", message: "The evaluation could not be read." }
    case "BodyNotJson":
      return { code: "request_body_not_json", message: "The evaluation is not JSON." }
  }
}

/** Read and validate the body under its byte cap. */
export const parseJevRequest = (request: Request): Effect.Effect<ParsedJevRequest> =>
  readBoundedJson(request, JEV_BODY_MAX_BYTES).pipe(
    Effect.map(validateJevRequest),
    Effect.catch((failure) => Effect.succeed<ParsedJevRequest>({ ok: false, ...bodyRefusal(failure) }))
  )

const jsonWith = (status: number, body: unknown, headers: Record<string, string>): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

const refusal = routeRefusal

/**
 * POST /api/jev. `login` is the validated session's login when the caller has
 * one; the router passes `undefined` for a visitor. Order is the
 * recommender's: the body first, then the key, then both ceilings, then Jev.
 */
export const handleJev = (
  request: Request,
  login: string | undefined,
  headers: Record<string, string>
): Effect.Effect<Response, never, TurnLimits | ServerConfig | Transport> =>
  Effect.gen(function*() {
    const parsed = yield* parseJevRequest(request)
    if (!parsed.ok) return refusal(parsed.code, parsed.message, headers)
    const config = yield* ServerConfig
    if (config.aiGatewayApiKey === undefined) {
      return refusal("seam_not_configured", "Decisions aren't available on this deployment.", headers, {
        seam: "jev",
        cause: "AI_GATEWAY_API_KEY is unset"
      })
    }
    const limits = yield* TurnLimits
    const salt = config.anonymousTurnSalt === undefined ? undefined : Redacted.value(config.anonymousTurnSalt)
    const key = yield* recommendKey(request, login, salt)
    const own = yield* limits.spend(key, RECOMMEND_CEILING)
    if (!own.allowed) return turnLimitResponse(own, headers, RECOMMEND_CEILING)
    const shared = yield* limits.spend(RECOMMEND_ALL_KEY, RECOMMEND_ALL_CEILING)
    if (!shared.allowed) return turnLimitResponse(shared, headers, RECOMMEND_ALL_CEILING)
    // A login's evaluation is metered against its own credit (modelPayer.ts).
    const answer = yield* jevEvaluate(
      { model: JEV_DEFAULT_MODEL, state: parsed.body.state, questions: parsed.body.questions },
      JEV_TIMEOUT_MS
    ).pipe(paidBy(login))
    if (!answer.ok) {
      return refusal(
        answer.reason === "out_of_credit" ? "out_of_credit" : "service_temporarily_unavailable",
        jevFailureMessage(answer),
        headers,
        jevFailureDetail(answer)
      )
    }
    return jsonWith(200, { answers: answer.answers, model: answer.model }, headers)
  })
