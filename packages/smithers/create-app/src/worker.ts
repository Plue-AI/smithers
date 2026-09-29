/**
 * The turn host a scaffolded Worker serves `POST /api/turn` with.
 *
 * {@link turnResponse} takes the request, resolves the routed chat flow, checks
 * the host can run it, and answers with an NDJSON stream of `TurnFrame` lines:
 * model text as `delta`, each cell the agent ran as `cell`, each host call as
 * `call`, each card a tool painted as `card`, then exactly one `done` or
 * `error`, then close. A request the host cannot run is refused before any
 * stream opens, in one typed JSON body.
 *
 * Nothing here reaches a Node builtin. Seats resolve over `fetch`, digests come
 * from WebCrypto, and the QuickJS build is the caller's: workerd compiles only
 * a WebAssembly module its toolchain bundled, so a Worker imports the `.wasm`
 * module and passes the variant built from it as `sandboxVariant`.
 *
 * A turn is one request, so it runs on the in-memory flow engine. Nothing
 * resumes a half-finished turn; a client that wants continuity replays its
 * history into the next payload.
 *
 * @since 1.0.0
 */

import * as EventSink from "@smthrs/agent/EventSink"
import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as Seat from "@smthrs/agent/Seat"
import { Interpreter } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import type * as Evaluator from "@smthrs/model/Evaluator"
import type * as ModelError from "@smthrs/model/ModelError"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Redacted from "effect/Redacted"
import type * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import type { AgentSpec, AnyFlowSpec, SandboxSpec, ToolsSpec } from "./app.ts"
import { readJson } from "./http.ts"
import { layerFor, materializeFlow, type SeatProvider } from "./runtime.ts"
import type { AppCard, TurnFrame } from "./ui.ts"

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/** A route builder as `Route.anthropic` and `Route.openai` both shape it. */
type RouteFor = (
  input: { readonly apiKey: Redacted.Redacted<string> }
) => Result.Result<Parameters<typeof Route.toModel>[0], ModelError.ModelError>

/** One credentialed provider: the binding that holds its key and its route. */
interface Provider {
  readonly binding: string
  readonly route: RouteFor
}

const providers: Readonly<Record<string, Provider>> = {
  anthropic: { binding: "ANTHROPIC_API_KEY", route: Route.anthropic as RouteFor },
  openai: { binding: "OPENAI_API_KEY", route: Route.openai as RouteFor }
}

/** Provider requests over the platform's `fetch`. */
const executor = RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))

const unresolved = (seat: string, message: string): Seat.SeatUnresolved => new Seat.SeatUnresolved({ seat, message })

/**
 * Resolves `anthropic:<model>` and `openai:<model>` seats against the keys in
 * `env`, over `fetch`. A seat with no `<provider>:` prefix is an Anthropic
 * seat. An unknown provider or a missing key fails `SeatUnresolved`, naming the
 * binding to set.
 *
 * @category constructors
 * @since 1.0.0
 */
export const seatsFromEnv = (env: Readonly<Record<string, string | undefined>>): SeatProvider => ({
  resolve: (seatId) =>
    Effect.gen(function*() {
      const separator = seatId.indexOf(":")
      const name = separator < 0 ? "anthropic" : seatId.slice(0, separator)
      const provider = providers[name]
      if (provider === undefined) {
        return yield* unresolved(
          seatId,
          `This host resolves ${Object.keys(providers).join(" and ")} seats only; "${name}" has no route here`
        )
      }
      const key = env[provider.binding]
      if (key === undefined || key.length === 0) {
        return yield* unresolved(seatId, `Set the ${provider.binding} secret to run the ${seatId} seat`)
      }
      // Both routes are fixed endpoints over a header key, so building one
      // cannot fail on anything a deployment configures.
      const configured = yield* Effect.orDie(Effect.fromResult(provider.route({ apiKey: Redacted.make(key) })))
      const model = yield* Route.toModel(configured).pipe(Effect.provide(executor))
      return { model, route: FlowEngineLike.routeResolver(configured) }
    })
})

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

/**
 * `effect/Crypto` over WebCrypto, which workerd, browsers, and Node all have.
 *
 * `randomBytes` returns a fresh array per call: `Crypto.make` formats UUIDs by
 * mutating the bytes it is handed, so a shared buffer would repeat ids.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerCryptoWeb: Layer.Layer<Crypto.Crypto> = Layer.succeed(Crypto.Crypto)(
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.tryPromise({
        try: () => globalThis.crypto.subtle.digest(algorithm, data as BufferSource),
        catch: (cause) =>
          new PlatformError.PlatformError(
            new PlatformError.BadArgument({
              module: "create-app/worker",
              method: "digest",
              description: String(cause),
              cause
            })
          )
      }).pipe(Effect.map((buffer) => new Uint8Array(buffer)))
  })
)

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * One routed flow, as a generated `routes.gen.ts` records it.
 *
 * @category models
 * @since 1.0.0
 */
