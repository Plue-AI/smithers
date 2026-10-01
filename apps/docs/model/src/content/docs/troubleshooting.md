---
title: "Troubleshooting"
description: "Concrete failure modes of @smthrs/model, their typed codes, and their fixes."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/model/docs/troubleshooting.md"
---

Every failure below exists in the package's source. Each surfaces as a
`ModelError` with the stated `code`; branch on the code, and read
[Handle failures](/guides/handle-failures/) for the decision per code.

## Configuration

**`no_route`: `no model route in this environment`.** The environment
provides the noop model, which fails every stream this way so a missing
provider reports rather than hangs. Provide a real route with
`Route.layer(config)`, or your own implementation with `Model.layer`.

**`authentication`: `API key must not be empty`.** Signing reads the
redacted credential at request time and rejects an empty value. The
environment variable you passed was unset or empty. Fix the variable; note
that a server which ignores its `Authorization` header, such as Ollama,
still needs a non-empty placeholder.

**Endpoint construction fails.** `Route.anthropic`, `Route.openai`, the
compatible constructors, and `Endpoint.make` itself return
`Result<Route, ModelError>` (or `Result<Endpoint, ModelError>`) rather than
throwing. The failure is `invalid_request` with one of these messages:

- `Endpoint URL could not be parsed`: the `baseUrl` or `url` is not a URL.
- `Endpoint URLs must use http or https`: other schemes are not served.
- `Endpoint URLs must not embed credentials`: move the credential into
  `Auth`; an endpoint is public route identity.
- `Endpoint URLs must not contain fragments`.
- `Endpoint query parameter <name> must not carry credentials`:
  credential-shaped query keys, including plain `key` and `sig`, are
  rejected for the same reason as embedded credentials.
- `Endpoint paths must not contain query strings or fragments`: pass query
  pairs through `query`, not inside `path`.
- `Endpoint paths must not contain relative segments`: `.` and `..`,
  including `%2e`-encoded forms, are refused.

## Preparation

Preparation failures are `invalid_request` and never reach the network.
`error.path` names the offending member when known, never its value.

**`Model request failed Schema validation`.** The `ModelRequest` itself is
malformed; `path` points at the member, for example
`messages[2].content[0].text`. Build requests with `ModelRequest.make` and
the `Message.*` constructors to catch shape errors early.

**`<protocol id> produced an invalid provider request body`.** The lowering
produced a body the provider schema rejects. This indicates a request
combination the adapter cannot express; the `path` identifies the body
member.

**`Model request could not be encoded as canonical JSON`.** A value in the
lowered body is not valid JSON: `undefined`, a function, a symbol, a
non-finite number, a class instance such as `Date` or `Map`, a symbol-keyed
member, a cycle, or an array that is sparse, carries named or symbol-keyed
members (such as a `RegExp` match result), or is an Array subclass or from
another realm. `CanonicalJson` rejects these rather than dropping or
reshaping them; find the member in `path`.

**`Route header <name> must be applied through Auth`.** A `headers` entry
has a credential-shaped name. Move the secret into an `Auth` constructor;
`headers` is for public values only.

**`invalid_request` with `path: "params.maxTokens"` on the ChatGPT route.**
The ChatGPT-subscription backend rejects `max_output_tokens` and offers no
other output cap, so the route refuses the budget locally. Omit
`params.maxTokens` on `OpenAIChatGPT.make` routes, or use an API-key route.

**`Anthropic Messages tool-call arguments must be a JSON object`.** A
historical `ToolCallPart.arguments` in the transcript is not a JSON object.
Validate tool-call arguments when you execute them, before they re-enter a
request.

## Execution

**`authentication` from the provider (HTTP 401 or 403).** The credential was
rejected. On a route whose `Auth` declares `refresh`, the package already
ran the refresh and retried exactly once; a second failure means the
credential itself is bad. Rotate it outside the route.

**`rate_limited` with reset metadata.** The executor already applied its
bounded ladder. When `retryAfterMillis` exceeds the 60 s budget the error
surfaces immediately instead of sleeping; park on `resetAtEpochMillis` and
resume after it.

**`quota_exceeded`.** The account has no usable balance: an HTTP 402, a
quota-vocabulary provider code, or Anthropic's "credit balance is too low".
Waiting does not add credit. Fund the account, then resume.

**Repeated `transport` failures.** After three consecutive transport
failures, the next attempt invokes the transport's `rebuild` effect.
`RequestExecutor.make` and `RequestExecutor.layer` wrap `fixed(http)` and
reuse the same client. A host that owns a connection pool can supply
`RequestExecutor.makeWith(transport)` with a rebuilding effect that returns
a client backed by a fresh pool; see
[Supply a rebuilding transport](/guides/handle-failures/#supply-a-rebuilding-transport).
If failures persist with a fresh pool, check the proxy, firewall, and
provider's reachability.

**`PermissionRequired` or `PermissionDenied`.** These are kernel classes,
not `ModelError` codes. They appear when the kernel's permission middleware
is composed over your HTTP client, as it is in a Smithers run: it checks a
`model:call` capability for the target host and model before the request
leaves. Grant the capability through the host's permission layer; see the
[capability API](https://capability.smithers.sh/reference/api/).

## Streaming

**`invalid_provider_output`.** The provider sent bytes the protocol cannot
read: a frame that is not valid JSON for the event schema (with `path`), a
completion for an unknown tool call (`Received completion for unknown tool
call <id>`), or streamed tool-call arguments that are not a JSON object
(`Invalid JSON input for streamed tool call <name>`). The request was fine;
report the incident with `requestId` when present.

**The stream ended without a `settle` event.** The call was interrupted:
fiber cancellation or a dead transport mid-body (the latter also raises
`transport` on the stream). `ModelEvent.settledMessage` folds what arrived
into a message with `stopReason: "aborted"`, and the next built-in request
omits that turn automatically. Partial tool-call argument text in such a
message is audit data; never execute it.

## Prompt cache

**Cached input stops growing across a conversation.** Set
`SMITHERS_WIRE_TRACE` to a file path and rerun. Each outgoing request
appends one JSON line with the route, the `prompt_cache_key` body field, the
`session-id` header, `affinity` (whether a remembered `x-codex-turn-state`
rides along), a short hash of the instructions, a hash and kind for
each input item, and `commonPrefixItems`: how many leading input items match
the previous request on the same cache key. The line never contains the
signed credential or item content. Compare it with the usage the stream
reports:

- `cacheKey` or `sessionIdHeader` is `null`: the request named no cache
  identity, and the provider may spread the conversation across machines.
- `commonPrefixItems` stays low while the input grows: the request is not
  append-only, so the provider has no earlier prefix to read back.
- Both are sound, and cached tokens still stop at the same count every call:
  the loss is on the provider side of the wire. Compare the stall point with
  the first item of a kind the provider treats differently, such as a
  replayed `reasoning` item.
- A short probe cannot show growth. The cache is read in fixed blocks, and a
  frame whose new stable items are smaller than one block plus the trailing
  state section reads back the same count as the frame before. Make each
  frame add a few thousand tokens before reading a flat count as a defect.
