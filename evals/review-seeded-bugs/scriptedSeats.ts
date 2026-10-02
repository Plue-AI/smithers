/**
 * A seat resolver that answers from a function instead of a provider.
 *
 * Copied deliberately rather than imported from `flows/review/tests`: an eval
 * that reaches into another package's test tree breaks the moment those tests
 * are reorganised, and this file is the eval's own harness.
 *
 * @since 1.0.0
 */
import type * as FlowEngineLike from "../../packages/smithers/agent/src/FlowEngineLike.ts";
import * as Seat from "../../packages/smithers/agent/src/Seat.ts";
import * as SeatResolver from "../../packages/smithers/agent/src/SeatResolver.ts";
import * as Model from "../../packages/smithers/agent/model/src/Model.ts";
import * as ModelError from "../../packages/smithers/agent/model/src/ModelError.ts";
import * as ModelEvent from "../../packages/smithers/agent/model/src/ModelEvent.ts";
import type * as Route from "../../packages/smithers/agent/model/src/Route.ts";
import { Effect, Layer, Stream } from "effect";

const SCRIPTED_MODEL_ID = "scripted-reviewer";

const prepared: Route.PreparedRequest = {
  routeId: "review-seeded-bugs",
  protocolId: "review-seeded-bugs",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}",
};

/** What the scripted model was asked, flattened into one searchable string. */
export type Ask = string;

/**
 * A model that answers each call with one fenced `cell` block carrying the
 * value `answer` returns for what it was asked.
 *
 * `answer` returning `undefined` makes the model refuse the way a provider
 * error does, which is how a test drives the caught-failure paths.
 */
export function scriptedModel(answer: (ask: Ask) => unknown): Model.Model {
  return Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        const ask = [
          ...request.system.map((part) => part.text),
          ...request.messages.flatMap((message) =>
            message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          ),
        ].join("\n");
        const value = answer(ask);
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
        // A backtick run in `value` would close the ```cell fence early, so each
        // backtick is written as its JSON escape; backticks only occur inside
        // JSON strings, where ``` decodes to the same character.
        const cell = `ctx.done(${JSON.stringify(value).replaceAll("`", "\\u0060")})`;
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" }),
        ]);
      }),
  });
}

/** Resolves every declared seat to one scripted model. */
export function scriptedSeats(answer: (ask: Ask) => unknown): Layer.Layer<SeatResolver.SeatResolver> {
  const model = scriptedModel(answer);
  return SeatResolver.layer({
    resolve: (id) =>
      Effect.succeed(
        Seat.make({
          id,
          modelId: SCRIPTED_MODEL_ID,
          model,
          route: { prepare: () => Effect.succeed(prepared) } as FlowEngineLike.RouteResolver,
          contextWindowTokens: 200_000,
        }),
      ),
  });
}
