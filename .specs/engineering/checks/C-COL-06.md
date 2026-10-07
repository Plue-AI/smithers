# C-COL-06 The machined wire contract: both codecs match ADR 0004's golden corpus, the skeleton refuses, and the protocol constants agree

Proves: spec.md §9.1, ADR 0004 · Layer: integration · Stage: S2 · Tickets: T-COL-03r
Automation: `smthrs test //:machinedWire` · Runs in: CI

`//:machinedWire` runs the Go wire tests (`TestMachinedWire*`, `TestWireContentLimit`, `TestMachinedSkeletonDisabled`, `TestMachinedWireFixturesMatchGenerator`) and the Rust `smithers-machined` golden, fake-host and local tests against `testdata/cocontracts/` at the protocol recorded in `MANIFEST.json`.

## Pass when
- Every corpus frame decodes and encodes byte-exactly to its MANIFEST expectation in both codecs, including the committed HMAC vectors and the refusal frames.
- Go `wire.Protocol`, Rust `conn::PROTOCOL` and `MANIFEST.json` `protocol` are equal.
- The daemon binary exits 78 with no subcommand and refuses non-19998 uids without connecting.

This check covers T-COL-03r's wire slice only. C-COL-01 and C-COL-03 stay with T-COL-03, T-COL-03a and T-COL-10, which prove behaviour beyond the wire (8a, 2026-10-07, #3626).
