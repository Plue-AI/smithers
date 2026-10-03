# C-SEC-04 Only the setup token claims the install, once; the owner can do only setup until GitHub confirms access

Proves: mvp.md J1.1, J1.2 · spec.md §5.1.0, §5.1.2, §16.2, §16.3.3 · Layer: integration · Stage: S1 · Tickets: T-ACC-01, T-INS-06 · T-ACC-07 owns the setup-URL stdout handoff and pre-claim restart rotation.
Automation: `packages/backend/internal/services/setup_claim_integration_test.go` (new), including an external-process harness for the real compiled backend in native install mode; packaged relay in `apps/app/scripts/server-bundle.integration.test.ts` with T-INS-02 · Runs in: CI (backend), macOS arm64/reference host (packaged relay)

## Setup
A fresh install with real PostgreSQL. Step 10 seeds `public_origins` directly and uses the compiled backend built by `scripts/build-backend.sh`, `testkit/postgresfixture`, a `SMITHERS_FLOW_HOST_MANIFEST` fixture and test-only `SMITHERS_WORKSPACE_ISOLATION=process`. Only step 10 is implementable on the current lane without downstream setup work; the new harness must still be written. Steps 1–8 use T-INS-02 setup sessions, T-INS-06 durable setup routes, T-GH-01 App setup and fake GitHub, and T-INS-04 LAN serving. Order concurrent callbacks with test barriers; no production fault hook is added.

## Steps
11. On separate fixtures, test live setup Merge, merge-gating approval and forged member-id requests; expire a setup credential without claim and retry. Test provisional owner status/setup versus non-setup commands, and owner-delegated versus lower-role delegated setup/status.
1. From `lan-a`, start GitHub sign-in with no setup session. From loopback, exchange a wrong token. Waits on T-INS-02 setup sessions and T-INS-04 LAN serving.
2. Exchange T on loopback (setup session S1) and on `lan-a` (S2). From S1 and S2, start the GitHub App step at the same instant, and let it finish. Waits on T-INS-02 sessions, T-INS-06 step compare-and-set and T-GH-01 App creation.
3. From S1, call `GET /api/todos`, `POST /api/todos` and `GET /api/members`. Waits on T-INS-02 setup-session authorization and T-INS-06 routes.
4. S1 signs in as C and S2 as B, and the hook delivers both callbacks at once. Steps 4 to 8 run twice: once with C's callback first, once with B's. Waits on T-INS-02 session-bound claim and T-GH-01 App OAuth.
5. Replay the winning callback, exchange T again, and call a setup route from the losing session. Waits on T-INS-02 session invalidation and T-INS-06 routes.
6. As the new owner, call `GET /api/todos`, `POST /api/todos` and `GET /api/install`. Waits on T-INS-06 install routes and T-GH-01 access verification.
7. Kill the host and restart it. Waits on T-INS-02 durable sessions and T-INS-06 durable steps.
8. The owner picks the repository and installs the App; the `setup_url` redirect carries a forged `installation_id`. Waits on T-GH-01 installation verification and T-INS-06 setup sequencing.
9. Search backend application/request logs, stderr, traces, status/response bodies and OAuth state values for each token and its URL-encoded form. Search stdout outside only the exact mint-line byte range; scan PostgreSQL for plaintext credentials and compare digests with independent SHA-256. The raw token is permitted in the OAuth-start query `/api/auth/github/start?setup_token=`. Backend logs record the path only; proxy access logs and browser history can retain the query and are outside this assertion. Post-exchange URL and setup-session credential checks wait for T-INS-02; setup response checks wait for T-INS-06 and T-GH-01. Redact saved evidence. Backend token checks wait on T-ACC-07.
10. With T-ACC-07 and T-ACC-01, launch the compiled native backend against real PostgreSQL using the Setup harness. Capture mint output for empty origins and seeded `public_origins` values `http://lan-a:4000` and `https://box.example`. Restart and compare token/digest only. Reject the old token and claim with the new one through the existing OAuth-start/callback routes and fake GitHub; restart after claim. Test both mint-vs-claim lock orders and commit failure with a deferred PostgreSQL RAISE trigger. Separately test failure after digest commit before emission in-process via the Fprintf error path, then restart. Session and step preservation is tested in steps 2 and 7 after T-INS-02/T-INS-06 land, not in this rotation case.
11. With T-INS-02, launch the real bundled `bin/smithers-server`. Capture backend-pipe and launcher-output bytes, and compare the mint line including newline before claim and after pre-claim restart. Claim through served OAuth and restart; scan both outputs and ordinary logs. C-INS-06 adds the real launchd/host-start log scan. All expected prefixes, fields and refusal predicates are fixed test fixtures; no runtime spec parsing or production-code oracle. Waits on T-INS-02 packaged relay and sessions, T-GH-01 App OAuth; T-INS-08 supplies the C-INS-06 service transport.