export interface TurnRoute {
  readonly id: string
  readonly spec: AnyFlowSpec
  readonly agent: AgentSpec
  readonly sandbox: SandboxSpec
  readonly tools: ToolsSpec
}

/**
 * Why a turn was refused before its stream opened.
 *
 * @category models
 * @since 1.0.0
 */
export type TurnRefusal =
  | {
    readonly status: 400
    readonly error: "flow_not_routed"
    readonly message: string
    readonly known: ReadonlyArray<string>
  }
  | { readonly status: 400; readonly error: "flow_not_chat"; readonly message: string }
  | { readonly status: 400; readonly error: "flow_not_pipeline"; readonly message: string }
  | { readonly status: 503; readonly error: "host_unconfigured"; readonly message: string }

const unrouted = (flows: ReadonlyArray<TurnRoute>, id: string): TurnRefusal => ({
  status: 400,
  error: "flow_not_routed",
  message: `No flow is routed as "${id}"`,
  known: flows.map((flow) => flow.id)
})

/**
 * The routed chat flow named `id`, or the refusal that says why there is none.
 *
 * A flow without `chat: true` runs through a flow-run endpoint, not a turn.
 *
 * @category constructors
 * @since 1.0.0
 */
export const resolveChatFlow = (flows: ReadonlyArray<TurnRoute>, id: string): TurnRoute | TurnRefusal => {
  const route = flows.find((flow) => flow.id === id)
  if (route === undefined) return unrouted(flows, id)
  if (route.spec.chat !== true) {
    return { status: 400, error: "flow_not_chat", message: `"${id}" is not a chat flow` }
  }
  return route
}

/**
 * The routed pipeline flow named `id`, or the refusal that says why there is
 * none.
 *
 * A flow with `chat: true` runs as a turn, not as a flow run.
 *
 * @category constructors
 * @since 1.0.0
 */
