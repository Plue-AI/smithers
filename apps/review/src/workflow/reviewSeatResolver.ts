/**
 * Turning the review flow's four declared seats into live models.
 *
 * The flow declares logical seats (`review`, `review-verify`, `review-narrate`,
 * `review-quiz`) so a step identity does not move when the model behind it
 * changes. This module is where a logical seat becomes a `provider:model`
 * string, and then a credentialed route.
 *
 * It is also the only file in the app that reads a credential.
 *
 * @since 1.0.0
 */
import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike";
import * as Seat from "@smthrs/agent/Seat";
import * as SeatResolver from "@smthrs/agent/SeatResolver";
import * as Capability from "@smthrs/capability/Capability";
import * as Permission from "@smthrs/capability/Permission";
import * as GrantStore from "@smthrs/kernel/GrantStore";
import * as KernelHttpClient from "@smthrs/kernel/HttpClient";
import * as AnthropicMessages from "@smthrs/model/AnthropicMessages";
import * as Auth from "@smthrs/model/Auth";
import * as Endpoint from "@smthrs/model/Endpoint";
import * as Framing from "@smthrs/model/Framing";
import type * as ModelError from "@smthrs/model/ModelError";
import * as RequestExecutor from "@smthrs/model/RequestExecutor";
import * as Route from "@smthrs/model/Route";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { SEAT, type ReviewSeats } from "./reviewSeats.ts";

/**
 * The credential variable each provider reads. The action scrubs every one
 * before a hosted review.
 *
 * @since 1.0.0
 * @category constants
 */
export const SEAT_CREDENTIAL: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/**
 * Names the credential a seat needs when the environment does not carry it.
 *
 * The check is a courtesy, not the enforcement: an uncredentialed seat is
 * refused with `SeatUnresolved` either way. Doing it up front means a run that
 * cannot possibly reach a model says so before it shells out to git.
 *
 * @since 1.0.0
 * @category constructors
 */
export function missingSeatCredential(
  seat: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const separator = seat.indexOf(":");
  const provider = separator < 0 ? "anthropic" : seat.slice(0, separator);
  const variable = SEAT_CREDENTIAL[provider];
  if (variable === undefined) return `no route is configured for the ${provider} provider (seat "${seat}")`;
  const value = environment[variable];
  return value === undefined || value.trim() === "" ? `the "${seat}" seat needs ${variable}` : undefined;
}

/**
 * The provider origins this module can build a route to.
 *
 * `Route.anthropic` pins `api.anthropic.com`, `Route.openai` pins
 * `api.openai.com`, and the OpenRouter route pins `openrouter.ai`. A host that
 * is not one of these can only arrive through `ANTHROPIC_BASE_URL`, which
 * {@link modelCallHosts} adds separately.
 */
const PROVIDER_HOSTS: ReadonlyArray<string> = ["api.anthropic.com", "api.openai.com", "openrouter.ai"];

/**
 * Every origin resource a review's seats can reach, lowercased the way the
 * kernel spells it. HTTPS keeps the historical host-only form; every other
 * scheme keeps `protocol//` so an HTTP grant cannot authorize HTTPS or vice
 * versa.
 *
 * @since 1.0.0
 * @category constructors
 */
