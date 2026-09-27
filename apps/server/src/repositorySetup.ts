import { REPOSITORY_SETUP_API } from "@smthrs/rpc/RepositorySetup"
import * as Effect from "effect/Effect"
import { ServerConfig } from "./Config"
import type { Transport } from "./Http"
import { forwardToCloud } from "./proxies"
import { methodNotAllowed, notFound } from "./Responses"
import { requireWorkflowSession } from "./workflows"

/** The backend reads at most 64,000 bytes of a setup draft. */
const SETUP_REQUEST_MAX_BYTES = 64_000

/**
 * `/api/repository-setup/{operation}`: the Smithers backend owns setup
 * requests, their durable admission, execution and recovery
 * (packages/backend internal/compose/repository_setup.go). The Worker checks
 * the session and forwards the request as that user, path and query intact.
 */
export const handleRepositorySetup = (request: Request): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed()
    const session = yield* requireWorkflowSession(request)
    if (session instanceof Response) return session
    const url = new URL(request.url)
    if (!new RegExp(`^${REPOSITORY_SETUP_API}/[a-z]{1,32}$`).test(url.pathname)) return notFound()
    const config = yield* ServerConfig
    return yield* forwardToCloud(request, session.login, {
      path: url.pathname + url.search,
      bodyLimit: SETUP_REQUEST_MAX_BYTES,
      deadlineMs: config.upstreamTimeoutMs
    })
  })
