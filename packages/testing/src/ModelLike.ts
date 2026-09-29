/**
 * Structural model seam coordinated read-only with `packages/smithers/agent/model`.
 *
 * These shapes are a structural copy of `@smthrs/model`'s request, event, and
 * error contracts, and the copy is deliberate: a third-party engine subject or
 * scorer implements `ModelLike` without adopting the model package's classes,
 * and a recorded fixture stores plain data rather than a `Schema.Class`
 * instance whose shape would change with the class.
 *
 * It is NOT a way to avoid depending on `@smthrs/model`. This package depends
 * on it, and `CachedModel` and `RecordingModel` import it directly to wrap the
 * real provider seam. That is what the earlier wording here claimed, and it was
 * never true. The two shapes can therefore drift, and
 * `test/ModelLikeParity.test.ts` is what stops them: it asserts, at compile
 * time, that a production request, event, and error are assignable to the
 * structural copies a fixture stores.
 *
 * @since 0.0.0
 */

import { Context } from "effect"
import type { Stream } from "effect"
import type { CapabilityContractError } from "./TestingError.ts"

/**
 * The public request shape of `/model/ModelRequest`, copied structurally so a
 * fixture stores plain data and a third-party subject need not adopt the model
 * package's classes. See this module's header for why the copy exists.
 *
 * @since 0.0.0
 * @category models
 */
export interface ModelRequestLike {
  readonly modelId: string
  readonly system: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
  readonly messages: ReadonlyArray<
    | { readonly role: "user"; readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }> }
    | {
      readonly role: "assistant"
      readonly content: ReadonlyArray<
        | { readonly type: "text"; readonly text: string }
        | { readonly type: "thinking"; readonly text: string; readonly signature?: string | undefined }
        | { readonly type: "tool-call"; readonly id: string; readonly name: string; readonly arguments: string }
      >
      readonly stopReason: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "aborted" | "unknown"
      readonly responseId?: string | undefined
      readonly itemIds?: ReadonlyArray<string> | undefined
    }
    | {
      readonly role: "tool"
      readonly content: ReadonlyArray<{
        readonly type: "tool-result"
        readonly toolCallId: string
        readonly content: string
        readonly addedToolNames: ReadonlyArray<string>
      }>
    }
  >
  readonly tools: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
    readonly deferred?: boolean | undefined
    readonly loader?: boolean | undefined
  }>
  readonly params: {
    readonly maxTokens?: number | undefined
    readonly temperature?: number | undefined
    readonly topP?: number | undefined
    readonly topK?: number | undefined
    readonly stopSequences?: ReadonlyArray<string> | undefined
    readonly thinkingBudget?: number | undefined
    readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined
  }
  /**
   * How the provider may use the declared tools. Only `none` is modelled,
   * matching `/model/ModelRequest`. It is declared request state rather than a
   * wire field, so two requests that differ only here are different calls and
   * must not share a replay digest.
   */
  readonly toolChoice?: "none" | undefined
  /**
   * Provider-run tools the model may use, matching `/model/ModelRequest`. A web
   * search changes what the model can answer, so it is part of the call.
   */
  readonly serverTools?:
    | ReadonlyArray<{ readonly type: "web_search"; readonly allowedDomains?: ReadonlyArray<string> }>
    | undefined
  /**
   * The provider prefix-cache key, matching `/model/ModelRequest`. It never
   * reaches the model and is keyed to the run, so a fixture does not store it:
   * see {@link RecordedRequestLike}.
   */
  readonly cacheKey?: string | undefined
  /**
   * How many leading messages the next request in this conversation repeats
   * unchanged; unset means all of them. Matches `/model/ModelRequest`, where
   * protocols that cache automatically ignore it, and it never reaches the
   * model, so a fixture does not store it: see {@link RecordedRequestLike}.
   */
  readonly cacheBoundary?: number | undefined
}

/**
 * The request fields that steer a provider's prefix cache and never reach the
 * model.
 *
 * @since 0.0.0
 * @category models
 */
export type ProviderCacheHint = "cacheKey" | "cacheBoundary"

/**
 * The request a fixture stores and a replay digest covers: {@link ModelRequestLike}
 * without its {@link ProviderCacheHint} fields. `cacheKey` is keyed to the run,
 * so a fixture that stored it, or a digest that included it, would miss on
 * every later run of the same conversation.
 *
 * @since 0.0.0
 * @category models
 */
export type RecordedRequestLike = Omit<ModelRequestLike, ProviderCacheHint>

/**
 * The public event shape of `/model/ModelEvent`, copied structurally
 * from its streaming protocol. Every member of that union is present,
 * including `tool-result` and `retry`: a recorder that dropped them would
 * write a fixture that replays a different stream than the one the provider
 * produced, and the tool output a harness reported is what feeds the next
 * request's tool message.
 *
 * @since 0.0.0
 * @category models
 */
