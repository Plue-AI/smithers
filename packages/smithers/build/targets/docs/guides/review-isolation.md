---
title: "Review isolation"
description: "Pinned policy, immutable source, and tool-free review inference."
---

## Run a review

Use an installed CLI that you trust, outside the proposed checkout's executable
code. Select an approved commit containing a generated target index with review
policy. Generate that index only from trusted declarations with `pnpm target-index`.
Approve policy updates separately before selecting their commit as the next pin.

```bash
smthrs review '//packages/example/...' --policy-revision <approved-commit-sha> --revision <source-commit-sha>
```

`--policy-revision` requires a full commit SHA. `--revision` defaults to `HEAD`;
uncommitted edits are excluded. Add `--plan` to inspect the selected files and
revision receipts without contacting a provider. A missing policy index, missing
policy, invalid pin, matching symlink, or oversized input fails closed.

## Authority

The review command parses the approved index as JSON. It does not import
`WORKSPACE.ts`, `PACKAGE.ts`, `security.ts`, or their helpers from either revision.
Git object reads ignore replacement refs, disable lazy fetching and external
protocols, and receive no model credentials. Files are copied into a bounded
in-memory snapshot before inference; changes to the checkout cannot change it.

Changed declaration files receive a separate security review using the installed
reviewer's built-in policy. Changes to indexed review policy receive a separate
before/after JSON projection, identified as `review-policy-changes` in the result.
That projection includes added, removed, and modified policies. Its findings name
line 1 of the index; it is not a line-preserving copy of that generated file.
Candidate policy never replaces the approved policy during the review.

## Inference

Default review inference uses `@smthrs/model` with no tools. It starts no agent
process and exposes no shell, filesystem, local configuration, credentials, or
network tool to the model. The host sends requests only to the fixed Anthropic
Messages or OpenAI Responses endpoint; redirects and cookies are disabled.
Provider authentication stays in HTTP headers outside model-visible messages.

Configure `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` on the trusted host. Security
reviews use both provider families. CLI subscription logins do not authenticate
these requests. Missing credentials, truncated streams, tool calls, and output
limits fail the review; provider diagnostics are not echoed back.

The library's explicit `executable` override is a trusted-host test/extension
seam, outside this containment contract. The review command never accepts it from
flags, the index, or candidate files. Generic `promptEngine` still supports CLI
callers and withholds undeclared environment variables; it is not an OS sandbox.

## Evidence and limits

File contents are JSON-encoded data and active policy is sent as system text.
Neither framing nor wording proves resistance to a model following malicious
source comments. The enforced boundary is the absence of executable declarations
and reviewer tools, together with pinned policy and restricted outbound requests.
A model can still miss a defect. See [completion evidence](security-completion.md)
for coverage receipts and independent passes. A passing review is not proof of
safety or deployed enforcement.
