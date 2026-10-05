# T-INS-05b Preview image exception (M-41)

Stage R · Size M · Depends on T-INS-02, T-INS-05 · Checks: C-J1-01, C-J1-04, C-REL-02

Issue: [#3709](https://github.com/smithersai/smithers/issues/3709) · Tracking: #3707
Spec: spec.md §1.3, §10.4.3, §16.1.0 · Product: mvp.md M-41

M-41 narrows T-INS-05's Docker-image deletion to the install path and release publishing. The preview-only Dockerfile and entrypoint remain, and the preview acceptance script and image target are added. The publishing scripts, old image acceptance script and their callers are deleted. The lifecycle scripts (`backup.sh`, `restore.sh`, `upgrade.sh`, `lib.sh`) and guard tests remain T-INS-07 port sources with no production invocation. Other T-INS-05 deletions stand.

The packaged `web-selfhost` mode still launches the old external-database topology. Its coupled deletion belongs to T-INS-05 and is outstanding; it is not acceptance evidence for this preview image (R3-38).

The preview image uses ephemeral native PostgreSQL, machines off, and no credentials. It is built for linux/amd64 off the install host and is never published as a release artifact. The backend preview build must land before the image acceptance workflow.

Acceptance: `bash distribution/test-preview.sh`, `go test ./distribution/...`, release contracts, target-index lint and docs sync/check. The preview acceptance checks the HTML shell at `GET /`, bootstrap, unauthenticated refusal, non-root execution, loopback PostgreSQL, credential-free environment/history, revision and shutdown under ten seconds.

Ready: pending smithers-8a review; no owner stamp is asserted.

The amd64 image acceptance has not run: image size, time to ready and time to stop require a real build and run. Local guard tests are not those receipts.
