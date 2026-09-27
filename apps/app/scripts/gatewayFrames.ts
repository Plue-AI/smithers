/*
 * The RPC framing the local relay speaks to a loopback gateway.
 *
 * In production the box's coding host on the Smithers backend
 * (packages/backend internal/compose/browser_flow.go) takes the product's
 * envelope — a repo, a box, a procedure name, and a payload — and answers
 * `{ ok, payload }` or `{ ok: false, error }`. The proof and e2e stacks stand
 * a `NodeGateway` in for the box, so this relay writes the gateway's
 * newline-delimited RPC frame for the same envelope and decodes its answer
 * into the same shape.
 *
 * Frame shapes, read off a live rc.0 gateway:
 *
 *   request  {"_tag":"Request","id":1,"tag":"List","payload":{…},"headers":[]}
 *   success  {"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":…}}
 *   failure  {"_tag":"Exit","requestId":1,"exit":{"_tag":"Failure","cause":[…]}}
 *
 * A failure `cause` is Effect's array of reasons — `{_tag:"Fail",error}`,
 * `{_tag:"Die",defect}`, `{_tag:"Interrupt",fiberId}` (`ExitEncoded` in
 * `effect/unstable/rpc/RpcMessage`) — and `gatewayFrames.test.ts` pins that shape
 * against the installed codec.
 */

/**
 * Where each relayed procedure is mounted on the gateway: the same procedure
 * set the backend relays (`browserFlowProcedures`).
 *
 * `Plan`, `Run`, `Cancel`, `Resume`, `Steer`, `Signal`, and `List` are
 * `@smthrs/control` `ControlRpcs` at `/rpc`. `Projection.Snapshot` and
 * `Approval.Submit` are `@smthrs/gateway` `GatewayRpcs` at `/projections`.
 *
 * `Approve` and `Deny` stay out — a decision crosses as the gateway's
 * `Approval.Submit` — and the streaming procedures (`Watch`,
 * `Projection.Subscribe`) belong on the gateway's WebSocket mounts.
 */
export const GATEWAY_PROCEDURE_MOUNTS: Readonly<Record<string, "/rpc" | "/projections">> = {
  Plan: "/rpc",
  Run: "/rpc",
  Cancel: "/rpc",
  Resume: "/rpc",
  Steer: "/rpc",
  Signal: "/rpc",
  List: "/rpc",
  "Projection.Snapshot": "/projections",
  "Approval.Submit": "/projections"
}

/** The gateway procedures the product relays. Nothing else crosses this seam. */
export const ALLOWED_GATEWAY_PROCEDURES: ReadonlyArray<string> = Object.keys(GATEWAY_PROCEDURE_MOUNTS)

/** Encodes one call as the gateway's newline-delimited request frame. */
export const encodeGatewayRequest = (procedure: string, payload: unknown): string =>
  `${JSON.stringify({ _tag: "Request", id: 1, tag: procedure, payload: payload ?? {}, headers: [] })}\n`

/** What the relay answers the browser: the gateway's own outcome, unwrapped. */
export type GatewayRpcFrame =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly error: { readonly message: string; readonly detail?: unknown } }

const failure = (message: string, detail?: unknown): GatewayRpcFrame => ({
  ok: false,
  error: detail === undefined ? { message } : { message, detail }
})

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const isTyped = (record: Record<string, unknown>): boolean =>
  typeof record.code === "string" || (typeof record._tag === "string" && record._tag.startsWith("/"))

/**
 * The typed error inside an encoded cause. Effect's RPC protocol encodes a
 * failure cause as an array of reasons, `[{ _tag: "Fail", error }]`
 * (`effect/unstable/rpc/RpcMessage` `ResponseExitDieEncoded` is the `Die`
 * twin), so the first `Fail` reason's error is the typed refusal. A bare
 * record is read too: the record itself when it carries a code or a
 * `/control/...` tag, else the `error` it wraps.
 */
