/**
 * HTTP POST flow declaration and portable handler.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { capability, envelope } from "./internal/Declaration.ts"
import { execute, Response, Timeout } from "./internal/Http.ts"

/**
 * Registry name for the http-post flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "http-post"

/**
 * Model-facing description of the http-post flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description =
  "Post a text body to an absolute URL and return the response; this is irreversible because the remote side may already have acted."

/**
 * Input schema for the http-post flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  url: Schema.String.annotate({ description: "Absolute http or https URL to post to" }),
  body: Schema.String.annotate({ description: "Request body sent verbatim" }),
  contentType: Schema.optional(Schema.String).annotate({
    description: "Request content type; defaults to application/json"
  }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Additional request headers"
  }),
  timeout: Schema.optional(Timeout).annotate({
    description: "Total request and response body timeout in seconds; defaults to 30, capped at 120"
  })
})

/**
 * Decoded input accepted by the `http-post` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * Output schema for the http-post flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Response

/**
 * Decoded output returned by the `http-post` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * Static effect envelope for the http-post flow.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({ tier: "irreversible", mode: "expected", reads: [], writes: [] })

/**
 * Narrows the http-post effect envelope for one decoded input.
 *
 * Network reach is expressed as a capability rather than a path envelope, so
 * a post has nothing left to narrow.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (_input: typeof Input.Type) => effects

/**
 * Capabilities required by the http-post flow.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("net:post", "*")]

/**
 * Declaration-only http-post flow.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = { name, description, input: Input, output: Output, capabilities, effects } as const

/**
 * Posts a body through the permission-aware kernel HTTP client.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("HttpPost.run")((input: Input) =>
  execute(input, (url) =>
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText(input.body, input.contentType ?? "application/json")
    ))
)
