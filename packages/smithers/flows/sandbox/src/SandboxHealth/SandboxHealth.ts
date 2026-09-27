/**
 * Defines the sandbox health service tag.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import type { Service } from "./Service.ts"

/**
 * Sandbox health service tag.
 *
 * @category services
 * @since 0.1.0
 */
export const SandboxHealth: Context.Service<Service, Service> = Context.Service(
  "@smthrs/sandbox/SandboxHealth"
)
