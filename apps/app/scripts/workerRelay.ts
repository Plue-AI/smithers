import { isGatewayWorkspaceId } from "@smthrs/rpc/GatewayWorkspace"
import type { ServerResponse } from "node:http"
import { json, refuse } from "../src/bun/routes"
import { decodeGatewayResponse, encodeGatewayRequest, GATEWAY_PROCEDURE_MOUNTS } from "./gatewayFrames"

/* Local proof relay for the backend's /api/workflow/rpc envelope. */
const REQUEST_MAX_BYTES = 1024 * 1024
const ANSWER_MAX_BYTES = 4 * 1024 * 1024

// Match browserFlowRepo in packages/backend/internal/compose/browser_flow.go.
const isRelayRepoName = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) &&
  value.split("/").every(segment => segment !== "." && segment !== "..")

class BodyTooLarge extends Error {
  constructor() { super("Body exceeds relay byte limit.") }
}

/** Bound memory even when the sender omits Content-Length or streams chunks. */
const readBoundedText = async (body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> => {
  if (body === null) return ""
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return text + decoder.decode()
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new BodyTooLarge()
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

const relayCall = (body: unknown) => {
  const candidate = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined
  const repo = isRelayRepoName(candidate?.repo) ? candidate.repo : undefined
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

/** Credentials and gateway discovery stay in this process, as on the backend. */
export const relayRpc = async (
  request: Request,
  gatewayUrl: string,
  credential: string,
  forwarded?: (procedure: string) => void,
  options: { readonly timeoutMs?: number } = {}
): Promise<Response> => {
  let body: unknown
  try {
    body = JSON.parse(await readBoundedText(request.body, REQUEST_MAX_BYTES))
  } catch (failure) {
    return failure instanceof BodyTooLarge
      ? refuse("request_body_too_large", "Request body is larger than 1 MiB.")
      : refuse("request_body_not_json", "Request body must be valid JSON.")
  }
  const call = relayCall(body)
  if (call instanceof Response) return call
  forwarded?.(call.procedure)
  const deadline = new AbortController()
  const timeout = setTimeout(() => deadline.abort(), options.timeoutMs ?? 30_000)
  let response: Response
  try {
    response = await fetch(`${gatewayUrl}${call.mount}`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: call.text,
      redirect: "manual",
      signal: AbortSignal.any([request.signal, deadline.signal])
    })
  } catch {
    return deadline.signal.aborted
      ? refuse("upstream_timeout", "The workspace did not answer before its deadline.")
      : refuse("upstream_unreachable", "The workspace could not be reached.")
  } finally {
    clearTimeout(timeout)
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {})
    return json({ ok: false, error: { message: `The workspace answered HTTP ${response.status}.` } })
  }
  try {
    return json(decodeGatewayResponse(await readBoundedText(response.body, ANSWER_MAX_BYTES)))
  } catch (failure) {
    return failure instanceof BodyTooLarge
      ? refuse("upstream_malformed", "The workspace answer is larger than 4 MiB.")
      : refuse("upstream_unreachable", "The workspace answer broke off before it ended.")
  }
}

export const writeResponse = async (response: Response, target: ServerResponse): Promise<void> => {
  target.writeHead(response.status, Object.fromEntries(response.headers))
  target.end(Buffer.from(await response.arrayBuffer()))
}
