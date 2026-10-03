# T-FLW-10 Plans cite wiki page revisions

Stage S3 · Size S · Depends on T-FLW-02, T-APP-17, T-STK-01, T-APP-02, T-UI-04, T-ACC-03 · Unblocks T-COL-09, T-REL-02 · Issue: [#3465](https://github.com/smithersai/smithers/issues/3465)
Spec: spec.md §10.4.1 (plan cites wiki revisions), §10.4.3, §13.4, §15.1.2 · Delta: delta.md §8 (no row; research/collab-terminals-wiki.md gap "cites page revisions") · Product: mvp.md J8.3, §6.9 Works TODOs, §6.11 One vault for both agents
Ready: 2026-10-03 smithers-8a sha256:2961056afb0f

## Goal
A TODO's plan reads authored and generated wiki pages through the API, and its receipt records `{slug, revision, digest}` for every page it cited, so the TODO's evidence links to the exact revision.

## Scope
- The plan step treats each cited decision page as a binding constraint: a plan that departs from a cited decision names it and says why in the plan text. Check: C-J8-05.

In:
- Lands dark until T-FLW-02: without the pinned generated-page declaration, refuse citation-enabled planning with `unavailable`; never generate defaults here.
- Lands dark until T-APP-17: without the shared selector, refuse citation-enabled planning with `unavailable`; never fall back to a second selector.
- Lands dark until T-STK-01, T-APP-02 and T-UI-04: without the attempt evidence contract and TODO renderer, keep citation-enabled planning disabled; never claim evidence was published.
- Lands dark until T-ACC-03: without repository-scoped run authorization for wiki and selector reads, deny those calls and refuse citation-enabled planning; never substitute a person credential.
- Lands dark until T-FLW-01 and T-INS-02: without machine-only dispatch and the microVM launcher, refuse citation-enabled runs with `isolation_required`; never use a host-process fallback. These are activation preconditions, not new code dependencies.
- The plan step reads wiki pages through the host API with the run credential: authored pages as well as generated ones. Authored reads do not depend on `input.wiki`, `options.wiki` or a generated-page inventory. An empty authorized vault is valid; a disabled wiki gate or failed read is not an empty vault. Check: C-J8-04.
- Page selection (§13.4): the same selector as the app agent's preflight (§15.1.2, T-APP-17), restricted to wiki pages, given the TODO's prompt, within the selector's token budget. The plan step calls it through the host API; it is a model call on the `fast` role (§11.5a), recorded as a step of the run. No second selector exists.
- The plan receipt lists `{slug, revision, digest}` for each page placed in the planning context; `digest` is SHA-256 of that revision's Markdown.
- The TODO card's evidence shows the cited pages, each opening that revision.

Out:
- The default page declaration for a fresh repository (T-FLW-02).
- Learning's decision pages (T-FLW-06); wiki co-editing (T-COL-09).
- Obsidian (T-FLW-12) and laptop access to the vault over git ([D] spec §13.3).
- A second selector, wiki store, revision scheme or evidence store; wiki generation during planning; changes to selector ranking or token budgets.
- New launcher or root provisioning steps, host execution of repository flows or freshness collectors, write or secret scopes for run credentials, and changes to wiki co-editing transport.

## Changes
- Reshape `flows/coding/planning-memory.ts:93-135` (`wikiMemory`) and `:188-205` (selection): reuse T-APP-17's selector restricted to `kind: wiki`, then `GET /api/repos/{owner}/{repo}/wiki/{slug}` (`packages/backend/internal/compose/router.go:1686`) for each selected page. Replace the wiki part of `Memory.select`, preserving file selection. Generated pages keep arriving from the stack (`input.wiki`) through `freshWikiPages` (`:65-85`), now with slug and revision; apply freshness checks to API-sourced generated pages too. Delete the `wikiOutput/current.json` pointer-read branch in the same change. Reuse the existing wiki API and revision store; add no parallel reader or storage.
- Capture slug, page ID, revision, Markdown and content digest from the same authorized response (`packages/backend/internal/services/wiki.go:28-42`). Verify SHA-256 before placing the body in context. A digest mismatch excludes both body and citation. Build history links from the captured page ID and revision, never from a later lookup. Check: C-J8-04.
- `flows/coding/planning.ts:26-46` (`PlanningContext`) → add optional `wikiCitations: Array<{slug, revision, digest}>`. Optional, so a run parked before this field replays its captured context.
- `flows/coding/schema.ts:78-88` (`SuppliedWiki`) → carry `slug` and `revision` per page. Reshape `packages/backend/internal/services/mythical_wiki.go:790-814` (`suppliedWiki`) to pass the slug and revision already retained by `publishWiki`, not only `inputDigest`. Legacy supplied pages without those fields are refreshed through the API before citation; parked contexts retain their captured data.
- Reshape attempt evidence (T-STK-01) to include `wikiCitations` under the existing attempt/generation ownership checks (§10.4.3). Extend the existing evidence union in `packages/rpc/src/CardPrimitives.ts:324`, consumed by `packages/rpc/src/TodoCard.ts:106`, and wire `apps/app/src/mainview/cards/TodoContainer.tsx` to `views/TodoView.tsx`. smithers-06 owns the View change; engineering owns the schema and Container. Reuse existing card action dispatch. Each citation opens `…/wiki/history/{pageID}/{revision}/content` (`packages/backend/internal/compose/router.go:1679`). Add no separate evidence store.
- The coding host reaches the host API only through the relay port with the run credential (§8.9, §17.2). Reuse T-ACC-03's authorizer for repository-scoped wiki and selector reads. `gateWiki` is an availability gate, not a credential scope; when disabled it refuses the read. Grant no write, merge, members or secret scope. smithers-3f approves the public API and authorization seam; smithers-38 approves selector reuse, citation encoding, generated-page freshness and replay compatibility; smithers-b8 and smithers-06 approve the Container/View seam. Changes to product behavior require Will's decision through smithers-8a. Check: C-J8-04.

## Tests
- Unit, `flows/test/coding-wiki-memory.test.ts` (extend): a fake API returns pages at revisions 3 and 7; the context holds both with matching digests; a page whose body doesn't hash to its stated digest is dropped and not cited.
- Unit, same file: the selector receives the TODO prompt and only wiki candidates; a page the selector rejects is neither read nor cited.
- Unit, `flows/test/coding-planning-wiki-prior.test.ts` (extend): a parked context without `wikiCitations` still decodes and replays.
- Integration, `packages/backend/internal/services/plan_wiki_citations_integration_test.go` (new automation for C-J8-04): create and start a TODO through the production dispatcher and launcher, then observe the plan receipt and attempt evidence through the production routes. Use real PostgreSQL, production wiki/selector authorization and a real microVM coding host on the reference host; recorded model responses are allowed. Direct service or plan-step calls and process runtimes are component coverage only.
- C-J8-04 subcases: authored-only vault with no generated pages; API-sourced stale generated page; edit between selection and read; digest mismatch; disabled wiki gate; missing selector/config/evidence provider; expired or wrong-repository run credential; unavailable microVM. Refused cases publish no successful plan receipt, start no host repository process and use no local pointer fallback. Freshness collection and repository flow canaries run only inside the machine as a non-root uid.
- Commit literal page bodies, revisions, slugs, digest values, selected refs, decision functions and failure codes as fixture oracles for all new tests. Do not derive expected values from spec files, selectors, production digest helpers or observed receipts at runtime. C-J8-05 creates TODOs through the production command dispatcher; its edited-page fixture has a fixed expected revision and digest, and asserts the fixed `retryFixed(5000)` diff.
- C-J8-05 revision-link subcase: after editing the page, click the older attempt's citation in the production TODO card and assert the history-content route returns the original fixture bytes; clicking the new attempt's citation returns the edited fixture bytes.

## Acceptance

- [C-J8-05](../checks/C-J8-05.md): after a decision page is edited, the next related plan cites the new revision and its change follows it.

- [C-J8-04](../checks/C-J8-04.md): the plan receipt records `{slug, revision, digest}` for every cited page, and the digest matches the stored revision.

## Risks and notes
- Build against the specified S1 contracts while dependencies are unlanded; the Scope gates refuse activation until each provider is available. Unlanded dependencies do not block Ready.
- Risk: authored pages edited mid-plan change between selection and read. Confirmed if a receipt's revision differs from the revision the body came from. Read by slug once and record the revision from that same response.
- Risk: a generated page read through the API bypasses the `inputDigest` freshness filter (`freshWikiPages`, `planning-memory.ts:65-85`) and describes older code. Confirmed if a stale generated page is cited after its inputs changed. Apply the filter to every generated page, whatever its source.
- Security: shipped host code reads wiki bytes as data and runs the shared selector; repository flows and freshness collection execute only in the branch machine as a non-root user (M-29, §17.3). No root step is added or changed by this ticket, so it introduces no root-consumed inputs. Do not pass branch modules, commands, page declarations or Markdown to root execution. smithers-3f reviews this boundary and the scoped relay calls. Check: C-J8-04.

## Ready checklist
1. Dependencies: T-FLW-02's pinned config, T-APP-17's selector, T-STK-01's evidence contract, T-APP-02/T-UI-04's TODO schema and renderer, and T-ACC-03's authorizer are direct code/schema edges, all S1. Scope states fail-closed dark landing for each and for T-FLW-01/T-INS-02 activation; no activation-only edge is added.
2. Exclusions: Out names selector/store duplication, generation during planning, ranking/budget changes, wiki transport, learning, Obsidian, laptop sync, launcher/root work, host execution and broader credential scopes.
3. Boundary tests: C-J8-04 drives production TODO dispatch, authorization, relay, microVM and evidence routes; C-J8-05 drives production commands and the TODO card's revision links. Committed literal fixtures supply expectations; no runtime spec or implementation-derived oracle.
4. Decisions: smithers-3f approves API, authorization and evidence ownership; smithers-38 approves selector reuse, freshness, citation encoding and legacy replay; smithers-b8/smithers-06 approve the Container/View seam. Will decides product changes through smithers-8a; no ADR is introduced.
5. Owner pre-review (answers stand; review may occur post hoc under the parallel-build directive): smithers-3f: Do relay reads enforce run/repository scope without widening authority? Do evidence writes retain attempt/generation ownership and machine-only execution? smithers-38: Does the shared selector preserve file selection and include authored pages without generated config? Do digest/freshness checks bind citations to actual context and preserve parked replay? smithers-b8: Does the Container dispatch open the captured revision through existing card actions? smithers-06: Does the View show each citation and open its captured revision without a fresh slug lookup?
6. Security: repository code and freshness collectors run only in machines as non-root; host wiki/selector reads treat repository content as data, use scoped run credentials and fail closed. No root step or root-consumed input is introduced. smithers-3f reviews; C-J8-04's isolation, credential and canary subcases prove the boundary.

