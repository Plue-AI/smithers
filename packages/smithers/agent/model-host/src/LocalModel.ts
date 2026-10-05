/**
 * The local host's half of a configured model (@smthrs/rpc/ConfiguredModel):
 * which credentials this machine resolves, the catalog it reports, and the
 * transport and failure mapping every local call shares.
 *
 * A credential is read by NAME from the host keychain or the environment
 * record it was started with, at exactly one env key, and only after the
 * planner has pinned the request's origin to that name. The value is Redacted
 * at the read and is sent nowhere but the planned URL: redirects are never
 * followed, and no failure here carries provider text.
 *
 * @since 1.0.0-rc.0
 */

import * as Evaluator from "@smthrs/model/Evaluator"
import { ModelError } from "@smthrs/model/ModelError"
import { cloudRole } from "@smthrs/rpc/AgentRoles"
import {
  DECISION_MODEL_IDS,
  hostModelCredentials,
  MODEL_CREDENTIALS,
  modelCredentialEnvName,
  modelSeatsOf,
  planModelBinding,
  servableModels
} from "@smthrs/rpc/ConfiguredModel"
import type {
  ConfiguredModel,
  ModelCatalog,
  ModelCredentialEnv,
  ModelCredentialListing,
  ModelPlan,
  ModelPlanOptions,
  ModelTestFailure
} from "@smthrs/rpc/ConfiguredModel"
import { Layer, Redacted } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import type { HttpClient } from "effect/unstable/http/HttpClient"

/**
 * Model values stay behind this host-only interface. Listing and planning
 * never hold one.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ModelCredentials {
  readonly refresh: () => Promise<void>
  readonly list: () => ReadonlyArray<ModelCredentialListing>
  readonly read: (name: string) => Redacted.Redacted<string> | undefined
}

/**
 * The value behind a credential NAME, Redacted at the read; undefined when unset or blank.
 *
 * @category credentials
 * @since 1.0.0-rc.0
 */
export const localModelCredential = (
  env: ModelCredentialEnv,
  name: string
): Redacted.Redacted<string> | undefined => {
  const value = env[modelCredentialEnvName(name)]?.trim()
  return value === undefined || value === "" ? undefined : Redacted.make(value)
}

/**
 * A binding this host agreed to serve, with the one secret its plan names.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type LocalPlanned =
  | { readonly ok: true; readonly plan: ModelPlan; readonly apiKey: Redacted.Redacted<string> }
  | { readonly ok: false; readonly failure: ModelTestFailure }

/**
 * Plans an untrusted binding against THIS host's table, then reads the secret the plan names and no other.
 *
 * @category planning
 * @since 1.0.0-rc.0
 */
export const planOnLocal = (
  input: unknown,
  env: ModelCredentialEnv,
  options: ModelPlanOptions = {},
  credentials?: ModelCredentials
): LocalPlanned => {
  const planned = planModelBinding(input, credentials?.list() ?? hostModelCredentials(env), options)
  if (!planned.ok) return planned
  const apiKey = credentials
    ? credentials.read(planned.plan.credential)
    : localModelCredential(env, planned.plan.credential)
  return apiKey === undefined
    ? { ok: false, failure: { code: "credential_missing", credential: planned.plan.credential } }
    : { ok: true, plan: planned.plan, apiKey }
}

const originOf = (credential: string): string | undefined =>
  MODEL_CREDENTIALS.find((row) => row.name === credential)?.origins[0]

/** The rows this host offers before the user configures any: the models the product already runs on these two keys. */
const LOCAL_BUILTIN_MODELS: ReadonlyArray<ConfiguredModel> = [
  {
    id: "cerebras",
    protocol: "openai-chat",
    baseUrl: originOf("CEREBRAS_API_KEY"),
    modelId: cloudRole("librarian").model.id,
    credential: "CEREBRAS_API_KEY",
    builtin: true
  },
  {
    id: "jev",
    protocol: "evaluation",
    modelId: DECISION_MODEL_IDS[0],
    credential: "AI_GATEWAY_API_KEY",
    builtin: true
  }
]

/**
 * GET /api/model/catalog on this host: names, presence and origins. Never a
 * value. `options` are the ones this host's Test plans with, so an offline
 * host lists no row it could not reach.
 *
 * @category planning
 * @since 1.0.0-rc.0
 */
export const localModelCatalog = (
  env: ModelCredentialEnv,
  options: ModelPlanOptions = {},
  stored?: ModelCredentials
): ModelCatalog => {
  const credentials = (stored?.list() ?? hostModelCredentials(env)).map((row) => ({
    ...row,
    origins: [...row.origins]
  }))
  return {
    models: [...servableModels(LOCAL_BUILTIN_MODELS, credentials, options)],
    credentials,
    seats: modelSeatsOf("local").filter((seat) => seat !== "chat")
  }
}

/**
 * One call's transport: fetch that never follows a redirect, and the 3xx it was answered, if any.
 *
 * @category transport
 * @since 1.0.0-rc.0
 */
export interface ManualRedirects {
  readonly layer: Layer.Layer<HttpClient>
  /** RequestExecutor reads any status under 400 as an answer, so the refusal a 3xx is has to be remembered here. */
  readonly redirected: () => number | undefined
}

/**
 * Built per call, so one call's redirect is never another's.
 *
 * @category transport
 * @since 1.0.0-rc.0
 */
export const manualRedirects = (base: typeof globalThis.fetch = globalThis.fetch): ManualRedirects => {
  let status: number | undefined
  const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await base(input, { ...init, redirect: "manual" })
    if (response.status >= 300 && response.status < 400) status = response.status
    return response
  }) as typeof globalThis.fetch
  return {
    layer: FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, guarded))),
    redirected: () => status
  }
}

const isStatus = (status: number | undefined): status is number =>
  status !== undefined && Number.isInteger(status) && status >= 300 && status <= 599

/**
 * A stream that fails after HTTP 200 (OpenAI Responses' `response.failed`
 * with credit_balance_exhausted) carries the provider's code and no status:
 * a refusal is the status the provider answers it with outside a stream.
 */
const refusalStatus: Partial<Record<ModelError["code"], number>> = {
  authentication: 401,
  out_of_credit: 402,
  quota_exceeded: 429,
  rate_limited: 429
}

/**
 * The ONLY mapping from a provider failure to the contract's union. It reads
 * codes and numbers and never a message: a provider's words, and a transport
 * error's URL, stop here.
 *
 * @category failures
 * @since 1.0.0-rc.0
 */
export const modelFailureOf = (error: unknown, deadlineMs?: number): ModelTestFailure => {
  // A timeout names the deadline that armed it; with none armed, nothing answered.
  const timeout: ModelTestFailure = deadlineMs === undefined ? { code: "unreachable" } : { code: "timeout", deadlineMs }
  if (error instanceof ModelError) {
    if (isStatus(error.httpStatus)) return { code: "refused", status: error.httpStatus }
    const refused = refusalStatus[error.code]
    if (refused !== undefined) return { code: "refused", status: refused }
    if (error.code === "transport") return { code: "unreachable" }
    if (error.code === "call_timeout") return timeout
    return { code: "invalid", field: "protocol" }
  }
  if (error instanceof Evaluator.EvaluatorError) {
    if (error.code === "unreachable") return { code: "unreachable" }
    if (error.code === "timeout") return timeout
    if (isStatus(error.status)) return { code: "refused", status: error.status }
    return { code: "invalid", field: "protocol" }
  }
  return { code: "unreachable" }
}
