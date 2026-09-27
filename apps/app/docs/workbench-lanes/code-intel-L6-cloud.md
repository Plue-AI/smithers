# Lane L6 (cloud) — hover, definition and diagnostics on cloud workspaces (2026-09-03)

plue #505 is live (API tag 6d320ea92cd0); the wire is recorded at the end of
`docs/code-intel/PLAN.md` ("Live"). Build the cloud half of the LSP design on
top of what lanes L2/L3 landed for native (`state/LspClient.ts`,
`state/seams/CodeIntelSeam.ts`, the `code.*` flows), so the same three flows
answer for a file card whose repo is a cloud repo with a running workspace.
Laws as always (apps/app/AGENTS.md incl. THE THREE-DOOR LAW, apps/DESIGN.md):
NO INVENTION, no useEffect, collections via the dispatcher, every act one
flow with three doors, close reasons and refusals verbatim.

## Design

- Transport: the Bun tunnel `/api/cloud-ws/*` already relays workspace
  terminal sockets to Smithers Cloud with the keychain PAT (`src/bun/server.ts`
  CloudWsBridge: segment guard, Origin policy, 64 KiB frame cap, refusal →
  44xx close codes via one recovery GET). Add an `lsp` branch: allow the
  `…/workspace/sessions/{id}/lsp` path, the `lsp` subprotocol, and raise the
  frame cap to 1 MiB for that branch only (fragments `{ seq, last, data }`
  are reassembled in the renderer client, capped at 16 MiB). On the web host
  (no Bun) the Worker relay from the web-mode plan W4 carries the same
  branch later; until then cloud LSP is native-only and `local.lsp`/
  `cloud.terminal` capability gating says so.
- `state/CloudLspClient.ts` (mirrors `CloudTerminalClient.ts`'s close-code
  policy): `POST /workspace/sessions { workspace_id, kind: "lsp", language }`
  through the cloud proxy, open the socket through the tunnel, `initialize`
  with `rootUri file:///home/developer/workspace` and `workspaceFolders`,
  `initialized`, `didOpen` with the card's content (path relative to the
  checkout), then hover/definition/diagnostics requests; pre-upgrade 425/503
  honor Retry-After (bounded auto-retry, verbatim text meanwhile); 409
  `language_server_missing` renders the install line verbatim on the card;
  1011 retries once with a fresh initialize; 1001 reconnects; 1008/1002/1003/
  1009 final; every close reason shown verbatim, never a silent close.
- `CodeIntelSeam` picks the client by the card's repo: local working copy →
  `LspClient` (native host); cloud repo with a running workspace → the cloud
  client; cloud repo without a running workspace → the honest line naming
  `box.open` / `box.resume`; unsupported language → the DTO's
  `lsp.languages` list stated.
- Workspace card: the header's kind line gains `lsp: typescript` from
  `lsp.languages`; no new facet.

## Tests

Tunnel `lsp` branch test with a real loopback WebSocket upstream (the
`CloudWsTunnel.test.ts` pattern): subprotocol forwarded, 1 MiB frame passes,
fragments reassembled, refusal mapped to the 44xx code. `CloudLspClient.test.ts`
with a real loopback server speaking the recorded transcript (initialize →
hover result), plus 425/503/409-missing/1011/1001/1008 paths. Seam test for
the client selection. Workspace card test for `lsp: typescript`.

## Files

`src/bun/server.ts` (tunnel `lsp` branch + tests), new
`state/CloudLspClient.ts` (+test), `state/seams/CodeIntelSeam.ts` (+test),
`state/seams/WorkspaceSeam.ts` (parse `lsp.languages`, session `kind`),
`cards/WorkspaceCard.tsx` (one header line), `packages/rpc/src/Cards.ts` /
`LocalApp.ts` rows as needed. Depends on the code-intel workflow (L0–L5)
having landed; re-read every shared file before each edit.

## Verification

`cd apps/app && bun x tsc --noEmit -p . && bun test src/bun/CloudWsTunnel.test.ts src/bun/server.test.ts src/mainview/state/CloudLspClient.test.ts src/mainview/state/seams src/mainview/cards/WorkspaceCard.test.tsx`, then `bun test src/mainview` once. Write `code-intel-L6-cloud.REPORT.md`.
