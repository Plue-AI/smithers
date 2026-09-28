/**
 * Run one routed flow against a recorded model fixture.
 *
 * The flow id is a string, so nothing infers the output type: state it, or
 * `output` is `unknown` and `expect` cannot read a field.
 *
 * ```ts
 * import { Flow } from "../flows/chat/flow.ts"
 *
 * cachedModelTest<{ message: string }, typeof Flow.output.Type>(
 *   "chat answers a balance question",
 *   {
 *     fixture: new URL("./fixtures/balance.json", import.meta.url),
 *     flow: "chat",
 *     payload: { message: "What is vitalik.eth's balance?" },
 *     expect: (output) => { expect(output.answer).toContain("ETH") }
 *   }
 * )
 * ```
 *
 * Two modes, one call site. Replay is the default: the fixture is decoded with
 * `@smthrs/testing`'s `Fixture` schema and served by `RecordedModel`, with no
 * network and no API key. Recording (`SMTHRS_RECORD=1`) builds the live model
 * from `options.live`, captures every request and event through
 * {@link recordModel}, and rewrites the fixture after the run.
 *
 * `vitest` is an optional peer: only this module needs it.
 *
 * @since 0.1.0
 */

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Interpreter } from "@smthrs/flow"
import { make as makeModel, type Model, type ModelFailure } from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import { Fixture, type RecordedCall } from "@smthrs/testing/Fixture"
import type { ModelErrorLike, ModelEventLike, ModelLikeError, ModelRequestLike } from "@smthrs/testing/ModelLike"
import { modelErrorTag } from "@smthrs/testing/ModelLike"
import * as RecordedModel from "@smthrs/testing/RecordedModel"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect as vitestExpect, test } from "vitest"
import { type AgentSpec, type AnyFlowSpec, type AppDirs, defaultDirs, type SandboxSpec, type ToolsSpec } from "./app.ts"
import { discover } from "./router.ts"
import { layerFor, materializeFlow } from "./runtime.ts"

/**
 * One routed flow: its declaration plus the three layers resolved for it.
 *
 * @category models
 * @since 0.1.0
 */
export interface RoutedFlow {
  readonly id: string
  readonly file: string
  readonly spec: AnyFlowSpec
  readonly agent: AgentSpec
  readonly sandbox: SandboxSpec
  readonly tools: ToolsSpec
}

/**
 * What one {@link cachedModelTest} takes.
 *
 * @category models
 * @since 0.1.0
 */
export interface CachedModelTestOptions<P, O> {
  readonly fixture: URL
  readonly flow: string
  readonly payload: P
  readonly expect: (output: O) => void | Promise<void>
  /**
   * Builds the live model used when `SMTHRS_RECORD=1`. Omit it on a flow that
   * is only ever replayed; recording then fails with a message instead of
   * running silently against a noop model.
   */
  readonly live?: () => Model
  /**
   * Loads the routed flows this test may run. Defaults to re-running the
   * router over `process.cwd()` and importing just the named flow and its
   * three layer files.
   */
  readonly routes?: () => Promise<ReadonlyArray<RoutedFlow>>
  /** Source directories, when the app under test does not use the defaults. */
  readonly dirs?: AppDirs
  /** App root the default `routes` loader walks. Defaults to `process.cwd()`. */
  readonly root?: string
  /**
   * Cancels the run. {@link cachedModelTest} passes vitest's own test signal,
   * so a test that exhausts `testTimeout` interrupts the flow instead of
   * leaving the sandbox evaluating and, under `SMTHRS_RECORD=1`, the live
   * provider stream spending until the worker exits.
   */
  readonly signal?: AbortSignal
}

/**
 * Whether this process is recording rather than replaying.
 *
 * @category constructors
 * @since 0.1.0
 */
export const recording = (): boolean => process.env["SMTHRS_RECORD"] === "1"

/**
 * The credential-free route every test seat resolves to.
 *
 * A replayed run never reaches the network, and a recording run signs its own
 * request downstream of this value, so the body is a placeholder in both modes.
 *
 * @category models
 * @since 0.1.0
 */
