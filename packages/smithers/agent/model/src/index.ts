/**
 * The provider Model layer: provider-neutral requests and streaming events on
 * one side, protocol, endpoint, authentication and transport on the other.
 *
 * Modules are re-exported as namespaces, following `effect`'s index style,
 * so provider contracts and their constructors remain unambiguous. Every
 * namespace is also importable on its own subpath, `@smthrs/model/Route`.
 *
 * @since 0.1.0
 */

/**
 * @since 0.1.0
 * @slop
 */
export * as AnthropicMessages from "./AnthropicMessages.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as Auth from "./Auth.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as CanonicalJson from "./CanonicalJson.ts"

/**
 * @since 1.0.0-rc.0
 */
export * as Classifier from "./Classifier.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as DeferredTools from "./DeferredTools.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as Endpoint from "./Endpoint.ts"

/**
 * @since 1.0.0-rc.0
 */
export * as Evaluator from "./Evaluator.ts"

/**
 * @since 1.0.0-rc.1
 */
export * as EvaluatorBackup from "./EvaluatorBackup.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as Framing from "./Framing.ts"

/** @since 1.0.0-rc.1 */
export * as FailureCopy from "./FailureCopy.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as Model from "./Model.ts"

/**
 * @since 1.0.0-rc.0
 */
export * as ModelCatalog from "./ModelCatalog.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as ModelError from "./ModelError.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as ModelEvent from "./ModelEvent.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as ModelRequest from "./ModelRequest.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as OpenAIChatCompletions from "./OpenAIChatCompletions.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as OpenAIChatGPT from "./OpenAIChatGPT.ts"

/**
 * @since 0.1.0
 * @slop
 */

/**
 * @since 0.1.0
 * @slop
 */
export * as OpenAIResponses from "./OpenAIResponses.ts"

/**
 * @since 1.0.0-rc.1
 */
export * as Pricing from "./Pricing.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as Protocol from "./Protocol.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as RequestExecutor from "./RequestExecutor.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as Route from "./Route.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as ToolStream from "./ToolStream.ts"
