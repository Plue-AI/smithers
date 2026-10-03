# C-CAT-02 Every Appendix A row with a CLI path has flags equal to its payload schema

Proves: mvp.md §2 rule 1, §6.13 "CLI", §8 (CLI and skill), M-21, Appendix A · spec.md §5.4, §6.1.1, §6.1.2, §6.1.2a, §6.4 · Layer: unit · Stage: S1 · Tickets: T-CAT-02
Automation: `packages/smithers/test/CatalogCli.test.ts` (new) · Runs in: CI

## Setup
Use committed literal expectations in packages/smithers/test/fixtures/CatalogCli.ts, reviewed against Appendix A/B.6 when authored. Invoke makeCli().serve(argv), exercising its parser and production dispatcher with recording HTTP/app-opener adapters; assert pinned paths, flags, payloads, attribution, invalid-input refusals and mutation-free person card doors. The CLI tree, descriptors and catalog.mvp.json are actual results or supplemental parity inputs only, never runtime expectation sources. CatalogCli.integration.test.ts exercises production install routes with real PostgreSQL, delegated authorization and confirmation approval. Read no spec file at runtime.

## Steps
6. Feed recording HTTP stubs literal allow, 202 confirmation/requested, 403 never/never, 403 permission/permission, 401 permission/unauthenticated and 503 infra/confirmation_unavailable responses. Record CLI stdout, stderr and exit codes.
1. Invoke makeCli().serve(argv) with committed literal CatalogCli.ts cases through parser and production dispatcher recording adapters.
2. Run CatalogCli.integration.test.ts through production install routes with real PostgreSQL, delegated authorization and confirmation approval.
3. Compare actual command paths and parsed payloads against literal fixtures.
4. Assert pinned paths, flags, payloads, attribution, invalid-input refusals and mutation-free person card doors; descriptors and catalog.mvp.json are supplemental parity inputs only.
5. List `Definitions.ts` entries whose HTTP method and path equal a descriptor's binding.
- Dispatch a confirmable command through the installed CLI and inspect its 202 result and printed state.

## Pass when
- Step 6 prints Waiting for <person> to confirm with id/pending state for 202, makes no follow-up execution call and exits with a code distinct from refusal. Refusals preserve exact class/code and never fabricate pending/success or completion. S1 terminal immediate append and S2 ordinary confirmation remain distinct server-issued profile outcomes.
- `/terminal` resolves through `workspace ssh`, `shell` and `exec`. `/search` and `/github` status expose read-only external-agent paths. GitHub App changes are Owner-only (C-ACC-01).

- Every Appendix A row that lists `external_agent` has a resolvable CLI action path. `/secrets`, `/members` and `/settings` have only person card doors: running them opens the app card and sends no mutation. UI-only rows ⌘K, `/help`, `/stop` and `/theme` have no CLI path (§6.1.2a, mvp.md B.6).
- For every literal external-agent action case, step 3 finds zero differences from the committed fixture.
- The recording adapter receives exactly one request per external-agent action fixture, with its literal method, path, body and Smithers-Via attribution.
- Step 5 returns an empty list, so no second CLI declaration exists for a catalog action.
- The CLI reports id/pending state and Waiting for <person> to confirm with its distinct exit code.

## Fail when
- A row's CLI door is an old name, such as `history todo` for `/todo.new`.
- A TODO argument takes `#n` instead of `Tn`.
- `smthrs merge Tn` with a delegated credential merges instead of returning a person confirmation (§5.4).
- A row whose Appendix B Who column has no X exposes an external-agent mutation path, such as `smthrs secrets set`.
- A flag is optional in the CLI but required in the payload, or the reverse.
- An enum is widened to string.
- The handler builds its own URL instead of the descriptor binding.
- A test passes only against the installed rc binary.

## Evidence
Written to `.artifacts/checks/C-CAT-02/<UTC timestamp>/`:
- `cli-diff.json` (row, CLI path, differences);
- `stub-requests.jsonl`;
- `duplicates.txt`;
- `bun test` output;
- the commit SHA.