## Pass when

- T-INS-06 running-step recovery: kill after durable running admission and after external success before completion. Recovery uses the same operation id with a new fence, reconciles before repeating an effect and atomically writes completion plus projection. A released stale worker cannot overwrite it. Interrupted image recovery executes repository recipes only inside isolation and keeps provider/App secrets sealed on the host.
- Step 11 live setup non-setup, Merge and approval return exactly 403 permission/permission; setup stays memberless despite a submitted member id. Claim-invalidated setup returns 401 permission/setup_closed; ordinary expired/invalid setup returns 401 permission/unauthenticated. Provisional owner remains a person session: status/setup allows, every other action returns 403 permission/owner_unverified. Delegated owner setup/status returns 403 never/never; lower delegated roles return 403 permission/permission. No refusal creates a confirmation, approval, fence, outbound row or effect.
- Step 1: both are refused, and no setup session or owner exists.
- Step 2: one App creation runs and the second start sees `running`; the fake GitHub holds one App.
- Step 3: every live pre-claim setup non-setup call gets HTTP 403, class permission, code permission, and nothing is written.
- Step 4: exactly one owner, the user whose callback came first. One transaction deleted the token digest and both setup sessions; the other callback gets `401 setup_closed`.
- Step 5: every request gets `401 setup_closed`.
- Step 6: the provisional owner session TODO routes get HTTP 403 permission/owner_unverified; GET /api/install and setup steps succeed.
- Step 7: the owner is still provisional, and every step state is unchanged.
- Step 8: the host reads the installation with the App JWT and ignores the forged id. Owner C stays provisional, and the step shows "needs access on GitHub ↗". Owner B gets `last_access_check_at`, and `GET /api/todos` succeeds.
- Step 9: no match in the stated capture surfaces. OAuth-start query copies in proxy access logs and browser history are excluded; post-exchange assertions require T-INS-02.
- Step 10: one complete newline-terminated JSON line has the sole key `setup_urls`. The empty-origin fixture has only `http://localhost:4000/setup?token=`; the configured fixture also has literal prefixes `http://lan-a:4000/setup?token=` and `https://box.example/setup?token=`, with one shared token. Independent SHA-256 matches the stored digest. Restart changes token/digest; old-token OAuth start is refused and the new token claims once. Claim followed by restart emits nothing. Claim-first lock ordering prevents mint and emission; mint-first ordering completes the digest transaction before claim. Commit failure emits nothing. Fprintf failure leaves a committed digest that the next startup replaces. No session or step-state preservation assertion is made by this step.
- Step 11: backend and launcher mint-line bytes are identical, with one relay and no token in any other output or ordinary log. A pre-claim restart relays the replacement; a post-claim restart emits nothing on either side. C-INS-06 also proves no token in `$STATE/logs/`. Stored evidence redacts the allowed line and every plaintext credential.

## Fail when
- Any origin accepts a claim without a setup session, or T works twice.
- Two owners exist, or a setup session survives the claim.
- A provisional owner reaches any route outside setup.
- The installation id comes from a callback parameter.
- A restart loses a setup step or the provisional state.

## Evidence
`.artifacts/checks/C-SEC-04/<ts>/`: test output, per-step request transcripts, the transaction log of each claim, the search results for T and the commit.
