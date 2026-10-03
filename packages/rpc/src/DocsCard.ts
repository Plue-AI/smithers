/**
 * Docs data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks, CardProps } from "./CardAction.ts"

/**
 * The bundled docs page card (ui-components.md T-UI-21, spec §14.3 Docs, M-35): the table of contents in order,
 * the open page, an anchor to scroll to, and the requested slug when no page has it.
 * @since 1.0.0
 * @category schemas
 */
export const DocsCardSchema = z.object({
  toc: z.array(z.object({ slug: z.string(), title: z.string() })),
  page: z.object({ slug: z.string(), title: z.string(), summary: z.string(), markdown: z.string() }),
  anchor: z.string().optional(),
  not_found: z.string().optional()
})

/**
 * The value decoded by {@link DocsCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type DocsCard = z.infer<typeof DocsCardSchema>

/**
 * The Docs View's props. `gestures.open`: a toc entry or an in-page `.md` link raises
 * `onAction(gestures.open.tag, { page: "<slug>#<anchor>" })` (the `docs` flow).
 * @since 1.0.0
 * @category models
 */
export type DocsViewProps = CardProps<DocsCard, {}, "open">

/**
 * Typed catalog callbacks for Docs.
 * @since 1.0.0
 * @category models
 */
export type DocsCardCallbacks = CardCallbacks<"docs">
