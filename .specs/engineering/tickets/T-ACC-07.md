# T-ACC-07 Structured setup-URL stdout handoff

Stage S1 · Size S · Depends on T-ACC-01, T-INS-01 · Unblocks T-INS-02, T-REL-02 · Issue: [#3607](https://github.com/smithersai/smithers/issues/3607)
Spec: spec.md §5.1.0 · Delta: delta.md §2 (setup token) · Product: mvp.md J1.1, J1.2
Ready: 2026-10-02 smithers-8a sha256:6600e4a7f4f7

## Goal
The backend hands the launcher all setup URLs at token mint without persisting plaintext tokens.

## Scope
Approved integration requirements (In):
- A live pre-claim setup credential allows only install status, setup steps and the required OAuth start/callback; any other action returns HTTP 403, class and code `permission`. It never becomes a person session by presenting a member id. Claim-invalidated setup sessions return HTTP 401, class `permission`, code `setup_closed`; ordinary expired or otherwise invalid setup credentials return HTTP 401, class `permission`, code `unauthenticated`. A provisional owner's person session allows install status and setup steps but returns HTTP 403, class `permission`, code `owner_unverified` on every other action. Integrate the frozen setup seam after T-ACC-01 lands; no frozen-ticket edits. Check: C-SEC-04.
In:
- One structured stdout line at mint: `{"setup_urls": [...]}` for loopback and each origin from `install_settings`.
- Restart before claim re-mints the token and replaces its digest, invalidating the old URL.
- No setup line after claim.
Out:
- Setup-session and OAuth implementation; App manifest, credentials and installation (frozen T-GH-01). T-ACC-07 owns the shared mint/claim advisory lock in claimOwner; frozen T-ACC-01 is not edited.
- Launcher relay, stdout framing and bundle environment (T-INS-02); launchd, host-start transport and repeated-start output (T-INS-08).
- Listener configuration, live Address changes and origin validation (T-INS-04); setup-step sequencing (T-INS-06).
- Printing on settings changes, exposing tokens in status or HTTP responses, persisting plaintext tokens, reconstructing URLs in the launcher, enabling repository execution, and changing setup-session expiry or claim policy.

## Changes
- `packages/backend/internal/services/setup_token.go` and native startup: read the JSON array of origins from `install_settings.public_origins`; after committing the new digest, emit one newline-terminated JSON stdout line with the sole key `setup_urls`, containing `http://localhost:4000/setup?token=…` and one setup URL for each configured origin. Every URL uses the same newly minted token. Emit no prefix or diagnostic on that line. Do not derive origins from shell settings or request headers. Update the lane fixture `owner_signin_integration_test.go:154`, which matches `^Setup URL:`, to the structured line. Check: C-SEC-04.
- MintSetupToken runs in one PostgreSQL transaction: acquire `pg_advisory_xact_lock(installSetupOwnerLockID)`, re-read InstallHasOwner inside that transaction, and upsert the digest only when no owner exists. Define one shared named constant, `installSetupOwnerLockID`, for the install-wide lock. T-ACC-07 changes claimOwner to acquire the same lock before LockInstallSetting. A claim that commits before mint acquires the lock prevents that mint and its setup line; mint that acquires it first precedes claim. Emit only after digest commit; commit failure emits nothing. Rotation replaces only the token digest. Setup-session and step-state preservation belongs to T-INS-02 and T-INS-06. Check: C-SEC-04.
- Keep the token out of stderr, application/request logs, status responses and tracing. The launcher relay and host-start terminal handoff are transports of this same line, not permission to retain it in launchd log files. smithers-b8 owns transport approval with T-INS-02/T-INS-08; smithers-3f owns backend redaction. Checks: C-SEC-04, C-SEC-02, C-INS-06.
- Replace the pre-claim digest on each restart; do not persist the plaintext token. Check: C-SEC-04.

## Tests
- Live setup non-setup=403 permission/permission; claim-invalidated setup=401 permission/setup_closed; expired setup=401 permission/unauthenticated; provisional owner non-setup=403 permission/owner_unverified. Include Merge/approval and forged member-id cases. Check: C-SEC-04.
- Relay proof without a test hook (smithers-b8): assert the launcher's printed line matches the literal fixture shape and that SHA-256 of the printed token equals the digest stored in PostgreSQL (the minted token, relayed unaltered); restart before the claim gives a different token and digest; nothing is printed after the served OAuth claim. Never tap the backend pipe inside the production launcher.
- Create `packages/backend/internal/services/setup_claim_integration_test.go` (new). Its external-process harness builds the real backend with `scripts/build-backend.sh`, uses `testkit/postgresfixture`, supplies a `SMITHERS_FLOW_HOST_MANIFEST` fixture and explicitly sets `SMITHERS_WORKSPACE_ISOLATION=process` for this test only. Launch the compiled native entrypoint against real PostgreSQL. Assert literal URL prefixes, the sole JSON key, one complete newline-terminated line and one shared nonempty token for empty origins and seeded `public_origins` values `http://lan-a:4000` and `https://box.example`. Compute SHA-256 independently. No existing test spawns this binary. Check: C-SEC-04 step 10.
- Restart before claim and assert a different token and digest only. Use the existing OAuth-start path `/api/auth/github/start?setup_token=` and served callback with fake GitHub for token refusal and claim; the lane stores the digest in `oauth_states.setup_token_digest`, not a setup session. Add mint-vs-claim ordering tests for both lock acquisition orders; the existing lane `owner_signin_integration_test.go:481` covers claim-vs-claim only. Update `owner_signin_integration_test.go:154` for JSON output. Inject digest commit failure with a deferred PostgreSQL trigger that executes RAISE, not a code hook. Test failure after commit before emission in-process through the Fprintf error path; restart must replace the committed digest. No successful setup line exists on a failed write. Check: C-SEC-04.
- Scan stdout outside the exact allowed line byte range, stderr, backend request/application logs, traces, status responses and PostgreSQL rows/dump for each minted token and its URL-encoded form. Persist only digests and redact saved evidence. The raw token travels in `/api/auth/github/start?setup_token=`; backend request logs record the path only. Proxy access logs and browser history can contain that query and are outside this no-match assertion. Post-exchange URL checks wait for T-INS-02 setup sessions. Check: C-SEC-04 step 9.
- Packaged relay acceptance in `apps/app/scripts/server-bundle.integration.test.ts` invokes the real `bin/smithers-server` with its real backend child and PostgreSQL. Assert the launcher prints one newline-terminated line with the literal `{"setup_urls": [...]}` shape and sole key `setup_urls`. Independently compute SHA-256 of the printed token and compare it with the stored PostgreSQL digest. Never tap the backend pipe inside the production launcher. Repeat restart before claim and after served OAuth claim; require a new token before claim and no setup line after claim. No logger prefix, URL reconstruction, duplicate line or setup token in ordinary logs is allowed. Checks: C-SEC-02, C-SEC-04. T-INS-02 implements the relay and owns this joint acceptance; ACC-07 backend landing does not claim relay completion.
- C-INS-06 drives real `smthrs host start` and launchd, scans `$STATE/logs/` for both tokens, and distinguishes a repeated start without backend restart from a restart that rotates. C-J1-01/02 prove the operator handoff and setup journey after their dependent tickets land. These are joint checks, not new ACC-07 runtime prerequisites.
- All URL prefixes, JSON shape, statuses, newline framing and token-digest assertions are literal fixtures maintained in tests. No test reads spec files or derives its expected output from production code at runtime.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-SEC-04](../checks/C-SEC-04.md): backend emission, token rotation and silence after claim.
- [C-SEC-02](../checks/C-SEC-02.md): verbatim bundled-launcher relay, together with T-INS-02.