export const preparedRequest: Route.PreparedRequest = {
  routeId: "cached-model-test",
  protocolId: "cached-model-test",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

type MessageLike = ModelRequestLike["messages"][number]
type AssistantPartLike = Extract<MessageLike, { readonly role: "assistant" }>["content"][number]

/** Projects one live message onto the structural shape a fixture stores. */
const toMessageLike = (message: ModelRequest.Message): MessageLike => {
  if (message.role === "user") {
    return { role: "user", content: message.content.map((part) => ({ type: "text", text: part.text })) }
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content.map((part) => ({
        type: "tool-result",
        toolCallId: part.toolCallId,
        content: part.content,
        addedToolNames: [...part.addedToolNames]
      }))
    }
  }
  // An assistant message carries text, thinking, or a tool call; a tool result
  // is its own message, so there is no fourth case to fall through to.
  const content = message.content.map((part): AssistantPartLike =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : part.type === "thinking"
      ? { type: "thinking", text: part.text, signature: part.signature }
      : { type: "tool-call", id: part.id, name: part.name, arguments: part.arguments }
  )
  return {
    role: "assistant",
    content,
    stopReason: message.stopReason,
    responseId: message.responseId,
    itemIds: message.itemIds
  }
}

/**
 * Projects a live `ModelRequest` onto the structural shape a fixture stores.
 *
 * `toolChoice` is carried rather than dropped. `@smthrs/testing`'s request
 * schema holds it, and its replay digest reads it, so two requests that differ
 * only in `toolChoice` are different calls. Dropping it here would record a
 * request that the digest of the live request no longer matches, and the replay
 * would report the recorded call as unscripted. The key is omitted when the
 * request carries no choice, which is the shape the fixture schema declares.
 */
const toRequestLike = (request: ModelRequest.ModelRequest): ModelRequestLike => ({
  modelId: request.modelId,
  system: request.system.map((part) => ({ type: "text" as const, text: part.text })),
  messages: request.messages.map(toMessageLike),
  tools: request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    deferred: tool.deferred,
    loader: tool.loader
  })),
  params: {
    maxTokens: request.params.maxTokens,
    temperature: request.params.temperature,
    topP: request.params.topP,
    topK: request.params.topK,
    stopSequences: request.params.stopSequences,
    thinkingBudget: request.params.thinkingBudget,
    reasoningEffort: request.params.reasoningEffort
  },
  ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice })
})

/**
 * Projects a live provider failure onto the structural shape a fixture stores.
 *
 * Every field `ModelErrorLike` declares is carried, retry metadata included:
 * a consumer that parks on a reset-bearing refusal branches on those fields,
 * so a replay that dropped them would exercise a different path than the
 * recording did. Keys the error does not carry are omitted rather than written
 * as `undefined`, which is the shape the fixture schema declares.
 *
 * A permission or grant-store failure returns `undefined` and is not recorded.
 * Those are kernel decisions rather than provider responses, and
 * `ModelErrorLike`'s own contract is that a fixture never stores one: replaying
 * it would hand the code under test a provider refusal the provider never made.
 */
const toFailureLike = (error: ModelFailure): ModelErrorLike | undefined => {
  if (error._tag !== modelErrorTag) return undefined
  return {
    code: error.code,
    message: error.message,
    ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
    ...(error.resetAtEpochMillis === undefined ? {} : { resetAtEpochMillis: error.resetAtEpochMillis }),
    ...(error.resetSource === undefined ? {} : { resetSource: error.resetSource }),
    ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus })
  }
}

/**
 * Wraps a live model so every request and its events are appended to `sink`.
 *
 * The sink fires once per request, when its stream ends. A failed or
 * interrupted stream records the events seen so far, which is what makes a
 * half-recorded fixture visible instead of empty.
 *
 * Every event is recorded. `@smthrs/testing`'s `ModelEventLike` covers each
 * member of `@smthrs/model`'s event union, `tool-result` and `retry` included,
 * so nothing has to be dropped. Dropping either would replay a different stream
 * than the provider produced, and the tool output a harness reported is what
 * feeds the next request's tool message.
 *
 * @category constructors
 * @since 0.1.0
 */
