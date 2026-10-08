# C-UI-11 canary

Provision these bytes on the scratch repository's awake T1 branch. Copy
`smithers-lsp-canary` into the branch's `node_modules/smithers-lsp-canary`;
the committed tsconfig loads it in TypeScript's language server. The invalid
argument in `src/b.ts` deliberately produces one diagnostic. Never load this
plugin on the install or test host. Serve `page.html` at a public HTTP URL
reachable by the install's existing webpage reader (loopback is refused).

Run `file-intelligence.spec.ts` with `SMITHERS_JOURNEY=file-intelligence.spec.ts`,
the built reference origin, pinned SHA and headed authenticated Ben profile.
Set `SMITHERS_INTELLIGENCE_BRANCH`, `SMITHERS_READER_CANARY_URL`,
`SMITHERS_INTELLIGENCE_SSH_HOST` / `SMITHERS_INTELLIGENCE_SSH_PORT` (Ben's
branch identity), and `SMITHERS_INTELLIGENCE_INSTALL_SSH_HOST` /
`SMITHERS_INTELLIGENCE_INSTALL_SSH_PORT` (read-only host probes). Start with
no LSP session and no `/tmp/smithers-lsp-plugin-canary.json` on either host.
The test compares the plugin's OS identity with Ben's SSH identity, checks
session reuse, and independently checks the install has no canary write or
TypeScript language-server process. The LSP confinement receipt and T-SEC-01
R1–R3 sign-off remain owner prerequisites; this fixture activates neither.

`file-gone.spec.ts` is T-APP-11's real-backend + machine reload integration
for C-J3-08 S2 steps 1–5. Run with `SMITHERS_JOURNEY=file-gone.spec.ts` and a
fresh branch containing tracked `src/retry.ts` and `src/webhook.ts`, with
`src/deliver.ts` absent. Set `SMITHERS_OUTSIDE_BRANCH`,
`SMITHERS_OUTSIDE_SSH_HOST` / `SMITHERS_OUTSIDE_SSH_PORT` to Maya's SSH
identity. Ben's browser exercises Restore and Follow with the keyboard.
The test reads back machine bytes and composed HTTP projections, retains
live frames and SSH operations, checks one activity entry per operation,
and checks Follow retains the same mounted card. It leaves the canary
changes in place for inspection; provision a fresh branch before rerunning.
Formatter Restore/Compare is in `branch-outside-change.spec.ts`.
