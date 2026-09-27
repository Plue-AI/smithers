/**
 * Host-only access to untrusted MCP diagnostics, separate from model-facing
 * errors. Merely logging or JSON-encoding an event cannot expose its detail.
 *
 * @since 1.0.0-rc.0
 */

import { Context, Layer } from "effect"
import type { Redacted } from "effect"

/**
 * One bounded diagnostic from a connection. Detail can contain credentials,
 * private tool arguments, or arbitrary server text. Only an explicitly trusted
 * local host should unwrap it; never forward it to agents, journals, or logs.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Event {
  readonly server: string
  readonly source: "spawn" | "stderr" | "remote-error" | "invalid-response" | "invalid-arguments"
  /** At most 16 KiB of UTF-8 text; never the original unbounded value. */
  readonly detail: Redacted.Redacted<string>
  readonly truncated: boolean
}

/**
 * Optional diagnostic observer, captured when a connection is opened. The
 * synchronous callback must not block; throws are isolated from the protocol.
 * Absent this service, raw diagnostics are discarded, not logged implicitly.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export class Diagnostics extends Context.Service<Diagnostics, {
  readonly report: (event: Event) => void
}>()("@smthrs/mcp/Diagnostics") {}

/**
 * Installs a trusted host observer. Inspecting detail requires an explicit
 * `Redacted.value` call and responsibility for its destination and retention.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (report: (event: Event) => void): Layer.Layer<Diagnostics> =>
  Layer.succeed(Diagnostics)({ report })
