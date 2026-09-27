/**
 * Validated collector endpoints for the OTLP exporters.
 *
 * The endpoint is the field an operator most often gets wrong, and a wrong one
 * is invisible: Effect's exporter absorbs export failure by design, so a layer
 * built against `""` or `"localhost:4318"` looks identical to a working one and
 * simply never delivers. Every builder therefore decodes its endpoint during
 * layer acquisition, the same posture `Resource` already takes.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Largest collector endpoint accepted by a builder.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumEndpointLength = 2_048

/** The largest code unit the WHATWG URL parser repairs away: the space. */
const largestRepairedCodeUnit = 0x20

/**
 * Reports whether the URL parser would repair the value rather than parse it
 * as written. It strips leading and trailing C0 controls and spaces and
 * removes tab, newline, and carriage return from anywhere in its input, and
 * every one of those sits at or below {@link largestRepairedCodeUnit}.
 */
const repairedByUrlParser = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) <= largestRepairedCodeUnit) return true
  }
  return false
}

const isAbsoluteHttpUrl = (value: string): boolean => {
  // `new URL` alone is not a validator here. It strips padding and inline
  // control characters before parsing, so it reports a copy-pasted
  // `"http://collector:4318\n"` as well formed while the untrimmed original is
  // what a builder would hand its exporter: either an unusable URL or a
  // request to a host nobody typed. No legal collector endpoint carries one of
  // these, so refusing them costs nothing and closes the silent case.
  if (repairedByUrlParser(value)) return false
  // Exporters append /v1/<signal> to this base. A query or fragment would
  // swallow that suffix instead of changing the request path. Also refuse
  // missing authority separators and backslashes that WHATWG silently repairs.
  if (!/^https?:\/\/[^/]/i.test(value) || /[?#\\]/.test(value)) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.username === "" && url.password === ""
}

/**
 * Runtime schema for an absolute `http:` or `https:` collector endpoint that
 * carries no credentials, query, fragment, backslashes, spaces, or controls.
 * A base path is allowed; authentication belongs in exporter headers.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Endpoint = Schema.String.check(
  Schema.isMaxLength(maximumEndpointLength),
  Schema.makeFilter((value: string) => isAbsoluteHttpUrl(value), { title: "absoluteCollectorEndpoint" })
)

/**
 * Stable exporter-endpoint refusal shared by every OTLP builder.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class InvalidExporterEndpoint extends Schema.TaggedError<InvalidExporterEndpoint>()(
  "@smthrs/observability/InvalidExporterEndpoint",
  {
    code: Schema.Literal("invalid_exporter_endpoint"),
    path: Schema.String,
    message: Schema.String
  }
) {}

/**
 * Removes the repeated trailing separators that would otherwise produce a
 * double slash in a signal URL.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const normalize = (endpoint: string): string => endpoint.replace(/\/+$/, "")

/**
 * Decodes one collector endpoint into its normalized form without retaining
 * the rejected value.
 *
 * `path` names the option the endpoint arrived on, so the refusal points at the
 * caller's own field rather than at a shared internal name.
 *
 * @category decoding
 * @since 1.0.0-rc.0
 */
export const decode = (
  endpoint: unknown,
  path: string
): Effect.Effect<string, InvalidExporterEndpoint> =>
  Schema.decodeUnknownEffect(Endpoint)(endpoint).pipe(
    Effect.map(normalize),
    Effect.mapError(() =>
      new InvalidExporterEndpoint({
        code: "invalid_exporter_endpoint",
        path,
        message:
          `OTLP collector ${path} must be an absolute http:// or https:// base URL without credentials, query, fragment, backslashes, spaces, or control characters`
      })
    )
  )

/**
 * Builds the OTLP/HTTP URL one signal is posted to below a decoded endpoint.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const signalUrl = (endpoint: string, signal: "traces" | "metrics" | "logs"): string =>
  `${normalize(endpoint)}/v1/${signal}`
