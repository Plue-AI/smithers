---
title: "Context preflight"
description: "Host-owned context selection and durable replay."
---

`ContextPreflightInputSchema` validates pinned provider candidates and defaults the token budget to 24000. Files and wiki pages require revisions; issues are excluded. `SelectedContextItemSchema` requires a selection reason.

`projectContextPreflight` folds ordered pages and exposes completion only after the last page. Persist `ContextPreflightProgressSchema` to resume interrupted replay. Legacy unpaged frames remain readable. Inconsistent sequences throw `ContextPreflightRejected` with code `invalid_page_sequence`; malformed frames fail schema validation.
