# T-ACC-07 Structured setup-URL stdout handoff

Stage S1 · Size S · Depends on T-ACC-01, T-INS-01 · Unblocks T-INS-02, T-REL-02 · Issue: [#3607](https://github.com/smithersai/smithers/issues/3607)
Spec: spec.md §5.1.0 · Delta: delta.md §2 (setup token) · Product: mvp.md J1.1, J1.2

## Goal
The backend hands the launcher all setup URLs at token mint without persisting plaintext tokens.

## Scope
In:
- One structured stdout line at mint: `{"setup_urls": [...]}` for loopback and each origin from `install_settings`.
- Restart before claim re-mints the token and replaces its digest, invalidating the old URL.
- No setup line after claim.
Out:
- Claim, setup-session and OAuth implementation (frozen T-ACC-01); App manifest, credentials and installation (frozen T-GH-01).
- Launcher relay, stdout framing and bundle environment (T-INS-02); launchd, host-start transport and repeated-start output (T-INS-08).
- Listener configuration, live Address changes and origin validation (T-INS-04); setup-step sequencing (T-INS-06).
- Printing on settings changes, exposing tokens in status or HTTP responses, persisting plaintext tokens, reconstructing URLs in the launcher, enabling repository execution, and changing setup-session expiry or claim policy.

## Changes
- `packages/backend/internal/services/setup_token.go` and native startup: read the committed origins from `install_settings`; after committing the new digest, emit one newline-terminated JSON stdout line with the sole key `setup_urls`, containing `http://localhost:4000/setup?token=…` and one setup URL for each configured origin. Every URL uses the same newly minted token. Emit no prefix or diagnostic on that line. Do not derive origins from shell settings or request headers. Check: C-SEC-04.
- Serialize owner claim, digest replacement and emission so a committed claim prevents any later mint or setup line. Do not emit before digest commit; commit failure emits nothing. A crash between commit and emission produces no usable terminal handoff; the next restart replaces the digest and emits the new line. Preserve setup sessions and step states. Check: C-SEC-04.
- Keep the token out of stderr, application/request logs, status responses and tracing. The launcher relay and host-start terminal handoff are transports of this same line, not permission to retain it in launchd log files. smithers-b8 owns transport approval with T-INS-02/T-INS-08; smithers-3f owns backend redaction. Checks: C-SEC-04, C-SEC-02, C-INS-06.
- Replace the pre-claim digest on each restart; do not persist the plaintext token. Check: C-SEC-04.

## Tests
- Relay proof without a test hook (smithers-b8): assert the launcher's printed line matches the literal fixture shape and that SHA-256 of the printed token equals the digest stored in PostgreSQL (the minted token, relayed unaltered); restart before the claim gives a different token and digest; nothing is printed after the served OAuth claim. Never tap the backend pipe inside the production launcher.
- Extend `setup_claim_integration_test.go` with an external-process harness that invokes the real compiled Go backend entrypoint in native install mode against real PostgreSQL. Do not call the emitter or service directly. Use an empty database and then fixed configured origins `http://lan-a:4000` and `https://box.example`; assert literal URL prefixes, the sole JSON key, one complete line and one shared nonempty token. Do not fix a random token value. Derive the expected digest independently with SHA-256, not the production token helper. Check: C-SEC-04.
- Kill and restart the process before claim. Require a different token and digest, refusal of the old token through the served setup exchange, success of the new token, and unchanged setup-session digests and step states. Complete the owner claim through the served OAuth callback using fake GitHub, then restart and require zero setup lines. Inject digest-commit failure and a crash after commit; order claim against restart to prove no post-claim line. Check: C-SEC-04.
- Scan all captured stdout outside the allowed line, all stderr, request/application logs, traces, status responses, setup URLs after exchange, and PostgreSQL rows/dump for each minted token and its URL-encoded form. The allowed line is excluded by exact byte range, not by dropping every line with a setup_urls key. Persist only digest values. Fail on a copied token anywhere else. Redact raw lines and tokens in stored check evidence. Check: C-SEC-04.
- Packaged relay acceptance in `apps/app/scripts/server-bundle.integration.test.ts` invokes the real `bin/smithers-server` with its real backend child and PostgreSQL. Capture the backend pipe and launcher terminal output, and compare the mint line byte-for-byte, including newline. Repeat restart before claim and after served OAuth claim. No logger prefix, URL reconstruction, duplicate line or setup token in ordinary logs is allowed. Checks: C-SEC-02, C-SEC-04. T-INS-02 implements the relay and owns this joint acceptance; ACC-07 backend landing does not claim relay completion.
- C-INS-06 drives real `smthrs host start` and launchd, scans `$STATE/logs/` for both tokens, and distinguishes a repeated start without backend restart from a restart that rotates. C-J1-01/02 prove the operator handoff and setup journey after their dependent tickets land. These are joint checks, not new ACC-07 runtime prerequisites.
- All URL prefixes, JSON shape, statuses and byte-comparison rules are literal fixtures maintained in tests. No test reads spec files or derives its expected output from production code at runtime.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-SEC-04](../checks/C-SEC-04.md): backend emission, token rotation and silence after claim.
- [C-SEC-02](../checks/C-SEC-02.md): verbatim bundled-launcher relay, together with T-INS-02.

