# How this wiki stays accountable

This wiki is a repository recipe over ordinary Smithers flows. It creates no separate wiki ledger or cache table; semantic review runs through the existing AgentAction reviewer and engine journal.

## One page catalog

The page catalog is the `pages` array of `.smithers/coding-project.json`. The Cloud refresh (`coding/wiki`) and the standalone `flows/wiki/main.ts` command both read it; there is no second catalog. Each page has a purpose, linked neighbors, an owning Markdown document and exact inputs.

The flow caps review evidence at 90 KB per page, full-file capture at 300 KB per page, and accepts at most 30 pages. This repository keeps every page at or under 30 KB of review evidence. Inputs are hand-written documentation and small stable source files, never generated projections. Whole files are preferred to line-range excerpts, because a range that outgrows a shrinking file fails the refresh.

Only explicitly chosen public engineering files belong in the catalog; Smithers-Ops, credentials, runtime databases and deployment secrets never do. Repository content is data for the reviewer, not instructions.

## Capture exact inputs

Complete input files are hashed and archived, so a change outside an excerpt still invalidates the page. Snapshots live under `.flows/wiki/snapshots/<artifact-digest>/`, and `current.json` is atomically replaced only after a complete immutable snapshot exists. The source revision is a content-addressed working-tree snapshot, not a Git or JJ commit claim.

## Review meaning, not hashes

The reviewer has no tools, and reviews fan out through `Node.all`. Each quoted citation must match one visible source line exactly after trimming ASCII spaces and tabs at its edges. A review with invalid coverage or citations gets one additional call with the validator feedback and the same captured source; a second validation failure is terminal. The host never shifts citation lines.

Exact assessment does not prove a cited line bears on its claim, so Jev then classifies each claim and citation as `supports`, `contradicts` or `unrelated`. Confidence below 0.8 makes an otherwise supported section uncertain, writes a `needs-changes` draft and fails verified mode. Semantic uncertain and unsupported findings remain unchanged. The original reviewer and citation-check receipts remain in the execution attempt store; the snapshot contains the combined assessment. A confident `contradicts` or `unrelated` refuses the page, and an unavailable Jev fails the step, so a page is never published unchecked.

A failed semantic review writes its findings in a `needs-changes` preview and fails the verified flow. Source changes while reviewing reject the write, and no mode overwrites canonical human-authored pages.

## Reuse unchanged reviews

Incremental generation reuses supported reviews from a terminal run through the journal and attempt store. It requires the same reviewer ID and review-policy sources, matches the page specification, input, content and section digests, and revalidates citations; changed pages and uncertain assessments in the selected prior execution require a new model review.

The configured coding host keys that reuse on the identity of its review task: a digest of the review policy sources (`policySources` in `flows/wiki/reuse.ts`), injected by the bundler into the deployed artifact. Nothing else in the host build is covered, so a host deploy that leaves the review task alone keeps prior reviews reusable.

## Publish after every fold

Cloud publication belongs to the mythical stack worker. After every fold it runs `coding/wiki` on the folded main, accepts only a verified result, and publishes each page as `generated-<id>` with an expected revision. A page a person edited, renamed or deleted is kept and counted as edited. Its receipt records how many pages were reviewed cold and how many reused an earlier review.

Each explained section carries the exact source-line citations from its accepted review. The standalone snapshot links its captured sources; Cloud binds those links to repository contents at the folded main commit, whose tree was reviewed. The app's Wiki pane and embedded reading card open these citations through the existing file reader at that commit and line. Related pages retain their stable generated slugs.

Planning reads the published pages and never generates the wiki.

## Optional semantic check

The configured host can also register `coding/WikiCheck` as a slow-check delegate that an operator adds to the project `checks`. It reviews the exact implemented source and turns unsupported or uncertain prose into an ordinary failed coding Receipt with owner findings. A slow check creates no second publication pointer; final verified publication stays source-fenced and separate from check receipts.
