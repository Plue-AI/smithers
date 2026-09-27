/**
 * Block Kit button approvals.
 *
 * A prompt is an `actions` block whose buttons carry an `action_id` of the
 * form `sap:<token>:a`, `sap:<token>:d`, or `sap:<token>:s:<key>`. A press
 * arrives as a `block_actions` interaction, and {@link decision} reads it.
 *
 * A press carries no trust of its own: anyone in the channel can press a
 * button, and an `action_id` is data. So a decision checks the presser's user
 * id against an explicit allowlist, and a press that is not an authorized
 * answer to this prompt is `Ignored`, never a rejection, so the approval stays
 * pending. This is the authentication an approval gate relies on when its
 * answer comes from Slack: the gate records only a `Decided` outcome.
 *
 * The per-prompt {@link token} keeps one prompt's buttons from resolving
 * another's. It is a namespace, not a secret; sender authorization is checked
 * separately. A prompt with no token, or an empty one, matches nothing.
 *
 * @since 1.0.0
 */

import { SmithersError } from "@smthrs/errors/SmithersError"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { BlockActions } from "./Payload.ts"

/** Namespace prefix for approval action ids: Smithers APproval. */
const PREFIX = "sap"

const asBlockActions = Schema.decodeUnknownOption(BlockActions)

/**
 * Slack's limit on an `action_id`, in characters.
 *
 * @category constants
 * @since 1.0.0
 */
export const ACTION_ID_MAX_LENGTH = 255

/**
 * What an approver can choose.
 *
 * @category models
 * @since 1.0.0
 */
export type Choice = { readonly kind: "approve" } | { readonly kind: "reject" } | {
  readonly kind: "select"
  readonly key: string
}

/**
 * One option offered in `select` mode.
 *
 * @category models
 * @since 1.0.0
 */
export interface Option {
  /** The value echoed back as the decision. No `:`. */
  readonly key: string
  readonly label: string
}

/**
 * How to build the prompt and read the press.
 *
 * @category models
 * @since 1.0.0
 */
export interface PromptSpec {
  readonly mode: "approve" | "select"
  /** Namespaces this prompt's buttons. A prompt without one is answerable by nobody. */
  readonly token?: string | undefined
  /** User ids whose press decides. Missing or empty admits nobody. */
  readonly allowedUserIds?: ReadonlyArray<string> | undefined
  /** When set, the press must also come from one of these workspaces. */
  readonly allowedTeamIds?: ReadonlyArray<string> | undefined
  /** Required and non-empty in `select` mode. */
  readonly options?: ReadonlyArray<Option> | undefined
  readonly approveText?: string | undefined
  readonly rejectText?: string | undefined
}

/**
 * The decision an `approve`-mode press produces.
 *
 * @category models
 * @since 1.0.0
 */
export interface Decision {
  readonly approved: boolean
  readonly note: string | null
  /** The presser's Slack user id. */
  readonly decidedBy: string
  readonly decidedAt: string
}

/**
 * The decision a `select`-mode press produces.
 *
 * @category models
 * @since 1.0.0
 */
export interface Selection {
  readonly selected: string
  readonly notes: string | null
  readonly decidedBy: string
  readonly decidedAt: string
}

/**
 * A short, colon-free token derived from an id: the first 16 hex digits of
 * its SHA-256.
 *
 * Raises `INVALID_INPUT` for an id that is not a non-empty string, because an
 * empty id would give every miscalled prompt the same namespace.
 *
 * @category constructors
 * @since 1.0.0
 */
export const token = (id: string): string => {
  if (typeof id !== "string" || id.length === 0) {
    throw new SmithersError("INVALID_INPUT", "Approval token id must be a non-empty string.")
  }
  return createHash("sha256").update(id).digest("hex").slice(0, 16)
}

/**
 * Encodes a choice as an `action_id`.
 *
 * Raises `INVALID_INPUT` for a token containing `:`, an empty or colon-bearing
 * option key, and an id over {@link ACTION_ID_MAX_LENGTH}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const actionId = (choice: Choice, approvalToken: string): string => {
  if (approvalToken.includes(":")) {
    throw new SmithersError("INVALID_INPUT", "Approval token must not contain a colon.")
  }
  if (choice.kind === "select" && (choice.key.length === 0 || choice.key.includes(":"))) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Approval option key must be non-empty and contain no ":": ${JSON.stringify(choice.key)}`
    )
  }
  const code = choice.kind === "approve" ? "a" : choice.kind === "reject" ? "d" : `s:${choice.key}`
  const id = `${PREFIX}:${approvalToken}:${code}`
  if (id.length > ACTION_ID_MAX_LENGTH) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Approval action_id exceeds Slack's ${ACTION_ID_MAX_LENGTH}-character limit.`
    )
  }
  return id
}

/**
 * Decodes an `action_id`, or `null` when it is not one {@link actionId} could
 * have produced.
 *
 * @category getters
 * @since 1.0.0
 */
export const parseActionId = (value: unknown): (Choice & { readonly token: string }) | null => {
  if (typeof value !== "string") return null
  const parts = value.split(":")
  if (parts[0] !== PREFIX) return null
  const approvalToken = parts[1] as string
  if (parts.length === 3 && parts[2] === "a") return { token: approvalToken, kind: "approve" }
  if (parts.length === 3 && parts[2] === "d") return { token: approvalToken, kind: "reject" }
  if (parts.length === 4 && parts[2] === "s" && parts[3] !== "") {
    return { token: approvalToken, kind: "select", key: parts[3] as string }
  }
  return null
}

