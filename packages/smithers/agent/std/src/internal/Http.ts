/**
 * Shared HTTP response limits, error mapping, and request deadlines.
 *
 * @since 1.0.0
 */

import * as HttpClient from "@smthrs/kernel/HttpClient"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as StdError from "../StdError.ts"
import { MAX_OUTPUT_BYTES, notice, truncateBytes } from "./Text.ts"
import { parseHttpUrl } from "./Url.ts"

/**
 * Maximum captured response bytes before decoding.
 *
 * @category http
 * @since 1.0.0
 */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

interface BodyState {
  readonly chunks: Array<Uint8Array>
  size: number
}

/**
 * Reads a response up to the shared byte limit and finalizes the stream on failure.
 *
 * @category http
 * @since 1.0.0
 */
export const readBounded = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  url: string
): Effect.Effect<Uint8Array, E | StdError.StdError, R> =>
  Stream.runFoldEffect(
    stream,
    (): BodyState => ({ chunks: [], size: 0 }),
    (state, chunk) => {
      const size = state.size + chunk.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        return Effect.fail(
          new StdError.StdError({
            code: "response_too_large",
            message: "Response exceeds the 5 MiB limit",
            path: url
          })
        )
      }
      state.chunks.push(chunk)
      state.size = size
      return Effect.succeed(state)
    }
  ).pipe(
    Effect.map((state) => {
      const output = new Uint8Array(state.size)
      let offset = 0
      for (const chunk of state.chunks) {
        output.set(chunk, offset)
        offset += chunk.byteLength
      }
      return output
    })
  )

/**
 * Maps transport failures while preserving standard HTTP failure codes.
 *
 * @category http
 * @since 1.0.0
 */
export const requestError = (url: string, error: unknown): StdError.StdError =>
  error instanceof StdError.StdError ? error : new StdError.StdError({
    code: "request_failed",
    message: `Request failed: ${url}${error instanceof Error ? ` (${error.message})` : ""}`
  })

/**
 * Looks up a response header without depending on transport normalization.
 *
 * @category http
 * @since 1.0.0
 */
export const header = (headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined => {
  const lower = name.toLowerCase()
  return Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1]
}

/**
 * Seconds; the runtime caps valid overrides at 120.
 *
 * @category http
 * @since 1.0.0
 */
export const Timeout = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))

/**
 * Bounds the entire request and body read with one timer. Interruption reaches
 * HttpClient.execute and response.stream so Effect aborts the transport and
 * finalizes the body reader before returning the timeout failure.
 *
 * @category http
 * @since 1.0.0
 */
export const withDeadline = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  url: string,
  timeout = 30
): Effect.Effect<A, E | StdError.StdError, R> => {
  if (!Schema.is(Timeout)(timeout)) {
    return Effect.fail(
      new StdError.StdError({
        code: "invalid_input",
        message: "Timeout must be a finite number greater than zero seconds",
        path: url
      })
    )
  }
  const seconds = Math.min(timeout, 120)
  return Effect.timeoutOrElse(effect, {
    duration: seconds * 1_000,
    orElse: () =>
      Effect.fail(
        new StdError.StdError({
          code: "timeout",
          message: `Request timed out after ${seconds} seconds`,
          path: url
        })
      )
  })
}

/**
 * Keeps the head of rendered response text within the shared output budget and
 * discloses the cut.
 *
 * @since 1.0.0
 * @private
 */
export const capOutput = (
  text: string
): { readonly text: string; readonly truncated: boolean; readonly notice?: string } => {
  const rendered = truncateBytes(text, MAX_OUTPUT_BYTES, { keep: "head" })
  return {
    text: rendered.text,
    truncated: rendered.truncated,
    ...(rendered.truncated
      ? { notice: notice("bytes", rendered.keptBytes, rendered.keptBytes + rendered.droppedBytes) }
      : {})
  }
}

/** Shared response contract for the GET and POST tools.
 * @since 1.0.0
 * @private
 */
export const Response = Schema.Struct({
  status: Schema.Number.annotate({ description: "HTTP status code, including error statuses" }),
  body: Schema.String.annotate({ description: "Response body as text" }),
  truncated: Schema.Boolean.annotate({ description: "Whether the body exceeded the display budget" }),
  notice: Schema.optional(Schema.String.annotate({ description: "Truncation disclosure" }))
})

/** Validate, execute, and render one bounded HTTP request.
 * @since 1.0.0
 * @private
 */
export const execute = Effect.fn("Http.execute")(function*(
  input: {
    readonly url: string
    readonly headers?: Readonly<Record<string, string>> | undefined
    readonly timeout?: number | undefined
  },
  makeRequest: (url: string) => HttpClientRequest.HttpClientRequest
): Effect.fn.Return<typeof Response.Type, StdError.StdError, HttpClient.HttpClient> {
  const url = parseHttpUrl(input.url)
  if (url === undefined) {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "invalid_input",
        message: `URL must use http or https without user information: ${input.url}`,
        path: input.url
      })
    )
  }
  const client = yield* HttpClient.HttpClient
  const request = makeRequest(url.toString())
  const { status, bytes } = yield* withDeadline(
    Effect.gen(function*() {
      const response = yield* client.execute(
        input.headers === undefined ? request : HttpClientRequest.setHeaders(request, input.headers)
      )
      const bytes = yield* readBounded(response.stream, input.url)
      return { status: response.status, bytes }
    }).pipe(Effect.mapError((error) => requestError(input.url, error))),
    input.url,
    input.timeout
  )
  const { text, ...disclosure } = capOutput(new TextDecoder().decode(bytes))
  return { status, body: text, ...disclosure }
})
