# Released bootstrap input contract

`app-bootstrap-v1.schema.json` pins the frontend input contract shipped for
[#3343](https://github.com/smithersai/smithers/issues/3343). It was captured from
`z.toJSONSchema(AppBootstrapSchema, { io: "input" })` after adding tolerance for
unknown capability strings. It deliberately accepts additional fields and
capability names while preserving required fields, their types, and API version.

Keep this snapshot frozen. Backend HTTP contract tests validate candidate
responses against it so regenerating a schema with the backend cannot hide a
breaking change. A later API version needs a separate contract and rollout.

Deploy this tolerant frontend before extending capabilities served to older,
strict clients. The frontend deploy also validates the live backend with the
candidate's exact `AppBootstrapSchema` immediately before publication.
