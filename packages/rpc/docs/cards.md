# Cards persistence contract

`CardSchema` is the single persisted-card decoder. `LEGACY_CARD_KINDS` is the
shared removed-kind set used by the decoder and renderer registration coverage.
It excludes `retired`, the current tombstone schema. Unknown kinds outside the
set fail decoding; malformed live rows fail their current schema.
`CardSchemaOptions` names the current union options for embedding schemas.

A legacy row keeps its stored title, identity, ordering and timestamp. Decoding
removes its body and payload, sets `payload: { was: <original kind> }`, stops
loading and sets status to `acted`. Existing tombstones preserve their title and
optional `payload.was`; decoding twice is stable. Old tombstones without `was`
remain readable. Titles are inert text, never saved actions.

Retired flow forms, Linear issue rows and cloud `agents` inventories use the same
retirement path. Non-cloud `agents` stays live (L4). A kind joins the legacy set
only when its last producer is removed (L3). `grant-confirm` is legacy;
`stack` and `factory.home` retain live schemas under #3447. They are deferred
and hidden by the app-local `DEFERRED_CARD_KINDS` list. `branches`, `file`,
`diff`, `secrets`, `run-trace`, `balance` and `billing-plans` remain current.
`cardAvailable` excludes decoded tombstones and the two deferred app kinds.


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
