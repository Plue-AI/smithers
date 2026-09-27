/**
 * Constructs a healthy no-op sandbox health service.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import { Healthy } from "./Healthy.ts"
import { SandboxHealth } from "./SandboxHealth.ts"
import type { Service } from "./Service.ts"

/**
 * A no-op service that always reports `Healthy` for hosts without a remote
 * sandbox.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): Service => SandboxHealth.of({ check: Effect.succeed(new Healthy()) })
