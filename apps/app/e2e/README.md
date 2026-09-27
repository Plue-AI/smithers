# End-to-end tiers (`apps/app/e2e/`)

| Tier | Script                               | Runner                 | Specs                    |
| ---- | ------------------------------------ | ---------------------- | ------------------------ |
| T1   | `pnpm --filter smithers-app test:e2e` | `playwright.config.ts` | `playwright/*.spec.ts`   |
| T2   | `bun run test:e2e` (repository root) | `packaged/run.ts`      | `packaged/*.e2e.test.ts` |
| Real | `pnpm --filter smithers-app test:e2e:real` | `scripts/run-real-e2e.ts` | `real/**/*.spec.ts` |
| Showcase | `pnpm --dir apps/app showcase [id...]` | `playwright.showcase.config.ts` | `showcase/cases/*.case.ts` |

T1 builds the SPA through `playwright/webserver.ts`, runs
`scripts/browser-test-host.ts` on port 47311 with `SMITHERS_CHAT_STUB=1`,
and drives it with headless Chromium. Individual specs use `page.route`
and `page.routeWebSocket` for their fixture seams.

T2 builds the stable Electrobun package and launches its real executable with
the production native renderer. A test-only, bearer-authenticated HTTP bridge
binds `127.0.0.1` only when the runner supplies `SMITHERS_E2E_BRIDGE=1`; DOM
evaluation crosses Electrobun's own WebView RPC. The local origin, its HTTP
routes and the native renderer are production implementations.

Every test gets a temporary home and uses the app's persisted local origin, so
relaunch tests exercise production origin selection without touching the user's profile. An atomic suite lease
and per-test marker are cleared only after process and fixture cleanup. A dead
prior lease is removed and fails preflight once; rerun after inspecting the
stale-fixture report, or set `SMITHERS_E2E_RECOVER_STALE=1` to repair and
continue explicitly. Failure logs, reports, and best-effort screenshots land
under `test-results/electrobun-packaged/`. T2 currently requires macOS and
network access to the public fixture remote.

## The showcase (`showcase/`)

One file per case, `showcase/cases/<id>.case.ts`, default-exporting
`showcase({ id, order, title, summary, flows, run })`. `run` drives the T1
host with the T1 fake-backend fixtures through `app` (open, slash, say, press,
click, type, show, maximize) and `backend` (cloud, signedOut, json, route).
The harness fails a case whose `flows` did not all actually run.

`pnpm --dir apps/app showcase` records every case (`showcase <id>` records
one), turns each video into a GIF, and rebuilds `showcase-out/index.html`
with a coverage table over the flow registry (`showcase/coverage.ts`; its
`UNAVAILABLE` list names what cannot run on this host). Recording needs
`ffmpeg` and `gifski` (`brew install ffmpeg gifski`). `showcase-out/` is
gitignored: the GIFs are several megabytes each and change on every
recording. The PR browser tier runs the same cases without recording.

## The real tier (`real/`)

The real tier has no doubles. `scripts/run-real-e2e.ts` builds the SPA, boots
an isolated local host in hybrid mode with `SMITHERS_CHAT_STUB=0`, drives it
with Chromium through `playwright.real.config.ts`, and then runs the coverage
gate (`scripts/check-real-e2e.ts`). `real/coverage/README.md` holds the
scenario contract the gate enforces. Arguments pass through:

```sh
pnpm --filter smithers-app test:e2e:real --grep models
bun apps/app/scripts/check-real-e2e.ts   # the structural gate alone, no browser
```

`SMITHERS_REAL_PORT` moves the host off 47321, `SMITHERS_SKIP_SPA_BUILD=1`
reuses `dist/`, and `SMITHERS_REAL_BASE_URL` points the suite at a deployed
canary instead of booting a host.

`real/run-inspection.spec.ts` compares the deployed frontend's sources with
this checkout through jj, or through git on a clone without jj; the deployed
revision must be fetched. Its coding host claims need the API image's pin,
which no product endpoint serves. An operator with cluster access sets
`SMITHERS_REAL_HOST_PIN_CONTEXT` to the kube context of the deployment under
test (production is `gke_plue-prod-1771780303_us-central1_plue-cluster`).
Without it, each scenario records a `HostPinUnread` annotation and skips only
the claims that need the pin.

`real/models.spec.ts` tests a configured model against a provider the runner
owns. A custom model credential is a NAME the operator declares as an env pair
before the host boots: `SMITHERS_MODEL_KEY_<NAME>` holds the value and
`SMITHERS_MODEL_KEY_<NAME>_ORIGIN` is the only origin that value may be sent
to. The runner launches `real/support/model-provider.ts` on a free loopback
port, mints two per-run values, and declares both pairs at that origin:
`E2E_LOOPBACK` (the key the provider accepts) and `E2E_REVOKED` (a well-formed
key it answers 401). `playwright.real.config.ts` forwards every
`SMITHERS_MODEL_KEY_*` variable to the host under test. The specs type only the
names, and assert that neither value reaches the DOM, any request or response
between the page and its host, or the provider's journal, which holds a sha256.
Those scenarios are `host:local` only: a deployed Worker cannot reach a
loopback provider. `real/models/MANUAL.md` is the same walk by hand.

### Waiting after a navigation or a reload

`page.goto` and `page.reload` both resolve while the app is still fetching its
view chunk and opening its store, so an assertion made straight after one
spends its budget inside the boot skeleton and then reports the element it
wanted as missing. An absence assertion made there is worse: it passes, because
nothing has rendered yet.

