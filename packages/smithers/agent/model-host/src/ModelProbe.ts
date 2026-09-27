/**
 * POST /api/model/test on the local host: ONE real request against a
 * configured model, on the real @smthrs/model stack. Generation goes through
 * the record's Route over a RequestExecutor built with no retries; a decision
 * model answers its questions through the real Evaluator and the answers are
 * decoded by the real Classifier. The request is the fixed Test unless the
 * caller composed one (the model-call card). One deadline covers the whole
 * call and is echoed in the timeout it produces.
 *
 * `test` never throws and never returns provider text, except the generated
 * words with the credential cut out of them.
 *
 * @since 1.0.0-rc.0
 */

import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import { ModelRequest, SystemPart } from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import {
  bindingOf,
  cutModelCredential,
  failedModelTest,
  MODEL_CALL_TEXT_MAX,
  MODEL_TEST_DEADLINE_MS,
  modelCallDefault,
  modelCallSample,
  modelStateOf
} from "@smthrs/rpc/ConfiguredModel"
import type {
  ConfiguredModel,
  ModelAnswer,
  ModelCallInput,
  ModelCallOutput,
  ModelCatalog,
  ModelCredentialEnv,
  ModelPlanOptions,
  ModelTestFailure,
  ModelTestResult
} from "@smthrs/rpc/ConfiguredModel"
import { Effect, Exit, Redacted, Schema, Stream } from "effect"
import { toEvaluatorLayer, toModel } from "./ConfiguredModelRoute.ts"
import { localModelCatalog, manualRedirects, modelFailureOf, planOnLocal } from "./LocalModel.ts"
import type { LocalPlanned, ModelCredentials } from "./LocalModel.ts"

/**
 * How a probe reads credentials, reaches providers and bounds a call.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ModelProbeOptions {
  readonly credentials?: ModelCredentials
  /** The record credentials are read from. The host passes the one it was started with. */
  readonly env: ModelCredentialEnv
  /** False on the offline host, which may reach loopback only. */
  readonly egress: boolean
  /** The one deadline a test runs under. Defaults to MODEL_TEST_DEADLINE_MS. */
  readonly deadlineMs?: number
  /** Test override for the transport. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * The catalog this host reports and the one-call Test it runs.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ModelProbe {
  readonly catalog: () => ModelCatalog
  /** One call. With no input, the fixed Test of the model's kind. */
  readonly test: (model: ConfiguredModel, input?: ModelCallInput) => Promise<ModelTestResult>
}

type Outcome = { readonly output: ModelCallOutput } | { readonly failure: ModelTestFailure }

const invalidProtocol: Outcome = { failure: { code: "invalid", field: "protocol" } }

const decodeQuestion = Schema.decodeUnknownEffect(Evaluator.Question)

/**
 * The classifier's answers in the contract's shape: the classifier reads the
 * type off the question, the wire states it on the answer.
 *
 * @category decoding
 * @since 1.0.0-rc.0
 */
export const modelAnswersOf = (
  questions: Readonly<Record<string, Evaluator.Question>>,
  answers: Readonly<Record<string, Classifier.Answer>>
): Record<string, ModelAnswer> =>
  Object.fromEntries(
    Object.entries(answers).map(([id, answer]) => {
      const type = questions[id]?.type
      return [
        id,
        type === "boolean" && "probability" in answer ?
          { type, value: answer.value, probability: answer.probability }
          : type === "choice" && "confidence" in answer && typeof answer.value === "string"
          ? { type, value: answer.value, probabilities: answer.probabilities, confidence: answer.confidence }
          : type === "score" && "label" in answer
          ? {
            type,
            value: answer.value,
            label: answer.label,
            probabilities: answer.probabilities,
            confidence: answer.confidence
          }
          : answer as never
      ] as const
    })
  )

