# flows

A flow's file location is its name: `flows/chat/flow.ts` is the flow `chat`.
No path literal appears anywhere else.

Each `flow.ts` default-exports a tagged `Flow.make` from `@smthrs/flow`: a payload, a typed output, the
prompt built from the payload, and whether it is a chat. It never names a model.

The seat, sandbox, and tools come from the nearest ancestor `AGENT.ts`,
`SANDBOX.ts`, and `TOOLS.ts`. Nearest of each kind wins and nothing merges:
`flows/build/AGENT.ts` replaces the root teaching rather than adding to it.

Every flow has a `flow.e2e.ts` that replays a fixture from its own `fixtures/`
directory, so `pnpm test` runs offline. Re-record against the live seat with
`SMTHRS_RECORD=1 pnpm test`, which writes the fixture back on a miss.