/**
 * The prompt token a `block_actions` press names, or `null` when the payload
 * is not one press of an approval button. A host with several pending
 * prompts uses it to find the one to ask {@link decision} about; it decides
 * nothing by itself.
 *
 * @category getters
 * @since 1.0.0
 */
export const pressedToken = (payload: unknown): string | null => {
  const decoded = asBlockActions(payload)
  if (decoded._tag === "None" || decoded.value.actions.length !== 1) return null
  return parseActionId((decoded.value.actions[0] as typeof decoded.value.actions[number]).action_id)?.token ?? null
}

const button = (text: string, choice: Choice, approvalToken: string, style?: "primary" | "danger") => ({
  type: "button",
  text: { type: "plain_text", text },
  action_id: actionId(choice, approvalToken),
  value: choice.kind === "select" ? choice.key : choice.kind,
  ...(style === undefined ? {} : { style })
})

/**
 * The Block Kit `actions` block for a prompt, to send beside the question.
 *
 * Raises `INVALID_INPUT` for `select` mode with no options.
 *
 * @category constructors
 * @since 1.0.0
 */
export const blocks = (spec: PromptSpec): ReadonlyArray<Record<string, unknown>> => {
  const value = spec.token ?? ""
  const options = spec.options ?? []
  if (spec.mode === "select" && options.length === 0) {
    throw new SmithersError("INVALID_INPUT", "Slack approval mode \"select\" requires at least one option.")
  }
  const elements = spec.mode === "select"
    ? options.map((option) => button(option.label, { kind: "select", key: option.key }, value))
    : [
      button(spec.approveText ?? "Approve", { kind: "approve" }, value, "primary"),
      button(spec.rejectText ?? "Reject", { kind: "reject" }, value, "danger")
    ]
  return [{ type: "actions", block_id: `${PREFIX}:${value}`, elements }]
}

/**
 * Why a press did not resolve an approval.
 *
 * - `foreign-prompt`: not a press on this prompt (another token, no token, a
 *   payload that is not one block action, or an id this module cannot produce).
 * - `unauthorized`: the presser is not in `allowedUserIds`, or the workspace
 *   is not in `allowedTeamIds`.
 * - `unknown-option`: this prompt's token, but a choice it never offered.
 *
 * @category models
 * @since 1.0.0
 */
export type IgnoredReason = "foreign-prompt" | "unauthorized" | "unknown-option"

/**
 * A press that is not an authorized answer. The approval stays pending.
 *
 * @category models
 * @since 1.0.0
 */
export interface Ignored {
  readonly _tag: "Ignored"
  readonly reason: IgnoredReason
}

/**
 * An authorized answer to this prompt.
 *
 * @category models
 * @since 1.0.0
 */
export interface Decided<A extends Decision | Selection> {
  readonly _tag: "Decided"
  readonly decision: A
}

/**
 * What {@link decision} reports for a press on a prompt of mode `M`.
 *
 * @category models
 * @since 1.0.0
 */
export type Outcome<M extends PromptSpec["mode"] = PromptSpec["mode"]> =
  | Ignored
  | Decided<M extends "select" ? Selection : Decision>

const ignored = (reason: IgnoredReason): Ignored => ({ _tag: "Ignored", reason })

/**
 * Maps a delivered `block_actions` payload to an outcome.
 *
 * Only an authorized press of an option this prompt offered is `Decided`.
 * Every other press is `Ignored` and leaves the approval pending: a
 * non-approver's press or a press on another prompt never resolves it, not
 * even as a rejection. `decidedAt` is the resolution wall clock.
 *
 * @category constructors
 * @since 1.0.0
 */
export const decision = <M extends PromptSpec["mode"]>(
  payload: unknown,
  spec: PromptSpec & { readonly mode: M },
  nowMs: number = Date.now()
): Outcome<M> => {
  const decoded = asBlockActions(payload)
  if (decoded._tag === "None" || decoded.value.actions.length !== 1) return ignored("foreign-prompt")
  const press = decoded.value
  const choice = parseActionId((press.actions[0] as typeof press.actions[number]).action_id)
  if (choice === null || spec.token === undefined || spec.token.length === 0 || choice.token !== spec.token) {
    return ignored("foreign-prompt")
  }
  const userId = press.user.id
  const teamId = press.team?.id ?? press.user.team_id
  const teamAllowed = spec.allowedTeamIds === undefined ||
    (teamId !== undefined && spec.allowedTeamIds.includes(teamId))
  if (!teamAllowed || !(spec.allowedUserIds ?? []).includes(userId)) return ignored("unauthorized")
  const decidedAt = new Date(nowMs).toISOString()
  if (spec.mode === "select") {
    const offered = new Set((spec.options ?? []).map((option) => option.key))
    if (choice.kind !== "select" || !offered.has(choice.key)) return ignored("unknown-option")
    const selection: Selection = { selected: choice.key, notes: null, decidedBy: userId, decidedAt }
    return { _tag: "Decided", decision: selection } as Outcome<M>
  }
  if (choice.kind === "select") return ignored("unknown-option")
  const decided: Decision = { approved: choice.kind === "approve", note: null, decidedBy: userId, decidedAt }
  return { _tag: "Decided", decision: decided } as Outcome<M>
}
