# The verified repository wiki refresh

`coding/RefreshWiki` is the private flow that refreshes the verified wiki the
project declares. The stack service runs it through `coding/wiki`
(wiki/flow.ts) on the folded tip after every fold, and publishes the pages it
answers (see [wiki-refresh.ts](wiki-refresh.ts)). Planning never runs it:
planning reads the published pages as context when they are fresh
(planning-memory.ts). A generated publication is not a plan, implementation,
vibed state or delivery receipt.

```ts
import { RefreshWiki, planningWikiLayers } from "./planning-wiki.ts"

const wiki = planningWikiLayers({
  repositoryPath,
  wikiOutput,
  pages: engineeringPageCatalog,
  reviewer: "configured-reviewer-policy"
})
// Compose this layer with the host's agent layers; `pool` is the reviews an
// earlier refresh answered, or null.
const refreshed = yield* RefreshWiki.execute({ pool: null })
```

This adds no public package API, database, generator service or pointer store.
The host owns the page catalog, source and output paths, and reviewer identity.
That identity must describe the configured reviewer/model/route policy and change
when that policy changes; it is not a model-supplied label.
The caller also supplies the existing planning and memory layers, HumanTask,
`Interpreter.layer(PreparePlan)`, and `ReviewPage.layer` on `wiki/reviewer` with
the planning-authority helper. The reviewer inherits the parent's budget,
steering, seat routing and injected services. The old standalone wiki agent
runtime is not installed over that parent context. A prompt requesting no tools
is not a capability boundary; the host must apply the narrowing helper.

Each refresh captures its operator configuration and asks the existing engine
run catalog for one page of at most twenty completed refreshes. A compatible
refresh's native result is only a hint to its earlier wiki child execution.
Without one, a `pool` the caller carried (the reviews an earlier refresh on
another workspace answered) is admitted only under exactly this host's current
reviewer policy and seat. The first generation invokes `smithers/Wiki`; later
generations invoke `smithers/IncrementalWiki`. Those existing flows collect
exact source bytes and perform semantic review, assessment and immutable
publication through their ordinary actions; a carried review is reused only
after the same recapture and citation revalidation as a journaled one. The
host includes the selected wiki model and owning gateway in the operator's
reviewer identity, so changing those routes invalidates reuse through this
same protocol.

The configured `coding/request` selects this dependency only when host-owned
`planning.wiki` is true; Wiki planning is off by default. Enabled preparation
refreshes before planning, including later feedback-driven planning passes.
The separate `coding/prototype` entry does not make a POC a prerequisite for
implementation.

The configuration scope hashes the complete PageSpec catalog, reviewer identity,
canonical source root, configured output path, composition policy and lookup
limits. Source bytes are separately measured by the existing Collect action.
A different configuration falls back to ordinary first generation. A bounded
lookup miss also regenerates normally; it does not scan the remaining history
or trust a mutable publication pointer as a model receipt.

Existing reuse validation checks the terminal native run, committed attempt,
reviewer and policy identities, every page/source digest, section boundaries,
and the current exact-citation assessment. Unchanged pages do not call the
model again. Changed pages are reviewed again. The configured Smithers catalog
must include the `policySources` files declared in `flows/wiki/reuse.ts` only when no trusted host fingerprint is supplied; that is an explicit
requirement of the current wiki recipe's reuse protocol, not a new generic
policy subsystem. Source files stay inside the configured public engineering
repository. Private Ops content is not an input.

The catalog admits at most thirty pages, 128 KiB of configuration JSON and
256 distinct source paths. Existing wiki file/page/section evidence limits
still apply. Prior-run inspection is bounded to 256 KiB per state record and
1 MiB across the one catalog page. No new retention or cache policy is added.

The internal refresh result is `{ scopeDigest, wikiRunId, receipt }`, recorded
as the ordinary native run result. It is not another ledger. The private
configuration and prior-selection actions are captured once per refresh
execution; resumed executions replay their existing decisions. A new request
recollects current source. The wiki writer checks source again before accepting
its publication.

Unsupported or uncertain semantic review fails the refresh; the stack service
shows it as failed and retries it. The existing wiki writer retains its source-pinned `needs-changes`
artifact for inspection. The recipe does not relabel that draft as verified,
publish it, or infer correctness from matching hashes alone.

`flows/test/coding-planning-wiki-prior.test.ts` covers bounded prior-review
selection. `flows/test/wiki-reuse.test.ts` covers unchanged-page reuse and
invalidation, while `flows/test/wiki.test.ts` covers source capture, citation
validation, and immutable artifacts. These scripted checks do not certify a
live provider or a deployed end-to-end request.

The prior-review hint reads the latest 256 run IDs through the existing indexed
catalog, newest insertion first, and inspects at most 20 completed wiki-refresh
candidates within the existing 1 MiB state budget. The catalog's filtered
`listRuns` page is ascending and must not be mistaken for a recent page.
Collected parents or children are skipped. The window contains all flow kinds;
a large intervening workload can cause a normal cold-review miss. This is a
bounded optimization, never a guarantee that the newest refresh in all history
was found and never permission to reuse missing evidence.

The configured host reevaluates its external-output boundary during configuration,
child generation and immediately before publication after semantic review. The
writer uses that newly canonical destination with the explicitly supplied host
filesystem. A changed output ancestor cannot silently turn wiki publication into
an edit of the coding workspace. This is an option on the private wiki recipe;
it does not change the standalone wiki CLI's local artifact policy.

The configured coding host supplies the identity of its review task to reuse
policy: a digest of the review policy sources (`policySources` in
`flows/wiki/reuse.ts`), which the bundler injects into the deployed artifact.
Such target repositories need only their own declared public page inputs; they
do not vendor Smithers' reviewer implementation. Standalone wiki composition
reads those policy sources from the repository when no host identity is
provided. The reviewer string also retains the model and operator policy, so a
changed review task, model or policy never inherits an old review, while a host
deploy that leaves them alone keeps every review reusable.

Required `checks/wiki` entries now run semantic review as ordinary asynchronous
backpressure after implementation and rewritten-source checks. They capture an
immutable native export and return owner findings without racing publication;
see `wiki-check.md` for the source, replay and catalog identity contracts.

## Captured planning citations

Revision citations are disabled until the trusted host supplies
`MemoryOptions.wikiCitations` and `wikiProvider`. The provider uses the shared
wiki-only preflight selector and repository-scoped run relay reads. Its
`authorize` refuses unavailable pinned config, selector, attempt evidence or
renderer, disabled wiki and invalid run credentials; it refuses non-machine
execution with `isolation_required`. No production adapter is bound here.

Selected pages are read once, capturing page ID, slug, revision, Markdown and
SHA-256 together. Digest mismatches are omitted. Generated pages also pass the
existing source-input freshness check; authored pages need no generated inventory.
The context budget retains whole pages and their citations together. The old
`current.json` planning fallback is removed. Supplied legacy pages are not a
substitute for API reads. Parked contexts without `wikiCitations` remain readable.
The draft planner treats cited decisions as constraints and names any departure.

Activation still needs attempt-owned evidence publication and TODO revision
links, plus C-J8-04 and C-J8-05 reference-host receipts. These are not established
by the component tests.
