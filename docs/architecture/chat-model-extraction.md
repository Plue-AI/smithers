# Chat and model runtime extraction

## Audited provider paths

- The renderer contract is `WebAgent`: `POST /api/agent/turn`, `/cancel`,
  `/replay`, and `/retire`. Journal turns require
  `x-smithers-turn-journal: 1` and the version 1 cursor/batch NDJSON contract
  from `@smthrs/rpc/AgentTurnJournal`.
- The former web path entered `apps/server/src/turns.ts`, used a Cloudflare
  cancellation registry and Durable Object journal, then selected private
  Worker credentials and provider policy before calling a model.
- The former native path resolved configured models in the app Bun server.
  Its real provider adapters already use `@smthrs/model`; the browser does not
  run provider logic.
- Repository agent-session SSE carries a different event schema and remains a
  separate product surface.

Cloudflare Durable Objects, AI Gateway, and the private chat Worker are
deployment adapters. They are absent from the common turn protocol and are
not required by the single-owner container.

## Shared runtime

`@smthrs/model-host` owns the provider-neutral implementation:

- `ModelTurnHost` projects the established request into `@smthrs/model`, then
  emits the existing text, reasoning, tool call, and terminal frames.
- `DurableChatProducer` marks the provider boundary and commits exact sealed
  batches through the Go callback API. One identical retry repairs a lost
  receipt without repeating inference.
- `HostServer` authenticates bounded grants, pins the callback origin, carries
  cancellation through the request signal, and keeps provider failures and
  credentials out of responses.
- A deployment injects `ModelTurnResolver`. The public executable supplies the
  environment-backed single-owner resolver, which serves a request model only
  on the configured credential and origin and refuses provider redirects. The
  stream endpoint caps a buffered response at 16 MiB. Plue supplies its owner-scoped
  credential resolver to the same handler and model runtime.
- `LocalModel` plans a binding against the host's credentials, reports the
  catalog, refuses redirects, and maps provider failures to the contract.
- `ModelProbe` runs the one bounded model Test both local hosts serve.

`apps/model-host` is only a loopback executable and immutable bundle builder.
The app imports the package directly. Neither entrypoint owns another agent
loop or Flow graph.

The packaged process contract is:

- build `apps/model-host/build.mjs [output]`; ship the executable and adjacent
  SHA-256 manifest;
- run `smithers-model-host serve --host 127.0.0.1 --port <adapter port>`;
- inject `SMITHERS_CHAT_HOST_TOKEN`, a backend-reachable
  `SMITHERS_CHAT_CALLBACK_URL`, `SMITHERS_CHAT_MODEL`, and only the credential
  environment selected by `@smthrs/rpc/ConfiguredModel`; optionally inject
  `SMITHERS_CHAT_MAX_TOKENS`;
- accept readiness only after the first stdout identity and `GET /health` both
  name `smithers.chat-model-host/v1`; send grants to authenticated
  `POST /v1/chat/turn`.

The trusted process adapter reaches loopback directly. The isolated adapter
reaches that same loopback listener through its placement-fenced HTTP dialer.
The executable never prints a credential, journal capability, or request.

## Go boundary

PostgreSQL migration `0009_chat_turn_journal.sql` owns accepted request hashes,
producer fencing, immutable hash-linked batches, cancellation intent, terminal
receipts, and content-free retirement tombstones. The migration moved from
0008 after coordination reserved 0008 for provider connections.

Batch and head seals use the shared RFC 8785 implementation. Its Go string
encoding is byte-compatible with `JSON.stringify`, including literal U+2028
and U+2029 while preserving text that contains the characters `\u2028` and
`\u2029`.

The common Go runtime mounts the exact WebAgent routes through shared auth and
mounts authenticated producer callbacks on the trusted host network. A new
turn commits and flushes its accepted cursor before model dispatch. A renderer
disconnect only ends delivery; inference continues and replay resumes from the
last applied cursor. Cancellation commits `done(cancelled)` before interrupting
the host. A producer lost after provider start becomes an explicit uncertain
terminal result instead of being rerun.

Tool approval and execution stay in the existing controller and canonical
Flow runtime. A model leg ends with `done(tool_call)`; the controller obtains
approval, runs the tool through Flow, and submits the next model leg.

## Composition handoff

- Issue 01 mounts `chat.Runtime` behind the existing authenticated router and
  runs it with the app lifecycle.
- Issue 05/provider migration 0008 supplies secure owner credential lookup;
  raw credentials remain inside the trusted TypeScript process.
- Issues 07 and 10 package and supervise the trusted TypeScript hosts.
- Issue 11 keeps `WebAgent` as the sole renderer chat client.
- Plue injects its isolated owner resolver and service placement through the
  public `ports.ChatHost` contract.

The shared code is complete at these boundaries. End-to-end mode claims still
require root composition with migrations 0004 through 0008, the owner
credential adapter, process supervision, route mounting, and the renderer
acceptance matrix.
