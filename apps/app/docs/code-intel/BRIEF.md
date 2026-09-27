# Planning brief — syntax highlighting and LSP support in Smithers file cards

> Partly superseded 2026-09-27 (smithersai/smithers#2239): the local repository inventory (`repos.loaded`), pins (`repo.pinned`, `repo.unpinned`, `repo.unpin`), `repo.open`, `local:` working copies and `POST /api/repo/files` are gone. Working copies are boxes and shared copies.

Will, 2026-09-03: "When I open files I notice there is no syntax highlighting
or LSP support can we have a fable agent figure out how to get that working
with high quality architecture."

Write a PLAN AND ARCHITECTURE, not code. Ground every claim in the tree and
cite files. Recommendations, not menus. Under ~450 lines. Write it to
`apps/app/docs/code-intel/PLAN.md` (NOT `docs/plans/`, which is gitignored).

## Facts in the tree (verify, then build on them)

- The file card (`apps/app/src/mainview/cards/FileCards.tsx`) renders source
  as a bare `<pre>` (line ~236) inside a 60vh scroll panel (`world-card-panel`,
  `styles/cards.css`); markdown goes through `MarkdownEditorSurface.tsx`
  (`@smthrs/ui/adapters/markdown-editor` = Milkdown Crepe 7.21, which has its
  own code-block editor) in readOnly mode. Payload
  (`packages/rpc/src/Cards.ts` ~903): `{ repo, path, content, truncated,
  binary?, globalPath? }`; reads are bounded by `REPO_FILE_READ_CAP_BYTES`
  (`apps/app/src/bun/RepoFiles.ts`), binary stated never printed. `files.read
  <path> [repo]` is a flow the agent, slash and buttons share and returns
  `{ value }` to the model; local reads go through `POST /api/repo/files` on
  the Bun host, cloud reads through `/api/repos/{o}/{r}/contents` and the
  workspace files route.
- Diffs: `packages/smithers/ui/src/diff-hunks.tsx` + the `pierre-diff-view` adapter;
  the change card's Diff facet (`cards/ChangeCards.tsx`).
- `packages/smithers/ui` puts heavy dependencies under `./adapters/*` subpath exports
  (`packages/smithers/ui/package.json` exports; `tests/barrel-weight.test.ts` ratchets
  the barrel). `apps/site` already depends on `@shikijs/themes` (Astro docs);
  nothing else in the workspace ships a highlighter, CodeMirror, Monaco,
  tree-sitter, or an LSP client.
- Bundling: Vite + rolldown; `apps/app/vite.config.ts` splits vendor code into
  `initial~` chunks and carries `entryChunkGuard()` (a chunk statically
  reachable from the entry must not import the entry back; a white window
  on 2026-09-03 taught this). Heavy editors already load as async chunks
  (`GraphCard`, `MarkdownEditorSurface`). Any highlighter or LSP client must
  be an async boundary too.
- Two shells (`apps/app/docs/web-mode/PLAN.md`): native = Bun main process
  (`apps/app/src/bun/`) with the repo on disk, PTY, harness spawning, a
  `/api/cloud-ws/*` WebSocket tunnel, keychain; web = Cloudflare Worker, no
  processes. Cloud workspaces (plue) are real Linux machines with a terminal
  WebSocket (Bearer, `terminal` subprotocol, 64 KiB frames, close-code
  contract in ADR 0002) and a files route; an LSP could run inside a
  workspace if plue relays it. Agent runs are workspaces (plue RFD-004).
- Laws (`apps/app/AGENTS.md`, `apps/DESIGN.md`): EMBED LAW (a file is a card
  in the one chat; maximize only by the user), NO INVENTION, no React
  `useEffect`, state in TanStack DB collections via the dispatcher, every act
  is ONE flow with three doors (slash, button, agent) — will's parity rule,
  restated in `docs/workbench-lanes/agent-parity.md`: anything a human can do
  in the UI the agent can do too; 300 ms toast law (no jank on open); the
  composed model instructions are capped at 16 KiB, so new flows must be few
  and well-namespaced; product code and e2e use real backends, never mocks
  (`CLAUDE.md`); theme tokens live in `state/Appearance.ts` + `styles/*.css`
  (light/dark).

## Decide (a recommendation for each, with the reason it beat the alternative)

1. **Highlighting engine and rendering.** Shiki (`@shikijs/core` with
   fine-grained language and theme imports, JS regex engine vs WASM
   oniguruma) rendering static tokens for read-only cards, versus CodeMirror
   6 + Lezer (an editor, also usable read-only), versus web-tree-sitter.
   Cover: theme mapping onto the app's light/dark tokens; lazy language
   loading; where the work runs (main thread vs a Web Worker) to hold the
   300 ms law on a capped file; line numbers and a line anchor
   (`files.read <path> [repo] [line]` so a definition or diagnostic can open
   a card scrolled to a line); one engine shared by file cards, the diff
   view, and Crepe's markdown code blocks (which highlighter Crepe uses and
   whether it can be unified); the `packages/smithers/ui/adapters/*` placement and
   the barrel-weight ratchet; bundle placement under the entry-chunk guard.
2. **What "LSP support" means in a chat-card product, v1 scope.** Hover
   (type/signature), go-to-definition (opens another file card at a line),
   diagnostics for the open file, references, document symbols, rename?
   Recommend a v1 set and say what waits.
3. **LSP host architecture per shell.** Native: Bun spawns language servers
   per repository root from a registry keyed by language (TypeScript via
   `typescript-language-server` or `tsserver` directly, plus rust-analyzer,
   gopls, pyright, etc. discovered on PATH; not installed by default: a
   missing server is stated honestly with the install line), one JSON-RPC
   session per repo, document sync from the card's content, requests over
   the local origin (route shape, streaming diagnostics via the existing
   WebSocket or SSE), lifecycle (idle shutdown, one server per repo, sign-out
   and repo-close teardown), and the security boundary (the server sees the
   repo the user granted, nothing else; no arbitrary binary execution from
   the renderer). Cloud workspace: the server runs inside the workspace;
   name the relay plue must add (route, auth, framing, mirroring the
   terminal contract) as a filed backend ask. Web without a workspace: no
   LSP, stated honestly with the next step (open a workspace, or the native
   app).
4. **The agent's doors.** Flows the model can call too: e.g.
   `code.hover <path> <line> <col>`, `code.definition …`,
   `code.diagnostics <path>`, `code.symbols <path>`, each returning
   `{ value }` text to the model and a card to the human; namespace, args,
   and the instruction-budget cost. This is the parity rule and a real
   capability for the agent ("what is the type of X", "where is Y defined").
5. **UI in the card.** Hover popover, Cmd/Ctrl-click definition, a
   diagnostics strip or gutter, the line-anchor scroll, maximized behavior;
   ASCII mockups. Nothing that only lives in a component: card state in the
   payload/collections.
6. **Testing.** Unit: token snapshots for TS, TSX, JSON, Markdown, Rust
   fixtures; theme mapping. Seam: the Bun LSP host against a real
   `typescript-language-server` over stdio on a fixture repo (real backends;
   how the test provisions the binary). Card tests. A T1 spec: open a `.ts`
   file, see tokens; hover a symbol; go to definition opens a second card
   at the line.
7. **Lanes**, ordered, with file-level scope, tests, dependencies, and what
   proves the walking skeleton (a highlighted TypeScript file card, then
   hover on native). Risks. At most five open questions for will, each with
   the default you assume.
