# Cards persistence contract

`CardSchema` decodes persisted rows and embedded card snapshots. A preprocessor
retires rows the product no longer serves before the kind union sees them, so a
frame stored by an older build still parses. A retired row keeps its `id`,
`ordinal` and `createdAt`, and becomes `kind: "retired"` with an empty title, an
empty payload and `status: "acted"`. These rows are retired:

- the kinds `factory`, `repo-onboarding`, `repo-home`, `agent-models` and
  `agent-form`
- a `connector-setup` row for Linear and a `sync-ops` row whose source is Linear
- a `flow-form` row whose flow starts with `linear.` or is one of the retired
  flows: `repo.welcome`, `repo.explore`, `repo.contribute`, `repo.maintain`,
  `repo.home`, `factory.show`, `workspace.fork`, `workspace.snapshot`,
  `workspace.snapshot.delete`, `workspace.snapshot.fork`, `workspace.template`,
  `change.open-computer`, `agent.create`, `agent.edit`, `agent.models`,
  `agent.new`, `agent.remove`, `issues.link-linear`, `issues.unlink-linear`,
  `sync.retry` and `sync.ops.load-older`

Malformed rows of a current kind still fail validation.

`CardPatchSchema` requires `kind`, including for metadata-only updates. Its payload
is a shallow partial of that kind's payload schema: every top-level field is
optional and has no default, so a field the patch omits stays absent and the
merge keeps the stored value. Nested objects and arrays keep their full
validation, including file diagnostic caps. Consumers must require the patch kind
to match the existing card, merge payload fields, then validate the resulting card
with `CardSchema` before storing the parsed result. The UI store fills in the
existing kind for local transitions; model frames must provide it. Environment
transitions are redacted before journaling or tracing.

Environment variable `value` fields are display-only. Decoding cards and patches
keeps three leading characters followed by `…`; values of three characters or fewer
become `…`. Repeated decoding is stable. Use parsed values for persistence and
re-read upstream when a raw value is needed. This does not scrub old bytes already
on disk; it redacts them when decoded and on subsequent writes.

## Link fields

Card URLs a renderer links, embeds or opens decode through `@smthrs/rpc/WebUrl`.
`htmlUrl`, `installUrl`, `avatarUrl`, persona `iconUrl`, a workspace service
`url`, and a browser card's `finalUrl` must be absolute `http://` or `https://`
URLs. A desktop `streamUrl` must be an origin-relative path (`/…`, never `//`).
A browser card may record a refused `url` of any scheme, but a `frameable` card
must embed an http(s) page. A row that breaks these rules fails validation.
