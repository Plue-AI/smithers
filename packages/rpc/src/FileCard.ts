/**
 * File data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks } from "./CardAction.ts"
import { ActorSchema } from "./CardPrimitives.ts"

/**
 * File projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const FileCardSchema = z.object({
  path: z.string(),
  branch: z.string(),
  text: z.string(),
  language: z.string(),
  diagnostics: z.array(
    z.object({ line: z.number().int().positive(), severity: z.enum(["error", "warning"]), message: z.string() })
  ),
  gone: z.object({ kind: z.enum(["deleted", "renamed"]), by: ActorSchema, to: z.string().optional() }).optional(),
  outside: z.object({ snapshot: z.string() }).optional(),
  authors: z.array(z.object({ actor: ActorSchema })).optional(),
  editors: z.array(z.object({ actor: ActorSchema, line: z.number().int().positive() })).optional(),
  saved: z.enum(["saving", "saved", "stale"]).optional()
})

/**
 * The value decoded by {@link FileCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type FileCard = z.infer<typeof FileCardSchema>

/**
 * Typed catalog callbacks for File.
 * @since 1.0.0
 * @category models
 */
export type FileCardCallbacks = CardCallbacks<
  "file" | "diff" | "file.restore" | "file.compare" | "file.restore-deleted" | "file.follow-rename"
>