const generation = (
  planned: Extract<LocalPlanned, { ok: true }>,
  input: Extract<ModelCallInput, { kind: "generation" }>
): Effect.Effect<Outcome, unknown, KernelHttpClient.HttpClient> =>
  Effect.gen(function*() {
    const http = yield* KernelHttpClient.HttpClient
    const executor = yield* RequestExecutor.makeWith(RequestExecutor.fixed(http), { maxRetries: 0 })
    const model = yield* toModel(planned.plan, planned.apiKey).pipe(
      Effect.provideService(RequestExecutor.RequestExecutor, executor)
    )
    const events = Array.from(
      yield* Stream.runCollect(model.stream(ModelRequest.make({
        modelId: planned.plan.modelId,
        system: input.system.trim() === "" ? [] : [SystemPart.make({ text: input.system })],
        messages: [{ role: "user", content: [{ type: "text", text: input.prompt }] }],
        tools: [],
        params: {
          maxTokens: input.maxTokens,
          ...(input.temperature === undefined ? {} : { temperature: input.temperature })
        }
      })))
    )
    // Reaching `settle` is the pass: a reasoning model may spend every token thinking and say nothing.
    if (!events.some((event) => event.type === "settle")) return invalidProtocol
    const text = events.flatMap((event) => event.type === "text-delta" ? [event.text] : []).join("")
    const output: ModelCallOutput = {
      kind: "generation",
      text: cutModelCredential(text, Redacted.value(planned.apiKey)).slice(0, MODEL_CALL_TEXT_MAX)
    }
    return { output }
  })

const decision = (
  planned: Extract<LocalPlanned, { ok: true }>,
  deadlineMs: number,
  input: Extract<ModelCallInput, { kind: "decision" }>
): Effect.Effect<Outcome, unknown, KernelHttpClient.HttpClient> =>
  Effect.gen(function*() {
    // The questions become the classes every host builds, so their construction limits hold here too.
    const questions = Object.fromEntries(
      yield* Effect.forEach(Object.entries(input.questions), ([id, question]) =>
        Effect.map(decodeQuestion(question), (typed) => [id, typed] as const))
    )
    const evaluator = yield* Evaluator.Evaluator
    const answer = yield* evaluator.evaluate({ state: modelStateOf(input.state), questions })
    const decoded = yield* Effect.result(Classifier.decodeAnswers(questions, answer.answers))
    if (decoded._tag !== "Success") {
      return invalidProtocol
    }
    const output: ModelCallOutput = { kind: "decision", answers: modelAnswersOf(questions, decoded.success) }
    return { output }
  }).pipe(Effect.provide(toEvaluatorLayer(planned.plan, planned.apiKey, deadlineMs)))

/**
 * POST /api/model/test on this host: one bounded call that never throws.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const createModelProbe = (options: ModelProbeOptions): ModelProbe => {
  const deadlineMs = options.deadlineMs ?? MODEL_TEST_DEADLINE_MS
  /** One rule for what is listed and what is tested, so the catalog offers no row a Test would refuse to dial. */
  const planOptions: ModelPlanOptions = options.egress ? {} : { egress: false }

  const test = async (model: ConfiguredModel, input?: ModelCallInput): Promise<ModelTestResult> => {
    const started = performance.now()
    const failed = (failure: ModelTestFailure): ModelTestResult =>
      failedModelTest(failure, performance.now() - started, "local")
    await options.credentials?.refresh()
    const planned = planOnLocal(bindingOf(model), options.env, planOptions, options.credentials)
    if (!planned.ok) return failed(planned.failure)
    const request = input ?? modelCallDefault(planned.plan.kind)
    // A prompt for a decision model, or questions for a generation model, fit no wire the record speaks.
    if (request.kind !== planned.plan.kind) return failed({ code: "invalid", field: "protocol" })
    const http = manualRedirects(options.fetch)
    const exit = await Effect.runPromiseExit(
      (request.kind === "decision" ? decision(planned, deadlineMs, request) : generation(planned, request)).pipe(
        Effect.catch((error) => Effect.succeed<Outcome>({ failure: modelFailureOf(error, deadlineMs) })),
        Effect.timeoutOrElse({
          duration: deadlineMs,
          orElse: () => Effect.succeed<Outcome>({ failure: { code: "timeout", deadlineMs } })
        }),
        Effect.provide(http.layer)
      )
    )
    const redirected = http.redirected()
    if (redirected !== undefined) return failed({ code: "refused", status: redirected })
    // A defect is a bug in this host, and its cause may hold a signed request: dropped, never logged or returned.
    if (!Exit.isSuccess(exit)) return failed({ code: "unreachable" })
    if ("failure" in exit.value) return failed(exit.value.failure)
    const { output } = exit.value
    return {
      ok: true,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      sample: modelCallSample(output, Redacted.value(planned.apiKey)),
      output
    }
  }

  return { catalog: () => localModelCatalog(options.env, planOptions, options.credentials), test }
}
