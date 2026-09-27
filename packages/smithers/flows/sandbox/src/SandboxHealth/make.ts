/**
 * Constructs sandbox health services.
 *
 * @since 0.1.0
 */

import { makeNoop } from "./makeNoop.ts"
import type { PingProvider } from "./PingProvider.ts"
import { probe } from "./probe.ts"
import type { ProbeOptions } from "./ProbeOptions.ts"
import { SandboxHealth } from "./SandboxHealth.ts"
import type { Service } from "./Service.ts"

/**
 * Builds the service from a provider's ping capability.
 *
 * `ping` is optional, so this is where the two cases meet. A provider that
 * answers a ping is probed under the usual deadline. A provider that has no
 * ping cannot be asked, so it gets the same service a host with no remote
 * sandbox at all gets ({@link makeNoop}): always `Healthy`. That is not a claim
 * that the session is alive; it says nothing is watching it, and supervision
 * built on such a provider will never fire. A provider that wants to be
 * supervised implements `ping`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  provider: { readonly ping?: PingProvider["ping"] | undefined },
  options?: ProbeOptions
): Service =>
  provider.ping === undefined
    ? makeNoop()
    : SandboxHealth.of({ check: probe({ ping: provider.ping }, options) })