export function modelCallHosts(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyArray<string> {
  const hosts = new Set(PROVIDER_HOSTS);
  const baseUrl = environment.ANTHROPIC_BASE_URL?.trim();
  if (baseUrl !== undefined && baseUrl !== "") {
    try {
      const url = new URL(baseUrl);
      const host = url.host.toLowerCase();
      hosts.add(url.protocol === "https:" ? host : `${url.protocol}//${host}`);
    } catch {
      // An unparseable base URL is the route builder's failure to report, with
      // a message naming the value. Granting nothing for it keeps this set
      // honest rather than widening it to cover a string nobody can dial.
    }
  }
  return [...hosts];
}

/**
 * The capability patterns a review run needs, one per reachable provider host.
 *
 * The kernel asks `model:call` on `<host>/<model id>` for every model request
 * (`@smthrs/kernel/HttpClient`), so a composition that declares none of these
 * cannot make a single call: the first request parks on a permission and an
 * unattended run has nobody to grant it. The pattern is per host rather than
 * `*` so a compromised seat string cannot dial an arbitrary origin, and the
 * model id stays a wildcard because the seat names it.
 *
 * @since 1.0.0
 * @category constructors
 */
export function modelCallEnvelope(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyArray<Capability.CapabilityPattern> {
  return modelCallHosts(environment).map(
    (host) => new Capability.CapabilityPattern({ action: "model:call", resource: `${host}/*` }),
  );
}

/**
 * {@link modelCallEnvelope} as host grant rules.
 *
 * These go to the durable host's grant store, which is what actually answers
 * the kernel's check; the envelope is the matching claim the agent boundary
 * publishes.
 *
 * @since 1.0.0
 * @category constructors
 */
export function modelCallRules(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyArray<Permission.Rule> {
  return modelCallEnvelope(environment).map((pattern) => new Permission.Rule({ effect: "allow", pattern }));
}

/**
 * The real HTTP transport the routes run on.
 *
 * `FetchHttpClient` rather than undici: this app's bin runs under whichever
 * runtime the caller has, and the undici client's dispatcher teardown is not
 * available on every one of them. Fetch is, and a review makes ordinary
 * streaming POSTs that need nothing undici offers on top.
 */
const executorLayer = RequestExecutor.layer.pipe(
  Layer.provide(KernelHttpClient.layer),
  Layer.provide(GrantStore.layerNoop),
  Layer.provide(FetchHttpClient.layer),
);

/**
 * Anthropic's Messages surface at a caller-chosen origin.
 *
 * `Route.anthropic` pins `https://api.anthropic.com`, which is right for a
 * direct key and wrong for the metered proxy the GitHub Action runs behind: the
 * service mints a session-scoped key and points the run at its own origin.
 * `ANTHROPIC_BASE_URL` is the same variable 0.x used for that, so a caller's
 * configuration carries over unchanged.
 */
const anthropicAt = (baseUrl: string, apiKey: Redacted.Redacted<string>) =>
  Result.map(Endpoint.make({ url: baseUrl, path: "/v1/messages" }), (endpoint) =>
    Route.make({
      id: "anthropic",
      providerName: "anthropic",
      protocol: AnthropicMessages.protocol,
      endpoint,
      auth: Auth.apiKeyHeader("x-api-key", apiKey),
      framing: Framing.sse,
      headers: { "anthropic-version": "2023-06-01" },
    }));

const seatOf = <Body, Frame, Event, State>(
  configured: Result.Result<Route.Route<Body, Frame, Event, State>, ModelError.ModelError>,
  executor: RequestExecutor.RequestExecutor,
  seat: string,
  modelId: string,
): Effect.Effect<Seat.Seat, Seat.SeatUnresolved> =>
  Effect.gen(function* () {
    const routeConfig = yield* Effect.fromResult(configured).pipe(
      Effect.mapError((error) => new Seat.SeatUnresolved({ seat, message: error.message })),
    );
    const model = yield* Route.toModel(routeConfig).pipe(
      Effect.provideService(RequestExecutor.RequestExecutor, executor),
    );
    return Seat.make({
      id: seat,
      modelId,
      model,
      route: FlowEngineLike.routeResolver(routeConfig),
      contextWindowTokens: SeatResolver.contextWindowTokensFor(modelId),
    });
  });

/**
 * Builds the seat resolver for one review run.
 *
 * A seat with no separator is a bare model id on the Anthropic route, which is
 * the one provider convention this app assumes. `openrouter:` seats spell the
 * model as `openrouter:vendor/model` and route through the OpenAI-compatible
 * surface at OpenRouter's origin.
 *
 * @since 1.0.0
 * @category layers
 */
export function reviewSeatResolver(
  seats: ReviewSeats,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Layer.Layer<SeatResolver.SeatResolver> {
  const byName: Readonly<Record<string, string>> = {
    [SEAT.review]: seats.review,
    [SEAT.verify]: seats.verify,
    [SEAT.narrate]: seats.narrate,
    [SEAT.quiz]: seats.quiz,
  };
  return Layer.effect(SeatResolver.SeatResolver)(
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.RequestExecutor;
      return SeatResolver.make({
        resolve: (declared) =>
          Effect.suspend(() => {
            const seat = byName[declared] ?? declared;
            const separator = seat.indexOf(":");
            const provider = separator < 0 ? "anthropic" : seat.slice(0, separator);
            const modelId = Seat.modelIdOf(seat);
            const variable = SEAT_CREDENTIAL[provider];
            if (variable === undefined) {
              return Effect.fail(
                new Seat.SeatUnresolved({
                  seat,
                  message: `No route is configured for the ${provider} provider`,
                }),
              );
            }
            const key = environment[variable];
            if (key === undefined || key.trim() === "") {
              return Effect.fail(
                new Seat.SeatUnresolved({ seat, message: `Set ${variable} to run the ${seat} seat` }),
              );
            }
            const credential = Redacted.make(key);
            const anthropicBaseUrl = environment.ANTHROPIC_BASE_URL?.trim();
            return provider === "anthropic"
              ? seatOf(
                anthropicBaseUrl === undefined || anthropicBaseUrl === ""
                  ? Route.anthropic({ apiKey: credential })
                  : anthropicAt(anthropicBaseUrl, credential),
                executor,
                seat,
                modelId,
              )
              : provider === "openrouter"
              ? seatOf(
                Route.openaiResponsesCompatible({
                  id: "openrouter",
                  providerName: "openrouter",
                  baseUrl: "https://openrouter.ai/api",
                  apiKey: credential,
                }),
                executor,
                seat,
                modelId,
              )
              : seatOf(Route.openai({ apiKey: credential }), executor, seat, modelId);
          }),
      });
    }),
  ).pipe(Layer.provide(executorLayer));
}
