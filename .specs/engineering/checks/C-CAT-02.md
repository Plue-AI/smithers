# C-CAT-02 Every Appendix A row with a CLI path has flags equal to its payload schema

Proves: mvp.md §2 rule 1, §6.13 "CLI", §8 (CLI and skill), M-21, Appendix A · spec.md §5.4, §6.1.1, §6.1.2, §6.4 · Layer: unit · Stage: S1 · Tickets: T-CAT-02
Automation: `packages/smithers/test/CatalogCli.test.ts` (new) · Runs in: CI

## Setup
- The source tree at the commit under test. The CLI is built in-process with `makeCli()` from `packages/smithers/src/Cli.ts`, never the installed `smthrs` binary.
- `packages/rpc/src/catalog/catalog.mvp.json`, its descriptors, and the Appendix A table parsed from `.specs/product/mvp.md` by `packages/rpc/src/catalog/mvpAppendix.ts`.

## Steps
1. For each Appendix A row, read its `cli` field in `catalog.mvp.json`.
2. Resolve each non-null path in `Cli.toCommands.get(makeCli())`, using the technique of `test/McpDocs.test.ts`.
3. For each resolved command, compare its positional args and options with the descriptor payload's zod shape:
   - key names, as the kebab-case flag of each payload key;
   - type (string, number, boolean or enum, including the enum values);
   - required vs optional;
   - positional order for `Tn`, `#n` (issues and PRs), `<name>`, `<path>` and `<branch>`.
4. Run each command's parser on the descriptor's example payload, and run the handler against a recording HTTP stub.
5. List `Definitions.ts` entries whose HTTP method and path equal a descriptor's binding.

## Pass when
- Every row has a resolvable CLI path, except the UI-only rows ⌘K, `/help`, `/stop` and `/theme`, which are exactly the `cli: null` rows (§6.1.2).
- For every resolved command, step 3 finds zero differences.
- In step 4, the stub receives exactly one request per command, to the descriptor's method and path, with a body deep-equal to the example payload and a `Smithers-Via` header present.
- Step 5 returns an empty list, so no second CLI declaration exists for a catalog action.

## Fail when
- A row's CLI door is an old name, such as `history todo` for `/todo.new`.
- A TODO argument takes `#n` instead of `Tn`.
- `smthrs merge Tn` with a delegated credential merges instead of returning a person confirmation (§5.4).
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
