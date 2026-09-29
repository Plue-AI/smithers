/**
 * The app's API: a switch over `Routes` from `src/api.ts`, which is the one
 * place the browser and the Worker agree on a path.
 *
 * Everything the switch does not claim falls through to the assets binding, so
 * a deep link into the SPA is served by the static bucket and not by a handler
 * that has to know about it. `run_worker_first` in `wrangler.jsonc` is scoped
 * to `/api/*` for the same reason: no asset request wakes this code.
 *
 * Session state lives in one Durable Object per `sessionId`. The turn route
 * forwards to it and streams the object's own NDJSON body straight back, so
 * frames reach the browser as the agent writes them.
 *
 * This module is deliberately separate from `index.ts`: `index.ts` exports the
 * Durable Object class and therefore imports `cloudflare:workers`, which only
 * workerd resolves. Keeping the routing here lets `test/worker.test.ts` call
 * {@link handle} with stub bindings on plain Node.
 *
 * ## What bounds a deployed instance
 *
 * `CreateApp` ships `deploy` as a first-class target with a custom domain, so
 * read this before you point one at it. Request checks run ahead of the routes;
 * `@smthrs/create-app/http` owns the credential, media-type, and size checks;
 * `worker/guard.ts` owns origin and session-id shape:
 *
 * - **Credential.** `APP_API_TOKEN` is a Worker secret. Every `/api/*` path
 *   but `GET /api/health` requires its bearer header. Missing or empty tokens
 *   refuse requests unless local development opts in with `APP_API_OPEN=1`.
 *   Health does not disclose authentication configuration.
 * - **Browser origin.** Present Origin and Sec-Fetch-Site headers must identify
 *   the same origin, including in local open mode.
 * - **Media type.** JSON routes require `Content-Type: application/json`.
 * - **Size.** Every JSON body is read through a 64 KiB cap and answers 413 past
 *   it, whether or not the request declared a `content-length`.
 * - **Identity.** A session id is a flat identifier of at most 128 characters,
 *   and never the registry object's own name, so a caller can neither address
 *   `INDEX_SESSION` as a session nor name an object with arbitrary text.
 *
 * What is still unbounded: per-session Durable Object storage, model spend, and
 * request rate. One shared token is one tenant, not tenancy: a holder of the
 * token reaches every session. `worker/README.md` says the same in its Security
 * section.
 */
import { authorized, readJson } from "@smthrs/create-app/http"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  CancelRequest,
  FlowRunRequest,
  Routes,
  type FlowSummary,
  TurnRequest
} from "../src/api.ts"
import type { Env } from "./env.ts"
import { isSessionId, sameOrigin } from "./guard.ts"
import { indexSession, sessionOf } from "./registry.ts"

/** The build this Worker was cut from. Vite replaces it; dev leaves the default. */
declare const __APP_BUILD__: string | undefined

const build = (): string => (typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "dev")

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } })

const fail = (status: number, message: string): Response => json({ error: message }, status)

const decodeTurn = Schema.decodeUnknownOption(TurnRequest)
const decodeCancel = Schema.decodeUnknownOption(CancelRequest)
const decodeFlowRun = Schema.decodeUnknownOption(FlowRunRequest)

/**
 * The refusal a caller-supplied session id gets when it cannot name an object.
 *
 * The value is echoed so a caller can see what was rejected, and truncated
 * because a body is capped at 64 KiB rather than at an id's length: reflecting
 * the whole of it would turn a refusal into an amplifier.
 */
const badSessionId = (value: string): Response =>
  fail(
    400,
    `"${value.slice(0, 64)}" is not a usable session id. A session id is a flat identifier of at most 128 characters.`
  )

/** The flows the router found on disk, in the shape `GET /api/flows` answers. */
// Loaded lazily: routes.gen.ts pulls in the agent runtime, and Workers
// reject module-scope I/O at upload time (@smthrs/core seeds a nonce at load).
const fileFlows = async (): Promise<Array<FlowSummary>> => {
  const { flows } = await import("../routes.gen.ts")
  return flows.map((flow) => ({
    id: flow.id,
    description: flow.spec.description,
    source: "file" as const,
    chat: flow.spec.chat ?? false
  }))
}

/**
 * Why this flow cannot run through `route`, or `undefined` when it can.
 *
 * A chat flow runs only as a turn and a pipeline flow only as a flow run.
 * The check is here rather than only in the Durable Object because it needs
 * the routed flow list, and refusing before the object is woken keeps a typo
 * from creating a session. The run host repeats both halves
 * (`@smthrs/create-app/worker`), so a direct object call cannot bypass them.
 */
