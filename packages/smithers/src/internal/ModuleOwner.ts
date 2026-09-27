/** Approved control identity restored by ModuleAuthority at each native handler.
 * Private host composition data, never a workflow payload or authority lookup.
 * @since 1.0.0
 */

import { Context } from "effect"

/**
 * Native module identity supplied by the owning host.
 *
 * @since 1.0.0
 * @private
 */
export class ModuleOwner extends Context.Service<ModuleOwner, {
  readonly rootId: string
  readonly flowId: string
}>()("/cli/internal/ModuleOwner") {}
