---
title: "Error code reference"
description: "Current integration errors and retained historical codes."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/errors/docs/reference/error-codes.md"
---

The public `SmithersErrorCode` union keeps five codes. The GitHub adapter uses
`INTEGRATION_ERROR`; the two Telegram codes remain readable in historical
failures after the adapter's MVP retirement. They do not expose a current
Telegram client.

## Summary

| Code                         | Meaning                                                | Caller action                                           |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `INVALID_INPUT`              | A helper cannot accept the argument.                   | Correct the argument before retrying.                   |
| `INTEGRATION_ERROR`          | A provider call, webhook or listener operation failed. | Inspect `reason` and the delivery outcome.              |
| `TELEGRAM_API_ERROR`         | Historical Telegram transport or API failure.          | Retain the receipt; the retired adapter is unavailable. |
| `TELEGRAM_INIT_DATA_INVALID` | Historical Telegram authentication refusal.            | Treat it as an authentication refusal.                  |
| `UNSUPPORTED`                | The runtime lacks a required primitive.                | Supply a compatible runtime.                            |

[`smithersErrorDefinitions`](/reference/api/#smitherserrordefinitions) exports the
runtime definition table. Keeping an old code does not imply its original
provider remains supported.

## INVALID_INPUT

The call is invalid. A helper may attach the offending field to `details`.
Correct the argument; retrying the same input cannot fix it. Custom adapters
can raise this code without importing a provider implementation.

## INTEGRATION_ERROR

[`Core.IntegrationError`](https://integrations.smithers.sh/reference/api/) carries `reason` and a safe details
record. Current reasons are `invalid-config`, `invalid-signature`,
`decode-failed`, `poll-failed`, `delivery-failed`, `credentials-missing`,
`permission-denied`, `listener-conflict`, and `rate-limited`.

Use `Core.IntegrationError.isIntegrationError` to refine a failure across module
copies. `isRetryable` reads the adapter's retry classification; a retryable
failure alone does not make an ambiguous outbound write safe to repeat.
`outcomeUnknown` means the provider may already have applied it. Reconcile
against its durable receipt before attempting another write.

`toUnauthorized` and `toInvalidInput` map to control-plane errors using
`summary`, so the documentation URL does not enter the transport response.

At a durable action boundary,
`Core.ActionFailure.fromIntegrationError` converts the class to
`IntegrationFailure`, with its reason, bounded message, retryability and
available outcome details. `toIntegrationError` converts it back. An
unrecognized value becomes a conservative non-retryable failure rather than a
defect in the converter.

## TELEGRAM_API_ERROR

Retained for historical decoding. Old receipts may include `errorCode`,
`retryAfterSeconds`, `deliveredMessageIds` and `outcomeUnknown`. Preserve that
evidence: missing a response never proves a write did not happen. The current
MVP has no Telegram client or conversion helper.

## TELEGRAM_INIT_DATA_INVALID

Retained for historical authentication failures. Do not reinterpret a stored
refusal as success or retry it through another provider. The current MVP has
no Telegram Mini App verifier.

## UNSUPPORTED

A required runtime primitive is unavailable. Correct the runtime or adapter
configuration. The error code remains part of the public API even when a
particular provider that used it has been retired.
