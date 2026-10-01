# Models: the decisions behind the surface

The models surface lets a person create, test and assign a configured model from
chat. This page records the decisions that shaped it and the reasons, so a later
change keeps the properties that matter. The exact exports are in
`packages/rpc/src/ConfiguredModel.ts`; the manual test script is
`apps/app/e2e/real/models/MANUAL.md`.

The decision that is expensive to reverse is R4: a credential is a name pinned to
the origins it may be sent to, and a request body can never change an existing pin.
Every button is also an agent act, so a free endpoint beside a server-held key is
key exfiltration.

## R1. One contract module
`packages/rpc/src/ConfiguredModel.ts` — zod only. The rpc import law
(`packages/rpc/test/NativeAgent.test.ts:185-196`) forbids `effect` and `@smthrs/*` there.
Route path constants go in
`packages/rpc/src/AgentApiRoutes.ts` (RouteOwnership test), not in the contract module.

## R2. Model routes, under the family the README already owns
- `GET  /api/model/catalog` -> `{ models, credentials, seats }` (builtin models this host can serve, credential NAMES with `present`
  and their allowed origins, and the seat ids this host resolves). Never a value.
- `POST /api/model/test`    -> `{ model: ConfiguredModel }` -> HTTP 200 with a typed
  result for BOTH outcomes; only transport refusals use the existing envelopes.
R11 adds enrollment and receipt routes in this same family.
NOT `/api/models`, NOT `/api/model/credentials`.

## R3. The record is flat, and the name is the id
`{ id, protocol, baseUrl?, path?, modelId, credential, builtin? }`. `id` is the slug the
user types as the name; no separate label; renaming saves a copy. Kind is derived:
`modelKindOf(protocol)`. Protocols: `anthropic-messages`, `openai-responses`,
`openai-chat`, `evaluation`. Flat because the FORM LAW cannot render unions or
conditional fields.

## R4. A credential is a NAME pinned to ORIGINS — this is the security model
Exfiltration, not loopback, is the hole: agent parity means a prompt-injected agent can
file `{credential: "CEREBRAS_API_KEY", baseUrl: "https://attacker"}`. Therefore:
- `MODEL_CREDENTIALS` in the contract maps each built-in name to its allowed https
  origins: ANTHROPIC_API_KEY, OPENAI_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY,
  AI_GATEWAY_API_KEY. Built-in names read their standard env name.
- A CUSTOM credential exists on the local Bun host through R11 enrollment, or when the OPERATOR
  declares the env pair `SMITHERS_MODEL_KEY_<NAME>=<value>` and
  `SMITHERS_MODEL_KEY_<NAME>_ORIGIN=<origin>`. The mandatory prefix means the route can
  never be made to read an arbitrary env var; the declared origin is the only place that
  value may be sent. An explicitly enrolled or operator-declared origin may be loopback/private/`http:`,
  and `http:` only for loopback hosts. A `_ORIGIN` sibling of a built-in name is ignored.
- `resolveModelEndpoint(model, credentials)` refuses any baseUrl whose origin is not in
  the named credential's list: failure code `endpoint_forbidden`. A model request cannot
  introduce or change a pin.
- The Worker resolves CEREBRAS_API_KEY and AI_GATEWAY_API_KEY from ServerConfig
  and account credentials from the authenticated login's encrypted vault. It never scans env.
  Cloud pins require canonical HTTPS DNS origins on port 443; no IP literals,
  localhost or private/local names. Deployment names remain read-only.
- The value is `Redacted` from the moment it is read; it must be unable to reach a log,
  an error message, a response body, browser persistence, the DOM after submit, or a test artifact. Redirects are never
  followed (`redirect: "manual"`; a 3xx is `refused`).
R11 adds in-app key enrollment while preserving these endpoint restrictions.

