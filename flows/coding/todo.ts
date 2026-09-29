/**
 * `factory/Todo`: the head of a TODO's lane. Jev routes the TODO once, and
 * code maps the answer onto the existing planner: every leaf plans through
 * `coding/Request`, which is the only implementer. The route only changes
 * what the planner is told.
 *
 * - implement: plan and implement the TODO as written.
 * - bug: reproduce first; the plan's first atom is a failing regression test.
 * - feature: lint it first; the planner declines an unclear request with
 *   at most three questions, and a maintainer re-applying `todo` after the
 *   author's edit is the acceptance.
 * - close: the TODO needs no code change; the planner declines with the
 *   evidence (the existing `declined` path), unless the source shows a change
 *   is needed after all.
 */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Classifier from "@smthrs/model/Classifier"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { CodingError, PlanningInput, Route } from "./schema.ts"

export { Route } from "./schema.ts"

/** One question: which leaf this TODO takes. */
export const todoRouter = Classifier.make("factory/route", {
  description: "Route one TODO, an issue a maintainer committed to, before it is planned.",
  state: Schema.Struct({
    todo: Schema.String.annotate({ description: "The TODO's approved title and body, as the planner reads it" })
  }),
  questions: {
    route: Classifier.choice({
      instructions: "What does this TODO need first?",
      criteria: {
        implement: "a new behavior or change to build as written",
        bug: "existing behavior is wrong: it must be reproduced by a failing test before it is fixed",
        feature: "a new capability someone asked for, which must first be clear, valid and worth building",
        close: "no code change: it is already done, only a question, a duplicate, or invalid"
      }
    })
  }
})

/** Asks Jev the route. Low confidence is Jev deciding; an unanswered route fails the lane. */
export const RouteTodo = Action.make("factory/route-todo", {
  payload: { prompt: PlanningInput.fields.prompt },
  success: Schema.Struct({ route: Route, confidence: Schema.Number }),
  error: CodingError,
  nondeterministic: true
})

/**
 * Fails with a TODO's failure stamped with its route, so a declined TODO still
 * says how it was routed. (A `Node.fail` of the stamped value is refused: the
 * engine will not settle an inert failure against the flow's CodingError.)
 */
export const StampRoute = Action.make("factory/stamp-route", {
  payload: { error: CodingError, route: Route },
  success: Schema.Never,
  error: CodingError
})

/** What each leaf tells the planner, after any feedback already given. */
export const leafFeedback = (route: Route, feedback: string): string => {
  const instruction = {
    implement: "",
    bug:
      "Jev routed this TODO as a bug. Reproduce it first: the plan's first atom adds a regression test that fails on the current source for the reported reason, and the fix follows it.",
    feature:
      "Jev routed this TODO as a feature request. Lint it before planning: it must say how the product behaves now, the assumptions, and the measurable behavior wanted, each checkable. If it is not clear, valid and worth building, decline it with at most three questions for its author; the author edits the issue and a maintainer re-applying todo accepts it. Otherwise plan it.",
    close:
      "Jev routed this TODO as needing no code change. Decline it with the evidence from the source (already done, only a question, a duplicate, or invalid). Plan a change only if the source shows one is needed, and say why."
  }[route]
  return [feedback, instruction].filter((part) => part.trim() !== "").join("\n\n")
}

/** Routes a TODO and answers the feedback its leaf plans with. */
export const Todo = Flow.make("factory/Todo", {
  payload: Schema.Struct({ prompt: PlanningInput.fields.prompt, feedback: Schema.String }),
  success: Schema.Struct({ route: Route, feedback: Schema.String }),
  error: CodingError,
  body: ({ prompt, feedback }) =>
    RouteTodo.call({ prompt }).pipe(
      Node.map(({ route }) => ({ route, feedback: leafFeedback(route, feedback) }))
    )
})

/** The most bytes of TODO text Jev reads; it keeps the route request small. */
export const MAX_TODO_BYTES = 32 * 1024
const encoder = new TextEncoder()
/** The TODO text clipped to {@link MAX_TODO_BYTES} on a code point boundary. */
export const clipTodo = (text: string): string => {
  let clipped = text
  while (encoder.encode(clipped).length > MAX_TODO_BYTES) clipped = [...clipped].slice(0, -1024).join("")
  return clipped
}

/** Jev's answer, or a typed failure naming why Jev did not answer. */
export const routeTodo = ({ prompt }: { readonly prompt: string }) =>
  todoRouter.evaluate({ todo: clipTodo(prompt) }).pipe(
    Effect.map(({ route }) => ({ route: route.value, confidence: route.confidence })),
    Effect.mapError((error) =>
      new CodingError({ code: "unavailable", message: `Jev did not route the TODO: ${error.message}` })
    )
  )

/** Register `factory/Todo` with the host's Jev. */
export const todoLayers = (evaluator: Layer.Layer<Evaluator.Evaluator>) =>
  Layer.mergeAll(
    Interpreter.layer(Todo),
    RouteTodo.toLayer((payload) => routeTodo(payload).pipe(Effect.provide(evaluator))),
    StampRoute.toLayer(({ error, route }) =>
      Effect.fail(new CodingError({ code: error.code, message: error.message, route }))
    )
  )
