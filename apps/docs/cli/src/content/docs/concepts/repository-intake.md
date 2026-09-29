---
title: "Repository intake"
description: "Screening limits for incoming repository issues, pull requests, and replies."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/concepts/repository-intake.md"
---

## Complete screening

Repository intake screens each issue, pull request, comment, and author reply
before passing it to the coding model. It accepts at most 64 nonempty texts,
with each complete JSON-encoded classifier input at most 32 KiB in UTF-8,
including repository, title, body, and author. It never clips these fields.

Exceeding either limit stops the run with `incomplete screening` before any
classifier request or downstream model call. Reduce the incoming content and
retry. An unavailable or partly answered classifier also stops the run.

The `flows.repository.intake-screened.v1` journal receipt records every text's
identifier, encoded byte count, and whether it received a successful answer,
alongside the total and screened counts. Failed preflight screening records
zero screened texts. Receipts use the existing optional, lossy journal channel;
the typed failure stops the run even when no journal is installed.
