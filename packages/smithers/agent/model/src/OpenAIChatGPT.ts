/**
 * Route construction for OpenAI's ChatGPT-subscription Responses backend, the
 * deployment the codex CLI speaks. The wire protocol is
 * {@link OpenAIResponses.chatgptProtocol}: the same SSE stream as
 * api.openai.com with the request narrowed to the subscription surface.
 *
 * The credential is an OAuth access token plus a `chatgpt-account-id` header,
 * both rotating, so the route takes a composed {@link Auth.Auth} rather than a
 * redacted key: the host owns the token store and its refresh, and this module
 * owns everything deterministic — endpoint, protocol, and the static header
 * set the backend was confirmed against (2026-08-25).
 *
 * @since 0.1.0
 */

import * as Result from "effect/Result"
import type * as Auth from "./Auth.ts"
import * as Endpoint from "./Endpoint.ts"
import * as Framing from "./Framing.ts"
import * as OpenAIResponses from "./OpenAIResponses.ts"
import * as Route from "./Route.ts"

/**
 * The ChatGPT backend origin plus base path. The Responses call is served at
 * `{baseUrl}/codex/responses` — no `/v1` prefix, unlike api.openai.com.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const defaultBaseUrl = "https://chatgpt.com/backend-api"

/**
 * The client identity headers the backend was confirmed against. They are
 * deterministic route identity, safe in the sealed-step view; the bearer and
 * account id are not, and arrive through `Auth.sign` alone.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const clientHeaders: Readonly<Record<string, string>> = {
  accept: "text/event-stream",
  "openai-beta": "responses=experimental",
  originator: "codex_cli_rs",
  "user-agent": "codex_cli_rs/0.149.1"
}

/**
 * Builds the ChatGPT-subscription Responses route.
 *
 * ```ts
 * const chatgpt = OpenAIChatGPT.make({ auth: codexStore.auth({ modelId }) })
 * ```
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = (input: {
  readonly auth: Auth.Auth
  readonly baseUrl?: string | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
}) =>
  Result.map(
    Endpoint.make({ url: input.baseUrl ?? defaultBaseUrl, path: "/codex/responses" }),
    (endpoint) =>
      Route.make({
        id: "openai-chatgpt",
        providerName: "openai",
        protocol: OpenAIResponses.chatgptProtocol,
        endpoint,
        auth: input.auth,
        framing: Framing.sse,
        headers: { ...clientHeaders, ...input.headers }
      })
  )
