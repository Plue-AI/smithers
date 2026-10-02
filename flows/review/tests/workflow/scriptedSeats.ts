import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike";
import * as Seat from "@smthrs/agent/Seat";
import * as SeatResolver from "@smthrs/agent/SeatResolver";
import * as Model from "@smthrs/model/Model";
import * as ModelError from "@smthrs/model/ModelError";
import * as ModelEvent from "@smthrs/model/ModelEvent";
import type * as Route from "@smthrs/model/Route";
import { Effect, Layer, Stream } from "effect";

const prepared: Route.PreparedRequest = {
  routeId: "review-tests",
  protocolId: "review-tests",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}",
};

/** What the scripted model was asked, flattened into one searchable string. */
export type Ask = string;

/**
 * How a scripted seat answers: a value, or a promise of one.
 *
 * A promise is what lets a test observe concurrency. A synchronous answer
 * settles inside the same tick the call was made in, so every call looks
 * sequential no matter how wide the fan-out really is; a call held on a
 * promise is still in flight while its siblings start, which is the only way
 * to see a bound take effect.
 */
export type Answer = (ask: Ask, signal: AbortSignal) => unknown | Promise<unknown>;

/**
 * A model that answers each call with one fenced `cell` block carrying the
 * value `answer` returns for what it was asked.
 *
 * `answer` returning `undefined` makes the model refuse the way a provider
 * error does, which is how a test drives the caught-failure paths.
 */
export function scriptedModel(answer: Answer): Model.Model {
  return Model.make({
    stream: (request) =>
      Stream.unwrap(Effect.promise(async (signal) => {
        const ask = [
          ...request.system.map((part) => part.text),
          ...request.messages.flatMap((message) =>
            message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          ),
        ].join("\n");
        const value = await answer(ask, signal);
        if (value === undefined) {
          // A real refusal, not a bare Error: a `ModelFailure` is what the
          // agent boundary classifies, and failing with anything else dies as
          // an empty AnyOf instead of the caught failure a test is driving.
          return Stream.fail(
            // `invalid_request` rather than a retryable code: the boundary would spend
            // its whole transport ladder on a retryable refusal, and what these
            // tests drive is the caught failure, not the ladder.
            new ModelError.ModelError({ code: "invalid_request", message: "scripted model refused" }),
          );
        }
        const cell = `ctx.done(${JSON.stringify(value)})`;
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Usage({ inputTokens: 100, outputTokens: 20 }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" }),
        ]);
      })),
  });
}

/** Resolves every declared seat to one scripted model. */
export function scriptedSeats(answer: Answer): Layer.Layer<SeatResolver.SeatResolver> {
  const model = scriptedModel(answer);
  return SeatResolver.layer({
    resolve: (id) =>
      Effect.succeed(
        Seat.make({
          id,
          modelId: id,
          model,
          route: { prepare: () => Effect.succeed(prepared) } as FlowEngineLike.RouteResolver,
          contextWindowTokens: 200_000,
        }),
      ),
  });
}
