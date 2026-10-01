# Models: manual test script

Every step names what to do and what you must see. Anything else is a bug.
Run the steps in order: each one uses what the steps before it left behind.
Step 13 composes a request and asks it. No paid key is needed before step 14.
The automated receipt is step 15.

A credential is a NAME pinned to an origin. Enroll its value in the local
macOS keychain or the signed-in production account vault (PRODUCTION below). Model records carry only the name.

## 0. Before you start

```sh
df -h /System/Volumes/Data      # Avail must read at least 2Gi
lsof -nP -iTCP:47400 -iTCP:47500 -sTCP:LISTEN   # must print nothing
cd ~/smithers/apps/app
pnpm build:web
```

See: `✓ built in …`. The build writes about 20 MB to `dist/`.

## 1. Terminal A: the loopback provider

```sh
cd ~/smithers/apps/app
SMITHERS_MODEL_PROVIDER_KEY=sk-loopback-will-0123456789abcdef \
SMITHERS_MODEL_PROVIDER_PORT=47500 \
SMITHERS_MODEL_PROVIDER_SLOW_MS=30000 \
bun e2e/real/support/model-provider.ts
```

See: `{"event":"ready","origin":"http://127.0.0.1:47500","port":47500}`

Check it refuses a request with no key:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:47500/v1/chat/completions \
  -H 'content-type: application/json' -d '{"model":"e2e-answers"}'
```

See: `401`

## 2. Terminal B: the app, without model environment keys

> Enrollment steps below are removed (2026-09-23, no bring-your-own-key). Declare keys as operator env pairs instead.

```sh
cd ~/smithers/apps/app
SMITHERS_LOCAL_PORT=47400 SMITHERS_LOCAL_MODE=hybrid \
SMITHERS_LOCAL_STATE_DIR=/tmp/smithers-models-manual \
bun src/bun/serve.ts
```

See: `SMITHERS_LOCAL_ORIGIN=http://127.0.0.1:47400`. Open that address in
Chrome. No sign-in is needed. Use a fresh state directory for a fresh vault.

1. Cmd+K, `/model.list`, Enter. Click New and open Credential.
2. Choose Add credential. In its embedded form enter Name `LOOPBACK`, Origin
   `http://127.0.0.1:47500`, API key `sk-loopback-will-0123456789abcdef`.
3. Tab to Add and press Enter. See: the password clears immediately. Chat
   stays usable; a slow keychain operation keeps the shared toast running.
   The credential picker gains LOOPBACK only after host completion.
4. Open `/model.credential.new`. Enroll `REVOKED` on the same origin with
   `sk-revoked-will-0123456789abcdef`. The form accepts a value once; reload
   never restores it.
5. Restart Terminal B with the same state directory. Reload, `/model.list`.
   See both names. The keys were restored from macOS keychain, not the browser.

On the cloud host Add credential requires sign-in and the optional vault key.
An unavailable vault reads Vault unavailable; signed out reads Sign in required.
Off macOS the local host reads Keychain unavailable. A locked keychain fails visibly and can
be retried after unlocking. Nothing claims successful in-memory-only enrollment.

## 3. Create

1. Press Cmd+K, type `/model.list`, press Enter.
   The command acknowledges `Requested` immediately. With a slow catalog, the
   shared `Loading models…` toast appears after 300 ms and stays until the
   catalog answers. A repeated `/model.list` joins the same refresh. Chat
   remains usable. A failed refresh shows its typed code; a visible toast
   settles as failed with Retry;
   `/model.list` retries it. Reload during the request: the refresh resumes.
   See: a `Models` card. It lists only the host's own rows (`cerebras`
   `generation`, when `CEREBRAS_API_KEY` is exported in Terminal B), or
   `No models.` A host row has a `Test` button and no `Edit` or `Remove`.
   Without `SMITHERS_LOCAL_MODE=hybrid` the host is offline and lists no host
   row at all: it could reach none of them.
