import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { cutModelCredential, modelFailureRefusalCode, planModelBinding } from "@smthrs/rpc/ConfiguredModel"
import type { ModelBinding, ModelTestFailure } from "@smthrs/rpc/ConfiguredModel"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { routeRefusal } from "./Responses"
import {
  CLOUD_ROLE_MAX_TOKENS,
  CLOUD_ROLE_REASONING_EFFORT,
  CLOUD_ROLE_TEMPERATURE,
  CLOUD_ROLE_TIMEOUT_MS,
  cloudRoleMessages
} from "./cloudRoleTurn"
import type { TurnRequest } from "./cloudRoleTurn"
import { ServerConfig } from "./Config"
import type { ServerConfigShape } from "./Config"
import type { Transport } from "./Http"
import { JEV_DEFAULT_MODEL, JEV_EVALUATE_URL } from "./jev"
import { workerModelCredentials } from "./modelProbe"
import { CEREBRAS_CHAT_COMPLETIONS_URL, cerebrasChat } from "./recommend"

/*
 * The Worker's seat consumers (@smthrs/rpc/ConfiguredModel MODEL_SEATS): what
 * a request's model binding becomes here before anything is spent on it.
 *
 * A binding names a credential and never carries one. Every binding goes
 * through the shared planner against deployment metadata; the explainer
 * answers on `cerebrasChat`, metered against a login's credit (modelPayer.ts). Front door and Recommend plan only
 * against the deployment table and Jev allowlist. No refusal selects a default.
 */

/** A binding this host will not serve, as the refusal names it: the code and its field or credential NAME. */
export const modelRefusalMessage = (failure: ModelTestFailure): string => {
  switch (failure.code) {
    case "invalid":
      return `The configured model is invalid: ${failure.field}.`
    case "credential_missing":
      return `${failure.credential} is unset. The configured model is unavailable on this deployment.`
    case "credential_unknown":
      return `This deployment holds no credential named ${failure.credential}.`
    case "endpoint_forbidden":
      return "The configured model's address is not one its credential may be sent to."
    case "model_not_allowed":
      return "The configured model is not a decision model this deployment allows."
    case "refused":
      return `The configured model's service answered HTTP ${failure.status}.`
    case "timeout":
      return `The configured model did not answer within ${failure.deadlineMs}ms.`
    case "unreachable":
      return "The configured model's service is unreachable."
    case "empty_output":
      return "The configured model answered with no text."
    case "host_refused":
      return "The configured model was refused."
  }
}

/** The decision model a seat's request armed: the id Jev is asked by, or why the binding is refused. */
export type PlannedDecisionModel =
  | { readonly ok: true; readonly modelId: string }
  | { readonly ok: false; readonly failure: ModelTestFailure }

/**
 * The `front-door` and `recommend` seats. No binding is the deployment's own
 * default, as it was before seats existed. A binding is planned as a decision
 * model: an id off `DECISION_MODEL_IDS` is `model_not_allowed`, and an address
 * other than the one `jevEvaluate` posts to is refused rather than ignored.
 */
export const planDecisionModel = (
  binding: ModelBinding | undefined,
  config: ServerConfigShape
): PlannedDecisionModel => {
  if (binding === undefined) return { ok: true, modelId: JEV_DEFAULT_MODEL }
  const planned = planModelBinding(binding, workerModelCredentials(config), { kind: "decision" })
  if (!planned.ok) return planned
  if (planned.plan.url !== JEV_EVALUATE_URL) return { ok: false, failure: { code: "invalid", field: "baseUrl" } }
  return { ok: true, modelId: planned.plan.modelId }
}

/* This route's own refusal: the code names the status, and the caller's headers ride along. */
const refusal = routeRefusal

/** A refused binding, in the Worker's failure vocabulary. */
export const modelRefusal = (failure: ModelTestFailure, headers: Record<string, string>): Response =>
  refusal(modelFailureRefusalCode(failure), modelRefusalMessage(failure), headers)

const ndjson = (frames: ReadonlyArray<AgentTurnFrame>, headers: Record<string, string>): Response =>
  new Response(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""), {
    status: 200,
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", ...headers }
  })

/**
 * Serve one sealed turn on the model its body binds (the `explainer` seat).
 * The caller has already parsed the body, required the session and spent the
 * ceilings. Like a cloud role turn (cloudRoleTurn.ts) it carries no tools and
 * no tool-loop item, holds no cancel-registry entry, and answers one text
 * delta and one done frame. Order: the body's shape first (a refusal there
 * costs nothing), then the plan, then the model. Every failure is a refusal:
 * no path here reaches the chat upstream or answers on another model.
 */
export const handleConfiguredModelTurn = (
  body: TurnRequest & { readonly model: ModelBinding },
  headers: Record<string, string>
): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function*() {
    if (body.tools !== undefined && body.tools.length > 0) {
      return refusal("tools_not_supported", "A configured model answers one sealed turn and runs no tools; send this turn without tools.", headers)
    }
    const messages = cloudRoleMessages(body)
    if (messages === undefined) {
      return refusal("tools_not_supported", "A configured model runs no tools, so it cannot continue a tool call; send plain messages only.", headers)
    }
    const config = yield* ServerConfig
    const planned = planModelBinding(body.model, workerModelCredentials(config), { kind: "generation" })
    if (!planned.ok) return modelRefusal(planned.failure, headers)
    const plan = planned.plan
    // `cerebrasChat` is the one generation client this Worker has, and it
    // posts to its own URL with its own key. A plan it would not reach as
    // planned is refused here, not quietly served on Cerebras.
    if (plan.protocol !== "openai-chat") return modelRefusal({ code: "invalid", field: "protocol" }, headers)
    if (plan.url !== CEREBRAS_CHAT_COMPLETIONS_URL) return modelRefusal({ code: "invalid", field: "baseUrl" }, headers)
    if (config.cerebrasApiKey === undefined) return modelRefusal({ code: "credential_missing", credential: plan.credential }, headers)
    const deadlineMs = CLOUD_ROLE_TIMEOUT_MS
    const answer = yield* cerebrasChat({
      model: plan.modelId,
      messages,
      maxTokens: CLOUD_ROLE_MAX_TOKENS,
      temperature: CLOUD_ROLE_TEMPERATURE,
      reasoningEffort: CLOUD_ROLE_REASONING_EFFORT
    }, deadlineMs)
    if (!answer.ok) {
      switch (answer.reason) {
        case "http":
          return modelRefusal({ code: "refused", status: answer.status }, headers)
        case "empty":
          return refusal("model_no_answer", "The configured model's service sent no answer.", headers)
        case "timeout":
          return modelRefusal({ code: "timeout", deadlineMs }, headers)
        case "unreachable":
          return modelRefusal({ code: "unreachable" }, headers)
        case "out_of_credit":
          return refusal("out_of_credit", "Out of credit.", headers)
      }
    }
    const runId = body.runId
    const text = cutModelCredential(answer.content, Redacted.value(config.cerebrasApiKey))
    if (text.trim() === "") {
      return ndjson([{ runId, type: "done", reason: "stop", error: "The configured model answered with no text." }], headers)
    }
    return ndjson([
      { runId, type: "delta", kind: "text", text },
      { runId, type: "done", reason: "stop" }
    ], headers)
  })
