/**
 * The webhook alert sink: one POST per alert, keyed so the receiver can
 * dedupe on it.
 *
 * The transport rules live here rather than beside the policy, because which
 * endpoint is paged, over which scheme, carrying which credential is a
 * deployment's decision and the delays are not.
 *
 * @since 1.0.0
 */

import { Duration, Effect, Layer, Option } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { alertId } from "./AlertPolicy.ts"
import { AlertError, Sink } from "./AlertSink.ts"

/**
 * How long the webhook sink waits for an answer before it calls the page
 * refused.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultWebhookTimeout: Duration.Duration = Duration.seconds(10)

/**
 * The one check the webhook endpoint gets before an alert is ever built on
 * it.
 *
 * The url is operator config rather than runtime input, so there is no SSRF
 * vector to close here; the scheme bound is what keeps a credential the
 * deployment set in `headers` from being handed to a scheme that is not HTTP
 * at all. A `file:` or `javascript:` url is a config bug, and it fails the
 * composition the way an impossible policy rule does. The error names no
 * url: the value can carry basic-auth credentials, and an error is logged.
 */
const webhookUrl = (raw: string): Effect.Effect<string, AlertError> =>
  Effect.suspend(() => {
    const misconfigured = new AlertError({
      code: "sink_misconfigured",
      message: "Alert webhook url must be an absolute http: or https: URL"
    })
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      return Effect.fail(misconfigured)
    }
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? Effect.succeed(raw)
      : Effect.fail(misconfigured)
  })

/**
 * Runs a webhook request with redirect following switched off at the fetch
 * transport.
 *
 * The request carries whatever credential the deployment put in `headers`,
 * and a transport that follows a 3xx re-sends those headers to an origin the
 * deployment never named. Every other fetch default the composition set is
 * kept; only the redirect mode is forced. A 3xx therefore surfaces to the
 * status rule, which calls it `sink_rejected`: a redirecting pager endpoint
 * is a misconfiguration to fix, not an address to forward credentials to.
 */
const followingNoRedirects = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(
    Effect.serviceOption(FetchHttpClient.RequestInit),
    (init) =>
      Effect.provideService(effect, FetchHttpClient.RequestInit, {
        ...(Option.isSome(init) ? init.value : {}),
        redirect: "manual"
      })
  )

/**
 * A sink that POSTs each alert to one webhook.
 *
 * The body is the alert plus its {@link alertId}, and the same id is sent as
 * an `Idempotency-Key` header, because the package requires the receiver to
 * dedupe on it and a body without it cannot. The header is set after the
 * caller's headers, so it is the one this sink sends.
 *
 * The endpoint must be an absolute `http:` or `https:` URL, checked when the
 * layer is built, and the request is made with redirect following disabled:
 * the caller's headers can carry a credential, and a followed redirect would
 * re-send them to an origin the deployment never named. A 3xx answer is a
 * refusal like any other non-2xx, not a forwarding instruction. The sink owns
 * its Fetch transport; an externally supplied `HttpClient` is not used.
 * Each delivery has its own scope, which aborts the request and releases any
 * unread response body on completion, failure, timeout, or interruption.
 *
 * A non-2xx response is a failure, not a delivery, and an endpoint that never
 * answers is a failure after `timeout`. Paging is exactly the case where a
 * silently dropped request is worse than a retry, and a hung request is worse
 * than either: it is indistinguishable from silence, so it must not be
 * possible to wait on one forever.
 *
 * @param options the endpoint, any headers it needs, and how long to wait
 * @category layers
 * @since 0.1.0
 */
export const layerWebhook = (
  options: {
    readonly url: string
    readonly headers?: Readonly<Record<string, string>> | undefined
    readonly timeout?: Duration.Duration | undefined
  }
): Layer.Layer<Sink> =>
  Layer.effect(
    Sink,
    Effect.gen(function*() {
      const url = yield* Effect.orDie(webhookUrl(options.url))
      const client = HttpClient.withScope(yield* HttpClient.HttpClient)
      const timeout = options.timeout ?? defaultWebhookTimeout
      return {
        deliver: (alert) =>
          client.execute(
            HttpClientRequest.post(url).pipe(
              (request) =>
                options.headers === undefined ? request : HttpClientRequest.setHeaders(request, options.headers),
              HttpClientRequest.setHeader("Idempotency-Key", alertId(alert)),
              HttpClientRequest.bodyJsonUnsafe({ ...alert, alertId: alertId(alert) })
            )
          ).pipe(
            followingNoRedirects,
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300
                ? Effect.void
                : Effect.fail(
                  new AlertError({
                    code: "sink_rejected",
                    status: response.status,
                    message: `Alert webhook answered ${response.status}`
                  })
                )
            ),
            Effect.timeout(timeout),
            Effect.scoped,
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(
                new AlertError({
                  code: "sink_timeout",
                  message: `Alert webhook did not answer within ${Duration.toMillis(timeout)} ms`
                })
              )),
            // The transport error holds the request, and the request holds the
            // caller's headers. Only its reason tag crosses into the failure.
            Effect.catchTag("HttpClientError", (cause) =>
              Effect.fail(
                new AlertError({
                  code: "sink_unreachable",
                  reason: cause.reason._tag,
                  message: "Alert webhook could not be reached"
                })
              ))
          )
      }
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
