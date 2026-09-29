/**
 * What a person reads when a workspace's flow gateway refuses a call.
 *
 * The gateway answers `{ ok: false, error: { message, detail } }`, where the
 * detail names a control-plane code or tag (`@smthrs/control/ControlError`).
 * The message is the control plane's own text: an id, a schema complaint, a
 * driver error. It stays on the result as `detail`; the sentence comes from
 * this registry, one row per tag, so a new control failure does not compile
 * until it has words. A code this build does not know is the generic line.
 */
import type { ControlError } from "@smthrs/control/ControlError"
import { refusalOf } from "@smthrs/rpc/Refusal"
import { refusalLine } from "@smthrs/rpc/RefusalCopy"
import { presentUserFailure, type UserFailureCopy, type UserFailureRegistry } from "@smthrs/rpc/UserFailure"

const gone = (what: string): UserFailureCopy => ({ fault: "user", sentence: `That ${what} isn't in this workspace.`, actions: [] })
const notYours = (sentence: string): UserFailureCopy => ({ fault: "infra", sentence, actions: ["retry"] })

export const GATEWAY_FAILURE_COPY: UserFailureRegistry<ControlError> = {
  "/control/RunNotFound": gone("run"),
  "/control/PlanNotFound": gone("plan"),
  "/control/FlowNotFound": gone("flow"),
  "/control/PlanDenied": { fault: "user", sentence: "That plan was denied.", actions: [] },
  "/control/PlanDigestMismatch": { fault: "user", sentence: "That plan changed after it was approved. Review it again.", actions: [] },
  "/control/EnvelopeMismatch": { fault: "user", sentence: "That request doesn't match the run it names.", actions: [] },
  "/control/AlreadyResolved": { fault: "user", sentence: "That was already answered.", actions: [] },
  "/control/InvalidInput": { fault: "user", sentence: "The workspace couldn't use those inputs. Check them and try again.", actions: [] },
  "/control/Unauthorized": { fault: "user", sentence: "This account can't do that in this workspace.", actions: ["sign-in"] },
  "/control/NoMatchingWait": { fault: "user", sentence: "Nothing in that run is waiting for this.", actions: [] },
  "/control/CredentialConflict": { fault: "user", sentence: "Those credentials conflict with ones this workspace already has.", actions: [] },
  "/control/LaunchFailed": { fault: "user", sentence: "The flow couldn't start. Check its model and approval, then try again.", actions: ["retry"] },
  "/control/ClaimLost": notYours("Another worker took this run over. Not your fault."),
  "/control/CodeDrift": notYours("The workspace's code changed under this run. Not your fault."),
  "/control/Unavailable": notYours("The workspace isn't answering right now. Not your fault; try again in a moment."),
  "/control/TransportError": notYours("The workspace couldn't be reached. Not your fault; try again."),
  "/control/PersistenceError": notYours("The workspace couldn't save that. Not your fault."),
  "/notifications/NotificationError": notYours("The workspace's notifications aren't working right now. Not your fault.")
}

/** The wire names a code more often than a tag; every code maps to its one tag. */
const TAG_BY_CODE = {
  run_not_found: "/control/RunNotFound",
  plan_not_found: "/control/PlanNotFound",
  flow_not_found: "/control/FlowNotFound",
  plan_denied: "/control/PlanDenied",
  plan_digest_mismatch: "/control/PlanDigestMismatch",
  envelope_mismatch: "/control/EnvelopeMismatch",
  already_resolved: "/control/AlreadyResolved",
  invalid_input: "/control/InvalidInput",
  unauthorized: "/control/Unauthorized",
  no_matching_wait: "/control/NoMatchingWait",
  credential_conflict: "/control/CredentialConflict",
  launch_failed: "/control/LaunchFailed",
  claim_lost: "/control/ClaimLost",
  code_drift: "/control/CodeDrift",
  unavailable: "/control/Unavailable",
  transport_error: "/control/TransportError",
  persistence_failed: "/control/PersistenceError",
  notification_unavailable: "/notifications/NotificationError",
  notification_closed: "/notifications/NotificationError",
  notification_full: "/notifications/NotificationError",
  notification_id_reused: "/notifications/NotificationError",
  notification_invalid: "/notifications/NotificationError"
} as const satisfies Record<ControlError["code"], ControlError["_tag"]>

export const GATEWAY_REFUSED = "The workspace refused the call."

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** The sentence for a refusal naming `code` (a code or a tag), or the generic line. */
export const gatewayRefusalSentence = (code: string | undefined): string => {
  const tag = code === undefined ? undefined : code.startsWith("/") ? code : (TAG_BY_CODE as Readonly<Record<string, string>>)[code]
  return presentUserFailure(GATEWAY_FAILURE_COPY, tag === undefined ? null : { _tag: tag }, {
    unknown: { fault: "bug", sentence: GATEWAY_REFUSED, actions: ["retry"] }
  }).sentence
}

/**
 * The typed error's code in a relayed failure's `detail` (the gateway's
 * cause, carried whole by the relay). Effect's RPC protocol encodes a failure
 * cause as an array of reasons, `[{ _tag: "Fail", error }]`, so the first
 * `Fail` reason's error is the typed refusal; a bare record is the error
 * itself when it carries a code or a `/control/...` tag, else the `error` it
 * wraps. The `code` field wins; a tag in the `/control/...` form is the
 * fallback; anything else names no code.
 */
export const errorCodeOf = (detail: unknown): string | undefined => {
  const isTyped = (record: Record<string, unknown>): boolean =>
    typeof record.code === "string" || (typeof record._tag === "string" && record._tag.startsWith("/"))
  const typed = Array.isArray(detail)
    ? asRecord(detail.map(asRecord).find((reason) => reason._tag === "Fail")?.error)
    : isTyped(asRecord(detail))
    ? asRecord(detail)
    : asRecord(asRecord(detail).error)
  if (typeof typed.code === "string" && typed.code !== "") return typed.code
  return typeof typed._tag === "string" && typed._tag.startsWith("/") ? typed._tag : undefined
}

/**
 * The sentence for a workspace answer that is neither a result nor a gateway
 * refusal: a box still starting, or plue's own state for one at capacity or
 * over a quota (coded, so its registry row speaks), else the generic line.
 */
export const workspaceAnswerSentence = (body: Readonly<Record<string, unknown>>): string =>
  body.status === "provisioning"
    ? "The workspace is still starting. Try again in a moment."
    : refusalLine(refusalOf({ body, status: null, message: "" }), GATEWAY_REFUSED)