2. Click `New`.
   See: a form with `Name`, `Protocol`, `Base URL`, `Path`, `Model`,
   `Credential`, `Cancel` and `Save`. This model form stores only credential names. `Save` stays
   disabled until Name, Protocol, Model and Credential are filled.
   `Credential` is a pick list: the five built-in names, then `LOOPBACK` and
   `REVOKED`, then Add credential. A built-in name whose key the host lacks reads
   `ANTHROPIC_API_KEY · missing` and cannot be picked.
3. Fill: Name `loopback-chat`, Protocol `openai-chat`, Base URL
   `http://127.0.0.1:47500`, Model `e2e-answers`, Credential `LOOPBACK`.
   Leave Path empty. Click `Save`.
   See: the Models card gains the row `loopback-chat` `generation`, first in
   the list, with `Test`, `Edit` and `Remove`. The card carries no sentence of
   explanation.

A name is lowercase letters, digits and dashes, starts with a letter, and is
at most 40 characters. Save the same form with Name `Loopback Chat`.
See: the form stays open and reads `invalid · name`.

The card in the transcript shows four rows, led by the model you last saved or
tested, then `+N` for the rest. `Maximize card` shows every row.

## 4. Test, green

Click `Test` on `loopback-chat`.

See at once: the row's dot shows running, `Test` is disabled, and chat still
works (press Cmd+K and type; the composer accepts it).
See within a second: the dot turns green and the row reads a latency such as
`31 ms`.

In a third terminal:

```sh
curl -s http://127.0.0.1:47500/__journal | tail -c 400
```

See: `"status":200`, `"authorized":true`, a `credentialSha256`, and no
`sk-loopback` anywhere.

## 5. The key never reaches the browser

1. Open DevTools, Network. Click `Test` again. Open the `test` request
   (`POST /api/model/test`).
   See: the payload holds `"credential":"LOOPBACK"`. Search the payload and the
   response for `sk-loopback`: no match. The response is
   `{"ok":true,"latencyMs":…,"sample":"loopback pong","output":{"kind":"generation","text":"loopback pong"}}`.
2. DevTools, Elements: press Cmd+F, search `sk-loopback`: no match.
3. Open `GET /api/model/catalog` in Network.
   See: credential names, `present` flags and origins. No value.

## 6. It is listed after a reload

Press Cmd+R. Press Cmd+K, type `/model.list`, press Enter.
See: `loopback-chat` is there, with its last green result.

## 7. Failures. Each shows a typed code, and `Test` stays available

After a failed test the card's pill reads `FAILED` and the card shrinks to the
failed row and one button. The button is `Edit` when the record is wrong (a,
d, e, f, g below) and `Test` when it is not (b, c, h: a rate limit, a timeout,
a provider that is down). The failed toast carries the same button.
`/model.list` brings the list back.

From here on there are more than four models, and the card in the transcript
shows four. Find a row in the maximized card (`/model.list`, `Maximize card`),
which lists every model. A pane row carries `Test` and `Compose`; click the row
and its facts carry `Edit` and `Remove` too. `Edit` and `Compose` return to the
transcript.

| # | Create this model (other fields as in step 3) | Click `Test`. See on the row | Journal |
| --- | --- | --- | --- |
| a | Name `revoked`, Credential `REVOKED` | `refused · 401` | one new entry, `"status":401`, `"authorized":false` |
| b | Name `limited`, Model `e2e-rate-limited` | `refused · 429`, within a second | exactly one new entry, `429`. A Test never retries |
| c | Name `slow`, Model `e2e-slow` | running for 15 seconds, then `timeout · 15000 ms`. Chat stays usable while it runs | one new entry |
| d | Name `garbled`, Model `e2e-garbled` | `invalid · protocol` | one new entry, `200` |
| e | Name `elsewhere`, Base URL `http://127.0.0.1:47501` | `endpoint_forbidden`, instantly | no new entry. The host never dialed out |
| f | Name `remote`, Base URL `https://example.com` | `endpoint_forbidden`, instantly | no new entry. `LOOPBACK` is pinned to the origin you declared and nothing else |

g. A name nobody declared. Press Cmd+K and run:

```
/model.save --name undeclared --protocol openai-chat --model e2e-answers --credential HOME --url http://127.0.0.1:47500
```