export type ModelEventLike =
  | { readonly type: "text-start"; readonly id: string }
  | { readonly type: "text-delta"; readonly id: string; readonly text: string }
  | { readonly type: "text-end"; readonly id: string }
  | { readonly type: "thinking-start"; readonly id: string; readonly signature?: string | undefined }
  | { readonly type: "thinking-delta"; readonly id: string; readonly text: string }
  | { readonly type: "thinking-end"; readonly id: string }
  | { readonly type: "tool-call-start"; readonly id: string; readonly name: string }
  | { readonly type: "tool-call-delta"; readonly id: string; readonly arguments: string }
  | { readonly type: "tool-call-end"; readonly id: string; readonly arguments?: string | undefined }
  | {
    readonly type: "tool-result"
    readonly id: string
    readonly output: string
    readonly isError?: boolean | undefined
  }
  | {
    readonly type: "usage"
    readonly inputTokens?: number | undefined
    readonly outputTokens?: number | undefined
    readonly reasoningTokens?: number | undefined
    readonly cachedInputTokens?: number | undefined
    readonly cacheWriteTokens?: number | undefined
    readonly totalTokens?: number | undefined
  }
  | { readonly type: "retry"; readonly attempt: number; readonly code: string; readonly delayMillis: number }
  | {
    readonly type: "settle"
    readonly stopReason: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "aborted" | "unknown"
    readonly responseId?: string | undefined
    /** The vendor session that answered, for a seat that is a wrapped CLI. */
    readonly sessionId?: string | undefined
    readonly itemIds?: ReadonlyArray<string> | undefined
  }

/**
 * The tag every `/model/ModelError` carries.
 *
 * Copied as a literal for the same reason the shape below is: a fixture stores
 * a refusal's fields as plain data, and a replay stamps the tag back on so a
 * consumer that classifies the failure still recognizes it.
 *
 * @since 0.0.0
 * @category errors
 */
export const modelErrorTag = "flows/model/ModelError"

/**
 * The public error shape of `/model/ModelError`, copied structurally so a
 * fixture stores it as plain data.
 *
 * `code` is exactly `/model/ModelError`'s `ModelErrorCode`. The permission and
 * grant-store codes this union used to also carry belong to
 * `/capability/Permission`: they are separate typed error classes that the
 * model package never raises as a `ModelError`, and a fixture that recorded one
 * as a provider failure would replay a kernel decision as a provider response.
 *
 * @since 0.0.0
 * @category errors
 */
export interface ModelErrorLike {
  /**
   * The tag `/model/ModelError` carries on the wire.
   *
   * Optional because a recorded fixture stores the fields and not the tag, and
   * required in everything a replay HANDS BACK: a consumer that classifies a
   * provider refusal — the quota park is the one in tree — matches on the tag,
   * so a replayed refusal without one is not the failure that was recorded.
   * {@link module:RecordedModel} stamps it.
   */
  readonly _tag?: typeof modelErrorTag | undefined
  readonly code:
    | "invalid_request"
    | "context_overflow"
    | "no_route"
    | "authentication"
    | "rate_limited"
    | "quota_exceeded"
    | "out_of_credit"
    | "content_policy"
    | "provider_internal"
    | "transport"
    | "call_timeout"
    | "invalid_provider_output"
    | "unknown"
  readonly message: string
  /**
   * The key path a refusal is about, for example `messages[2].content[0].text`.
   *
   * A path only, never a value: `/model/ModelError` states that invariant
   * because a request value may carry credentials or user content, which is
   * what makes the field safe for a fixture to store. Recording it is what
   * lets a replayed `invalid_request` name the field the provider rejected
   * rather than only that it rejected something.
   */
  readonly path?: string | undefined
  readonly retryAfterMillis?: number | undefined
  readonly resetAtEpochMillis?: number | undefined
  readonly resetSource?: string | undefined
  readonly quotaScope?: "model" | "account" | undefined
  readonly providerCode?: string | undefined
  readonly requestId?: string | undefined
  readonly httpStatus?: number | undefined
}

/**
 * Errors surfaced by the local model port. Production model failures retain
 * the exact `/model` shape; a poisoned double reports a capability contract
 * violation.
 *
 * `UnscriptedModelError` and `ReplayHarnessMismatchError` are deliberately not
 * here. Both say the same thing: the fixture does not describe this run. That
 * is a defect in the test, not an outcome the code under test can handle, and
 * neither is a member of `/model/Model`'s `ModelFailure`, so a replay model
 * that failed with one could not be adapted to the production seam without
 * laundering it into a provider code. Code that retries or falls back on
 * provider failures would then retry against a fixture that will never match,
 * and the test would pass or hang for the wrong reason. The replay model dies
 * on both instead: a defect cannot be caught by `Effect.catchTag` or a retry
 * schedule, and it fails the test at the call that has no recording.
 *
 * @since 0.0.0
 * @category errors
 */
export type ModelLikeError = CapabilityContractError | ModelErrorLike

/**
 * The model seam a test drives, structurally identical to
 * `@smthrs/model`'s `Model` but not depending on it.
 *
 * @category services
 * @since 0.0.0
 */
export interface ModelLike {
  readonly stream: (request: ModelRequestLike) => Stream.Stream<ModelEventLike, ModelLikeError>
}

/**
 * The {@link ModelLike} service tag.
 *
 * @category services
 * @since 0.0.0
 */
export const ModelLike: Context.Service<ModelLike, ModelLike> = Context.Service("flows/testing/ModelLike")

/**
 * Builds a {@link ModelLike} from an implementation of its one method.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (implementation: ModelLike): ModelLike => ModelLike.of(implementation)