Use `awaitBoot(page, kind, startedAt)` from `real/support/index.ts` after a
navigation, and `reloadApp(page)`, which is `page.reload` plus `awaitBoot`, in
place of a raw reload. Both wait up to `BOOT_TIMEOUT_MS` (120 s) for the
booted view and record what the wait cost. `startedAt` is a
`performance.now()` reading taken before the navigation, so the recorded time
covers the whole navigate-to-boot. `reloadBootTimings()` returns every boot
this worker measured, each tagged `navigate` or `reload`, and
`reloadBootFact` summarises them into the `timeline-reload-boot-ms` evidence.

"Booted" is `BOOTED_SELECTOR`, and it is matched attached rather than visible,
because a restore produces one of two layouts. In the chat layout the
transcript is present and not busy, `[data-testid="transcript"][aria-busy="false"]`.
In the tab layout a tab body is the active one,
`[data-testid^="tab-body-"]:not([hidden])`. Every tab body stays mounted and
the inactive ones carry `hidden`, the main body with the transcript inside it
included (`src/mainview/App.tsx:516`, `src/mainview/tabs/TabBodies.tsx:43`), so
a reload that restores a durable card or terminal tab leaves the transcript
attached with `aria-busy="false"` and hidden for as long as that tab is
active. Waiting for it to be visible there spends the whole 120 s on a signal
that layout cannot produce and then names the transcript, which is the one
thing that was never wrong. Neither half of the selector exists inside the boot
skeleton, which is the whole page while the view chunk loads (`role="status"`,
`aria-label="Loading view"`, `src/mainview/ViewSkeleton.tsx:2`), so the wait is
still false for exactly as long as the app is still booting, and it is one
locator on one budget rather than a fallback tried after the first has spent
its own.

Measured 2026-09-20 against the canary from the persistent production profile
`~/.multi-e2e-profile`, build 9eefdba7:

| Sample | Time to booted view |
| --- | --- |
| First scenario invocation, 4 reloads | 12.3, 12.6, 18.8, 20.9 s |
| One scenario walk, 14 reloads, two canary redeploys under it | 16.8 s min, 45.8 s median, 72.5 s max |
| 12 idle reloads, no scenario activity | 12.3 s min, 18.3 s median, 24.9 s max |
| One cold `page.goto`, same profile | 11.8 s |

The idle series climbed from 12.3 s to 24.9 s while the profile's stored bytes
stayed at 91.9 MB, so the boot slows with the age of the browser session
rather than with the size of the store, and a scenario's own activity
multiplies it. A cold navigation starts at 11.8 s and climbs the same way, so
Playwright's 15 s assertion default is a coin toss on the first navigation and
loses outright later in a walk. Re-measure when the profile's store is pruned.

The waits are bounded above the measurement, not above the test: the real
project's own `timeout` is 90 s, so a boot that never finishes fails the test
first. The point of the bound is that the wait names the booted view, so a
genuine failure reads as "the boot did not finish" instead of blaming the
element that was being looked for. Waiting for boot never delays a real
failure, because it returns as soon as the view exists.

A raw navigation without `awaitBoot` remains correct where the next step
navigates again, reads only an API response, or expects the app NOT to boot —
the OPFS schema-fault case in `navigation-frames.spec.ts` waits for
"Smithers failed to start" instead.

`contracts/` holds the assertion contracts both tiers share: pure predicates
that decide what counts as evidence, each with its own Bun test.
`assistantReplyEvidence.ts` requires a completed assistant bubble rendered
after the user turn a send appended, so the bubbles the app renders at boot
never read as a reply to it. `//apps/app:unitTests` runs `contracts/` alongside
`src`, and `packaged/run.ts` reruns it in preflight.

`native/` holds the main-process subprocess probe driven by
`src/bun/Main.test.ts`; see `native/README.md`.

## The sign-in round trip

`playwright/signin-return.spec.ts` runs the repository page's sign-in door
round trip in T1 against a loopback OAuth fixture: the door carries
`return_to`, the fixture signs the visitor in and redirects back with the
`signed-in` marker the Worker adds, and the app must land on the same
repository page, drop the marker and the door, and read the account back.
`apps/server/src/index.test.ts` pins the Worker's half of that contract.
Against a deployment, the real tier's `auth.oauth-return-to-deferred-resume`
and `auth.sign-out-reauth-restart` scenarios run the same trip through GitHub
with the leased persistent profile; no test reads a GitHub password.

## The identity the suites run as

Open sign-in
is on and the permission tiers behind it stay deliberately narrow, so the e2e
and canary suites run as a scoped-down signed-in user and prove the product
works under the permissions a real visitor has. A suite that authenticates as
the factory admin is green while the product refuses everyone else, which is
the permission bug the suite exists to catch.

`codeplanesmithers` is that scoped-down account. It is a plain GitHub login: it
must not appear in the identity Worker's `ADMIN_LOGINS`, must not hold a
maintainer claim on any repository, and must not appear on the hand-seeded
closed-alpha roster `CANARY_ALLOWLIST_LOGINS`. The server-side canary carries
its session in `$CANARY_SESSION_COOKIE` and its login in
`$CANARY_SESSION_LOGIN`; those variables are documented in
`apps/server/DEPLOY.md`, under "The canary and e2e suites sign in as a
scoped-down user".

T1's server doubles answer with the same account. `playwright/identity.ts`
holds it once, `SCOPED_TEST_USER` for `/api/auth/session` and
`SCOPED_TEST_USER_CLOUD_SESSION` for `/api/cloud-auth/session`, so no spec
invents a login of its own. `allowlisted` is `true` there because open sign-in
makes identity answer `true` for every login (Factory spec 01 §3); the
privilege is the `admin` claim and the seeded roster, never that flag. A spec
that genuinely needs a maintainer or an admin says so in the spec, with the
reason, rather than raising the constant for every other spec.
