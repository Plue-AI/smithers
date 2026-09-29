import { WORKFLOW_PROVISION_PATH, WORKFLOW_RPC_PATH } from "@smthrs/rpc/AgentApiRoutes"
import * as Effect from "effect/Effect"
import { ServerConfig } from "./Config"
import type { Transport } from "./Http"
import { validateSession } from "./identity"
import type { ValidatedIdentity } from "./identity"
import { forwardToCloud } from "./proxies"
import { notConfigured, refuse } from "./Responses"

/*
 * "Make me a workflow": the browser drives /api/workflow/{provision,rpc}, and
 * the box's single coding host answers them on the Smithers backend
 * (packages/backend internal/compose/browser_flow.go). The Worker resolves the
 * caller's session and forwards the body unchanged as that user, with their
 * Smithers Cloud token as the bearer (`forwardToCloud`). The backend wakes a
 * sleeping box, validates the repository and box, relays the procedure, and
 * writes every answer; its status and body come back.
 */

/**
 * The most of one box answer the Worker reads. The body comes from the user's
 * own box, where a buggy flow or a prompt-injected agent can write without
 * end, and it is buffered in an isolate that serves other requests. 4 MiB
 * holds listings and snapshots. Past it the read stops and the rest is
 * cancelled.
 */
export const WORKFLOW_ANSWER_MAX_BYTES = 4 * 1024 * 1024

/**
 * How long the backend may take to answer one call. It writes its headers
 * only once the box's coding host has answered, and it allows a Plan or a Run
 * on a running host four minutes (`middleware.JSONTimeout(4 * time.Minute)`
 * in packages/backend internal/compose/main.go). Fifteen seconds past that
 * lets the backend's own timeout answer first, so the caller reads its
 * refusal rather than this Worker's.
 */
export const WORKFLOW_UPSTREAM_DEADLINE_MS = 255_000

/** The backend reads at most 1 MiB of a flow request body. */
const WORKFLOW_REQUEST_MAX_BYTES = 1024 * 1024

/**
 * The workflow seam spends the user's own workspace resources, so on any
 * deployment that HAS an identity seam it requires a validated, allowlisted
 * session — the same gate as a turn. Returns the validated identity or the
 * refusal response.
 */
export const requireWorkflowSession = (request: Request): Effect.Effect<ValidatedIdentity | Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    if (config.identityUpstreamUrl === undefined) {
      return notConfigured(
        "Flows",
        "IDENTITY_UPSTREAM_URL is unset. Flows run as the signed-in user, and no identity service can say who that is"
      )
    }
    const validation = yield* validateSession(request)
    if (validation.status === "unavailable") return validation.response
    if (validation.status === "invalid") {
      return refuse("sign_in_required", "Sign in to run workflows on your workspace.")
    }
    const session = validation.identity
    if (!session.allowlisted && !session.admitted) {
      return refuse("account_not_allowlisted", "This account is not in the closed-alpha allowlist yet.")
    }
    return session
  })

const forwardWorkflow = (request: Request, path: string): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function* () {
    const session = yield* requireWorkflowSession(request)
    if (session instanceof Response) return session
    return yield* forwardToCloud(request, session.login, {
      path,
      bodyLimit: WORKFLOW_REQUEST_MAX_BYTES,
      deadlineMs: WORKFLOW_UPSTREAM_DEADLINE_MS,
      answerMaxBytes: WORKFLOW_ANSWER_MAX_BYTES
    })
  })

/** Provision-or-resume one box: `{ repo, workspaceId }`, answered `ready` or `provisioning`. */
export const handleWorkflowProvision = (request: Request): Effect.Effect<Response, never, Transport | ServerConfig> =>
  forwardWorkflow(request, WORKFLOW_PROVISION_PATH)

/** One procedure on one box: `{ repo, workspaceId, procedure, payload }`. */
export const handleWorkflowRpc = (request: Request): Effect.Effect<Response, never, Transport | ServerConfig> =>
  forwardWorkflow(request, WORKFLOW_RPC_PATH)
