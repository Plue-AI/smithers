# C-SEC-04 Only the setup token claims the install, once; the owner can do only setup until GitHub confirms access

Proves: mvp.md J1.1, J1.2 · spec.md §5.1.0, §5.1.2, §16.2, §16.3.3 · Layer: integration · Stage: S1 · Tickets: T-ACC-01, T-INS-06 · T-ACC-07 owns the setup-URL stdout handoff and pre-claim restart rotation.
Automation: `packages/backend/internal/services/setup_claim_integration_test.go` (new), including an external-process harness for the real compiled backend in native install mode; packaged relay in `apps/app/scripts/server-bundle.integration.test.ts` with T-INS-02 · Runs in: CI (backend), macOS arm64/reference host (packaged relay)

## Setup
A fresh install bound to loopback and `0.0.0.0`, with the public origin `http://lan-a:4000` and no owner. The printed token is T. A fake GitHub provides OAuth for users B (push on the repository) and C (read only), the App JWT routes and the App installation. A fault hook orders concurrent callbacks and can kill the host between any two steps.

## Steps
1. From `lan-a`, start GitHub sign-in with no setup session. From loopback, exchange a wrong token.
2. Exchange T on loopback (setup session S1) and on `lan-a` (S2). From S1 and S2, start the GitHub App step at the same instant, and let it finish.
3. From S1, call `GET /api/todos`, `POST /api/todos` and `GET /api/members`.
4. S1 signs in as C and S2 as B, and the hook delivers both callbacks at once. Steps 4 to 8 run twice: once with C's callback first, once with B's.
5. Replay the winning callback, exchange T again, and call a setup route from the losing session.
6. As the new owner, call `GET /api/todos`, `POST /api/todos` and `GET /api/install`.
7. Kill the host and restart it.
8. The owner picks the repository and installs the App; the `setup_url` redirect carries a forged `installation_id`.
9. Search application/request logs, stderr, traces, status/response bodies, OAuth `state` values and every URL after exchange for T and its URL-encoded form. Search stdout excluding only the exact byte range of the mint line. Repeat for every replacement token. Scan PostgreSQL rows and a dump for plaintext token/session credentials; compare stored digests using independent SHA-256. Do not record raw secrets in saved evidence.
10. In a separate unclaimed install, launch the real compiled backend entrypoint against real PostgreSQL; do not call setup services in-process for this case. Capture one mint line with only loopback, then repeat with fixed stored origins `http://lan-a:4000` and `https://box.example`. Restart and capture its replacement, exchange the old and new tokens through the served route, claim through the served OAuth callback, then restart again. Test commit failure, crash after digest commit before output, and claim/startup ordering. Preserve sessions and step states across rotation.
11. With T-INS-02, launch the real bundled `bin/smithers-server`. Capture backend-pipe and launcher-output bytes, and compare the mint line including newline before claim and after pre-claim restart. Claim through served OAuth and restart; scan both outputs and ordinary logs. C-INS-06 adds the real launchd/host-start log scan. All expected prefixes, fields and refusal predicates are fixed test fixtures; no runtime spec parsing or production-code oracle.

## Pass when
- Step 1: both are refused, and no setup session or owner exists.
- Step 2: one App creation runs and the second start sees `running`; the fake GitHub holds one App.
- Step 3: every call gets 401 or 403, and nothing is written.
- Step 4: exactly one owner, the user whose callback came first. One transaction deleted the token digest and both setup sessions; the other callback gets `401 setup_closed`.
- Step 5: every request gets `401 setup_closed`.
- Step 6: the TODO routes get `{code: "owner_unverified", class: "permission"}`; `GET /api/install` succeeds.
- Step 7: the owner is still provisional, and every step state is unchanged.
- Step 8: the host reads the installation with the App JWT and ignores the forged id. Owner C stays provisional, and the step shows "needs access on GitHub ↗". Owner B gets `last_access_check_at`, and `GET /api/todos` succeeds.
- Step 9: no match.
- Step 10: the real backend emits exactly one newline-terminated JSON line whose sole key is `setup_urls`. Literal prefixes are `http://localhost:4000/setup?token=`, `http://lan-a:4000/setup?token=` and `https://box.example/setup?token=` for the three-origin fixture; all contain one shared token. The empty-origin fixture has only localhost. Restart changes token/digest, refuses the old exchange and accepts the new one. Claim and subsequent restart emit no setup line. Digest-commit failure emits nothing; a crash after commit is recovered by replacement at next startup. A committed claim prevents later emission. Session digests and step states survive rotation; only the replacement token digest is stored.
- Step 11: backend and launcher mint-line bytes are identical, with one relay and no token in any other output or ordinary log. A pre-claim restart relays the replacement; a post-claim restart emits nothing on either side. C-INS-06 also proves no token in `$STATE/logs/`. Stored evidence redacts the allowed line and every plaintext credential.

## Fail when
- Any origin accepts a claim without a setup session, or T works twice.
- Two owners exist, or a setup session survives the claim.
- A provisional owner reaches any route outside setup.
- The installation id comes from a callback parameter.
- A restart loses a setup step or the provisional state.

## Evidence
`.artifacts/checks/C-SEC-04/<ts>/`: test output, per-step request transcripts, the transaction log of each claim, the search results for T and the commit.