Click `Test` on `undeclared`. See: `credential_unknown · HOME`, and no new
journal entry. `HOME` is set in the host's environment, and the host still
refuses to read it: only `SMITHERS_MODEL_KEY_<NAME>` with its `_ORIGIN` is a
credential.

c, again, across a reload. Click `Test` on `slow` and reload while its dot is
running. See: one resumed `test` request in Network, a running toast, then
`timeout · 15000 ms` and a settled failure toast. The pending request is not
silently discarded by the identity read during boot. The journal gains two
entries: a Test is idempotent, so the resumed one dials again.

h. Provider down. Press Ctrl+C in Terminal A. Run `/model.list`, click
`Maximize card`, click `Test` on `loopback-chat`. See: `unreachable`. Start
Terminal A's command again. Click `Test`. See: green.

i. Mend a failure. On `revoked`, click `Edit`. See: the pane returns to the
transcript and the form opens filled in. Set Credential
`LOOPBACK`, click `Save`, click `Test`. See: green.

## 8. Edit and remove

1. On `garbled`, click `Edit`. The form opens filled in. Change Model to
   `e2e-answers`. Click `Save`. Click `Test`. See: green. Reload, run
   `/model.list`: still one `garbled` row, still the new model id (step 10
   shows where the id is drawn).
2. Saving under a new Name creates a second model. The name is the id.
3. On `limited`, click `Remove`. See: the row is gone at once. Reload, run
   `/model.list`: still gone.

## 9. A decision model

Click `New`. Name `loopback-jev`, Protocol `evaluation`, Base URL
`http://127.0.0.1:47500`, Model `e2e-answers`, Credential `LOOPBACK`. `Save`.
See: the row `loopback-jev` `decision`.

Click `Test`. See: green with a latency. The journal's new entry reads
`"protocol":"evaluation"` and carries `"ai-model-id":"e2e-answers"`.

Click `Edit`, set Credential `REVOKED`, `Save`, `Test`. See: `refused · 401`,
and exactly one new journal entry, protocol `evaluation`. Nothing else was
asked in its place.

Click `Edit`, set Credential `LOOPBACK`, `Save`, `Test`. See: green. Step 13
composes from this Test.

## 10. The card, maximized, and the seat

1. Run `/model.list`. Press Tab to `Maximize card`, press Enter.
   See: the card fills the pane, focus is on `Restore`. Left: every model.
   Right: the selected model's `Protocol`, `Model`, `URL`, `Credential`, and a
   table with the columns `Seat` and `Model`. The `undeclared` model's
   Credential reads `HOME · missing`.
2. Click the `garbled` row. See: its facts, with Model `e2e-answers` from
   step 8.
3. The local host lists one seat, `Explainer`. Open its list.
   See: `Default`, then `cerebras` and your generation models. `loopback-jev`
   is not offered: a decision model cannot take a generation seat.
4. Press Escape. See: the card is back in the transcript and focus is on
   `Maximize card`.

## 11. Assign a seat and see it answer

There are three seats. The local host serves `Explainer`. The cloud host
serves all three.

### Explainer (local host, no sign-in)

1. Seat unassigned. Press Cmd+K and run `/agent.explain the loopback provider`.
   See: an `Explain: the loopback provider` card. If the host has an agent, it
   answers in paragraphs and its last line reads
   `asked for the Explainer role (Kimi K3); the serving side chooses the model`.
   The provider journal gains no entry.
2. Run `/model.list`, `Maximize card`, and in the `Explainer` row pick
   `loopback-chat`. The same act by slash: `/model.assign explainer loopback-chat`.
3. Press Escape. Run `/agent.explain the loopback provider` again.
   See: the answer paints once when the provider finishes. It is exactly
   `loopback pong`, the provider's fixed reply, and
   the card's last line reads `loopback-chat`. The journal gains one entry,
   `"protocol":"openai-chat"`, `"status":200`, `"authorized":true`.
4. Reload. Run `/model.list`, maximize.
   See: `Explainer` still reads `loopback-chat`.
5. Offline. Restart Terminal B with `SMITHERS_LOCAL_MODE=offline` and the same
   state directory. Reload. `Test` on `loopback-chat`: green. Run
   `/agent.explain the loopback provider`. See: `loopback pong`. In the
   `Explainer` row pick `Default` and ask again. See: no new Explain card, and
   `There is no agent on this host to explain with.` The offline host never
   reaches a cloud agent. Restart Terminal B as in step 2 (`hybrid`) and reload.
