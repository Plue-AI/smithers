# Prompt planning from repository evidence

`PreparePlan` is a private repository recipe composed from ordinary `Flow`,
`Action`, `AgentAction`, and `HumanTask`. It returns the existing coding `Plan`;
it does not execute that plan or create another storage service. Optional plan
approval belongs to `coding/Request` after its last pre-implementation feedback
drain, not to preparation; see [request.md](request.md). The supplied
runtime persists its observations, model results, question, answer, and final
plan in the existing flow journal and database.

```ts
import { PreparePlan } from "./planning.ts"

const prepare = PreparePlan.execute({
  prompt: "Add a query API using the current storage layer.",
  feedback: ""
})
// Supply the configured Effect host, then run this Effect. A material question
// parks durably and is answered through the existing HumanTask interface.
```

This is a new **private workflow entry**, not a public Smithers package API.
The deployment provides `memoryLayer(options)`, `planningPolicy`, both model
action layers, `HumanTask.layer`, and `Interpreter.layer(PreparePlan)` through
the runtime's existing action registration. `coding/plan` is a logical model
seat which the deployment must resolve using its authorized provider route.
The model prompts request planning only; they are not an authorization boundary.
The configured coding host applies `evidenceOnly` at action execution after
native authority restoration. It supplies an empty callable catalog and
capability ceiling while retaining the parent's budgets, steering, plugins and
model routing. Plugin-contributed declarations cannot widen that ceiling.
For these evidence actions it also supplies the existing agent option
`unmovedCap: 0`: a planning or review result need not change workspace files.
Workspace observation remains enabled. Implementation actions keep their
normal completion checks and mutation authority.

## Gather, clarify, draft, verify

The default `GatherContext` implementation snapshots current bytes through the
configured native `Jj` service, preserving the same JJ change. It asks Plue for
a bounded, resolved linear native history, then reads request paths and existing
repository documents under the source byte and path bounds. Generated Wiki
memory is empty by default. This path creates no knowledge artifact.

A stack request carries the stack's published wiki pages; gather keeps only
those whose page inputs, under this host's own catalog, still hash to the
current source. Otherwise, with the operator's `wiki: true`, the owning Wiki
verifier checks the host's own snapshot for source freshness, publication
integrity and recorded semantic review. A missing or stale wiki never refuses
gather; planning proceeds without it. The existing keyword scorer ranks
complete current-behavior and intent
pages against the request and saved feedback. It retains complete pages within
a byte budget, with source identities and explicit current/intent labels.
Repository content is evidence for the planning model, never authority to
change the host's instructions. Wiki inputs come from the configured public
engineering page catalog; source attachments use the existing safe path reader.

`ReviewRequest` explains material constraints and either proceeds or emits one
bundled clarification. A nonempty question calls the existing durable
`HumanTask` with kind `ask`. A restarted host can answer that same token and
resume without asking the model to reconstruct its earlier reasoning.

`DraftPlan` chooses native atoms and predicts reads and writes. It selects
implementation/check names only from measured host catalog entries. Finalization
always includes every operator-required check on every Change; the model can
add available optional checks. Delivery checks retain their later delivery tier. Its
rationale and the request review remain separate recorded outputs, available
for the UI's explanation and detailed execution views.

After any human wait and model draft, `VerifyContext` captures current bytes
again, verifies every gathered native identity and parent chain, and rechecks
source attachments and, when enabled, Wiki freshness. A code change while
planning refuses the result as stale in either configuration.
`FinalizePlan` binds choices to the original verified executable digests,
memory identity, actual native base, and `observedHead`: the complete native
source revision inspected during planning. An amendment's base can precede
that observed head. Downstream implementation and checks
retain their own existing revision and executable fences.

`AdmitSource` is a private action for a composed request. It first compares the
observed native head and base with the prepared plan, then retains that exact
source through the existing cloud workspace infrastructure. Only after its
exact cloud ACK does it capture current bytes through the injected `Jj` service
and recheck head/base. Even an admission snapshot can rewrite a dirty working
copy, so retention comes first. A changed source refuses admission. This is an
initial check, not a lock covering the entire run. Legacy manually supplied
plans remain decodable without `observedHead`, but cannot pass this admission
check; they must be prepared again. The gate now uses the private durable action
identity `coding/admit-retained-source`; an older prepared-source action receipt
cannot stand in for this stronger admission.

