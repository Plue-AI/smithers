/**
 * The live seat a recording run streams from: API providers over `fetch`,
 * or a subscription through the vendor's signed-in Codex CLI.
 *
 * This is the credentialed half of `seatsFromEnv` in
 * `@smthrs/create-app/worker` with the Worker's env binding replaced by
 * `process.env` and the `Seat` wrapper dropped, because `cachedModelTest`'s
 * `live` option asks for a bare `Model.Model` and builds the seat itself. It
 * also runs the local Codex subscription seat, which a Worker never has.
 *
 * Two providers are credentialed here because the app has run on both. The
 * machine that records a fixture supplies one key, the seat in AGENT.ts names
 * the matching provider, and the other branch stays live for the machine that
 * has the other key.
 *
 * Nothing in this module runs during replay. `pnpm test` decodes the committed
 * fixture and serves it with `RecordedModel`, so it reads no key and opens no
 * socket. Only `SMTHRS_RECORD=1` reaches this file.
 */
import * as NodeControl from "@smthrs/cli/NodeControl"
import * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

/**
 * Provider request execution over `fetch`, the same transport the Worker uses.
 *
 * `RequestExecutor` depends on `@smthrs/kernel/HttpClient`, which re-exports
 * Effect's own tag, so the fetch layer satisfies it with no adapter.
 */
const executor: Layer.Layer<RequestExecutor.RequestExecutor> = RequestExecutor.layer.pipe(
  Layer.provide(FetchHttpClient.layer)
)

/** A route builder as `Route.anthropic` and `Route.openai` both shape it. */
type RouteFor = (
  input: { readonly apiKey: Redacted.Redacted<string> }
) => Result.Result<Parameters<typeof Route.toModel>[0], ModelError.ModelError>

/** One credentialed provider: where its key lives and how its route is built. */
interface Provider {
  /** The environment variable that holds the key. */
  readonly envVar: string
  readonly route: RouteFor
}

/** The ChatGPT-subscription model over the vendor's signed-in Codex CLI. */
const codexModel = (seat: string): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.unwrap(
        Effect.gen(function*() {
          const transport = yield* RequestExecutor.RequestExecutor
          const resolved = yield* NodeControl.seatResolver(process.env, transport).resolve(seat).pipe(
            Effect.mapError((error) => new ModelError.ModelError({ code: "authentication", message: error.message }))
          )
          return resolved.model.stream(request)
        }).pipe(Effect.provide(executor))
      )
  })

/**
 * The providers a recorded seat may name.
 *
 * A seat naming anything else fails by name rather than recording a fixture
 * against the wrong model.
 */
const providers: Record<string, Provider> = {
  anthropic: { envVar: "ANTHROPIC_API_KEY", route: Route.anthropic as RouteFor },
  openai: { envVar: "OPENAI_API_KEY", route: Route.openai as RouteFor }
}

/** The provider a bare seat resolves to, matching `seatsFromEnv`. */
const DEFAULT_PROVIDER = "anthropic"

/**
 * Reads a recording credential.
 *
 * A missing key fails here with the command that fixes it rather than at the
 * first provider response, where it would read as a model error.
 */
export const apiKeyFor = (envVar: string): string => {
  const key = process.env[envVar]
  if (key === undefined || key.length === 0) {
    throw new Error(
      `SMTHRS_RECORD=1 needs ${envVar} in the environment. Export it and re-run, or drop SMTHRS_RECORD to replay the committed fixture.`
    )
  }
  return key
}

/**
 * Builds the live model for a declared seat.
 *
 * The seat id is read for its provider half only. The model id travels on the
 * request (`Seat.modelIdOf` puts it there), so this function never has to know
 * which model the flow declared.
 */
export const liveModel = (seat: string): Model.Model => {
  const separator = seat.indexOf(":")
  const name = separator < 0 ? DEFAULT_PROVIDER : seat.slice(0, separator)
  // `SMITHERS_OPENAI_AUTH=chatgpt` swaps the openai provider's credential
  // source to vendor `codex exec`, exactly as the @smthrs/cli seat
  // resolver does.
  if (name === "codex" || (name === "openai" && process.env.SMITHERS_OPENAI_AUTH === "chatgpt")) {
    return codexModel(seat)
  }
  const provider = providers[name]
  if (provider === undefined) {
    throw new Error(
      `liveModel records ${Object.keys(providers).join(" and ")} seats only; "${seat}" names "${name}"`
    )
  }
  return Effect.runSync(
    Effect.fromResult(provider.route({ apiKey: Redacted.make(apiKeyFor(provider.envVar)) })).pipe(
      Effect.flatMap(Route.toModel),
      Effect.provide(executor),
      Effect.orDie
    )
  )
}