## Risks and notes
- T-ACC-01 supplies digest storage and OAuth claim, not setup exchange or durable sessions. T-ACC-07 supplies mint/claim serialization. T-INS-01 supplies the native binary and bundle. Startup reaches PostgreSQL and loads `public_origins` before mint; an empty array emits loopback only. Setup-session checks wait for T-INS-02 and step-state checks wait for T-INS-06.
- Do not depend on T-INS-02, T-INS-04, T-INS-06, T-INS-08 or T-GH-01: those are downstream. ACC-07 emits stored origins even before configurable listeners land; emitter tests seed literal settings directly. LAN serving evidence completes with T-INS-04. No App credentials or installed App are needed to mint. This change enables no repository execution.
- A real backend restart rotates; an idempotent host start that leaves the backend running does not mint or emit again. T-INS-08 owns any repeat terminal handoff. A live Address change does not mint or emit; the new origin is included at the next pre-claim restart. The tech lead must resolve the C-J1-02 live-Address handoff before joint journey acceptance.
- T-ACC-01 is frozen; T-ACC-07 owns emission, restart rotation and the advisory-lock change to claimOwner.

## Decisions and owner pre-review
- smithers-3f approves digest/claim/emission ordering, origin reads, redaction and the backend-process harness. smithers-b8 approves stdout bytes and launcher/host-start transport. smithers-8a accepts the shared seam and test evidence; Will decides product-policy exceptions.
- smithers-3f answered 17:45 with these edits (blocking pre-review): shared mint/claim advisory lock, token/digest-only rotation tests, downstream session gates, compiled-backend harness, `public_origins`, fixture update and scoped redaction.
- smithers-b8: answered, BLOCKING edits applied (tech lead adopts). Packaged relay acceptance proves the literal printed JSON shape, newline and stored digest without a backend pipe tap. Checks: C-SEC-02, C-SEC-04.
- smithers-3f's blocking edits and smithers-b8's adopted 17:37 relay modes and `host.sock` decision are recorded. smithers-8a verifies the resulting draft and joint evidence before any Ready stamp.

## Ready checklist
1. Dependencies: T-ACC-01 supplies digest storage and OAuth claim; T-ACC-07 adds the shared mint/claim advisory lock. T-INS-01 supplies the native binary and bundle. PostgreSQL and `public_origins` load before mint. Rotation tests assert token and digest only. Setup-session and step-state preservation waits for T-INS-02 and T-INS-06; App setup waits for frozen T-GH-01. Relay and serving remain joint gates.
2. Exclusions: App/claim/session redesign, launcher and launchd transport implementation, listener changes, setup sequencing, token status endpoints, settings-change emission, plaintext persistence and repository execution are named in Out.
3. Tests: C-SEC-04 step 10 uses the new compiled-backend harness, real PostgreSQL, existing OAuth-start/callback routes, literal fixtures and independent SHA-256. Steps 1–8 and 11 wait for the named downstream tickets. Fprintf failure is tested in-process; commit failure uses a PostgreSQL RAISE trigger. C-SEC-02 proves packaged relay and C-INS-06 proves host-start transport.
4. Decisions: smithers-3f approves Go ordering/security, smithers-b8 approves transport, smithers-8a accepts the seam and evidence; Will decides product exceptions.
5. Owner pre-review: smithers-b8: answered, BLOCKING edits applied (tech lead adopts). Preserve smithers-3f’s recorded 18:09 recheck: ok, all 5 edits and advisories present.
6. Security: C-SEC-04 step 10 proves native emission and digest-only token storage. Session storage and post-exchange assertions wait for T-INS-02/T-INS-06/T-GH-01. Step 9 excludes OAuth-start queries in proxy access logs and browser history. C-SEC-02 and C-INS-06 prove exact relay and no launchd log copy.
