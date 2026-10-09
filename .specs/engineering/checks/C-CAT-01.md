# C-CAT-01 Catalog doors, actors and roles equal Appendices A and B; every tag is in Appendix C and registers where it runs

Folded into T-CAT-01's tests (minimal-code synthesis, 2026-10-03).

2026-10-09 — Production native-host registration now rejects `coding/Request`
and `coding/Vibe`, after their removal from the pinned TODO composition.
`flows/test/catalog-runtime.test.ts` injects each literal Replaced entry point
through the native host's existing module registration boundary and verifies
startup refusal with no body or handler execution. The same test registers
`coding/Verify` and `review/change` successfully, preserving E-19. The registry
suite passes 3/0/0. This is host-construction evidence; the full allowlist still
fails on remaining placement, unlisted and Cut registrations. C-CAT-01 remains
partial.
