/**
 * Authority-free channel declarations.
 *
 * A channel authenticates opaque transport input, maps verified payloads to
 * control-plane starts or signals, and may project run state outbound. It
 * carries no execution authority: the target flow's envelope and permission
 * checks apply unchanged.
 *
 * @see packages/smithers/agent/triggers/docs/api.md
 * @since 0.1.0
 */

import type { IdempotencyKey } from "@smthrs/control/ControlSchema"
import type { CredentialRef } from "@smthrs/control/Credential"
import type * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import type { TriggerError } from "./TriggerError.ts"

/**
 * Opaque inbound transport data. Verification must inspect this value before
 * any payload decoding occurs.
 *
 * @category models
 * @since 0.1.0
 */
export interface RawInbound {
  readonly body: Uint8Array
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly idempotencyKey: IdempotencyKey
}

/**
 * A verified request that starts a flow.
 *
 * @category models
 * @since 0.1.0
 */
export interface Start {
  readonly start: {
    readonly flowId: string
    readonly input: unknown
  }
}

/**
 * A verified request that resolves a waiting flow step.
 *
 * @category models
 * @since 0.1.0
 */
export interface Signal {
  readonly signal: {
    readonly runId: string
    readonly stepId: string
    readonly value: unknown
  }
}

/**
 * The only operations an inbound channel may request.
 *
 * @category models
 * @since 0.1.0
 */
export type Inbound = Start | Signal

/**
 * Authenticates raw request bytes and headers against a credential reference.
 *
 * The credential arrives as a redacted reference rather than a secret, and it
 * arrives per request rather than at declaration time: a verifier resolves it
 * through the host's resolver when it needs the bytes. Dropping this parameter
 * left a verifier no way to reach a secret except by closing over it in plain
 * memory at declaration time, which is the shape the reference exists to
 * prevent. `packages/smithers/control/src/WebhookChannel.ts` states the same contract
 * for the control-plane side of the boundary.
 *
 * @category models
 * @since 0.1.0
 */
export type Verify = (
  raw: RawInbound,
  credential: Redacted.Redacted<CredentialRef>
) => Effect.Effect<void, TriggerError>

/**
 * An authority-free bidirectional channel declaration.
 *
 * `inbound` only describes a control-plane start or signal. It cannot supply
 * capabilities, grants, or an alternate execution envelope.
 *
 * @category declarations
 * @since 0.1.0
 */
export interface Channel<Payload, Run = never, Outbound = never> {
  readonly name: string
  readonly verify: Verify
  readonly inbound: (payload: Payload) => Inbound
  readonly outbound?: ((run: Run) => Outbound) | undefined
}

/**
 * Configuration for a schema-declared channel.
 *
 * @category models
 * @since 0.1.0
 */
export interface Config<Payload, Run = never, Outbound = never> extends Channel<Payload, Run, Outbound> {
  readonly schema: Schema.Schema<Payload>
}

/**
 * Declares a channel without adding authority or execution behavior.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <Payload, Run = never, Outbound = never>(
  config: Channel<Payload, Run, Outbound>
): Channel<Payload, Run, Outbound> => config