The private `NativeCoding.publishOriginalSource({requestId, source})` primitive
uses the Plue-installed adapter and native helper, the head reporter's existing
credential cache, JJ's transport and an immutable reserved source ref. Its
receipt contains workspace/repository, ref and exact commit/change/tree/parent
identity; no credentials, new atomic IDs or fabricated cloud operation IDs.
The request UUID comes from the existing FlowInstance execution ID and action
key. Retrying identical source publication recovers its cloud ACK after later
rewrites. A generic 404, old helper, incomplete ACK or network failure refuses
admission. This does not mark asynchronous operation provenance as published.

The host defaults to `sourcePublication:"cloud"`. An explicitly configured
`"local-only"` development adapter may admit local coding requests without a
cloud side effect, but publication itself fails and it cannot satisfy Vibe's
cloud-retention requirement. Local tests declare that capability explicitly;
they never manufacture a cloud acknowledgement. Both Node and Bun invoke the
same adapter through Effect's injected process service.

## Internal data and native adapter contract

The new `PlanningContext` is durable action input/output, not a database table:

- `head` and oldest-to-newest `history` contain native change, commit, tree,
  parent, and operation IDs, plus native descriptions.
- `memory` is empty by default, or contains selected Wiki pages labeled
  `current` or `intent`, with publication source revision and page input digest.
- `sources` carries bounded existing file text and digests; `missing` records
  paths whose bytes were unavailable.
- `implementation`, `implementationDigest`, and `checks` identify verified
  catalog definitions. The model cannot supply replacement digests.
- `memoryRevision` is a canonical digest of this measured evidence.

The existing private Plue read request accepts optional `historyLimit: 1..1024`.
Only requests supplying it receive `history` and `historyComplete`; one extra
ancestor detects whether the window is truncated. Complete-history landing
must require `historyComplete:true`. Legacy read payloads and results
retain their shape. No atomic ID is minted: a planned existing atom uses its
full native JJ change ID, and a new atom uses `null` until JJ creates it.

The history window must end at the captured head and contain one parent per
atom. An append uses the current head as base. An amendment chooses a visible
earlier base and retains every existing descendant after it in native
order; new atoms may sit anywhere after the base. Missing context, omitted/reordered descendants, duplicate
ownership, unknown checks, and paths escaping the repository or entering native
metadata are refused. Each Change receives all configured required checks and
needs a required fast and required slow check. New atoms may be inserted between
existing ones: the native adapter creates them with `jj new --insert-after` and JJ
restacks what follows. Existing atoms are never reordered or dropped. When the
request is not actionable (already done, only a question, a duplicate, an open
product decision), the review's `decline` fails the plan with
`CodingError{code:"declined"}` and its reason; nothing is drafted.
The model is instructed to use small emoji conventional commits;
final history cleanup is a separate later lifecycle step.

`feedback` is bounded text intended for saved disposable POC findings. Passing
text does not assert that a POC ran, and this workflow does not produce a POC.
The host owns the evidence source for that second pass.

`PlanningInput`, `RequestInput`, `CorrectionResult`, and `RequestResult` live in
the private pure `schema.ts` module so declarations and UI projections can
decode recorded evidence without importing backend action implementations.
The original planning and correction modules re-export their existing schemas.
`RequestResult` pairs a prepared `plan` with a correction `outcome`; an outcome
of `blocked` does not mean validation passed merely because its engine run
completed. These are internal flow data, not new public package APIs or stores.

## Platform and verification

The recipe uses injected Effect filesystem, path, process, native JJ, catalog,
and runtime services. It opens no database or Node sidecar. The same flow runs
with Node or Bun platform and SQLite layers.

`coding-planning.test.ts` verifies the native suffix/ownership/catalog policy
and runs real JJ, verified wiki artifact checks, and durable SQLite waits on
both platforms. It closes and reopens the host, answers the stored question,
checks terminal replay, and refuses source changed during clarification and
stale wiki dependencies. Model decisions and semantic citations are scripted
in this integration fixture; it is not a live-provider evaluation.
