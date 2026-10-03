/**
 * File data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { ActorSchema } from "./CardPrimitives.ts"
import { HttpUrlSchema } from "./WebUrl.ts"

/**
 * The largest text file that opens live, 1 MiB (spec §9.2.1); a larger text file is "too large to co-edit".
 * @since 1.0.0
 * @category constants
 */
export const LiveFileMaxBytes = 1_048_576

/**
 * A file's content: UTF-8 text, text over 1 MiB shown read-only, or binary with no editor.
 * @since 1.0.0
 * @category schemas
 */
export const FileContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("too_large"), bytes: z.number().int().gt(LiveFileMaxBytes), text: z.string() }),
  z.object({ kind: z.literal("binary"), bytes: z.number().int().nonnegative() })
])

/**
 * File projection fields from spec §14.3 and ui-components.md T-UI-11, T-UI-16 and T-UI-19: one schema whose S2
 * fields (`gone`, `outside`, `editors` from presence) and S3 fields (`authors`, `saved`, `unsaved`) are absent or
 * empty before their stage. Lines are 1-based; `col` counts UTF-16 units. `mode` is live only for text.
 * @since 1.0.0
 * @category schemas
 */
export const FileCardSchema = z.object({
  path: z.string(),
  branch: z.string(),
  language: z.string(),
  digest: z.string(),
  github_url: HttpUrlSchema.optional(),
  content: FileContentSchema,
  mode: z.enum(["read_only", "live"]),
  last_writer: ActorSchema.optional(),
  diagnostics: z.array(z.object({
    line: z.number().int().positive(),
    col: z.number().int().nonnegative().optional(),
    severity: z.enum(["error", "warning"]),
    message: z.string()
  })),
  hover: z.object({
    line: z.number().int().positive(),
    col: z.number().int().nonnegative(),
    markdown: z.string()
  }).optional(),
  reveal: z.object({
    line: z.number().int().positive(),
    col: z.number().int().nonnegative().optional(),
    to_line: z.number().int().positive().optional()
  }).optional(),
  gone: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("deleted"), by: ActorSchema }),
    z.object({ kind: z.literal("renamed"), to: z.string(), by: ActorSchema })
  ]).optional(),
  outside: z.object({ version: z.string(), at: z.string() }).optional(),
  authors: z.array(ActorSchema),
  editors: z.array(z.object({ actor: ActorSchema, line: z.number().int().positive() })),
  saved: z.enum(["saving", "saved"]).optional(),
  unsaved: z.object({ count: z.number().int().positive(), text: z.string() }).optional()
}).refine((file) => file.mode === "read_only" || file.content.kind === "text", {
  message: "only text content opens live",
  path: ["mode"]
})

/**
 * The value decoded by {@link FileCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type FileCard = z.infer<typeof FileCardSchema>

/**
 * The File card's per-member view state: the cursor line, which feeds presence `{path, line}` (§7.6), and
 * whether the outside version is being compared.
 * @since 1.0.0
 * @category models
 */
export interface FileView {
  readonly line?: number
  readonly compare?: boolean
}

/**
 * The code editor View's props. Gestures: `hover` and `definition` raise `onAction(tag, { path, line, col })`.
 * In live mode the Container also passes `binding`, the `EditorBinding` CodeMirror extensions from T-APP-15's seam
 * module (`packages/smithers/ui/src/adapters/code-editor/seam.ts`); it is not data, so this package declares no type.
 * @since 1.0.0
 * @category models
 */
export type CodeEditorViewProps = CardProps<FileCard, FileView, "hover" | "definition">

/**
 * Typed catalog callbacks for File.
 * @since 1.0.0
 * @category models
 */
export type FileCardCallbacks = CardCallbacks<
  | "file"
  | "diff"
  | "file.restore"
  | "file.compare"
  | "file.reapply"
  | "file.restore-deleted"
  | "file.follow-rename"
  | "code.hover"
  | "code.definition"
>