export const recordModel = (live: Model, sink: (call: RecordedCall) => void): Model =>
  makeModel({
    stream: (request) =>
      Stream.suspend(() => {
        const events: Array<ModelEventLike> = []
        let failure: ModelErrorLike | undefined
        // Snapshotted before the provider is handed the request, not in
        // `flush`: a provider that mutates the request in place would
        // otherwise be recorded asking its own mutation rather than what the
        // caller asked.
        const snapshot = toRequestLike(request)
        const flush = Effect.sync(() => {
          sink({
            request: snapshot,
            model: request.modelId,
            events: [...events],
            ...(failure === undefined ? {} : { failure })
          })
        })
        return live.stream(request).pipe(
          Stream.tap((event) => Effect.sync(() => events.push(event))),
          // A provider failure is part of the recording. Without this the
          // fixture stored a truncated success-shaped call, and replaying it
          // served a short stream where the provider had refused.
          Stream.tapError((error) => Effect.sync(() => (failure = toFailureLike(error)))),
          Stream.ensuring(flush)
        )
      })
  })

/**
 * Rebuilds the `ModelError` a fixture recorded.
 *
 * The replay error channel carries `ModelLikeError`, which is either the
 * recorded provider failure or the doubles' own
 * `CapabilityContractError`. Only the first is an outcome the code under test
 * can handle, so it is reconstructed field for field, retry metadata included;
 * mapping every failure onto `invalid_provider_output` replayed a different
 * decision than the recording captured. The contract violation is a defect in
 * the double rather than a provider response, so it keeps the
 * `invalid_provider_output` code and names itself in the message.
 *
 * `UnscriptedModelError` and `ReplayHarnessMismatchError` do not come through
 * here. `@smthrs/testing` dies on both, because a fixture that does not
 * describe the run is a defect in the test rather than an outcome the code
 * under test can handle.
 *
 * Exported because the contract-violation branch is unreachable from a
 * fixture: `ModelErrorLike.code` is a closed union that has no
 * `capability_contract_violation` member, so only a poisoned `ModelLike` can
 * produce one, and only a caller that supplies its own replay can poison one.
 * The branch is still the declared handler for half the error channel, so it
 * is driven directly rather than left unproven.
 *
 * @category constructors
 * @since 0.1.0
 */
export const replayModelError = (error: ModelLikeError): ModelError => {
  if (error.code === "capability_contract_violation") {
    return new ModelError({
      code: "invalid_provider_output",
      message: `recorded model replay failed: ${error.code}`
    })
  }
  const recorded = error
  return new ModelError({
    code: recorded.code,
    message: recorded.message,
    ...(recorded.retryAfterMillis === undefined ? {} : { retryAfterMillis: recorded.retryAfterMillis }),
    ...(recorded.resetAtEpochMillis === undefined ? {} : { resetAtEpochMillis: recorded.resetAtEpochMillis }),
    ...(recorded.resetSource === undefined ? {} : { resetSource: recorded.resetSource }),
    ...(recorded.providerCode === undefined ? {} : { providerCode: recorded.providerCode }),
    ...(recorded.requestId === undefined ? {} : { requestId: recorded.requestId }),
    ...(recorded.httpStatus === undefined ? {} : { httpStatus: recorded.httpStatus })
  })
}

/** Adapts a replay `ModelLike` to the production `Model` seam. */
const asModel = (replay: RecordedModel.Replay): Model =>
  makeModel({
    stream: (request) =>
      replay.model.stream(request).pipe(
        Stream.mapError(replayModelError),
        Stream.map((event): ModelEvent.ModelEvent => event)
      )
  })

const importModule = (root: string, file: string): Promise<Record<string, unknown>> =>
  import(/* @vite-ignore */ pathToFileURL(resolve(root, file)).href) as Promise<Record<string, unknown>>

/**
 * Reads one declared export and proves it is the spec its file owes.
 *
 * Every spec carries a `_tag`, and nothing used to read it: `export const
 * Agent = 42` in an `AGENT.ts` was accepted here and failed much later inside
 * `AgentAction.layerHost`, with a message that named neither the file nor the
 * field.
 */
const named = <T extends { readonly _tag: string }>(
  module_: Record<string, unknown>,
  name: string,
  file: string,
  spec: { readonly tag: T["_tag"]; readonly constructor: string }
): T => {
  const value = module_[name]
  if (value === undefined) throw new Error(`${file} must export \`${name}\``)
  if (typeof value !== "object" || value === null || (value as { _tag?: unknown })._tag !== spec.tag) {
    throw new Error(`${file} must export \`${name}\` built by ${spec.constructor}`)
  }
  return value as T
}

