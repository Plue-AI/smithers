import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type { WorkerFailureCode } from "@smthrs/rpc/WorkerFailureCodes"

/*
 * Where an Effect meets a Web callback. Exactly three callers exist: the
 * edge's `fetch(request, env)` entry (src/edge.ts), the native Durable Object
 * classes' `fetch(request)` (src/RetiredDurableObject.ts,
 * src/MaintenanceExport.ts), and test helpers.
 *
 * The request's AbortSignal interrupts the fiber: a client that disconnects
 * mid-request interrupts the upstream fetch and runs every finalizer instead
 * of leaving the work running. An interruption that reaches this boundary is
 * answered with 499, never restated as a 500. A defect (a bug, never a typed
 * failure) is logged and answered with a generic 500, so a route can never
 * leak a stack trace or hang the request (docs/worker-errors.md).
 */

/** The answer to a request whose caller went away before the response settled. */
export const CLIENT_DISCONNECTED_STATUS = 499

/** What a caller reads when a route failed in a way no contract names. */
export const UNEXPECTED_FAILURE_MESSAGE = "Smithers could not complete this request. Try again in a moment."

/*
 * The boundary's own answers carry the isolation headers the app document
 * carries (src/Responses.ts): the app document that made the
 * request is cross-origin isolated, and a 499 or 500 must not read as a
 * different origin's page.
 */
const answer = (status: number, code: WorkerFailureCode, message: string): Response =>
  new Response(JSON.stringify({ status: "error", code, message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    }
  })

const clientDisconnected = (): Response =>
  answer(CLIENT_DISCONNECTED_STATUS, "client_disconnected", "The client disconnected.")

/**
 * One request handler's outcome as the Response the caller gets. Success is
 * the route's own answer; an interruption is 499 and never restated as a 500;
 * anything else is a defect, logged once and answered generically.
 */
const responseFromExit = (exit: Exit.Exit<Response, never>): Response => {
  if (Exit.isSuccess(exit)) return exit.value
  if (Cause.hasInterruptsOnly(exit.cause)) return clientDisconnected()
  console.error("worker fetch failed:", Cause.squash(exit.cause))
  return answer(500, "unexpected_failure", UNEXPECTED_FAILURE_MESSAGE)
}

/**
 * Run a request handler to a `Response`. Typed failures must already be
 * mapped to responses (the handler's error channel is `never`).
 */
export const runRequest = (effect: Effect.Effect<Response, never>, signal?: AbortSignal): Promise<Response> => {
  if (signal?.aborted === true) return Promise.resolve(clientDisconnected())
  return Effect.runPromiseExit(effect, { signal }).then(responseFromExit)
}

/** Run an Effect with no failure channel to a Promise, for a Durable Object's own `fetch`. */
export const runDurable = <A>(effect: Effect.Effect<A, never>): Promise<A> => Effect.runPromise(effect)

