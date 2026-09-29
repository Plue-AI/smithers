# Semantic wiki checks on implemented source

`coding/WikiCheck` is a private registered check delegate. The repository's
`checks/wiki` declaration selects it, and an operator can include that flow as a
required slow check in the existing project configuration. It returns the
existing coding `Receipt`; it introduces no public package API or database.

```json
{ "id": "wiki", "target": "public engineering wiki", "flow": "checks/wiki", "tier": "slow", "required": true }
```

## Capture before asynchronous review

The check validates its current catalog identity, then uses the same private
immutable-source helper as command checks. Plue exports the exact implemented
commit. The helper verifies commit, tree and native JJ change IDs and rejects
escaping or unresolved links before reading any page. Existing wiki operations
capture full bounded source and curated reviewer excerpts from that export.

The capture action retains those Evidence values in the normal engine. Its
scoped source export is gone before the model phase begins. A child materializes
the captured page array and places the ordinary review, selection and provenance
actions in the existing build graph. Restart needs the recorded values, not a
live checkout or a surviving temporary directory. The existing evidence-only
reviewer receives no tool authority from this composition.

Each review passes the existing deterministic citation and section assessment
before its bound page is recorded. Citation confidence below 0.8 makes an
otherwise supported section uncertain, while preserving semantic uncertain and
unsupported findings and the original action receipts. Unsupported or uncertain
sections produce a failed ordinary check receipt. Findings name the checked Change, exact source
commit, page, section and owning Markdown path. The existing correction policy
can repair that owner while preserving the old review evidence. A completed
check procedure must still have a passed domain receipt to validate the Change.
Malformed review structure or citations receive one bounded semantic repair:
the same reviewer sees its prior review, validator feedback and the same captured
source. Exact validation runs again; a second failure refuses the check. The
existing AgentAction schema-correction budget still applies inside each call.
These errors do not become source-owner findings or automatic line-number edits.

## Reuse the native evidence store

A bounded indexed scan looks for a compatible recent check and its retained
review child. If none is available, the same existing planning lookup supplies
a prior refresh. Reuse compares exact page inputs, prose, section boundaries,
reviewer and policy, and reassesses citations. Missing or out-of-window evidence
causes a fresh review; there is no second cache or wiki ledger. The lookup scans
at most 256 recent runs and 1 MiB of retained state, so heavy unrelated work can
cause a safe cold miss.

The configured host supplies the identity of its review task: a digest of the
review policy sources, injected at bundle time into the deployed artifact.
That trusted policy and reviewer identify the reuse pool; target projects do not
need to vendor Smithers reviewer files. Standalone wiki composition without a
host identity reads the same policy sources from the repository.

## Bind one approval and execution identity

The configured host derives only descriptors that delegate to `coding/WikiCheck`.
Its private `smithersCodingWikiPolicy` frontmatter value hashes the operator's
page catalog and actual reviewer policy. A source-supplied value cannot override
it. The same derived Registry layer supplies Control planning, native module authority
and the executable catalog. Its list/get/visible views agree; refresh delegates
to the original registry. Body loading checks the derived requested identity,
then asks the original registry to verify its original source identity and bytes.
Unrelated descriptors remain unchanged.

`NativeControl.layerHost` accepts an optional private supplied Registry, matching
its existing lower-level composition. No public registry extension or gateway
payload was added. New internal action data consists of captured Evidence plus
the existing review Pool, optional prior-review and validation-message fields,
and a compact JSON evidence value naming the policy,
review-child execution and each page's result. Native JJ IDs and ordinary coding
receipt fields remain authoritative.

## Publish separately

A slow check never changes the wiki's current pointer. Several checks may review
different immutable revisions while implementation continues. Publication belongs
to the source-fenced refresh/finalization composition. Its external destination is
revalidated immediately before writing after a potentially long model review.
The final wiki still needs a verified snapshot for the final source; a passing
intermediate check does not make an older published snapshot current.
