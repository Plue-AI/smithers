# Review

`/review` is a registered `Flow.make("review", ...)` flow. It reads a working-copy change (including jj), a commit, or a revision range, reviews files in bounded batches, independently verifies findings, and produces a narrated walkthrough. `review/change` remains available for the focused child prompt.

Run it through the normal app flow catalog or `smthrs flow start review --payload '{"repo":"."}'`. The host supplies the engine, identity, permissions, filesystem, process launcher, model aliases, policy, and budget. The module exports implementations only; it does not start a service, create an engine, resolve credentials, or choose a budget. Review and verification use the host's `sol` alias; narration uses `luna`.

The typed result retains findings, coverage gaps, warnings, story and artifact receipts. Its `ui: { kind: "html", title, html }` field uses the common authored result renderer: an isolated iframe in the embedded run card. Any other flow may return the same shape. Scripts cannot access the app, navigate the parent, submit forms, or fetch external resources. The generated walkthrough also remains a self-contained HTML artifact.

All repository reads and commands go through the caller's filesystem and process services. Cancellation interrupts model calls and host child processes. Timeouts preserve partial findings and visibly mark failed or unverified work. The host's exhausted budget prevents model calls; no private review billing or proxy exists.

The old standalone app, CLI, HTTP service, sessions, publishing, billing proxy and quiz are removed. Walkthrough RPC responses and the app expose sections only; historical database quiz data remains readable without affecting sections, and new writes store an empty legacy column. Recovery source: commit `2ad6fe2afcd2e45d81587b62f79d51b4ab02ae0d`, paths `apps/review/`, `.github/workflows/review.yml`, `.github/workflows/pr-review.yml`, and the former `flows/review/flow.mdx`. Track migration and deferred product work in [#3388](https://github.com/smithersai/smithers/issues/3388).

`smthrs review <pattern>` remains the independent build-system verb for declared model-review targets.

Validation: `bun test flows/review/tests`, `bun evals/review-seeded-bugs/run.ts`, and `bun test apps/app/src/mainview/cards/RunResult.test.tsx`. The deterministic seeded-bug baseline is preserved. App command tests cover bare `/review` and JSON input through the common provision/Plan/Run path. `apps/tui/test/review-module-flow.test.ts` covers real TUI discovery, native host launch, completion and identical result/artifact HTML; its offline evaluator avoids provider calls and its native isolation helper must be installed. Tests use real discovery, registry loading, engine, git/jj and platform services; only model responses and explicit host-refusal/failure branches are injected. No percentage coverage claim is made by these receipts.

The Mermaid runtime is a committed, compressed resource measured with the flow closure. Regenerate after dependency updates using `node flows/review/scripts/generate-mermaid-runtime.mjs`; verify with `--check`.
