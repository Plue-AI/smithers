# Review implementations

`../flow.ts` is the catalog entry. `workflow/` supplies typed actions, file batches, verification and narration. `review/` holds prompts, filters, anchoring and deduplication. `git/` reads git and jj changes through the host process service. `walkthrough/` and `diffs/` render the authored result and self-contained artifact. `text/` holds small formatting helpers. `github/` retains reusable GitHub review-formatting helpers.

The runtime, model aliases, credentials, filesystem, process policy and budgets come from the normal flow host. The implementation exports no standalone service or CLI. See [the flow contract](../README.md).
