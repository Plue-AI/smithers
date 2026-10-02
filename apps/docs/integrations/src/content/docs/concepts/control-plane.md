---
title: "How adapters sit on the control plane"
description: "Webhook ingress as library code: the fixed verify, decode, map, dispatch order, secret resolution, routes, and the redelivery guarantee."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/integrations/docs/concepts/control-plane.md"
---

A webhook door is library code, not a server setting: a provider builds a
`@smthrs/control` `Channel`, the application registers it with `Channels`,
and `Channels.ingest` runs the delivery. This page explains the contract that
channel binding enforces, because every guarantee the adapters have sits on
it. For the coordinator's own API, see [the control API](https://control.smithers.sh/reference/api/).

## The fixed order

`Channels.ingest` runs one order on every delivery: verify the raw bytes,
decode, map, then reach `Control`. Verification is the amplification guard.
A delivery that does not verify never reaches a decoder, a plan, or a
database, so an attacker who can POST to your endpoint cannot make your
control plane do work with a forged payload.

`Core.Channel.make` is the binding each provider's `channel` constructor
calls. It wires the provider's two pieces of provider-specific code into the
coordinator's skeleton:

- `verify(raw, secret)` sees the exact delivered bytes and the resolved
  secret, and returns a boolean. A verifier that throws is treated as a
  failed verification: the delivery is refused with `Unauthorized`, not
  turned into a defect that kills the ingress fiber.
- `decode(raw, payload)` runs only after verification, and may throw an
  `IntegrationError` for a delivery whose headers or body it cannot read.

The decoder's output is validated against `Core.ExternalEvent` before it
leaves the channel, so a decoder bug fails loudly on the delivery that
triggered it rather than surfacing as a malformed signal three hops later.

What crosses to the control plane on a refusal is deliberately small.
`IntegrationError.toUnauthorized` and `toInvalidInput` map a failure onto the
control plane's own errors, and only the error's summary crosses: a verifier
that reported which byte of a digest mismatched would be a verification
oracle. An internal error that is not an `IntegrationError` (a `TypeError`
from provider code, say) crosses as a generic decode failure, and its detail
stays in the log.

## Secrets

A channel config carries a `credential`, the journal-safe
`CredentialRef`, and a `secret`, a `SecretResolver` that turns the reference
into the signing secret. Resolution is a host concern: the reference can be
journaled, the secret cannot, and only the host knows where it lives. Two
resolvers ship:

- `Core.Channel.constantSecret(secret)` always answers with one secret. It is
  for a single-tenant deployment that reads its webhook secret from the
  environment.
- `Core.Channel.credentialSecret(credentials)` resolves through the control
  plane's credential store. It takes the resolved service rather than
  requiring it, because a channel's verifier runs with no environment of its
  own.

## Routes

The `route` decides what a decoded event does. Two constructors ship:

- `Core.Channel.startFlow(flowId)` starts a flow with the event as its input.
- `Core.Channel.signalRun(runId)` signals a run that is already waiting, with
  the event's signal name and payload.

A delivery decodes to one event with one correlation.

## The redelivery guarantee

`Channels.ingest` drops a replayed `idempotencyKey`. The host derives the key
from the source's delivery identity and puts it on `RawInbound` before ingestion.
Leaving the field unset allows a retry to start work twice. The
[receiver guide](/guides/webhook-ingress/) bounds the body before ingestion.
