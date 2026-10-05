# T-INS-05b Preview image exception (M-41)

Issue: [#3709](https://github.com/smithersai/smithers/issues/3709) · Tracking: #3707
Spec: spec.md §1.3, §10.4.3, §16.1.0 · Product: mvp.md M-41

M-41 withdraws T-INS-05's deletion of `distribution/Dockerfile`, `entrypoint.sh`, `test-preview.sh`, `PACKAGE.ts`, `.dockerignore` and `distribution.yml`. The image publish path, `test-image.sh`, `publish-image.sh` and their callers were deleted in the commit carrying this ticket (#3709). The lifecycle scripts (`backup.sh`, `restore.sh`, `upgrade.sh`, `lib.sh`) and guard tests are retained as T-INS-07 port sources with no production invocation. Other T-INS-05 deletions stand, and its scan allows the files above.

The preview image uses ephemeral native PostgreSQL, machines off, and no credentials. It is built for linux/amd64 off the install host and is never published as a release artifact. The backend preview build must land before the image acceptance workflow.

Acceptance: `bash distribution/test-preview.sh`, `go test ./distribution/...`, release contracts, target-index lint and docs sync/check. The preview acceptance exercises Home, bootstrap, unauthenticated refusal, non-root execution, loopback PostgreSQL, credential-free environment/history, revision and shutdown under ten seconds.

Ready stamp remains with smithers-8a.
