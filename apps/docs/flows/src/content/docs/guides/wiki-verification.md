---
title: "Wiki verification"
description: "Citation confidence, publication, and reuse in the repository wiki flow."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/docs/guides/wiki-verification.md"
---

## Verification and reuse

The wiki flow combines semantic review with citation checks. A citation judged
with confidence below 0.8 makes an otherwise supported section uncertain.
Each check carries at most 8 KiB of the claim and 32 KiB of JSON state. Clipped
claims and source excerpts end on complete Unicode code points.
Semantic uncertain and unsupported findings remain unchanged. The original
reviewer and citation-check receipts remain in the execution attempt store;
the snapshot contains the combined assessment.

Uncertain sections produce a `needs-changes` draft and fail verified mode.
They cannot supply a supported review for incremental reuse. Selecting that
execution as the prior review requires a fresh semantic review. A refresh may
select an older verified execution instead; its reused review still passes the
current citation check before publication. Confident unrelated or contradictory citations refuse publication.
Support at confidence 0.8 or above preserves fully supported behavior.

Reuse requires matching source evidence and review policy. Changing the workflow
invalidates reviews captured under its previous policy, including carried pools.
These checks establish the publication protocol; they do not certify any page
without reviewing its actual sources.