6. A provider that says the key back. On `garbled` (step 8), `Edit`, set Model
   `e2e-echoes`, `Save`. Run `/model.assign explainer garbled`, then
   `/agent.explain what the provider was sent`.
   See: `your key is` with no key in the answer, response frames, DOM or stored
   state. The provider sends nested credential fragments across three deltas;
   the host sanitizes the complete answer before publishing it.
7. Run `/model.list`, maximize. See: `Explainer` reads `garbled`. Click
   `Remove` on `garbled`. See: the row is gone and `Explainer` reads
   `Default`. `/model.assign explainer default` hands a seat back without
   removing the model. `loopback-chat` is still listed; step 12 tests it.
### Recommendations (cloud host, signed in)

Not run for this script: it needs the deployed backend and a signed-in
account. The automated proof is `src/mainview/state/controller/models.test.ts`
and the Worker's route tests.

1. On the cloud app, sign in and run `/model.list`, `Maximize card`.
   See: two seat rows, `Explainer` and `Recommendations`, and a host row
   `typesafe-ai-jev` `decision`.
2. In `Recommendations` pick `typesafe-ai-jev`. Do anything that refreshes the
   next-step pills. Open `POST /api/recommend`.
   See: the payload carries `"model":{"protocol":"evaluation","modelId":"typesafe-ai/jev","credential":"AI_GATEWAY_API_KEY"}`.
3. A decision model whose id is not `typesafe-ai/jev` on a built-in credential
   is refused: the request answers 400 `request_invalid`. It never falls back.

## 12. Rotate, remove, and use your own endpoint

> Superseded 2026-09-23: Smithers Cloud has no bring-your-own-key. Smithers runs models on platform keys and charges the account's credit. The `model.credential.*` flows, the Models card's Add credential / Rotate / Remove, and the local `/api/model/credential` routes are removed. The local host still reads operator env credentials and any keychain entries enrolled earlier.

1. `/model.list`, Maximize card. In Credentials, press Rotate for LOOPBACK.
   The embedded form has its name and a blank API key, with no editable origin.
   Enter the revoked fixture from step 2 and press Rotate. Test `loopback-chat`:
   see `refused · 401`, and the journal gains the revoked key's SHA-256 only.
2. Rotate LOOPBACK back to the provider's accepted key. Test: green.
3. Add credential with Name LOOPBACK and Origin `https://example.com`.
   Submit any fixture key. See `exists`; the original pin and value still work.
4. In the maximized Credentials section, Remove LOOPBACK. Its value is gone;
   Test on `loopback-chat` reads `credential_missing · LOOPBACK`, without
   contacting the provider. Reload: still removed. Its pin remains reserved;
   Add cannot repin the name.
5. Rotate LOOPBACK to the provider's accepted key once more: Rotate restores a
   value on that same origin. Test `loopback-chat`: green. Step 13 asks through
   this credential.
6. Only with Ollama running. Add credential: Name OLLAMA, Origin
   `http://127.0.0.1:11434`, API key `anything-nonblank`. New model: Name
   `ollama-qwen`, Protocol `openai-chat`, Base URL `http://127.0.0.1:11434`,
   Model one you have loaded, Credential OLLAMA. Save, Test. No host
   environment edit or restart is needed.

`http:` is allowed only for loopback. Other origins must use `https:`. Built-in
credential names retain their predefined provider pins. Environment-declared
keys remain read-only; rotate or remove those in the host environment. A custom
Path belongs only to `openai-chat`.

For agent parity, ask the agent to enroll a credential with a name and origin.
See a confirmation before any key is collected. Confirm opens the human's key
form. Never put an API key in chat or a slash command.

Reload while a submission is pending: a completed host receipt resolves it.
If no receipt exists, see `interrupted`; Retry asks for the key again. It never
replays a persisted key, and a duplicate press never rotates or repins anything.

## 13. Compose a request and ask

The request is yours to edit; the answer is the model's. Nothing on the card
edits an answer. What is on screen is what `Ask` sends.

