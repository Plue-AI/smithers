/**
 * Threads: the conversation shapes the issue cards carry
 * (smithers-ui-DESIGN.md §3.1, §3.2, §3.6).
 *
 * A thread IS an issue (`kind: "chat"` owner-private, or a repository issue);
 * a message is an issue comment; a task is an issue that carries intent
 * metadata. These are the UI-owned payload fragments the `issue`,
 * `issue-list` and `connect` cards embed beside the chat = issues contract's
 * own fields (kind, personas, pending sends, reactions, the Slack mapping).
 *
 * @since 1.0.0
 */

import { z } from "zod"

/**
 * Who posted, acted or owns something; `agentId` when the identity is a configured agent profile.
 *
 * @since 1.0.0
 * @category schemas
 */
export const PersonaRefSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  iconUrl: z.string().optional(),
  agentId: z.string().optional()
})
/**
 * Who posted, acted or owns something.
 *
 * @since 1.0.0
 * @category models
 */
export type PersonaRef = z.infer<typeof PersonaRefSchema>

/**
 * The issue states the backend transitions (`open → fixed → verified → closed`; the verifier differs from the fixer).
 *
 * @since 1.0.0
 * @category schemas
 */
export const ThreadStateSchema = z.enum(["open", "fixed", "verified", "closed"])
/**
 * An issue state the backend transitions.
 *
 * @since 1.0.0
 * @category models
 */
export type ThreadState = z.infer<typeof ThreadStateSchema>

/**
 * Intent metadata on a task: who fixed and who verified it, the facts the
 * backend records (`fixed_by`, `verified_by`). Every field is optional because
 * a chat carries none. Owner, due, priority and parent are not stored by the
 * backend and so are not on the wire (#2186).
 *
 * @since 1.0.0
 * @category schemas
 */
export const TaskMetaSchema = z.object({
  fixedBy: PersonaRefSchema.optional(),
  verifiedBy: PersonaRefSchema.optional()
})
/**
 * Intent metadata on a task.
 *
 * @since 1.0.0
 * @category models
 */
export type TaskMeta = z.infer<typeof TaskMetaSchema>

/**
 * One integration row on the connect card: what it syncs and its state.
 *
 * @since 1.0.0
 * @category schemas
 */
export const IntegrationRowSchema = z.object({
  id: z.enum(["slack", "linear"]),
  /** `unavailable`: this server (or this host's proxy) has no route for the service, which is not the same as the account being disconnected. */
  state: z.enum(["connected", "not-connected", "unavailable", "error"]),
  /** The mapped target in the service's own words (`#smithers-team`, `ENG`). */
  detail: z.string().optional(),
  /** The server's error, verbatim. */
  error: z.string().optional(),
  /** ISO. */
  lastSyncAt: z.string().optional()
})
/**
 * One integration row on the connect card.
 *
 * @since 1.0.0
 * @category models
 */
export type IntegrationRow = z.infer<typeof IntegrationRowSchema>
