import { z } from "zod"

/**
 * Threads: the conversation shapes the issue cards carry
 * (smithers-ui-DESIGN.md §3.1, §3.2, §3.6).
 *
 * A thread IS an issue (`kind: "chat"` owner-private, or a repository issue);
 * a message is an issue comment; a task is an issue that carries intent
 * metadata. These are the UI-owned payload fragments the `issue`,
 * `issue-list` and `connect` cards embed beside the chat = issues contract's
 * own fields (kind, personas, pending sends, reactions, the Slack mapping).
 */

/** Who posted, acted or owns something; `agentId` when the identity is a configured agent profile. */
export const PersonaRefSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  iconUrl: z.string().optional(),
  agentId: z.string().optional()
})
export type PersonaRef = z.infer<typeof PersonaRefSchema>

/** The issue states the backend transitions (`open → fixed → verified → closed`; the verifier differs from the fixer). */
export const ThreadStateSchema = z.enum(["open", "fixed", "verified", "closed"])
export type ThreadState = z.infer<typeof ThreadStateSchema>

/** Intent metadata on a task; every field is optional because a chat carries none. */
export const TaskMetaSchema = z.object({
  owner: PersonaRefSchema.optional(),
  /** ISO date. */
  due: z.string().optional(),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  parent: z.object({ number: z.number().int().positive(), title: z.string().optional() }).optional(),
  fixedBy: PersonaRefSchema.optional(),
  verifiedBy: PersonaRefSchema.optional()
})
export type TaskMeta = z.infer<typeof TaskMetaSchema>

/** One integration row on the connect card: what it syncs and its one action. */
export const IntegrationRowSchema = z.object({
  id: z.enum(["slack", "linear", "notion"]),
  state: z.enum(["connected", "not-connected", "coming-soon", "error"]),
  /** The mapped target in the service's own words (`#smithers-team`, `ENG`). */
  detail: z.string().optional(),
  /** The server's error, verbatim. */
  error: z.string().optional(),
  /** ISO. */
  lastSyncAt: z.string().optional(),
  action: z.object({ label: z.string(), flow: z.string(), args: z.string().optional() }).optional()
})
export type IntegrationRow = z.infer<typeof IntegrationRowSchema>
