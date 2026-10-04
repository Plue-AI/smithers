/** Debug API browser projection shared by its View and Container. */
import type { CardCallbacks, CardProps } from "./CardAction.ts"

/**
 * The HTTP methods offered by the Debug API browser.
 * @since 1.0.0
 * @category models
 */
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"
/**
 * Operations and the current exchange supplied by the Debug API container.
 * @since 1.0.0
 * @category models
 */
export type DebugApiCard = {
  operations: { id: string; method: HttpMethod; path: string; summary: string; group: string }[]
  selected?: string
  pending?: { method: string; path: string }
  exchange?: {
    request: { method: string; url: string; headers: [string, string][]; body?: string }
    response?: { status: number; headers: [string, string][]; body: string; duration_ms: number }
    failure?: { class: string; message: string; status?: number }
  }
}

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
