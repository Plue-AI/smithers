/**
 * Provides sandbox health services as Effect layers.
 *
 * @since 0.1.0
 */

import * as Layer from "effect/Layer"
import { make } from "./make.ts"
import type { PingProvider } from "./PingProvider.ts"
import type { ProbeOptions } from "./ProbeOptions.ts"
import { SandboxHealth } from "./SandboxHealth.ts"
import type { Service } from "./Service.ts"

/**
 * Provides `SandboxHealth` backed by the given provider's ping.
 *
 * Layer form of {@link make}, so a provider without `ping` provides the noop
 * service that always answers `Healthy`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  provider: { readonly ping?: PingProvider["ping"] | undefined },
  options?: ProbeOptions
): Layer.Layer<Service> => Layer.sync(SandboxHealth, () => make(provider, options))
