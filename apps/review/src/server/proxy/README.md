# proxy/

The metered Anthropic proxy (`POST /anthropic/v1/messages` only).

- `handleAnthropic.ts`: authenticate, reserve budget, forward with the real
  API key, stream the response back and meter a teed copy via `waitUntil`.
- `anthropicEndpointAllowed.ts`: method/path allowlist for the shared key.
- `authenticateProxyRequest.ts`: resolve session tokens and `srk_` API keys.
- `modelPrices.ts`: explicit price allowlist; unknown models throw. Dated
  successors and long-context tiers resolve like the backend rate card.
- `priceRequest.ts`: validate bounded text/local-tool requests and calculate
  a conservative input-plus-output reservation.
- `reserveUsage.ts`: atomically enforce session, repository and API-key
  budgets, including outstanding calls, and report whether a refusal is the
  in-flight limit (429) or spend (402).
- `proxyInFlightLimit.ts`: the per-repository outstanding-call limit, shared
  with the action's `--concurrency`.
- `completedUsage.ts`: require final usage before settling a hold.
- `parseUsageFromJson.ts`: extract JSON token usage; `teeForMetering.ts` parses SSE.
- `recordUsage.ts`: atomically debit, insert an idempotent usage event and
  release the reservation using a D1 batch.
- `retryUsage.ts`: retry persisted settlements before further admission.
- `expireHolds.ts`: settle holds older than 15 minutes at their reserved cost.
- `parseUsage.ts`: shared `UsageSummary` type.

See [proxy budget admission](../../../docs/proxy-budget.md) for limits and
recovery. Ambiguous upstream failures retain their budget holds until they
expire at their reserved cost. API keys require a registered, authorized repository and enforce
its monthly cap plus the optional key cap on cumulative repository monthly
spend, including outstanding reservations. Sessions minted with an API key
retain its hash, inherit its live cap and lose access when it is revoked or
unscoped. Minting bounds the session cap by the remaining key budget.
