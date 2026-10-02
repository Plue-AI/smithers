# T-FLW-10 Plans cite wiki page revisions

Stage S3 · Size S · Depends on T-FLW-02, T-APP-17 · Unblocks — · Issue: to file
Spec: spec.md §10.4.1 (plan cites wiki revisions), §10.4.3, §13.4, §15.1.2 · Delta: delta.md §8 (no row; research/collab-terminals-wiki.md gap "cites page revisions") · Product: mvp.md J8.3, §6.9 Works TODOs, §6.11 One vault for both agents

## Goal
A TODO's plan reads authored and generated wiki pages through the API, and its receipt records `{slug, revision, digest}` for every page it cited, so the TODO's evidence links to the exact revision.

## Scope
In:
- The plan step reads wiki pages through the host API with the run credential: authored pages as well as generated ones.
- Page selection (§13.4): the same selector as the app agent's preflight (§15.1.2, T-APP-17), restricted to wiki pages, given the TODO's prompt, within the selector's token budget. The plan step calls it through the host API; it is a model call on the `fast` role (§11.5a), recorded as a step of the run. No second selector exists.
- The plan receipt lists `{slug, revision, digest}` for each page placed in the planning context; `digest` is SHA-256 of that revision's Markdown.
- The TODO card's evidence shows the cited pages, each opening that revision.

Out:
- The default page declaration for a fresh repository (T-FLW-02).
- Learning's decision pages (T-FLW-06); wiki co-editing (T-COL-09).
- Obsidian (T-FLW-12) and laptop access to the vault over git ([D] spec §13.3).

## Changes
- `flows/coding/planning-memory.ts:93-135` (`wikiMemory`) → choose pages with the preflight selector restricted to `kind: wiki`, then `GET /api/repos/{owner}/{repo}/wiki/{slug}` (`packages/backend/internal/compose/router.go:1672`) for each selected page. Generated pages keep arriving from the stack (`input.wiki`) through the `freshWikiPages` filter, now with slug and revision. Replace the host-local `wikiOutput/current.json` pointer branch with the same API reads, and delete it in the same change.
- `flows/coding/planning.ts:26-46` (`PlanningContext`) → add optional `wikiCitations: Array<{slug, revision, digest}>`. Optional, so a run parked before this field replays its captured context.
- `flows/coding/schema.ts:78-88` (`SuppliedWiki`) → carry `slug` and `revision` per page. The stack engine passes the revision it published, not only `inputDigest`.
- Evidence (T-STK-10) → the attempt evidence includes `wikiCitations`; the TODO card links each to `…/wiki/history/{pageID}/{revision}/content` (`router.go:1665`).
- The coding host reaches the host API only through the relay port with the run credential (§8.9, §17.2). Add the run credential's read scope for `wiki` and for the selector if `gateWiki` refuses it.

## Tests
- Unit, `flows/test/coding-wiki-memory.test.ts` (extend): a fake API returns pages at revisions 3 and 7; the context holds both with matching digests; a page whose body doesn't hash to its stated digest is dropped and not cited.
- Unit, same file: the selector receives the TODO prompt and only wiki candidates; a page the selector rejects is neither read nor cited.
- Unit, `flows/test/coding-planning-wiki-prior.test.ts` (extend): a parked context without `wikiCitations` still decodes and replays.
- Integration: [C-J8-04](../checks/C-J8-04.md), with the real PostgreSQL wiki store and a real plan step.

## Acceptance
- [C-J8-04](../checks/C-J8-04.md): the plan receipt records `{slug, revision, digest}` for every cited page, and the digest matches the stored revision.

## Risks and notes
- Needs T-APP-17's selector, which lands in S1, before this S3 ticket.
- Risk: authored pages edited mid-plan change between selection and read. Confirmed if a receipt's revision differs from the revision the body came from. Read by slug once and record the revision from that same response.
- Risk: a generated page read through the API bypasses the `inputDigest` freshness filter (`freshWikiPages`, `planning-memory.ts:65-85`) and describes older code. Confirmed if a stale generated page is cited after its inputs changed. Apply the filter to every generated page, whatever its source.