const typedError = (cause: unknown): Record<string, unknown> => {
  if (Array.isArray(cause)) {
    const failed = cause.map(asRecord).find((reason) => reason._tag === "Fail")
    return failed === undefined ? {} : asRecord(failed.error)
  }
  const record = asRecord(cause)
  return isTyped(record) ? record : asRecord(record.error)
}

/**
 * The reason an encoded cause leads with when no `Fail` is in it.
 *
 * `ExitEncoded` also carries `{ _tag: "Die", defect }` for a workspace that
 * crashed and `{ _tag: "Interrupt", fiberId }` for one whose fiber was
 * cancelled. Neither is a refusal, and a client told "the workspace refused
 * the call" for all three cannot tell a bug from a cancellation from a
 * decision. A `Fail` still wins where one exists: it is the answer the
 * workspace chose to state.
 */
const untypedReason = (cause: unknown): Record<string, unknown> | undefined => {
  if (!Array.isArray(cause)) return undefined
  const reasons = cause.map(asRecord)
  if (reasons.some((reason) => reason._tag === "Fail")) return undefined
  return reasons.find((reason) => reason._tag === "Die" || reason._tag === "Interrupt")
}

/**
 * What a defect states. `Schema.Defect` encodes a thrown `Error` as its `name`
 * and `message` and any other defect as its JSON, so the message is read off
 * the record where there is one and the defect itself where it is a string.
 */
const defectMessage = (defect: unknown): string | undefined => {
  const message = typeof defect === "string" ? defect : asRecord(defect).message
  return typeof message === "string" && message !== "" ? message : undefined
}

/**
 * The first sentence of a gateway failure. Effect encodes a typed error as the
 * cause's payload, so the tag and message are read off it where they exist and
 * the whole cause is carried as the detail either way: a refusal the seam
 * cannot summarize is still a refusal the client can show.
 *
 * `FlowNotFound` (packages/smithers/control ControlError.ts) declares no
 * message, so its tag would be the sentence; it is the one refusal written
 * here in words, naming the flow the workspace lacks.
 */
const describeCause = (cause: unknown): string => {
  if (typeof cause !== "object" || cause === null) return "The workspace refused the call."
  const untyped = untypedReason(cause)
  if (untyped !== undefined) {
    if (untyped._tag === "Interrupt") return "The workspace cancelled the call."
    const defect = defectMessage(untyped.defect)
    return defect === undefined ? "The workspace crashed." : `The workspace crashed: ${defect}`
  }
  const typed = typedError(cause)
  if ((typed._tag === "/control/FlowNotFound" || typed.code === "flow_not_found") && typeof typed.flowId === "string") {
    return `No flow "${typed.flowId}" is registered on this workspace.`
  }
  const record = asRecord(cause)
  const message = record.message ?? asRecord(record.error).message ?? typed.message
  if (typeof message === "string" && message !== "") return message
  const tag = record._tag ?? record.code ?? typed._tag ?? typed.code
  return typeof tag === "string" && tag !== "" ? tag : "The workspace refused the call."
}

/**
 * Decodes the gateway's answer to one call.
 *
 * Total on purpose: a body that is not a frame at all becomes a refusal the
 * client can render, never a throw inside the relay's fetch handler.
 *
 * @param text the gateway's response body
 */
export const decodeGatewayResponse = (text: string): GatewayRpcFrame => {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "")
  if (line === undefined) return failure("The workspace answered with nothing.")
  let frame: unknown
  try {
    frame = JSON.parse(line)
  } catch {
    return failure("The workspace answered in a shape the seam did not understand.", line.slice(0, 200))
  }
  if (typeof frame !== "object" || frame === null) {
    return failure("The workspace answered in a shape the seam did not understand.")
  }
  const exit = (frame as { exit?: unknown }).exit
  if (typeof exit !== "object" || exit === null) {
    return failure("The workspace answered without an outcome.", frame)
  }
  const outcome = exit as { _tag?: unknown; value?: unknown; cause?: unknown }
  if (outcome._tag === "Success") return { ok: true, payload: outcome.value }
  return failure(describeCause(outcome.cause), outcome.cause)
}