export const resolvePipelineFlow = (flows: ReadonlyArray<TurnRoute>, id: string): TurnRoute | TurnRefusal => {
  const route = flows.find((flow) => flow.id === id)
  if (route === undefined) return unrouted(flows, id)
  if (route.spec.chat === true) {
    return { status: 400, error: "flow_not_pipeline", message: `"${id}" is a chat flow; run it as a turn` }
  }
  return route
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

/**
 * Where a tool puts the cards it paints this turn. Each call becomes a `card`
 * or `card.update` frame on the response.
 *
 * @category models
 * @since 1.0.0
 */
export interface TurnCards {
  readonly emit: (card: AppCard) => void
  readonly update: (card: AppCard) => void
}

/**
 * What a host supplies for its turns.
 *
 * `env` holds the model connection configuration. `tools` rebinds a
 * route's tool sources to this turn's cards; omitted, the route's own tools
 * run. `seats`, `evaluator`, and `crypto` default to {@link seatsFromEnv},
 * the resolved agent seat for judgment, and {@link layerCryptoWeb}.
 *
 * @category models
 * @since 1.0.0
 */
export interface TurnHost {
  readonly flows: ReadonlyArray<TurnRoute>
  readonly env: Readonly<Record<string, string | undefined>>
  readonly sandboxVariant: Layer.Layer<QuickJSSandbox.Variant>
  readonly tools?: ((route: TurnRoute, cards: TurnCards) => ToolsSpec) | undefined
  readonly seats?: SeatProvider | undefined
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  readonly crypto?: Layer.Layer<Crypto.Crypto> | undefined
  /**
   * Sees every frame as the run produces it, before the reader does, and
   * exactly one terminal `done` or `error` frame even when the reader has hung
   * up. A host persists a run here so the record does not depend on how fast,
   * or whether, anyone reads the stream. A throw while observing a frame fails
   * the run; a throw while observing the terminal frame replaces it with an
   * `error` frame carrying that message.
   */
  readonly observe?: ((frame: TurnFrame) => void) | undefined
}

/**
 * One turn request, as `POST /api/turn` carries it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const TurnRequest = Schema.Struct({ flow: Schema.String, payload: Schema.Unknown })

/**
 * One turn request, as `POST /api/turn` carries it.
 *
 * @category models
 * @since 1.0.0
 */
export type TurnRequest = typeof TurnRequest.Type

const encoder = new TextEncoder()

/** What the reader sees for a failure that is not a typed error. */
const failedMessage = "Something went wrong on our side. Not your fault."

/**
 * The message a turn's reader may see for `cause`.
 *
 * A typed error (a `_tag` and a `message`, as every `Schema.TaggedError` and
 * `Data.TaggedError` carries) was written to be read: a payload the flow's
 * schema rejects, a provider refusal, a seat with no key. Anything else is a
 * defect or a host callback's throw, whose text can name the deployment's own
 * configuration, so it is logged on the server (`Effect.logError`) and the reader gets
 * {@link failedMessage}.
 */
const publicMessage = (cause: unknown): string => {
  if (
    typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
    && "message" in cause && typeof cause.message === "string"
  ) {
    return cause.message
  }
  Effect.runSync(Effect.logError("@smthrs/create-app/worker: turn failed", cause))
  return failedMessage
}

/** The one `delta`, `cell`, or `call` frame an agent event projects to, if any. */
const frameOf = (
  event: AgentEvent.AgentEvent,
  state: { cells: number; readonly inputs: Map<string, unknown> }
): TurnFrame | undefined => {
  switch (event._tag) {
    case "model-delta":
      return event.delta.type === "text-delta" ? { type: "delta", text: event.delta.text } : undefined
    case "cell-produced":
      return { type: "cell", source: event.cell.text, ordinal: state.cells++ }
    case "cell-call-started":
      state.inputs.set(JSON.stringify(event.call.identity), event.call.input)
      return undefined
    case "cell-call-settled": {
      const key = JSON.stringify(event.identity)
      const input = state.inputs.get(key)
      state.inputs.delete(key)
      return {
        type: "call",
        flow: event.flowName,
        input,
        outcome: event.result.outcome,
        ...(event.result.message === undefined ? {} : { message: event.result.message })
      }
    }
    default:
      return undefined
  }
}

/**
 * Checks a turn can run and, when it can, returns the stream that runs it.
 *
 * Every refusal is decided before the stream opens: an unrouted or non-chat
 * flow, a seat with no credential, and a host with no judge. A payload the
 * flow's schema rejects fails the run, so it ends in an `error` frame. After that the stream always ends with one `done` or
 * `error` frame and closes once. Aborting `signal`, or the reader cancelling,
 * interrupts the run and ends it with an `error` frame.
 *
 * @category constructors
 * @since 1.0.0
 */
export const runTurn = (
  host: TurnHost,
  request: TurnRequest,
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array> | TurnRefusal> => {
  const route = resolveChatFlow(host.flows, request.flow)
  return "error" in route ? Promise.resolve(route) : execute(host, route, request.payload, signal)
}

/**
 * {@link runTurn} for a pipeline flow: the same checks, the same frames, the
 * same single terminal frame. A chat flow is refused with
 * `flow_not_pipeline`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const runFlow = (
  host: TurnHost,
  request: TurnRequest,
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array> | TurnRefusal> => {
  const route = resolvePipelineFlow(host.flows, request.flow)
  return "error" in route ? Promise.resolve(route) : execute(host, route, request.payload, signal)
}

/** Runs one resolved route; the shared body of {@link runTurn} and {@link runFlow}. */
const execute = async (
  host: TurnHost,
  route: TurnRoute,
  payload: unknown,
  signal: AbortSignal | undefined
): Promise<ReadableStream<Uint8Array> | TurnRefusal> => {
  const seats = host.seats ?? seatsFromEnv(host.env)
  const seat = await Effect.runPromise(Effect.result(seats.resolve(route.agent.seat)))
  if (seat._tag === "Failure") return { status: 503, error: "host_unconfigured", message: seat.failure.message }

  const lines: Array<TurnFrame> = []
  let push: ((frame: TurnFrame) => void) | undefined
  const send = (frame: TurnFrame): void => {
    host.observe?.(frame)
    if (push === undefined) lines.push(frame)
    else push(frame)
  }
  const cards: TurnCards = {
    emit: (card) => send({ type: "card", card }),
    update: (card) => send({ type: "card.update", card })
  }

  let hostLayer: ReturnType<typeof layerFor>
  try {
    hostLayer = layerFor({
      agent: route.agent,
      sandbox: route.sandbox,
      tools: host.tools === undefined ? route.tools : host.tools(route, cards),
      seats: { resolve: () => Effect.succeed(seat.success) },
      crypto: host.crypto ?? layerCryptoWeb,
      sandboxVariant: host.sandboxVariant,
      ...(host.evaluator === undefined ? {} : { evaluator: host.evaluator })
    })
  } catch (cause) {
    return { status: 503, error: "host_unconfigured", message: publicMessage(cause) }
  }

  const materialized = materializeFlow(route.id, route.spec, route.agent)
  const state = { cells: 0, inputs: new Map<string, unknown>() }
  const sink = EventSink.layer({
    emit: (event) =>
      Effect.sync(() => {
        const frame = frameOf(event, state)
        if (frame !== undefined) send(frame)
      })
  })
  const runtime = Layer.mergeAll(materialized.action.layer, Interpreter.layer(materialized.flow), sink).pipe(
    Layer.provideMerge(hostLayer)
  )
  // `materializeFlow` erases the payload and success types; `run` reads
  // `this.payloadSchema`, so it stays bound to its flow.
  const run = materialized.flow.execute.bind(materialized.flow) as (
    payload: unknown,
    options: { readonly executionId: string }
  ) => Effect.Effect<unknown, unknown>
  // The raw payload, not the decoded one: `run` decodes it itself, and a
  // transforming schema must not decode twice.
  const program = run(payload, { executionId: `turn/${route.id}/${crypto.randomUUID()}` }).pipe(
    Effect.provide(runtime as unknown as Layer.Layer<never>)
  )

  const aborted = new AbortController()
  const onAbort = (): void => aborted.abort()
  signal?.addEventListener("abort", onAbort, { once: true })

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (frame: TurnFrame): void => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`))
        } catch {
          // The reader is gone; the run is being interrupted.
        }
      }
      const finish = (frame: TurnFrame): void => {
        try {
          host.observe?.(frame)
        } catch (cause) {
          write({ type: "error", message: publicMessage(cause) })
          return
        }
        write(frame)
      }
      push = write
      for (const frame of lines.splice(0)) write(frame)
      try {
        if (signal?.aborted === true) aborted.abort()
        const output = await Effect.runPromise(program, { signal: aborted.signal })
        finish({ type: "done", output })
      } catch (cause) {
        finish({ type: "error", message: aborted.signal.aborted ? "The turn was cancelled." : publicMessage(cause) })
      } finally {
        signal?.removeEventListener("abort", onAbort)
        try {
          controller.close()
        } catch {
          // Already closed by the reader cancelling.
        }
      }
    },
    cancel() {
      aborted.abort()
    }
  })
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/**
 * A {@link TurnHost} served over HTTP.
 *
 * Every turn spends the host's model credentials, so the endpoint has no
 * anonymous default: `authorize` decides each request before its body is
 * read. `authorized` from `@smthrs/create-app/http` is the bearer-token check
 * the templates use. `maxBodyBytes` bounds the body and defaults to
 * `MAX_BODY_BYTES` from the same module.
 *
 * @category models
 * @since 1.0.0
 */
export interface TurnEndpoint extends TurnHost {
  readonly authorize: (request: Request) => boolean
  readonly maxBodyBytes?: number | undefined
}

/**
 * Serves one `POST /api/turn`: the NDJSON turn stream, or a typed JSON
 * refusal. The request's own signal cancels the run when the client hangs up.
 *
 * A request `authorize` refuses answers 401 before its body is read. The body
 * must be `application/json` (415) no larger than `maxBodyBytes` (413).
 *
 * @category constructors
 * @since 1.0.0
 */
export const turnResponse = async (request: Request, host: TurnEndpoint): Promise<Response> => {
  if (request.method !== "POST") {
    return json({ error: "invalid_request", message: "POST a { flow, payload } body" }, 405)
  }
  if (!host.authorize(request)) {
    return json({ error: "unauthorized", message: "This endpoint requires authorization." }, 401)
  }
  const read = await readJson(request, host.maxBodyBytes)
  if (!read.ok) {
    return json({ error: "invalid_request", message: read.message }, read.status)
  }
  const decoded = Schema.decodeUnknownExit(TurnRequest)(read.value)
  if (decoded._tag === "Failure") {
    return json({ error: "invalid_request", message: "Expected a { flow, payload } JSON body" }, 400)
  }
  const turn = await runTurn(host, decoded.value, request.signal)
  if (turn instanceof ReadableStream) {
    return new Response(turn, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } })
  }
  const { status, ...body } = turn
  return json(body, status)
}