1. On `loopback-jev` (tested green at the end of step 9), click `Compose`.
   See: a `loopback-jev` card with one state field `text` = `The sky is blue.`,
   one question `ok` of kind `boolean`, its answer `yes · 0.97`, and a green
   latency: the Test you ran, prefilled. Buttons: `Ask again`, `Last test`,
   `Fixture`.
2. Click `Add question`. See: `q1`, kind `boolean`, an empty question, the
   line `question_empty · q1` and `Ask again` disabled. The answers above are
   struck: the request no longer matches what they answered.
3. Set `q1`'s kind to `choice` and type `Which is it?` as its question. See:
   `options_count · q1 · 0`. Click `Add option` twice and type `the sky`
   beside `option1`.
4. Click `Add question` again. See: `q2`. Set its kind to `score` and type
   `How sure?` as its question. See: `rungs_count · q2 · 0`. Click `Add rung`
   twice. See: `rung1`, `rung2`, the line is gone and `Ask again` is enabled.
5. Type `pick` over `q1` and leave the box. See: the block reads `pick` with
   its kind, wording and options kept.
6. Click `Add field`, set its kind to `boolean`, tick it.
7. Click `Ask again`. See at once: the card's pill reads running and chat still
   works. See within a second: per question, `ok` `yes · 0.97`, `pick`
   `option1 · 0.97`, `q2` `rung2 · 1`, and a latency. The journal's new entry
   carries `"questions":["ok","pick","q2"]` and the state as one JSON object
   with `"field1":true`.
8. Edit any question. See: every answer struck and dimmed, nothing removed.
   Click `Last test`. See: the fixed request and the Test's answer are back.
9. Click `Fixture`. See: an `Evaluator.layerScripted(() => ({ ... }))` block
   with one line per question, `["ok"]: { probability: 0.97 }`, and `Copy`.
10. A generation model never tested. `New`: Name `loopback-fresh`, other
    fields as in step 3. `Save`, then `Compose` on it. See: `System`,
    `Prompt` = `Reply with the single word: ok`, `Max tokens` 32,
    `Temperature` empty, `Ask`, and no `Last test`.
11. Type a system prompt, the prompt `ping?` and Temperature `3`. See: `3`
    stays in the box, the line `temperature · 0–2`, and `Ask` disabled. Type
    `0.2` over it and click `Ask`. See: `loopback pong` and a latency; the
    journal's entry reads `"system":true` and `"temperature":0.2`. Change the
    prompt to `pong?`. See: the words struck until you ask again. Paste more
    than 16 KiB into `Prompt`. See: the box stops at 16 KiB and the card keeps
    what it holds. Set the prompt back to `pong?`.
12. The ask that is out is the request you asked. `New`: Name `slow-fresh`,
    Model `e2e-slow`, other fields as in step 3. `Save`, then `Compose` on it.
    See: `Ask`, no answer and no `Last test`; it was never tested. Type the
    prompt `A`, click `Ask`, and while the pill reads running change the
    prompt to `B` and reload. See: one resumed `test` request in Network whose
    `input.prompt` is `A`, the pill running again, while the box still reads
    `B`; after 15 seconds `timeout · 15000 ms`, struck, because it answered
    `A`.
13. An answer belongs to the binding that gave it. On the `slow-fresh`
    composer click `Ask again`, and while it runs `Edit` the model
    `slow-fresh`: Model `e2e-answers`, `Save`. See at once: the composer is no
    longer running, the `timeout` line is gone and the button reads `Ask`.
    Wait 15 seconds. See: nothing lands; the old binding's answer is not
    evidence about the new one.
14. Reload. See: the composer cards are still there with their requests and
    answers.
15. Run `/model.list`, click `Maximize card`, click `loopback-jev`, click
    `Compose` in the detail pane. See: the pane closes and the composer is at
    the tail.

Cmd+K doors for the same acts: `/model.compose loopback-jev`,
`/model.ask loopback-jev`, `/model.recall loopback-jev`,
`/model.fixture loopback-jev`.

## 14. One real paid call

