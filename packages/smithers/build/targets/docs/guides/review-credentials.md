---
title: "Review credentials"
description: "Protect credentials during model reviews and rotate discoveries privately."
sidebar:
  order: 7
---

Reviews scan every bounded changed and context file, including host-supplied
immutable snapshots, and the review prompt and rubric before inference. Detected
values become stable typed placeholders in prompts, policy, answers and
diagnostics. Findings contain names and locations without values. Sample-like
values, such as `test-` prefixes, paths and URLs, are masked without a finding.
Pattern screening cannot recognize every credential format; inspect unfamiliar
credentials locally before review.

Default reviews use tool-free provider requests. Trusted executable overrides
run outside the workspace with a disposable home and an engine-specific
environment. They receive only the selected engine's API authorization, without
CLI login files. This isolates configuration; it does not sandbox the override.

Pass `onCredentials` to `LlmLint.review` or `LlmReviewLive` to deliver discoveries
to a trusted private rotation receiver before inference. The callback receives
only `{ file, line, name }` records, once per review. Delivery failure stops the
review with a generic error and never starts inference. Cancellation interrupts
pending delivery. No callback runs when the scan finds no credentials.

The host workflow owns durable retry, deduplication and failure receipts. Hosted
receiver configuration belongs in the private deployment repository. Without a
callback, findings are private rotation signals, not delivery receipts. Never
copy credential values into public issues or comments. Review findings do not
prove that credentials were rotated.
