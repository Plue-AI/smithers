import { isGatewayWorkspaceId } from "@smthrs/rpc/GatewayWorkspace"
import { Effect, Result } from "effect"
import type { ServerResponse } from "node:http"
import { isRelayRepoName } from "smithers-server/cloudToken"
import { discardBody, fetchWithDeadline, readBoundedText, transportLayer } from "smithers-server/Http"
import { json, readBody, refuse, upstreamUnreachable } from "smithers-server/Responses"
import { decodeGatewayResponse, encodeGatewayRequest, GATEWAY_PROCEDURE_MOUNTS } from "./gatewayFrames"

/*
 * The local stand-in for `POST /api/workflow/rpc`, which the box's coding host
 * on the Smithers backend serves in production: the same request envelope,
 * the same answer shape and the same Worker refusals, relayed to a loopback
 * gateway with a bearer this process holds.
 */

/** The most of one gateway answer the relay reads, as the Worker bounds a box answer. */
const ANSWER_MAX_BYTES = 4 * 1024 * 1024

const relayCall = (body: unknown) => {
  const candidate = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined
  const repo = typeof candidate?.repo === "string" && isRelayRepoName(candidate.repo) ? candidate.repo : undefined
  const procedure = typeof candidate?.procedure === "string" ? candidate.procedure : ""
  if (repo === undefined || procedure === "") {
    return refuse("request_invalid", "Body must be { repo, procedure, payload? }.")
  }
  if (!isGatewayWorkspaceId(candidate?.workspaceId)) {
    return refuse("request_invalid", "Body must name a box: workspaceId.")
  }
  const mount = Object.hasOwn(GATEWAY_PROCEDURE_MOUNTS, procedure) ? GATEWAY_PROCEDURE_MOUNTS[procedure] : undefined
  if (mount === undefined) {
    return refuse("procedure_not_relayed", `The flow seam does not relay ${procedure}.`)
  }
  return { procedure, mount, text: encodeGatewayRequest(procedure, candidate?.payload) }
}

const relayResponse = (response: Response): Effect.Effect<Response> => Effect.gen(function* () {
  if (response.status !== 200) {
    yield* discardBody(response)
    return json(200, { ok: false, error: { message: `The workspace answered HTTP ${response.status}.` } })
  }
  const read = yield* Effect.result(readBoundedText(response, ANSWER_MAX_BYTES))
  if (Result.isFailure(read)) {
    return read.failure._tag === "BodyTooLarge"
      ? refuse("upstream_malformed", "The workspace answer is larger than 4 MiB.")
      : refuse("upstream_unreachable", "The workspace answer broke off before it ended.")
  }
  return json(200, decodeGatewayResponse(read.success))
})

/** Only authentication and gateway discovery differ from the deployed route. */
export const relayRpc = (request: Request, gatewayUrl: string, credential: string, forwarded?: (procedure: string) => void): Promise<Response> =>
  Effect.runPromise(Effect.gen(function* () {
    const body = yield* readBody(request)
    if (body instanceof Response) return body
    const call = relayCall(body)
    if (call instanceof Response) return call
    forwarded?.(call.procedure)
    const response = yield* fetchWithDeadline("workspace", `${gatewayUrl}${call.mount}`, {
      method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: call.text
    }, 30_000)
    return yield* relayResponse(response)
  }).pipe(Effect.catch(failure => Effect.succeed(upstreamUnreachable("The workspace", failure))), Effect.provide(transportLayer(fetch))))

export const writeResponse = async (response: Response, target: ServerResponse): Promise<void> => {
  target.writeHead(response.status, Object.fromEntries(response.headers))
  target.end(Buffer.from(await response.arrayBuffer()))
}