/**
 * Resolves one flow by re-running the router, then imports only that flow and
 * its three layer files.
 *
 * `routes.gen.ts` is deliberately not used. It is generated, so a test that
 * read it would depend on it being current, and it imports every flow in the
 * app together with every layer file and tool module any of them resolves to:
 * one flow's test would load, and could be broken by, every other flow. The
 * pages and the shell layout are not the reason; those live in
 * `routes.ui.gen.ts` and no Worker table imports them.
 */
const discoverRoutedFlow = async (id: string, root: string, dirs: AppDirs): Promise<ReadonlyArray<RoutedFlow>> => {
  const routes = discover({ root, dirs })
  const route = routes.flows.find((candidate) => candidate.id === id)
  if (route === undefined) {
    throw new Error(
      `flow "${id}" is not routed. Known flows: ${routes.flows.map((candidate) => candidate.id).join(", ")}`
    )
  }
  if (route.file.endsWith(".mdx")) {
    throw new Error(`cachedModelTest cannot run ${route.file}: a markdown flow has no loader yet`)
  }
  const [flowModule, agentModule, sandboxModule, toolsModule] = await Promise.all([
    importModule(root, route.file),
    importModule(root, route.agent),
    importModule(root, route.sandbox),
    importModule(root, route.tools)
  ])
  return [{
    id: route.id,
    file: route.file,
    spec: named<AnyFlowSpec>(flowModule, "Flow", route.file, { tag: "FlowSpec", constructor: "defineFlow" }),
    agent: named<AgentSpec>(agentModule, "Agent", route.agent, { tag: "AgentSpec", constructor: "defineAgent" }),
    sandbox: named<SandboxSpec>(sandboxModule, "Sandbox", route.sandbox, {
      tag: "SandboxSpec",
      constructor: "defineSandbox"
    }),
    tools: named<ToolsSpec>(toolsModule, "Tools", route.tools, { tag: "ToolsSpec", constructor: "defineTools" })
  }]
}

/**
 * Decodes one fixture file, naming it in every failure.
 *
 * `JSON.parse` used to run eagerly outside the returned effect, so a fixture
 * with a trailing comma rejected with a bare `SyntaxError` carrying no path,
 * and a schema-drifted fixture surfaced its `SchemaError` unwrapped and
 * equally anonymous. Both now fail as one error whose message begins with the
 * fixture path, with the original failure kept as the cause.
 */
const readFixture = (path: string): Effect.Effect<typeof Fixture.Type> =>
  Effect.try({
    try: () => JSON.parse(readFileSync(path, "utf8")) as unknown,
    catch: (cause) => new Error(`${path} is not valid JSON: ${String(cause)}`, { cause })
  }).pipe(
    Effect.flatMap((parsed) =>
      Schema.decodeUnknownEffect(Fixture)(parsed).pipe(
        Effect.mapError((cause) => new Error(`${path} is not a @smthrs/testing fixture: ${cause.message}`, { cause }))
      )
    ),
    Effect.orDie
  )

/** An environment variable whose name marks it as a credential. */
const credentialName = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

/**
 * The credential variables in `env` whose value appears in `text`.
 *
 * A fixture is committed, and it stores every system prompt, tool result, and
 * provider message verbatim, so a tool that echoed a key while recording would
 * publish it. The value is also matched as JSON escapes it. Values under eight
 * characters are skipped: they are flags, not keys, and would match by chance.
 */
const leakedCredentials = (text: string, env: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  Object.entries(env)
    .filter(([name, value]) =>
      credentialName.test(name) && value.length >= 8
      && (text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1)))
    )
    .map(([name]) => name)
    .sort()

const writeFixture = (path: string, calls: ReadonlyArray<RecordedCall>): void => {
  const text = `${JSON.stringify({ calls }, null, 2)}\n`
  // A `process.env` entry is never `undefined` at runtime; only its type says so.
  const leaked = leakedCredentials(text, process.env as Record<string, string>)
  if (leaked.length > 0) {
    throw new Error(
      `the recording of ${path} contains the value of ${leaked.join(", ")}; it was not written. `
        + "Keep credentials out of prompts and tool results, then record again."
    )
  }
  mkdirSync(dirname(path), { recursive: true })
  // Written through a neighbouring temporary file and renamed, so an
  // interrupted process cannot leave the committed fixture truncated.
  const staging = `${path}.recording`
  writeFileSync(staging, text)
  renameSync(staging, path)
}

