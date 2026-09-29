# @smthrs/model

## [Unreleased]

### Added

- `Evaluator.layerFromSeat` judges with an already resolved seat's `Model`;
  malformed, truncated and unavailable judgments fail closed.
- `ModelRequest.serverTools`: provider-run tools a call may use, today
  `{ type: "web_search", allowedDomains? }`. OpenAI Responses (API key and
  ChatGPT plan) declares it as `{ type: "web_search", filters }` even under
  `toolChoice: "none"`, because no call reaches the caller; other protocols
  omit it. The Responses body's `tools` element is now a union, so a reader
  of `entry.name` checks `entry.type` first. Live on `gpt-6-luna` and
  `gpt-6-sol` over the ChatGPT plan on 2026-09-25: searches ran, the answer
  cited its URLs, and a later request that replayed the answer without the
  `web_search_call` items was accepted.

### Fixed

- `CanonicalJson` rejects arrays `JSON.stringify` would reshape: a sparse
  array (a hole became `null`), an array with named or symbol-keyed members
  (they were dropped), and an Array subclass (its `toJSON` or species could
  change the output). Arrays are now built with a plain loop rather than `map`
  (#2695).

- Anthropic Messages requests now carry prompt-cache breakpoints: one on the
  last system block (or last immediate tool) and one on the last stable
  message, set by the new optional `ModelRequest.cacheBoundary`. Requests
  previously sent no `cache_control`, so every frame of a run paid full input
  price for its whole prefix. Live on `claude-opus-5` on 2026-09-24, a
  five-frame run read 4,378 to 4,493 cached tokens on each frame after the
  first.

- The ChatGPT-subscription route sends a request's new `cacheKey` as
  `prompt_cache_key` and as the `session-id` header, as the Codex CLI does
  with its conversation id. Without them the backend spread a run's frames
  across machines: two Terminal-Bench trials on gpt-6-sol read 7% and 8% of
  their input from cache against the Codex CLI's 96% and 97% on the same
  tasks. Live on 2026-09-24, the body field alone still missed one frame in
  three; both together cached every frame after the first. The API-key
  Responses route sends `prompt_cache_key` too. `Protocol.headers` is the new
  hook a protocol derives per-request public headers through.

- `Evaluator.layerVercelGateway` asks again after a 429, 502, 503 or 504, or
  a connection that failed before any status, up to `attempts` requests (`Evaluator.defaultAttempts`, 3) with a pause of
  `Evaluator.retryBackoffMs` (100 ms) that doubles each time. `typesafe-ai/jev`
  shed about one request in seven with a fast 503 on 2026-09-23, which failed
  11 of 45 benchmark runs as `completion_unjudged`. A request shed on every
  attempt still fails `refused`. `timeoutMs` still bounds the whole
  evaluation, retries included; its default is now 3000 ms.

### Added

- `Evaluator.layerFromEnvironment(environment, host)` and `Evaluator.environmentKey`:
  the evaluator a host binds from its own environment, `layerVercelGateway`
  when `AI_GATEWAY_API_KEY` is nonblank, or an immediate startup refusal
  naming the host and both remedies. Offline hosts deliberately bind an
  evidence-based `layerScripted` judge. Missing configuration now fails boot
  instead of every completion; later transport failures still fail closed.

- `Classifier.fromEvaluatorError`: the conversion from an evaluator failure to
  a classifier failure, which `@smthrs/std`'s `classify` flow used to copy.

- Added `Classifier` and `Evaluator`, the typed-question API over Jev. The
  design doc they were specified against was retired with the Jev harness
  ([#1654](https://github.com/smithersai/smithers/issues/1654)); these two
  modules stayed. `Classifier.make` declares an id, a
  state schema and a map of `boolean`, `choice` and `score` questions, and
  infers the answer types: a choice's options become a literal union, a score's
  rungs its labels. `evaluate` sends one state and decodes the raw answers
  strictly; `evaluateAll` fans out with bounded concurrency and keeps every
  state's own `Result`; `digest` is the canonical hash of the declaration for
  durable call keys; `confident` reads a value only above a confidence floor.
  `Evaluator.layerVercelGateway` speaks the Vercel AI Gateway evaluation
  protocol over the kernel `HttpClient` with one deadline and no retries;
  `Evaluator.layerScripted` and `Evaluator.layerUnavailable` serve tests and
  hosts without a key. `ClassifierError` and `EvaluatorError` are typed and
  never thrown. The package now depends on `@smthrs/core` for the digest.

- Added `ModelCatalog.contextWindowTokensFor`, the context window in tokens of a
  known model id with a conservative floor for one the catalog has not met. The
  table moved here from `@smthrs/harness`, whose `ContextWindow` is otherwise
  provider-neutral. `@smthrs/agent` re-exports it from its own seat resolver.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added Schema-first Anthropic Messages and OpenAI Responses protocols, deterministic route composition, deferred tool loading, typed streaming events, and a redacting request executor.
- Added the OpenAI Chat Completions protocol (`OpenAIChatCompletions`), the wire shape Ollama, Gemini's compatibility layer, Cerebras and most other self-hosted or third-party "OpenAI-compatible" servers actually serve, and exported it from the root barrel.
- Added the native-structured-output toggle: `OpenAIChatCompletions.protocolWith({ structuredOutput })` and the `structuredOutput` option on the Chat Completions route constructor send `response_format` so the provider enforces the schema. A request that also declares tools fails locally as `invalid_request`, because the provider refuses both together. A request that declares tools and sets `toolChoice: "none"` is lowered instead of refused: that request forbids tool use, the lowering answers it by omitting `tools`, and the two fields never meet on the wire.
- Added the ChatGPT-subscription Responses route (`OpenAIChatGPT.make`, `OpenAIResponses.chatgptProtocol`, `OpenAIResponses.ChatGPTBody`). That backend rejects `max_output_tokens` and offers no other output cap, so a request that sets `params.maxTokens` fails locally as `invalid_request` with `path: "params.maxTokens"` before signing, rather than being sent without the budget the caller asked for.
- Added `Route.openaiResponsesCompatible` and `Route.openaiChatCompatible`. Both take the provider origin and append `/v1/responses` or `/v1/chat/completions` themselves, so one origin cannot yield two different URLs. They are the only compatibility constructors the package ships: a caller names the wire shape its provider serves, and no constructor guesses between the two.
- Added `RequestExecutor.Transport`, `RequestExecutor.fixed`, `RequestExecutor.makeWith` and `RequestExecutor.rebuildAfter`: the executor may now replace the HTTP client it runs on after three consecutive transport failures. A retry ladder repairs a failure by waiting, and an HTTP/2 session the peer has destroyed is the failure waiting does not repair, because every attempt that reuses the pool holding it fails identically. Three is exactly what one `execute` spends when every attempt fails on the transport, so no attempt inside a request ever runs on a client that request discarded, and any response of any kind resets the count because a 429 arrived over a connection that worked. `make` keeps a fixed transport, which is the honest answer in a browser where there is no pool to replace.
- Added `ToolChoice` and the optional `ModelRequest.toolChoice` field, so a frame that declares no tools can say so in the schema rather than have the value attached to the request afterwards. Every built-in encoder now omits `tools` when it is `"none"`.
- Added the `context_overflow` `ModelErrorCode` and `ModelError.isContextOverflow`, so a request that did not fit the model's context window is a typed code rather than a phrase a consumer has to re-parse. The protocols and the shared request executor classify their own overflow vocabulary ahead of the generic `invalid_request` branch.
- Added `ModelError.body` and `ModelError.bodyTruncated`: the redacted, 16 KiB-capped provider response body an executor failure was classified from. Both sit outside the durable schema and are defined non-enumerably, so a journal, a `JSON.stringify` and a structural comparison see exactly what they saw before, because a provider body is diagnostic text and not run state.
- Added `ModelError.isQuotaExhausted` and `ModelError.path`. The refinement gives an exhausted account one typed code across every provider; the path names the offending request member on a preparation failure and never carries its value.
- Added `Framing.ndjson` for newline-delimited JSON transports.
- Added package-owned documentation: an installation page, a quickstart, an API
  overview, concept pages and guides under `docs/`, alongside `README.md`.
  `PACKAGE.ts` declares them through the shared `docs` and `docsFiles` targets,
  so the README parity check runs with the package's other checks and the docs
  site reads the pages by target label instead of globbing the package.

### Changed

- `DeferredTools.supportsDeferred` answers from an explicit allowlist for Anthropic as it already did for OpenAI, instead of a 4.5-and-later version floor. The Anthropic list mirrors the model compatibility table on Anthropic's tool search page (fetched 2026-09-01) plus the undated alias of each dated 4.5 id, so `claude-haiku-4-5` now answers true and `claude-sonnet-5`, which that table omits, answers false. An id absent from the list, including a family or version released after this code, lowers through the portable non-native path instead of enabling an unverified wire body.
- Endpoint and built-in route constructors now return `Result`, making validation failures explicit instead of throwing. Request lowering and protocol state-machine failures now remain in typed Effect failure channels.
- `Endpoint.make` accepts only `http` and `https` URLs, rejects relative path segments, and no longer echoes the raw URL in its parse failure.
- The credential-name matcher no longer treats `max_tokens`, `budget_tokens` or `max_output_tokens` as secrets, so provider diagnostics quoting those numbers stay readable, and an endpoint may carry them as query parameters.
- `RequestExecutor` classifies 401 and 403 before it looks for content-policy vocabulary, and reads that vocabulary from the parsed provider error rather than from the whole body.

### Fixed

- Anthropic credit exhaustion, OpenAI's spaced "credit balance" phrasing and a bare HTTP 402 now classify as `quota_exceeded`, so an exhausted seat parks durably instead of terminating the run as a malformed request.
- A `Retry-After` header no longer escapes the 60 second retry budget. It is bounded by the per-wait cap, and a value larger than the budget surfaces immediately with its reset metadata instead of parking the fiber for the header's full value.
- Anthropic `redacted_thinking` blocks stream and replay instead of being dropped, so a turn whose reasoning was safety-redacted can still be sent back with its tool calls.
- Inline Chat Completions stream errors are classified by the protocol's own vocabulary instead of always reporting `provider_internal`, so a gateway that reports a rate limit or an exhausted quota inside an HTTP 200 stream is handled as that failure.
- An Anthropic `tool_use` block missing its id or name now fails with `invalid_provider_output` instead of fabricating an id and an empty tool name.
- `response.incomplete` reads `incomplete_details.reason`, so a filtered OpenAI Responses answer settles as `content-filter` rather than `length`.
- Canonical JSON encodes an own `__proto__` member instead of silently dropping it, so the sealed-step key always describes the body that was sent.
- Provider diagnostics redact nested and escaped credential values structurally, and a failed response body stops being read at 64 KiB, so nothing beyond the cap is held, parsed, walked or redacted. All three walks over that body stop at depth 12, so a body nested deeper than any V8 stack can walk is a typed `ModelError` rather than a crash.
- Inline Chat Completions stream errors that carry only a numeric provider code use it as the status the transport never sent, so a gateway answering `{"error":{"code":429}}` inside an HTTP 200 stream is rate limited rather than `unknown`.
- `Endpoint.make` rejects percent-encoded relative segments (`%2e%2e`), which the URL parser would otherwise decode and collapse after the raw-segment check had passed.
- Preserved OpenAI reasoning item references across tool-call continuations and honored initially deferred tool declarations in native and fallback lowering.
- Preserved partial tool-call arguments verbatim on interrupted turns instead
  of rewriting malformed provider output to `{}`.
- Raised the package's source coverage contract to exact 100% in every
  category and removed its temporary aggregate exemption.
- Redacting an embedded credential query no longer mutates the live
  `URLSearchParams` iterator, which could otherwise revisit the key forever.
