---
title: "Issue acceptance evidence"
description: "Completion evidence and linked remaining requirements for landed changes."
---

A prepared commit and a successful push do not establish issue completion.
Acceptance receipts bind one disposition per issue to the exact checked revision.

`complete` names criteria quoted from the issue and evidence quoted from executed
checks, with no remaining requirements. `landed` keeps the issue open and names a
concrete remaining condition linked to an issue. A bundle can contain both
kinds. Missing issues, invented criteria or evidence, failed checks, and
completion with unresolved requirements are rejected.

The acceptance validator checks receipt structure and citation binding. Full
acceptance still requires final review of the entire issue, actual executed
evidence, and any remaining requirements. A passing scoped check cannot replace
a broader acceptance gate, deployment check, or observed cache hit requirement.

Issue receipt writes attempt every issue and retain failures for retry. Only a
verified complete disposition permits closure. A landed prerequisite reports
its commit and linked remaining condition without closing the issue.

One durable landing receipt records either confirmed landing or verified
acceptance. A confirmed landing never permits closure. Verified receipts retain
their acceptance evidence, so losing the separate acceptance file does not lose
recovery. Older verified receipts remain readable.

Generated validators are qualified through the existing coding host deployment
bundler (`flows/coding/build.mjs`) and the native Node source runtime. The gate
compiles the actual deployment host graph without launching it and checks its
validator bindings. It executes generated review, push, and verified-replay
programs from the validator bundle with valid and malformed receipts. It preserves fail-closed validation after that transform;
custom minifiers and other bundlers are outside this qualification.
