/**
 * DebugApi data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { HttpUrlSchema } from "./WebUrl.ts"

const HeadersSchema = z.array(z.tuple([z.string(), z.string()]))
const StatusSchema = z.number().int().min(100).max(599)

/**
 * An HTTP method of a documented operation.
 * @since 1.0.0
 * @category schemas
 */
export const HttpMethodSchema = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])

/**
 * The value decoded by {@link HttpMethodSchema}.
 * @since 1.0.0
 * @category models
 */
export type HttpMethod = z.infer<typeof HttpMethodSchema>

/**
 * The person-only API playground (ui-components.md T-UI-22, spec §14.3 Debug API, M-36): every documented
 * operation, the selected one, a mutation waiting for its in-card confirmation (nothing sent yet), and the last
 * exchange with its response or typed failure.
 * @since 1.0.0
 * @category schemas
 */
export const DebugApiCardSchema = z.object({
  operations: z.array(z.object({
    id: z.string(),
    method: HttpMethodSchema,
    path: z.string(),
    summary: z.string(),
    group: z.string()
  })),
  selected: z.string().optional(),
  pending: z.object({ method: z.string(), path: z.string() }).optional(),
  exchange: z.object({
    request: z.object({ method: z.string(), url: HttpUrlSchema, headers: HeadersSchema, body: z.string().optional() }),
    response: z.object({
      status: StatusSchema,
      headers: HeadersSchema,
      body: z.string(),
      duration_ms: z.number().nonnegative()
    }).optional(),
    failure: z.object({ class: z.string(), message: z.string(), status: StatusSchema.optional() }).optional()
  }).optional()
})

/**
 * The value decoded by {@link DebugApiCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type DebugApiCard = z.infer<typeof DebugApiCardSchema>

/**
 * The Debug API card's per-member view state: picking an operation is `onView({ selected })`.
 * @since 1.0.0
 * @category models
 */
export interface DebugApiView {
  readonly selected?: string
}

/**
 * The DebugApi View's props. Send's `input` is the form generated from the operation's parameters and request
 * body (a JSON body is a multiline field); a mutation then shows Confirm <METHOD> <path>.
 * @since 1.0.0
 * @category models
 */
export type DebugApiViewProps = CardProps<DebugApiCard, DebugApiView>

/**
 * Typed catalog callbacks for DebugApi.
 * @since 1.0.0
 * @category models
 */
export type DebugApiCardCallbacks = CardCallbacks<"debug-api">