## R5. Seats: only seats something reads
`MODEL_SEATS`, closed: `chat` (generation; local), `explainer` (generation; local + cloud),
`recommend` (decision; cloud). The `front-door` seat retired with the Worker front door (#3313):
chat command selection always asks Jev through `POST /api/commands/select`. A seat nothing reads is a
failed feature and MINIMAL TEXT forbids a row whose value is "not wired". The six agent roles are not seats: nothing reads them since the local backend was retired. `DECISION_MODEL_IDS = ["typesafe-ai/jev"]`.

## R6. Consumers wired
- `explainer`: the live `agent.explain` sealed side turn carries `model: ModelBinding`.
  Local Bun host serves it through a real `@smthrs/model` Route; the Worker through the
  deployment `cerebrasChat` or that same account's vault-backed provider wire. A turn carrying `model` plus tools is refused
  `tools_not_supported`; it never falls back to the upstream.
  Local bootstrap advertises `model.turn` independently of `agent`: an offline
  host can explain through an operator-declared loopback binding, while an
  unbound turn remains unavailable. The local answer is buffered up to 65,536
  characters and published once after `cutModelCredential` sanitizes the whole
  text. Partial answers on failure use the same rule; output beyond the bound
  fails `invalid · protocol`. Worker answers use that same sanitizer before
  checking for empty text or building frames. Test samples use it too.
- `recommend`: the client sends the assigned decision model id; the
  server validates against `DECISION_MODEL_IDS`; an id off the list is `request_invalid`
  400, never a silent default; absent = today's default.
- `/api/jev`, `/api/model/stream`: untouched. `keys.byok` is deleted; e2e scenarios do
  NOT use it as a capability.

## R7. Test is instant-ack background work
`model.test` returns `{ value: "Requested" }` before the fetch, runs under the shared
toast stack, dedupes, reconnects after reload, drops stale responses. One deadline
`MODEL_TEST_DEADLINE_MS = 15000` echoed in the timeout failure as `deadlineMs` — the UI
reads the number from the record, never a constant. NO retries: add the small
provider-general `maxRetries` option to `@smthrs/model` `RequestExecutor` (the default
ladder would turn one Test into many requests). The failure union carries codes,
numbers, enums and the echoed credential NAME — no server free text.
Recovery starts after identity loads or is adopted, using the account epoch, which moves only when the owner changes: a same-owner re-probe sends nothing again.
`model.list` also returns `{ value: "Requested" }`: the card persists
`refresh: { state: "requested" }` before the catalog fetch, and duplicate human
and agent requests share the background work and the `model.list` toast. The
shared 300 ms debounce covers the whole refresh. Success clears the request;
failure persists `{ state: "failed", failure: ModelTestFailure }` and offers
Retry on the failed toast. Reload reconnects pending refreshes after identity;
an earlier account's response cannot overwrite the new account's catalog.

## R8. Sign-in
Naming what a host already holds costs nothing, so `GET /api/model/catalog` is PUBLIC on
the Worker: a signed-out visitor reads the deployment's own rows (the Cerebras seat, Jev),
the credential NAMES with `present`, and the seats; a valid allowlisted session adds only
that account's own credential names and pins, never another account's. Only a spend is gated. On the Worker
`POST /api/model/test` sits behind `requireTurnSession` and spends one `loginBudget` turn,
whether the key is the deployment's or the account's own;
on the LOCAL host it needs no sign-in, because it spends the operator's own env key on
their own machine.

So the flows' `requires` must NOT be `signed-in` globally. The two acts that make a real
call — `model.test` and `model.ask` — name `signed-in-to-spend`, the host-aware row in
`flows/entries/auth.ts`. Its predicate reads `CommandState.hostSpendsOwnKey`, true only on
a cloud bootstrap that has an identity seam, and only the DEFINITIVE signed-out answer
defers. On the Worker a signed-out press parks the command and renders the house sign-in
step (`auth.prompt`), and the park resumes itself once identity is signed in; on the local
host the same press runs with nobody signed in. `sign_in_required` is therefore never a
red line on the card: it is offered as the sign-in step, and `No models.` is drawn only
for a catalog that was actually read (`host: "observed"`).

## R9. App state
Collections `app-models`, `app-seats`; nothing is seeded — builtin rows arrive through a
`models.observed` system transition built from the host's catalog answer. The controller
(`state/controller/models.ts`), NOT a `*Seam.ts`, makes the two calls
(`parity-hosts.test.ts:240` lists `model` in API_HEADS). Flows: `model.list`,
`model.new`, `model.edit`, `model.save`, `model.show`, `model.remove`, `model.test`,
`model.assign` — a FRESH namespace; never reuse a retired `agent.*` name.
The model-seat migration advances APP_PROJECTOR_VERSION from 10 to 11 without
requiring a storage schema change. Presentation reaches the
card body through `CardActions.presentation`. Follow the app's existing CSS/card idiom;
do not introduce `@smthrs/ui` form components apps/app has never imported.


## R11. In-app credential enrollment (removed)

> Superseded 2026-09-23: Smithers Cloud has no bring-your-own-key. Smithers runs models on platform keys and charges the account's credit. The `model.credential.*` flows, the Models card's Add credential / Rotate / Remove, and the local `/api/model/credential` routes are removed. The local host still reads operator env credentials and any keychain entries enrolled earlier.

## R12. The composer: the request is edited, the response is generated

Will: "we should be able to debug a call via having a UI for composing a
request and response that we can click on for a single step and have it
prefilled with that steps inputs/outputs and ability to rerun it or change
outputs", and "why am I able to edit the response? I would expect to be
editing the request and then generating a response".

One `model-call` card per configured model, opened by Compose on its row or
`/model.compose <name>`. A decision request is one JSON state and a map of
typed questions; a generation request is a system prompt, a prompt, max tokens
and temperature. The state is authored as typed FIELDS (text, code, path,
diff, terminal, boolean, number, json), each drawn by its kind, so it never
renders as raw JSON; the fields become one JSON object at the host
(`modelStateOf`). A question is added, renamed, retyped among boolean / choice
/ score, worded, given options or rungs, and removed, through controls that
are flows:
`model.question`, `model.option`, `model.state`, `model.prompt`. Every limit
the `@smthrs/model` question classes enforce (2 to 255 options, at least 2
distinct rungs, a non-empty question, a 32 KiB state) is stated once in the
contract (`modelCallProblemOf`), refused by the host's schema through it,
refused by `model.ask` before a request leaves, and shown inline as its code
and numbers while Ask stays disabled. The text bounds the wire enforces (16 KiB
texts, 128-character option names, 128 KiB field values, an integer max tokens)
are refused by the edit itself as `invalid · <control> · <limit>`, and the
controls stop at the same bounds. A value the request cannot carry is kept as
typed instead, as the request's problem, so the screen never shows one setting
while Ask sends another: the temperature is drafted as text and becomes the
wire's number only once it is one from 0 to 2 (`modelCallInputOf`), and a rung
named `__proto__`, which a plain object would take as its prototype, is named
`name_reserved` (an option or a question id so named cannot be a record key and
is refused). Max tokens commits digits alone, and 0 for anything else or for
digits past what a number holds exactly, so the box never shows a number the
draft did not take.

`POST /api/model/test` takes an optional typed `input`; with none it runs the
fixed Test it always ran. Both hosts answer the typed `output` on every pass,
so the composer prefills from the model's last recorded Test: its fixed
request and the answer it got. `model.ask` snapshots the accepted request, the
binding, the account and a request id onto the card (`pending`) before it
dispatches, is requested at once, and runs under the shared toast stack like a
Test. The draft is only a draft from then on: a reload resumes the snapshot,
never an edit or a Last test made while it was out. The answer is kept with
the request and the binding it answered; an edit after it reads stale (struck,
dimmed) until asked again, and a model rebound or removed takes the answer,
the fixture and the pending ask off its composer in the same commit, wherever
the card is kept (the transcript, an archived conversation, a frame's snapshot,
a card history), so a late answer from the old binding settles nothing. A
composer that returns from a conversation that left, a history entry or a
recovery is read against the record as it is: it keeps only an answer its
binding gave, and an ask that was out when its conversation left is over. `model.recall` returns the
composer to the last Test. `model.fixture` writes the last decision answer as
the `Evaluator.layerScripted(...)` fixture every test in the repo scripts an
evaluator with: keys are computed and JSON-quoted, so any question id is valid
JavaScript, and a score carries its distribution by rung index, so a replay
through the real evaluator and classifier has the recorded confidence.

The Bun host decodes answers with the real `Classifier.decodeAnswers`; the
Worker cannot import the classifier and decodes with the contract's
`decodeModelAnswers`, held to the classifier by a parity test over every shape
and refusal. Four hidden, agent-disclosed edit flows instead of twelve, and
shorter summaries across the namespace, because each catalog entry is paid for
out of the agent's 16 KiB instructions.

Not built, with the seam named: an operator override of an answer
(`decidedBy: human`) would live on `ModelCallCardPayload.response`, which
today holds only what a host answered; prefill from a run-trace step has no
record to read, because `control.agent.model-settled` journals the answer text
and usage and never the request.
