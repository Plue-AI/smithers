# Check evidence

```sh
node scripts/checks/run-check.mjs C-STK-01
node scripts/checks/run-check.mjs C-ACC-04 --subcase owner-claim-and-refusals --sha <40-hex-sha>
node scripts/checks/run-check.mjs C-INS-05 --upload
node scripts/checks/qualify.mjs --gate G-THIN
node --test scripts/checks/run-check.test.mjs
```

Literal Automation argv runs without a shell. Prose needs a reviewed binding in
`commands.mjs`; missing files or bindings are NOT IMPLEMENTED. The acc bindings
cover owner claim separately. Full roster, provisional-owner and native-startup
coverage stay unbound until their real runners are reviewed. `thin.mjs` names the
finite obligations and their ticket/environment authority; an empty subcase list
means the entire check. `s1-person-merge` excludes S3 learning and has no binding yet.

Evidence defaults to `.artifacts/checks/<check>/<UTC>/`. `--evidence-root` changes
the parent directory. Each attempt has exclusive filenames, source snapshots,
sanitized stdout/stderr, `result.json`, and a detached SHA-256 manifest. Files are
sealed read-only. Concurrent/repeated timestamps advance by one millisecond.

Local execution PASS and durable qualification are separate. `--upload` checks
gcloud credentials and copies sealed bytes to the authorized evidence bucket.
Its immutable sibling `<UTC>.upload.json` records the transfer and the result
digest. Authentication or transfer failures preserve the local execution result.
G-THIN also requires durable evidence; a local-only PASS is BLOCKED at the gate.
Reviewer retrieval/hash verification and evidence retention remain QA/ops work.

Go uses the QA cache and four workers. Database cases require an allocated
PostgreSQL 18 URL; microVM cases require the verified absolute msb 0.6.16 path.
Reference/browser/device profiles require `appendices/executors.json` bindings.
The activation profile conflict stays BLOCKED pending the plan's 8a ruling.
Resource admission refuses overload or low disk with a two-minute retry reason.
No install, clone, silent skip, or alternate test runner is inferred.

Targets: `//scripts:checkRunner`; opt-in, uncached `//scripts:thinQualification`.
