/**
 * The `webfetch` flow: an HTTP GET rendered as text, Markdown, or HTML.
 *
 * The handler fetches through the permission-checked `HttpClient`, follows at
 * most ten redirects, refuses a body over 5 MiB, and returns the final URL,
 * status, and content type beside the rendered body. The rendered body keeps
 * its first 60,000 bytes and reports any cut with `truncated` and `notice`.
 *
 * @since 1.0.0
 */

import * as Flow from "@smthrs/core/Flow"
import type { GrantStore } from "@smthrs/kernel/GrantStore"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { capability, envelope } from "./internal/Declaration.ts"
import { toMarkdown, toText } from "./internal/Html.ts"
import { capOutput, header, MAX_RESPONSE_BYTES, readBounded, Timeout, withDeadline } from "./internal/Http.ts"
import { guarded, refusal } from "./internal/HttpNetwork.ts"
import { parseHttpUrl } from "./internal/Url.ts"
import * as StdError from "./StdError.ts"

const maxRedirects = 10
/**
 * The registry name of the `webfetch` flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "webfetch"
/**
 * The one-line description the model sees for the `webfetch` flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description = "Fetch an HTTP URL and render its content as text, Markdown, or HTML."
/**
 * What the `webfetch` flow accepts.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  url: Schema.String.annotate({ description: "Absolute http or https URL to retrieve without user information" }),
  format: Schema.optional(Schema.Literals(["text", "markdown", "html"])).annotate({
    description: "Response rendering format; defaults to markdown"
  }),
  timeout: Schema.optional(Timeout).annotate({
    description: "Total timeout across requests, redirects, and response body in seconds, capped at 120"
  })
})
/**
 * Decoded input accepted by the `webfetch` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type
/**
 * What the `webfetch` flow returns.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  url: Schema.String.annotate({ description: "Final URL after redirects" }),
  status: Schema.Int.annotate({ description: "HTTP status code, including error statuses" }),
  contentType: Schema.String.annotate({ description: "Response Content-Type header, or an empty string when absent" }),
  content: Schema.String.annotate({ description: "Response body rendered in the requested format" }),
  truncated: Schema.Boolean.annotate({ description: "Whether the rendered body exceeded the display budget" }),
  notice: Schema.optional(Schema.String.annotate({ description: "Truncation disclosure" }))
})
/**
 * Decoded output returned by the `webfetch` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type
/**
 * The declared effect envelope of the `webfetch` flow, before any input is known.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({ tier: "sealed", mode: "expected", reads: [], writes: [] })
/**
 * Narrows {@link effects} to what this particular input actually touches.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (_input: typeof Input.Type) => effects
/**
 * The authority the `webfetch` flow requires.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("net:get", "*")]
/**
 * The `webfetch` flow declaration: schemas, capabilities, and effects, with the
 * implementation attached separately.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

const error = (code: StdError.Code, message: string, path?: string): StdError.StdError =>
  new StdError.StdError({ code, message, ...(path === undefined ? {} : { path }) })
/**
 * Runs the `webfetch` flow: fetches one HTTP URL and renders it as text.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("WebFetch.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, HttpClient.HttpClient | GrantStore> {
  let url = parseHttpUrl(input.url)
  if (url === undefined) {
    return yield* Effect.fail(
      error("invalid_input", "URL must use http or https without user information", input.url)
    )
  }
  const client = guarded(yield* HttpClient.HttpClient, false)
  let headers: Readonly<Record<string, string>> = {
    accept: input.format === "html" ? "text/html, text/plain;q=0.8" : "text/markdown, text/plain, text/html;q=0.8"
  }
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    const response = yield* client.execute(
      HttpClientRequest.setHeaders(HttpClientRequest.get(url.toString()), headers)
    ).pipe(
      Effect.mapError((cause) => refusal(cause) ?? error("request_failed", `Web fetch request failed: ${url}`))
    )
    const location = header(response.headers, "location")
    if (response.status >= 300 && response.status < 400 && location !== undefined) {
      const next = parseHttpUrl(location, url)
      if (next === undefined) {
        return yield* Effect.fail(
          error("invalid_input", "Redirect target must use http or https without user information", location)
        )
      }
      if (next.origin !== url.origin) {
        headers = Object.fromEntries(
          Object.entries(headers).filter(([key]) =>
            key.toLowerCase() !== "authorization" && key.toLowerCase() !== "cookie"
          )
        )
      }
      url = next
      continue
    }
    const contentType = header(response.headers, "content-type") ?? ""
    const normalizedContentType = contentType.toLowerCase()
    if (
      !normalizedContentType.startsWith("text/")
      && !normalizedContentType.includes("json")
      && !normalizedContentType.includes("xml")
    ) {
      return yield* Effect.fail(
        error("unsupported_content_type", `Unsupported content type: ${contentType || "unknown"}`)
      )
    }
    const length = Number(header(response.headers, "content-length"))
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      return yield* Effect.fail(error("response_too_large", "Response exceeds the 5 MiB limit"))
    }
    const body = yield* readBounded(response.stream, url.toString()).pipe(
      Effect.mapError((cause) =>
        cause instanceof StdError.StdError
          ? cause
          : error("request_failed", "Web fetch response could not be read")
      )
    )
    const raw = new TextDecoder().decode(body)
    const format = input.format ?? "markdown"
    const { text: content, ...disclosure } = capOutput(
      format === "html" || !normalizedContentType.includes("html")
        ? raw
        : format === "text"
        ? toText(raw)
        : toMarkdown(raw)
    )
    return { url: url.toString(), status: response.status, contentType, content, ...disclosure }
  }
  return yield* Effect.fail(error("request_failed", "Web fetch exceeded the redirect limit"))
}, (effect, input) =>
  // Keep the shared deadline outside the redirect loop and error mapping.
  withDeadline(effect, input.url, input.timeout, (seconds) =>
    error("timeout", `Web fetch timed out after ${seconds} seconds`)))
