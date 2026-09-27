# Lane L6 (cloud) — report (2026-09-03)

Cloud hover, definition and diagnostics are built: a file card of a cloud
repository with a running workspace asks the language server plue relays
inside it (plue #505), through the Bun tunnel, with the same three `code.*`
flows and the same card fields as native. Nothing was committed.

## Files changed

Shared contract (`packages/rpc`, `@smthrs/rpc`):

- `src/LspWire.ts` (new) — the LSP 3.17 wire shapes and their one conversion
  (`toWireRange`, `hoverContents`, `toDiagnostic`, `redactHostPaths`,
  `relativeToRoot`, `LSP_CLIENT_CAPABILITIES`), moved out of the Bun session
  so the cloud client converts the same way. Two adapters, one module.
- `src/LocalApp.ts` — the relay constants: `CLOUD_WS_SESSION_KINDS`,
  `CLOUD_LSP_SUBPROTOCOL`, `CLOUD_TERMINAL_FRAME_CAP_BYTES` (64 KiB),
  `CLOUD_LSP_FRAME_CAP_BYTES` (1 MiB), `CLOUD_LSP_REASSEMBLY_CAP_BYTES`
  (16 MiB), `CLOUD_LSP_ROOT_URI`, `CloudLspFragmentSchema`,
  `CloudLspSessionSchema`, `CLOUD_WS_PENDING_CLOSE_CODE` (4425),
  `CLOUD_WS_NOT_READY_CLOSE_CODE` (4503), `withRetryAfter` / `retryAfterOf`.
- `src/Cards.ts` — workspace payload `lspLanguages?: string[] | null`;
  session rows gain optional `kind` and `language`.
- `src/LspWire.test.ts` (new), `src/LocalApp.test.ts` (+3 tests).

Bun host (`apps/app/src/bun`):

- `server.ts` — the tunnel's `lsp` branch: path
  `…/workspace/sessions/{id}/(terminal|lsp)`, `CloudWsBridge.kind`, plue's
  subprotocol = the kind, a per-branch frame cap (64 KiB terminal, 1 MiB lsp)
  enforced with the branch's own 1009 reason, the server ceiling raised to
  twice the largest cap (`maxPayloadLength`) with an explicit 128 KiB check
  on `/ws`, `backpressureLimit` 4 MiB so one 1 MiB lsp frame fits, and the
  refusal classifier per kind: the lsp table maps 425 → 4425 and 503 → 4503
  and writes the reason as plue's `code: message` plus `(retry after N s)`
  when the refusal carried a `Retry-After`. The terminal branch is unchanged
  (its 425 still maps to 4409; no plue code in its reasons).
- `lsp/LspSession.ts` — imports the shared helpers (re-exported for the host
  test); `initialize` capabilities come from `LSP_CLIENT_CAPABILITIES`.
- `lsp/LspHost.test.ts` — one timing-sensitive assertion fixed (below).
- `CloudWsTunnel.test.ts` — a generalized upstream double and a new
  `describe("the workspace lsp tunnel")`.

Renderer (`apps/app/src/mainview`):

- `state/CloudLspClient.ts` (new) — the cloud transport: session POST with
  `kind: "lsp"` through `/api/cloud/`, one socket per (workspace, language)
  through the tunnel, `initialize` (`rootUri file:///home/developer/workspace`,
  `workspaceFolders`), `initialized`, `didOpen` with the card's text at its
  checkout-relative path (`didChange` full-text when the card's text moves),
  hover / definition / diagnostics with a 5 s ceiling, `{ seq, last, data }`
  reassembly capped at 16 MiB (a gap or an over-cap set is dropped whole),
  and the close-code policy: 4425/4503 retried on the `Retry-After` the
  reason names (bounded, default 30 × 2 s; `waiting` events carry the words
  verbatim), POST 503 `guest_not_ready` likewise, 1011 retried once with a
  fresh initialize and every open document re-sent, 1001/1006 redialed (≤ 3,
  reset by a healthy answer) with the in-flight requests re-issued,
  1008/1002/1003/1009/1000/44xx final with the reason verbatim to the waiting
  request and to the listeners (`closed` events), and a closed socket
  redialed only by the next act. `pageCloudLspSocketUrl`, `cloudDocumentUri`,
  `documentLanguageId` exported.
- `state/seams/CodeIntelSeam.ts` — client selection by the card's repo:
  local working copy → `LspClient`; cloud repo → the sign-in gate, the
  running workspace (the active working copy's when it is one, else the one
  running workspace; several running → "select one in the sidebar"; a
  suspended/stopped one → `/box.resume <id>`; pending/starting →
  "wait for it to settle"; none → `/box.open <repo>`), the language
  (`lspLanguageFor` against the DTO's `lsp.languages`; unsupported →
  "No workspace language server handles .md files — "review" (ws-1) serves
  typescript."), the card's whole text (a truncated or binary card is
  refused), then the cloud client. Cloud answers land only while the card
  still shows the text the client sent; diagnostics publications, `waiting`
  and `closed` events patch the cards the connection serves (open documents
  plus the cards whose act is dialing). No `cloudLsp` (no tunnel) → the
  card is told the native app has it.
- `state/AppController.ts` — builds the cloud client where the bootstrap
  carries `cloud.terminal`; `AppServices.cloudLspSocketUrl`.
- `state/AppState.ts` — `CloudWorkspaceRow.lspLanguages`.
- `state/seams/WorkspaceSeam.ts` — parses `lsp.languages` (`null` when the
  DTO has no `lsp` object, `[]` when it names none), session `kind` and
  `language`; the per-user merge keeps the collection's list; the card
  payload carries both.
- `cards/WorkspaceCard.tsx` — `headerFacts` appends `lsp: typescript` from
  `lspLanguages` (nothing when null or empty). No new facet.
- Tests: `state/CloudLspClient.test.ts` (new), `state/seams/CodeIntelSeam.test.ts`
  (cloud describe replaces the "does not relay one yet" test),
  `state/seams/WorkspaceSeam.test.ts` (+2), `cards/WorkspaceCard.test.tsx` (+1).

Docs: `docs/LOCAL-APP.md` (the cloud relay paragraph and the workspace
header line), `docs/code-intel/PLAN.md` §3 cloud paragraph (the stale "does
not relay one yet" sentence replaced by what is built).

## Tests, by name

`src/bun/CloudWsTunnel.test.ts` — "the workspace lsp tunnel" (28 tests in the
file, 10 new):

- forwards plue's lsp subprotocol and the bearer, and relays a 1 MiB JSON-RPC
  frame both ways (exactly 1 MiB passes both ways; 100 KiB passes; 1 MiB + 1
  closes 1009 "A lsp frame is larger than the upstream accepts (1024 KiB).")
- the terminal branch keeps plue's 64 KiB cap and its own reason
- a fragment set crosses the tunnel untouched, in order, for the renderer to
  reassemble
- an lsp upstream %i closes the renderer with %i, plue's code and words and
  its Retry-After in the reason, after one re-read (425→4425, 503→4503,
  409 language_server_missing→4409 with the install line, 409 kind
  mismatch, 401, 429, 500→1011)
- the terminal branch's 425 and 503 mappings are unchanged, and a plue code
  never reaches a terminal's reason
- sign-out closes an lsp bridge like a terminal one

`src/mainview/state/CloudLspClient.test.ts` (20 tests, real loopback
WebSocket server speaking the recorded transcript):

- the recorded transcript: session POST, initialize with the guest root,
  initialized, didOpen with the card's text, then the hover (also: a second
  hover reuses the socket; a changed card sends didChange v2)
- a message plue split into { seq, last, data } fragments is reassembled in
  order; a gap drops the set whole
- a publication after didOpen answers diagnostics, reaches the listeners
  with the text it is about, and the next call reads the latest without
  waiting
- a server that publishes nothing within the wait answers null items, never
  a false zero
- a definition inside the checkout is a relative location; one in the store
  is counted as omitted, never listed
- a 503 guest_not_ready on the session POST is retried on its Retry-After,
  plue's words shown meanwhile
- a guest_not_ready that never clears gives up at the bound with plue's
  words; any other POST refusal is answered once
- a pre-upgrade 4425 (session pending) is redialed after the Retry-After the
  reason names, its words shown meanwhile; the session stands
- a pre-upgrade 4503 that never clears is the refusal, in plue's words, after
  the bound
- a 409 language_server_missing renders the install line verbatim and never
  redials
- a 1011 is retried once with a fresh initialize; the second is the answer,
  verbatim, and the listeners hear it
- a 1011 on the first generation only: the retry answers, and the open
  document was re-sent to the fresh server
- an abnormal drop mid-request reconnects: a fresh initialize, the document
  opened again, the request re-issued
- close %i is final (1008, 1002, 1003, 1009): the waiting request reads the
  reason verbatim, the listeners hear it, nothing redials
- a normal close with plue's reason and nothing in flight is stated to the
  listeners, never silent; the next act dials anew
- dispose closes every socket and answers nothing after
- the page URL, the document URI and the languageId follow plue's route and
  typescript-language-server's vocabulary

`src/mainview/state/seams/CodeIntelSeam.test.ts` — "a cloud repository
(lane L6)" (5 tests; the real Bun tunnel to a plue double on the loopback):

- a running workspace answers hover, diagnostics and definition through its
  relayed language server, and the card learns each (asserts the POST body,
  the `lsp` subprotocol, the transcript, the didOpen text, the publication
  patching the card with no request, the agent door, and a later 1000
  `language_server_idle` stated on the card)
- a cloud repository without a running workspace names the act that gets
  one, on the card and to the model (open / resume / settle)
- a file no relayed language handles is told the DTO's lsp.languages; signed
  out, the sign-in step
- plue's 409 language_server_missing reaches the card and the model with the
  install line verbatim, and nothing redials
- a card cut at the cap is refused: the server would see a partial file

`src/mainview/state/seams/WorkspaceSeam.test.ts` (+2): the DTO's
lsp.languages and a session's kind and language read onto the row and the
card; a DTO without an lsp object carries null (unknown), one with an lsp
object and no languages carries an empty list (and the per-user merge keeps
the list). `src/mainview/cards/WorkspaceCard.test.tsx` (+1): the header
states `lsp: typescript` from the DTO's lsp.languages, and nothing when the
DTO named none (the absent-facts test also forbids "lsp").
`packages/rpc/src/LspWire.test.ts` (6) and `LocalApp.test.ts` (+3): the wire
conversion, the fragment and session schemas, the Retry-After codec.

## Counts

- `cd apps/app && bun x tsc --noEmit -p .` — clean.
- `bun test src/bun/CloudWsTunnel.test.ts src/bun/server.test.ts
  src/mainview/state/CloudLspClient.test.ts src/mainview/state/seams
  src/mainview/cards/WorkspaceCard.test.tsx` — 547 pass, 0 fail (23 files).
- `bun test src/mainview --timeout 30000` (once) — 1588 pass, 0 fail (147
  files, 226 s).
- `cd packages/rpc && bun test` — 163 pass, 0 fail (15 files).
- `bun test src/bun/lsp/LspHost.test.ts` — 23 pass, 0 fail (final foreground
  run after the assertion fix below); `src/bun/routes/lsp.test.ts` — 8 pass.
  One earlier run under load (right after the 226 s mainview sweep) had the
  real tsserver miss the 5 s request ceiling in three host tests (hover,
  idle clock, idle shutdown) — the load sensitivity the lane rules name; the
  two runs that followed passed.
- Final foreground confirmation: `tsc` exit 0; the gate set 547 pass again.

## Deviations, with reasons

- `language_server_missing` on a cloud card lands as `intel.state:
  "unavailable"` with the note `no typescript language server in workspace
  "review" (ws-1) — install: npm i -g typescript-language-server typescript`,
  not `state: "missing"`: `FileCards`' missing note says "on this machine",
  which would be false for a workspace, and the L4 card file was not in this
  lane's set. The install line is verbatim on the card and in the model text
  (`Workspace "review" (ws-1) has no typescript language server. Install: …`).
- The renderer cannot read HTTP headers off a refused upgrade, so the
  `Retry-After` of a 425/503 rides the tunnel's close reason in words
  (`… (retry after 2 s)`, `withRetryAfter` / `retryAfterOf` in rpc) on the
  lsp branch only; the reason is shown as it arrives. The lsp branch's
  reasons also carry plue's `code:` prefix, because three different 409s
  share one close code and only the code tells the install line apart. The
  terminal branch's reasons and codes are untouched.
- The tunnel's server-wide `maxPayloadLength` had to rise for the 1 MiB
  branch (Bun has no per-socket cap), so every branch now enforces its own
  cap explicitly (terminal 64 KiB, lsp 1 MiB, `/ws` 128 KiB) with its own
  1009 reason; the ceiling sits at 2 MiB and a frame past it is Bun's
  abnormal close.
- A cloud file card that is `truncated` (past the 16 KiB card cap) or
  `binary` is refused before any dial: `didOpen` with the card's text is the
  brief's contract, and a partial text would make every answer a lie about
  the file. Native reads from disk, so it has no such case.
- A close after the answer with nothing in flight (idle 1000, "replaced by a
  newer client") is stated on the cards as `the workspace language server
  closed: <reason> (<code>)` and the NEXT act dials anew; the client never
  redials on its own without a request, mirroring the terminal client's
  stance that a deliberate/final close is not something to loop on.
- Session POST refusals other than `guest_not_ready` are answered once, in
  plue's words (`code: message`), including plue's 400 for an unknown
  language.
- `LspHost.test.ts` "diagnostics answer the deliberate error…" pinned the
  first publication after `didOpen` as the semantic one; under load tsserver
  answers the empty syntactic pass first (reproduced 1 in 3 runs here, and it
  is the same fact the seam test already awaits across calls). The test now
  awaits the publication carrying 2551 and matches the bus frame by digest
  and total. No product code changed for it.

## Unbuilt

- The web host's relay (web-mode W4): on the Worker the three flows stay
  hidden with `local.lsp`; `CodeIntelSeam` also tells a cloud card "needs
  the native app" when no `cloudLsp` exists. Nothing on `apps/server`.
- Outgoing fragmentation: the client reassembles fragments but never sends
  them; a `didOpen` carries at most the card cap (16 KiB), far under 1 MiB.
- `code.references` / `code.symbols`, rust/go/python rows, the CodeMirror
  theme from tokens (the rest of the PLAN's L6 row) — outside this brief.
- The FileCards L4 note wording for a workspace ("on this machine") — see
  the first deviation.

## Against plue's recorded contract

- Read exactly as recorded: session POST body and 201 row (`kind`,
  `language`, same id on repeat), the route and `lsp` subprotocol, Bearer
  with no Origin, one message per text frame at 1 MiB, `{ seq, last, data }`
  from seq 1 up to 16 MiB, `rootUri file:///home/developer/workspace`,
  1000/1001/1008/1011/1002/1003/1009 semantics, 425 `Retry-After: 2`, 503
  `guest_not_ready`, 409 `language_server_missing` with `message` = the
  install line, DTO `lsp.languages` and session `kind`/`language`.
- Not exercised against production: no cloud LSP session was minted from a
  test (the rules forbid it); every wire assertion runs against loopback
  doubles built from the "Live" transcript. Two things the transcript does
  not state and the client assumes: server pings every 30 s need no reply
  beyond the browser's automatic pong (nothing to build), and the 1 MiB cap
  is per frame in BOTH directions (the tunnel enforces it renderer→plue; the
  reassembly cap covers plue→renderer).
- `binary frames refused (1003)`: the client sends text only, so 1003 can
  only be a fault; it is final, as recorded.