const flowRefusal = async (
  flowId: string,
  route: typeof Routes.turn | typeof Routes.flowRun
): Promise<string | undefined> => {
  const routed = (await fileFlows()).find((flow) => flow.id === flowId)
  if (routed === undefined) {
    return `No flow is routed as "${flowId}". A saved flow has no file to execute; only routed flows run.`
  }
  if (route === Routes.turn) {
    return routed.chat ? undefined : `"${flowId}" is not a chat flow. Run it through ${Routes.flowRun}.`
  }
  return routed.chat ? `"${flowId}" is a chat flow. Send it through ${Routes.turn}.` : undefined
}

export const handle = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url)
  const path = url.pathname

  if (path.startsWith("/api/") && !sameOrigin(request)) {
    return fail(403, "This API requires same-origin requests.")
  }

  // Health stays public without disclosing the credential configuration.
  if (path === Routes.health) {
    return json({
      ok: true,
      build: build(),
      app: env.APP_NAME
    })
  }

  // Every other API path, the 404 included: an unrouted path that answered
  // before the credential check would report which paths exist to a caller with
  // no credential at all.
  if (path.startsWith("/api/") && !authorized(request, env.APP_API_TOKEN, env.APP_API_OPEN)) {
    return fail(401, "This API requires `Authorization: Bearer <APP_API_TOKEN>`.")
  }

  if (path === Routes.turn) {
    if (request.method !== "POST") return fail(405, "POST only.")
    const read = await readJson(request)
    if (!read.ok) return fail(read.status, read.message)
    const decoded = decodeTurn(read.value)
    if (Option.isNone(decoded)) return fail(400, "Expected { sessionId, flowId, message }.")
    const turn = decoded.value
    if (!isSessionId(turn.sessionId)) return badSessionId(turn.sessionId)
    const refusal = await flowRefusal(turn.flowId, Routes.turn)
    if (refusal !== undefined) return fail(400, refusal)
    return sessionOf(env, turn.sessionId).turn(turn)
  }

  if (path === Routes.turnCancel) {
    if (request.method !== "POST") return fail(405, "POST only.")
    const read = await readJson(request)
    if (!read.ok) return fail(read.status, read.message)
    const decoded = decodeCancel(read.value)
    if (Option.isNone(decoded)) return fail(400, "Expected { sessionId }.")
    const { sessionId } = decoded.value
    if (!isSessionId(sessionId)) return badSessionId(sessionId)
    return json(await sessionOf(env, sessionId).cancel(sessionId))
  }

  if (path === Routes.session) {
    if (request.method !== "GET") return fail(405, "GET only.")
    const id = url.searchParams.get("id")
    // The list form. A Durable Object namespace cannot be enumerated, so the
    // Recent column is one read of the registry object every session writes to
    // on its first turn (worker/registry.ts).
    if (id === null || id === "") return json({ sessions: await indexSession(env).sessions() })
    if (!isSessionId(id)) return badSessionId(id)
    return json(await sessionOf(env, id).state(id))
  }

  if (path === Routes.flows) {
    if (request.method !== "GET") return fail(405, "GET only.")
    const id = url.searchParams.get("sessionId")
    // Saved flows belong to the session that wrote them, so a caller with no
    // session id gets the routed flows only.
    if (id !== null && id !== "" && !isSessionId(id)) return badSessionId(id)
    const saved = id === null || id === "" ? [] : await sessionOf(env, id).listFlows()
    return json({ flows: [...(await fileFlows()), ...saved] })
  }

  if (path === Routes.flowRun) {
    if (request.method !== "POST") return fail(405, "POST only.")
    const read = await readJson(request)
    if (!read.ok) return fail(read.status, read.message)
    const decoded = decodeFlowRun(read.value)
    if (Option.isNone(decoded)) return fail(400, "Expected { sessionId, flowId, payload }.")
    const run = decoded.value
    if (!isSessionId(run.sessionId)) return badSessionId(run.sessionId)
    const refusal = await flowRefusal(run.flowId, Routes.flowRun)
    if (refusal !== undefined) return fail(400, refusal)
    return sessionOf(env, run.sessionId).runFlow(run)
  }

  // An unrouted /api path is this Worker's own 404, not the SPA's: answering
  // it with index.html would hand a fetch caller HTML and a 200.
  if (path.startsWith("/api/")) return fail(404, `No route for ${path}.`)

  return env.ASSETS.fetch(request)
}
