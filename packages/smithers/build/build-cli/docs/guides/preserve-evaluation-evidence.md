---
title: "Preserve evaluation evidence"
description: "Retain benchmark receipts outside a source checkout without weakening generated-file restoration."
---

## When a generated target refuses the checkout

The write-set guard refuses a gitignored snapshot above 50,000 entries or
1 GiB. Evaluation journals, patches, grading reports, and review receipts
are evidence: being ignored does not make them disposable or regenerable.
Do not raise the limits or add evidence to `Cache.hostDirectories`.

Before relocating a completed evaluation, its owner must stop every writer
and retain the entire run, including its ledger, subject fingerprint,
dataset identity, source revision, grading configuration, and review receipts.
Record missing provenance explicitly; moving files cannot make an
unreproducible historical measurement reproducible.

Use durable storage outside the checkout. Record a sorted inventory of
relative paths, file SHA-256 digests, modes, modification times, directories,
and symlink targets. Check that relative links resolve inside the retained
run. Preserve links themselves when copying or archiving, and verify the
inventory after relocation and after a trial restore. Keep a second verified
copy before retiring the original location. Record the owner, storage
location, checksums, restoration command, and verification receipt in the
owning issue. Local copies alone are not an off-host backup.

Do not leave a checkout symlink to external evidence: an external symlink
creates another filesystem boundary for the guard to protect. The SWE-bench
driver already accepts an external `FB_DIR`. Retain committed reports in the
source checkout. Never run evaluation, report, replay, or regrading tools
against retained originals or backup copies: reporting can write scorecards
and checkpoints. Restore into a new external working directory, verify it,
and point tools at that disposable copy with explicit manifest and journal
paths. Preserve the verified evidence separately from any new output.

## Verify the original target

Keep developer data, including `.backend-go-modcache`, present. Rerun the
exact refused command and retain its exit status and complete target summary:

```bash
pnpm exec smthrs target '//apps/site:apiDocs' --write
```

A launch receipt or a successful archive verification does not establish
target completion. Preserve any remaining failure and its owning issue.