## Risks and notes
- T-ACC-01 must have landed mint/claim serialization, digest storage, setup exchange and durable setup-session storage. T-INS-01 supplies the native binary and bundle used at the production boundary. Startup must reach PostgreSQL and load the persisted origins before minting. An empty origin list emits loopback only. These are landing preconditions, not service-test substitutes.
- Do not depend on T-INS-02, T-INS-04, T-INS-06, T-INS-08 or T-GH-01: those are downstream. ACC-07 emits stored origins even before configurable listeners land; emitter tests seed literal settings directly. LAN serving evidence completes with T-INS-04. No App credentials or installed App are needed to mint. This change enables no repository execution.
- A real backend restart rotates; an idempotent host start that leaves the backend running does not mint or emit again. T-INS-08 owns any repeat terminal handoff. A live Address change does not mint or emit; the new origin is included at the next pre-claim restart. The tech lead must resolve the C-J1-02 live-Address handoff before joint journey acceptance.
- T-ACC-01 is frozen; this follow-up owns emission and restart rotation.

## Decisions and owner pre-review
- smithers-3f approves digest/claim/emission ordering, origin reads, redaction and the backend-process harness. smithers-b8 approves stdout bytes and launcher/host-start transport. smithers-8a accepts the shared seam and test evidence; Will decides product-policy exceptions.
- Before start, smithers-3f answers: (1) Does claim serialization prevent emission after committed claim? (2) Does restart preserve sessions/steps through commit and emission failures? (3) Does the real binary test prove sole-line leakage and digest-only storage?
- Before start, smithers-b8 answers: (1) Does the real launcher relay exact bytes with no reconstruction or log copy? (2) Can launchd/host start relay without retaining the token in log files and without rotating on repeated start? (3) Does the bundled test prove pre-claim rotation and post-claim silence through served OAuth?
- Record each owner's answer and evidence here. The 17:05 b8 answer approved the earlier handoff shape; review of these boundary and log requirements remains pending. Do not mark owner pre-review done or add Ready until both owners answer. Each review has the README's 30-minute turnaround.

## Ready checklist
1. Dependencies: T-ACC-01 provides digest storage, exchange, claim serialization and durable sessions; T-INS-01 provides the native binary and bundle. PostgreSQL and committed origins load before mint. Empty origins need only loopback. Downstream relay, serving and service tests are explicit joint gates, not circular dependencies.
2. Exclusions: App/claim/session redesign, launcher and launchd transport implementation, listener changes, setup sequencing, token status endpoints, settings-change emission, plaintext persistence and repository execution are named in Out.
3. Tests: C-SEC-04 launches the real backend binary with real PostgreSQL and served exchange/OAuth routes. C-SEC-02 invokes the real bundled launcher and compares both sides of the relay. C-INS-06 drives launchd/host start. Literal fixtures and independent digest computation supply expectations; no runtime spec/code-derived oracle.
4. Decisions: smithers-3f approves Go ordering/security, smithers-b8 approves transport, smithers-8a accepts the seam and evidence; Will decides product exceptions.
5. Owner pre-review: both owners must answer the three concrete questions above before stamping; current strengthened review is pending. Record answers with dates, then smithers-8a computes the reviewed file digest with the Ready line omitted.
6. Security: C-SEC-04 executes native startup, setup exchange, real OAuth claim and restart; it asserts digest-only token/session storage and zero token occurrences outside the exact mint line. C-SEC-02 and C-INS-06 assert relay bytes and no launchd/application-log copy. smithers-3f and smithers-b8 review these executable preconditions before start.