The loopback provider cannot prove a vendor accepts our bytes. With
`CEREBRAS_API_KEY` exported in Terminal B's shell, run `/model.list`.
See: a host row `cerebras`. Click `Test`. See: green with a real latency
(228 ms when this script was written). Its detail reads Model `qwen-3.8-27b`,
URL `https://api.cerebras.ai`, Credential `CEREBRAS_API_KEY`.

Then `New`: Name `cerebras-revoked`, Protocol `openai-chat`, Base URL
`https://api.cerebras.ai`, Model as on the `cerebras` row, Credential
`REVOKED`. `Test`. See: `endpoint_forbidden`. `REVOKED` is pinned to your
loopback origin, so the vendor never sees it.

## 14b. Production, signed out

Open https://smithers.sh in a private window and run `/model`.
See: the deployment's own models listed, and the seats. Not `No models.`, and
no red line.

Click `Test`. See: the sign-in step in the chat, and no `POST /api/model/test`
in Network. Sign in, and the Test you asked for runs by itself.

## 15. The automated receipt

```sh
cd ~/smithers/apps/app
lsof -nP -iTCP:47401 -sTCP:LISTEN     # must print nothing
SMITHERS_REAL_PORT=47401 SMITHERS_CHAT_STUB=0 pnpm run test:e2e:real --grep models --trace off
```

If port 47401 is taken, leave its owner alone and use another number in both
lines. `SMITHERS_MODEL_PROVIDER_PORT=<port>` fixes the loopback provider's
port; unset, the runner takes a free one before the host boots.

See: `24 passed` in about two minutes. The command then prints the quality gate.
The gate's errors, if any, name other specs, never `models.spec.ts`.

The enrollment scenario reads the actual OPFS SQLite tables after the UI steps,
checks the host request log, and checks the provider journal's SHA-256 values.
It uses real browser input, the real local host and the real macOS keychain.
Playwright tracing remains off for credential entry.


## PRODUCTION — smithers.sh

> Superseded 2026-09-23: Smithers Cloud has no bring-your-own-key. Smithers runs models on platform keys and charges the account's credit. The `model.credential.*` flows, the Models card's Add credential / Rotate / Remove, and the local `/api/model/credential` routes are removed. The local host still reads operator env credentials and any keychain entries enrolled earlier.

Prerequisite: the operator has installed optional `MODEL_VAULT_KEY` (DEPLOY.md).
Until then, Vault unavailable is expected; deployment models still work.

1. Sign out, run `/model`. See deployment models only. Add credential is disabled
   with Sign in required. Sign in with your GitHub account and run `/model` again.
2. New → Credential → Add credential. Enter a name such as `MY_PROVIDER`, the
   provider's exact HTTPS origin (no path or port), and your API key. Press Add.
   The key clears immediately, Chat stays usable, and the toast settles after
   storage and catalog reconciliation. Never paste a key into Chat.
3. Create a model using `MY_PROVIDER`, its protocol, model id and Base URL.
   Test it. See green with latency. Compose → Ask also uses this account key.
4. In DevTools → Network, inspect credential, catalog, receipt and Test responses.
   Search each response for the key: no match. The enrollment REQUEST is the
   sole write-only ingress and necessarily contains it. Do not export a HAR or
   enable tracing. Elements and browser storage must contain no key.
5. Reload and run `/model`. The credential name and pin remain. A pending request
   with a completed host receipt reconciles; an unknown receipt says interrupted
   and asks for a fresh key. No value is restored or resent.
6. Maximize Models → Credentials → Rotate `MY_PROVIDER`. Enter a replacement key,
   submit, then Test again. The origin is not editable. Add the same name with a
   different origin: see exists; its original pin remains.
7. Assign the model to Explainer and run `/agent.explain hello`. It uses that
   account's provider. Set Explainer back to Default when finished.
8. Remove `MY_PROVIDER`. Test reads `credential_missing · MY_PROVIDER` without a
   provider call. Reload: the name and pin remain, present is false. Rotate can
   restore a key; Add cannot repin the name.
9. In another browser profile, sign in as a different GitHub account and run
   `/model`. `MY_PROVIDER` is absent. Sign out there: only deployment rows remain.
   Inspect responses again after rotation/removal: none contains either key.