/**
 * Runs one routed flow on a cached model, without registering a test.
 *
 * This is the body {@link cachedModelTest} puts inside `test()`. It is exported
 * so a harness other than vitest — or a test of this module itself — can drive
 * the same path and observe its refusals directly.
 *
 * @category constructors
 * @since 0.1.0
 */
export const runCachedModelTest = async <P, O>(
  name: string,
  options: CachedModelTestOptions<P, O>
): Promise<void> => {
  const fixturePath = fileURLToPath(options.fixture)
  if (!existsSync(fixturePath) && !recording()) {
    throw new Error(
      `no fixture at ${fixturePath}. Record one with \`pnpm test:record\` (SMTHRS_RECORD=1), then commit it.`
    )
  }

  const dirs = options.dirs ?? defaultDirs
  const root = options.root ?? process.cwd()
  const routed = await (options.routes ?? (() => discoverRoutedFlow(options.flow, root, dirs)))()
  const flow = routed.find((candidate) => candidate.id === options.flow)
  if (flow === undefined) {
    throw new Error(
      `flow "${options.flow}" is not routed. Known flows: ${routed.map((candidate) => candidate.id).join(", ")}`
    )
  }

  const calls: Array<RecordedCall> = []
  let model: Model
  if (recording()) {
    const live = options.live?.()
    if (live === undefined) {
      throw new Error(
        `SMTHRS_RECORD=1 needs a live model: add \`live: () => ...\` to cachedModelTest(${JSON.stringify(name)}).`
      )
    }
    model = recordModel(live, (call) => calls.push(call))
  } else {
    const fixture = await Effect.runPromise(readFixture(fixturePath))
    model = asModel(await Effect.runPromise(RecordedModel.make(fixture)))
  }

  const materialized = materializeFlow(flow.id, flow.spec, flow.agent)
  const host = layerFor({
    agent: flow.agent,
    sandbox: flow.sandbox,
    tools: flow.tools,
    seats: { resolve: () => Effect.succeed({ model, route: { prepare: () => Effect.succeed(preparedRequest) } }) },
    crypto: NodeCrypto.layer,
    // The model here is recorded or live-under-record, and the completion
    // brake never falls back: a claim nothing could judge fails the run. The
    // judge is scripted so this harness reaches no gateway and a recorded
    // completion replays exactly as it was recorded.
    evaluator: ScriptedJudge.layer
  })
  const runtime = Layer.mergeAll(materialized.action.layer, Interpreter.layer(materialized.flow)).pipe(
    Layer.provideMerge(host)
  )

  // `materializeFlow` erases the flow's payload and success schemas, so the
  // call site restates them. `execute` reads `this.payloadSchema`, so it stays
  // bound to its flow.
  const execute = materialized.flow.execute.bind(materialized.flow) as (
    payload: unknown,
    options: { readonly executionId: string }
  ) => Effect.Effect<O, unknown, never>
  const output = await Effect.runPromise(
    execute(options.payload, { executionId: `e2e/${flow.id}/${name}` }).pipe(
      Effect.orDie,
      Effect.provide(runtime as unknown as Layer.Layer<never>)
    ),
    { signal: options.signal }
  )
  await options.expect(output)

  // Only a run that reached here writes the fixture. The write used to sit in
  // a `finally`, so a provider 429, a bad payload, or an assertion that no
  // longer held replaced a good committed fixture with a partial one — and a
  // run that made no calls truncated it to `{"calls": []}` before the guard
  // below could fire. A failed recording now leaves the committed bytes alone.
  if (recording()) {
    vitestExpect(calls.length, "recording produced no model calls").toBeGreaterThan(0)
    writeFixture(fixturePath, calls)
  }
}

/**
 * Registers one vitest test that runs a routed flow on a cached model.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cachedModelTest = <P, O>(name: string, options: CachedModelTestOptions<P, O>): void => {
  // The registered test is vitest's to cancel, so its signal wins over one the
  // caller put in `options`: without it a run that exhausts `testTimeout` is
  // reported failed while its fiber keeps evaluating cells and, when
  // recording, keeps the provider stream open.
  test(name, ({ signal }) => runCachedModelTest(name, { ...options, signal }))
}
