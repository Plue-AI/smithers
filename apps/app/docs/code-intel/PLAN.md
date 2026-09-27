# Code intelligence in file cards — plan and architecture (Fable, 2026-09-03)

> Partly superseded 2026-09-27 (smithersai/smithers#2239): the local repository inventory (`repos.loaded`), pins (`repo.pinned`, `repo.unpinned`, `repo.unpin`), `repo.open`, `local:` working copies and `POST /api/repo/files` are gone. Working copies are boxes and shared copies.

Answers `BRIEF.md`. Every claim names a file; every decision names what it
beat. Walking skeleton: a highlighted TypeScript file card (lane 1), then
hover on native (lanes 2-4).

## 0. Where the brief is wrong (verified first)

1. **Two highlighters already ship.** `@pierre/diffs` 1.3.5, a dependency of
   `packages/smithers/ui` (`package.json:74`), depends on `shiki ^3||^4`; the lockfile
   resolves `shiki@3.23.0` with `@shikijs/{core,engine-javascript,
   engine-oniguruma,langs,themes}` (`pnpm-lock.yaml:22765-22771`). And
   `@milkdown/crepe` 7.21.2 depends on `codemirror`, `@codemirror/language-data`
   (every Lezer grammar) and `@codemirror/theme-one-dark`
   (`packages/smithers/ui/node_modules/@milkdown/crepe/package.json`). "Nothing else in
   the workspace ships a highlighter or CodeMirror" is false; only Monaco,
   tree-sitter and an LSP client are absent.
2. **`@pierre/diffs` is a file renderer, not only a diff widget.** Its `react`
   entry exports `File`, `CodeView` with `CodeViewFileItem { id, type: "file",
   file: FileContents }`, `CodeViewHandle.scrollTo({ type: "line", lineNumber })`,
   `lineAnnotations` + `renderAnnotation`, `selectedLines`, `OnTokenEventProps`
   (`lineNumber, lineCharStart, lineCharEnd, tokenText, tokenElement`), a
   worker pool (`./worker`, `useWorkerPool`), `preferredHighlighter:
   "shiki-js" | "shiki-wasm"` (`dist/types.d.ts:53,338-351,418-460,531-538`).
3. **Crepe's code blocks are CodeMirror 6 with one-dark.** The feature config
   is `Partial<CodeBlockConfig & { theme: Extension }>` with `languages` and
   `extensions` (`crepe/lib/types/feature/code-mirror/index.d.ts`,
   `@milkdown/components/lib/code-block/config.d.ts:3-21`). Our adapter
   constructs `new Crepe({ root, defaultValue })` with defaults
   (`packages/smithers/ui/src/adapters/markdown-editor/MarkdownEditor.tsx:249`). Shiki
   cannot replace it without replacing the feature.
4. **Payload fields.** `packages/rpc/src/Cards.ts:906-931`: `{ repo, path,
   content, truncated, binary?, address?, readAt? }`. The field is `address`,
   not `globalPath`.
5. **Two caps, and the small one governs rendering.** `REPO_FILE_READ_CAP_BYTES`
   = 256 KiB lives in `packages/rpc/src/LocalApp.ts:103` (RepoFiles.ts imports
   it); the card's content is then cut to `CARD_CONTENT_CAP` = 16 KiB chars
   (`state/seams/FilesSeam.ts:62,317-321,462-466`).
6. **Diffs are not highlighted today.** `DiffCardBody` renders `file.patch` as
   a bare `<pre>` (`cards/ChangeCards.tsx:1078`); nothing in `apps/app` imports
   `DiffHunks` or `PierreDiffView` (grep). The change card's Diff facet lists
   file rows and opens the `diff` card through `change.diff` (`:304`).
7. **Theme authority.** `state/Appearance.ts` is a localStorage mirror only
   (`:1-16`). The tokens live in `styles/tokens.css` on two axes (`data-theme`
   × `data-palette`, night-owl default plus eight palettes) and in
   `@smthrs/ui-styleguide` `themeRegistry[palette].syntax.{shikiDark,shikiLight}`
   (`packages/smithers/ui/ui-styleguide/src/themes/*.ts:72-73`), fourteen Shiki ids that all
   exist in `@shikijs/themes/dist` (checked, including `night-owl-light`).
8. **The `code.` namespace and the line anchor are already reserved.**
   `docs/WORKBENCH-UX.md:374,626` name `code.search`, `code.goto <path>:<line>`
   and "file card `line`" (lane C7, briefed, unbuilt: no `code.` flow exists in
   `flows/Flows.ts`).
9. **Targets live in `apps/app/PACKAGE.ts`** (`check`, `unitTests`), not
   `BUILD.ts`; T1 is not a target (`docs/web-mode/PLAN.md` correction 9).
10. Right as stated: `<pre>` at `FileCards.tsx:236`; `.world-card-panel`
    60vh (`cards.css:1175-1185`); `entryChunkGuard` (`vite.config.ts:78-101`);
    lazy `MarkdownEditorSurface`/`GraphCardBody`; keychain PAT
    (`bun/CloudAuth.ts:7`); RFD-004 (`workbench-lanes/L3b-desktop.md:106`);
    terminal contract (ADR 0002 `:53-69`); 16 KiB cap
    (`state/Instructions.ts:236`); 208 flows in the catalog today.

## 1. Highlighting engine and rendering

**Decision: `@pierre/diffs` `File` over Shiki 3.23, through a new
`@smthrs/ui/adapters/code-view` subpath.** It beat raw `@shikijs/core`
(we would rewrite line numbers, line anchors, annotations, virtualization and
the worker, and carry a second Shiki registry beside pierre's), CodeMirror 6
(an editor for a read-only card; Lezer tokens are a second theme system, and
it would still not unify with Crepe's CM, which lives inside ProseMirror) and
web-tree-sitter (WASM per grammar, no bundled themes, nothing in the tree).
Zero new dependencies; the diff card moves onto the same component in lane 5,
so "one engine for files and diffs" is a fact, not a goal.

- **Theme mapping.** Reuse `diffsThemeForMode(mode, palette)`
  (`packages/smithers/ui/src/adapters/pierre-diff-view.tsx:35-38`) with
  `useResolvedTheme`/`useResolvedPalette`; pass `theme` + `themeType` as the
  diff adapter does. Frame background is `var(--code-bg)`, text
  `var(--code-text)` (`tokens.css:91-93`) so the card follows both axes.
- **Lazy languages.** pierre resolves a grammar per file name
  (`getFiletypeFromFileName`, `resolveLanguage`); the JS regex engine is the
  default (`preferredHighlighter: "shiki-js"`), no WASM fetch. Grammars are
  separate chunks under `initial~` splitting because they are `node_modules`.
- **Where the work runs.** pierre's worker pool when `Worker` exists (the
  WebView and Chromium), main thread otherwise (happy-dom tests). The card
  renders the plain `<pre>` synchronously and swaps in the token view when the
  async chunk and grammar are ready: plain text is a complete state, so no
  toast. A 16 KiB file tokenizes in tens of milliseconds after grammar load;
  the 300 ms law is held by never blocking on the load.
- **Line numbers and the anchor.** pierre draws line numbers. The anchor is
  a `:line` suffix on the path token, `files.read <path>[:<line>[:<col>]]
  [owner/repo]`, the grammar C7 already chose for `code.goto`; no new flow,
  the parser stays first-token-is-path. Payload gains `line?`; the card
  scrolls with `CodeViewHandle.scrollTo({ type: "line" })` and marks it via
  `selectedLines`.
- **Crepe.** Keep CodeMirror inside markdown files. Lane 6 passes a `theme:
  Extension` built from the same tokens through `CodeMirrorFeatureConfig`,
  generated by `scripts/generate-ui-themes.ts` beside
  `crepeTheme.generated.ts`. Engines stay two; the look becomes one.
- **Placement and ratchets.** The adapter sits under
  `packages/smithers/ui/src/adapters/code-view/` behind `./adapters/code-view`;
  `tests/barrel-weight.test.ts` already lists `node_modules/@pierre/diffs` in
  `HEAVY_MODULES` (`:21-27`) and gains the subpath in the exports assertion
  (`:107-115`). In `apps/app` the surface is `lazy(() => import("./CodeSurface"))`
  from `FileCards.tsx`, the `MarkdownEditorSurface` pattern (`:21-23`), so
  pierre and Shiki land in an async chunk that never imports the entry.

## 2. What "LSP support" means here — v1 scope

**v1: hover, go-to-definition, diagnostics for the open file.** Hover answers
"what is the type of X"; definition answers "where is Y defined" and opens a
file card at the line; diagnostics is what a human sees in an editor and
what the agent needs before claiming code compiles. **v1.1: references,
document symbols** (bounded lists; one flow each, budget permitting).
**Waits:** rename and code actions (a write; the file card is read-only by
design, `FileCards.tsx:16-20`), completion (no editor), project-wide
diagnostics (unbounded), semantic tokens (Shiki covers the card).

## 3. LSP host architecture per shell

### Native (Bun main process)

One language-server process per `(repoId, language)`, owned by
`apps/app/src/bun/lsp/`, reached over the local origin the way PTYs are
(`routes/pty.ts`, `Pty.ts`). v1 language: TypeScript via
`typescript-language-server --stdio` (5.3.0 on this machine; it resolves the
repository's own `typescript`). The registry is a static table; the renderer
never names a binary, an argv, or a cwd (LOCAL-APP.md "Repository and
process authority").

```
apps/app/src/bun/lsp/LanguageServers.ts
  export type LanguageId = "typescript"                      // v1; table-ready for rust, go, python
  export interface ServerSpec { id: LanguageId; extensions: readonly string[]; bin: string;
    args: readonly string[]; rootMarkers: readonly string[]; install: string;
    initializationOptions?: Record<string, unknown> }        // TS: disableAutomaticTypingAcquisition
  export const languageFor: (path: string) => LanguageId | null
  export const resolveServer: (spec: ServerSpec, lookup: ServerLookup, node: NodeSidecar | null)
    => { argv: readonly string[] } | { missing: string }     // harnessCandidateDirs + PATH on the HOST, never <repo>/node_modules/.bin (see Remediation 1); node sidecar runs the cli

apps/app/src/bun/lsp/JsonRpc.ts                               // Content-Length framing over Bun.spawn stdio; no dependency
  export const createJsonRpc: (proc: Subprocess, opts: { onNotification; log }) => JsonRpc
  export interface JsonRpc { request<T>(method, params, timeoutMs): Promise<T>; notify(method, params): void; close(): void }

apps/app/src/bun/lsp/LspSession.ts                            // one server: initialize, didOpen from DISK text, requests, publishDiagnostics
  export interface LspSession { readonly repoId; readonly language; readonly state: "starting" | "ready" | "exited";
    open(relPath): Promise<void>; hover(relPath, pos): Promise<HoverResult | null>;
    definition(relPath, pos): Promise<readonly Location[]>; diagnostics(relPath, waitMs): Promise<readonly Diagnostic[]>;
    touch(): void; shutdown(): Promise<void> }

apps/app/src/bun/lsp/LspHost.ts
  export interface LspHostOptions { publish: LocalServer["publish"]; node: Promise<NodeSidecar | null>; home: string;
    sandbox: SandboxHost; maxServers?: number /* 4 */; idleMs?: number /* 10 min */; log }
  export interface LspHost { session(repoId, repoRoot, path): Promise<LspSession | { missing: string }>;
    list(): readonly ServerStatus[]; closeRepo(repoId): Promise<void>; killAll(): Promise<void> }

apps/app/src/bun/routes/lsp.ts                                // POST /api/lsp/{hover,definition,diagnostics}, GET /api/lsp/servers
  export const registerLspRoutes: (host: PtyRouteHost, lsp: LspHost, repositories: PtyRepositoryResolver) => void
```

- **Route shape** (`packages/rpc/src/LocalApp.ts`): `LSP_PATH = "/api/lsp"`;
  `LspPositionRequestSchema = { repoId, path (≤4096), line ≥1, character ≥1 }`;
  `LspFileRequestSchema = { repoId, path }`; answers are typed JSON, positions
  1-based on the wire and in flows, converted once at the session. Paths go
  through `repoPathSegments` + realpath like `RepoFiles.ts:39-84`. Access is
  `resolveRepo(repoId, "read")` (`routes/repoTargets.ts:127-135`): a language
  server reads. Failures use `{ error: { code, message } }`; `409
  language_server_missing` carries the install line verbatim.
- **Streaming diagnostics** ride the existing `/ws` bus: the session publishes
  `{ type: "lsp.diagnostics", repoId, path, version, items }` on topic
  `lsp:<repoId>` through `LocalServer.publish` (`server.ts:1083-1085`); the
  renderer subscribes like `PtyClient.ts` does for `pty:<id>`. No SSE: one bus,
  one subscription cap, one reconnect story. `POST /api/lsp/diagnostics` also
  answers the first `publishDiagnostics` after `didOpen` (bounded 5 s), so
  the flow has a value without a socket.
- **Lifecycle.** Spawn on first request (`state: "starting"` is stated on the
  card and by the 300 ms toast "Starting the TypeScript language server").
  Idle shutdown after 10 min (LSP `shutdown`/`exit`, SIGKILL after 2 s, the
  `Pty.ts:352-376` grace pattern). `POST /api/repo/close` calls
  `closeRepo` next to `targetGrants.delete` (`repoTargets.ts:221-231`);
  `server.stop` awaits `killAll` beside `pty.killAll`. Cloud sign-out is
  unrelated: local servers belong to local repositories.
- **Security boundary.** New `Sandbox.ts` policy `lsp`: network `deny`,
  writable = scratch tmpdir only (`sandboxPolicies` gains the id; profile
  snapshot-tested like the others). Env is the server's own (`lspChildEnv`:
  HOME, PATH, TMPDIR, locale, zone — none of the PTY allowlist's provider
  keys, SSH agent or config dirs; Remediation 2). Caps: 4 servers, 8
  in-flight requests per server, 5 s per steady-state request. Native
  initialization and the shared first positioned-query project-load window
  each allow 15 s: TypeScript loads the project after initialize, and cold
  loads regularly exceed 5 s under CPU contention. A successful positioned
  response ends the cold window; concurrent initial queries share its
  deadline rather than extending it. Bodies are capped at 64 KiB, hover text
  cut at 4 KiB, 50 diagnostics, 20 locations — every cap stated on the wire
  (`truncated`, `total`, `omitted`). A missing server is stated with its
  install line and never installed. Free text from the server has host paths
  made repository-relative or cut to a last segment before it leaves the
  session.
- **Capability.** `RuntimeCapabilitySchema` gains `"local.lsp"`
  (`packages/rpc/src/AppBootstrap.ts:6-21`); `localCapabilities` emits it
  (`HostCapabilities.ts:48-60`); `code.*` flows carry `runtime: ["local.lsp"]`
  so `Commands.available()` (`flows/Commands.ts:194-198`) hides them on web
  and `explainAbsent` answers "needs the native app".

### Cloud workspace (plue)

The server runs inside the workspace; plue must relay it. **Backend ask to
file (plue): "LSP relay per workspace session"**, mirroring the terminal
contract (ADR 0002 `:53-69`, `CloudTerminalClient.ts:84-98`):
`GET wss://api.jjhub.tech/api/repos/{o}/{r}/workspace/sessions/{id}/lsp?language=typescript`,
subprotocol `lsp`, Bearer PAT (browsers use the sse-ticket), text frames = one
JSON-RPC message each, max message 1 MiB (hover and diagnostics exceed 64 KiB;
if plue keeps 64 KiB, frames carry `{ seq, last }` fragments), server pings,
same pre-upgrade statuses (401/403/409/429) plus `409 language_server_missing`
with the install line, same close codes (1000/1001/1008/1011). The Bun tunnel
adds an `lsp` branch beside the terminal one in `server.ts` (`CloudWsBridge`
gains `kind`); the Worker relay comes with web-mode W4. **Built (lane L6,
2026-09-03):** `state/CloudLspClient.ts` speaks the relay's wire through the
tunnel and `CodeIntelSeam` picks it for a cloud repository with a running
workspace; a cloud repository without one is told `/box.open` or
`/box.resume`, and a file no relayed language handles is told the DTO's
`lsp.languages`. On the web host (no tunnel) the three flows are hidden with
`local.lsp` and a cloud card is told the native app has the tunnel.

### Web without a workspace

No LSP. `local.lsp` is absent, the flows are filtered, the refusal names the
native app. Highlighting works everywhere: it is client-side.

## 4. The agent's doors

Namespace `code.` (reserved by C7). Each flow is ONE act with three doors:
slash, the card's pointer/keyboard gesture, and the agent tool
(`docs/workbench-lanes/agent-parity.md:10-15`). None is `userOnly`; none needs
`confirm` (reads). Each returns `{ value }` to the model (`FilesSeam.ts:24-31`
rule) and updates the FILE card for the human: no new card kind.

| Flow | args | runtime | value to the model | card effect |
| --- | --- | --- | --- | --- |
| `code.hover` | `<path>:<line>:<col> [owner/repo]` | `local.lsp` | signature/type + docs, ≤4 KiB | `payload.hover` → popover at the token |
| `code.definition` | `<path>:<line>:<col> [owner/repo]` | `local.lsp` | `path:line:col` list, ≤20 | runs `files.read <target>:<line>` |
| `code.diagnostics` | `<path> [owner/repo]` | `local.lsp` | `line:col severity message` rows, ≤50 | `payload.diagnostics` → annotations + count |
| v1.1 `code.references`, `code.symbols` | as above | `local.lsp` | bounded lists | annotations / a listing in the card |

If `files.read` refuses the first definition target, `code.definition` keeps
the location list and appends `; the target could not be opened: <refusal>`
to its value.

Budget: three stage-0 lines at ~95 bytes ≈ 290 bytes against a 14 KiB prompt
budget (`Instructions.ts:240`); `InstructionsBudget.test.ts:69` stays the
gate and lane 3 reports the stage the catalog lands in. `Instructions.ts:65`
gains "answer type, definition and diagnostics questions about opened code
(code.*)". `files.read` gains `:line` with no new line in the prompt.

## 5. UI in the card

State lives in the payload (`Cards.ts` `file`), all optional so persisted
cards parse: `line?`, `column?`, `diagnostics?: [{ line, character, endLine,
endCharacter, severity, message, source? }]`, `hover?: { line, character,
contents } | null`, `intel?: { state: "ready" | "starting" | "missing" |
"unavailable"; note?: string }`. Components project it; the seam writes it
through `card.updated` patches (`AppState.ts:1220`). No `useEffect`: the
pointer-rest timer and the scroll-on-mount live in the adapter's imperative
handle callbacks, the card reads collections.

Embedded (60vh panel, `.world-card-panel`), TypeScript file, one error:

```
┌ File · smithers · apps/app/src/mainview/state/seams/FilesSeam.ts ─────────── ⤢ ┐
│ /smithers/smithers/apps/app/src/…/FilesSeam.ts · zvkqnrmx          TypeScript │
│ 1 error · 0 warnings                                                          │
│  60 │ const CARD_CONTENT_CAP = 16 * 1024                                       │
│  61 │                                                                          │
│  62 │ const isRecord = (value: unknown): value is Record<string, unknown> =>   │
│  63 │   value !== null && typeof value === "object" && !Array.isArray(value)   │
│     ┆ ┌───────────────────────────────────────────────────────────────┐        │
│     ┆ │ const isRecord: (value: unknown) => value is Record<string,   │        │
│     ┆ │ unknown>                                        ⌘-click: definition │  │
│     ┆ └───────────────────────────────────────────────────────────────┘        │
│  64 │                                                                          │
│ ▶317│   const truncated = !binary && (answer.body.truncated || content.lenght │
│     │   ✖ Property 'lenght' does not exist on type 'string'. (ts 2551)         │
│ 318 │   const payload = {                                                      │
│ … scrolls inside the card …                                                    │
└───────────────────────────────────────────────────────────────────────────────┘
```

- Header: existing address line (`FileCardAddressLine`) + language word +
  the diagnostics count line, present only when the server answered.
- Hover: pointer rest 300 ms on a token (or focus + `?`) runs
  `onRunCommand("code.hover", "path:line:col repo")`; one in flight; the
  popover is `@smthrs/ui` tooltip primitives anchored to `tokenElement`.
  ⌘/Ctrl-click a token runs `code.definition`. Both are `data-flow` bindings
  like every row in `FileCards.tsx`.
- Diagnostics: pierre `lineAnnotations` render the message under its line
  (`renderAnnotation`), colored by severity from `--danger`/`--warning`
  tokens; `▶` marks the anchored `line` (`selectedLines`).
- Server state, honest and only when relevant:

```
│ Hover and definitions: no TypeScript language server on this machine.        │
│ Install: npm i -g typescript-language-server typescript                      │
```

- Maximized: same component (`.smithers-card[data-maximized="true"]
  .world-card-panel { max-height: none }` exists, `cards.css:1182`); pierre
  virtualizes, so a 256 KiB file scrolls the page, not the card. Entered only
  by the user (EMBED LAW).
- Definition target: `files.read <path>:<line> <repo>` upserts the file card
  with id `file-<repo>-<path>` (existing dedupe, `FilesSeam.ts:327`) and
  scrolls to the line.

## 6. Testing

Real backends, never mocks (`CLAUDE.md`).

- **packages/smithers/ui** (`bun test tests`): `tests/code-view.test.tsx` renders the
  adapter on the main thread in happy-dom and snapshots token class/style
  sequences for fixtures `ts`, `tsx`, `json`, `md`, `rs`; a theme test asserts
  every `themeRegistry[*].syntax` id imports from `@shikijs/themes`;
  `barrel-weight.test.ts` gains `./adapters/code-view`.
- **apps/app unit** (`bun test src`): `FileCards.test.tsx` (plain `<pre>` first,
  token view after load, anchored line marked, diagnostic rows, missing-server
  note, hover popover from payload); `FilesSeam.test.ts` (`:line` parsing,
  payload.line); `flows/SlashPayload.test.ts` (code.* grammars);
  `state/seams/CodeIntelSeam.test.ts`; `flows/agent-parity.test.ts` (code.*
  invocable through `executeAgentToolCall`); `InstructionsBudget.test.ts`.
- **Bun host seam** (`src/bun/lsp/LspHost.test.ts`): spawns the REAL
  `typescript-language-server` over stdio on `src/bun/lsp/fixtures/ts-project/`
  (tsconfig, two files, one deliberate error). Provisioning: add
  `typescript-language-server` (pinned) to `apps/app` devDependencies, resolved
  from `apps/app/node_modules/.bin`; `typescript` already resolves in the
  workspace; both lockfiles refresh in the same commit. Asserts hover text,
  definition line, the deliberate diagnostic, idle shutdown, `closeRepo`
  kill, and the `lsp` seatbelt profile. `routes/lsp.test.ts` drives the
  routes against the same real host.
- **T1** (`e2e/playwright/code-intel.spec.ts`): open the fixture repo through
  the prompt fallback (`repo-targets.spec.ts:32-36`), `/files.read
  src/index.ts`, expect tokens inside `.smithers-card[data-kind="file"]
  [data-slot="code-view"]`; hover a token, expect the popover text; ⌘-click,
  expect a second file card with `data-line` and the line in view.

## 7. Lanes

| # | Lane | Files | Tests | Depends on | Proves |
| --- | --- | --- | --- | --- | --- |
| L0 | Contracts | `packages/rpc/src/{Cards.ts (file payload fields), LocalApp.ts (LSP_PATH, schemas), AppBootstrap.ts (local.lsp), HostCapabilities.ts}` | Cards tests, HostCapabilities parity test | — | tsc green; old cards parse |
| L1 | Highlight skeleton | `packages/smithers/ui/src/adapters/code-view/{index.ts,CodeFileView.tsx}`, `packages/smithers/ui/package.json` exports, `apps/app/src/mainview/cards/{CodeSurface.tsx,FileCards.tsx}`, `styles/cards.css`, `state/seams/FilesSeam.ts` + `flows/SlashPayload.ts` (`:line`) | code-view snapshots, barrel-weight, FileCards, FilesSeam, SlashPayload | L0 | `/files.read apps/app/src/mainview/App.tsx` shows tokens in light and dark, all nine palettes; `vite build` emits `CodeSurface-*.js` as its own chunk and passes `entryChunkGuard` |
| L2 | Native LSP host | `apps/app/src/bun/lsp/{LanguageServers,JsonRpc,LspSession,LspHost}.ts`, `routes/lsp.ts`, `Sandbox.ts` (`lsp` policy), `server.ts` (wiring, close, stop), `docs/LOCAL-APP.md` route rows, `apps/app/package.json` devDependency | LspHost seam test on the real server, routes test, Sandbox profile snapshot | L0 | `curl POST /api/lsp/hover` on the fixture answers the type |
| L3 | Renderer seam + flows | `state/seams/CodeIntelSeam.ts`, `state/LspClient.ts`, `flows/Flows.ts` (3 flows), `flows/SlashPayload.ts`, `state/AppController.ts`, `state/Instructions.ts`, `flows/agent-parity.test.ts` | seam, flows, budget, parity | L1, L2 | `/code.hover …:12:5` answers `{ value }` and patches the card; the agent answers "what is the type of X" through the tool |
| L4 | Card UI | `cards/FileCards.tsx`, `cards/CodeSurface.tsx`, `styles/cards.css`, `e2e/playwright/code-intel.spec.ts` | FileCards tests, T1 | L3 | hover popover, ⌘-click opens the definition at its line, diagnostics rows, missing-server note |
| L5 | Diff on the same engine | `cards/ChangeCards.tsx` (`DiffCardBody` → lazy `PierreDiffView` with `file.patch`), `styles/cards.css` | ChangeCards tests, `change.spec.ts` | L1 | the `diff` card shows highlighted hunks |
| L6 | Polish and cloud | `scripts/generate-ui-themes.ts` + `crepeTheme.generated.ts` (CM theme from tokens), `MarkdownEditor.tsx` (`codeMirror` feature config), `server.ts` tunnel `lsp` branch + `CloudLspClient.ts` once plue relays, `code.references`/`code.symbols`, rust/go/python rows in `LanguageServers.ts` | adapter tests, tunnel test, budget | plue relay | markdown code blocks follow the palette; cloud hover |

Walking skeleton = L0 + L1 (a highlighted TypeScript card), then L2 + L3
(hover on native from slash and agent), then L4 (hover in the card). L1, L2
and L5 run in parallel after L0.

### Risks

1. pierre's worker pool inside the Electrobun WebView (COOP/COEP headers are
   set; module workers from the built bundle are untested there). Mitigation:
   `disableWorkerPool` fallback per shell, measured in L1 on a 16 KiB file.
2. TypeScript grammar + theme chunk (~300-500 KB) on first open. Mitigation:
   async chunk, cached by hash; plain text shows first.
3. tsserver project load on a large repository (seconds). Mitigation: the
   `starting` state on the card, the 300 ms toast, idle keep-alive 10 min.
4. Seatbelt denies something tsserver needs. Mitigation: ATA disabled,
   writes scoped to scratch, the profile asserted and the seam test run with
   `SMITHERS_SANDBOX` enforced on macOS CI.
5. Budget stage flip (0→1) from three new lines. Mitigation: designed
   degradation; the lane reports the stage.
6. `@pierre/diffs` API churn (`^1.2.12` range). Mitigation: pin exact in
   `packages/smithers/ui/package.json` when L1 lands.
7. `:line` suffix versus paths containing `:`. Mitigation: parse only a
   trailing `:\d+(:\d+)?`; repository paths with colons keep working.
8. The cloud relay depends on plue. Mitigation: the ask is filed in L2 with
   the framing above; cloud cards degrade honestly until then.

### Remediation landed (2026-09-03, confirmed findings)

1. **No repository binary.** `resolveServer` searches the harness candidate
   dirs and PATH only; a `node_modules/.bin/typescript-language-server` a
   repository ships is never run (a read-only open executed repo code).
   `LspHost.test.ts` spawns a real trap binary and proves it never runs.
2. **Own environment.** `lspChildEnv` (LspHost.ts) hands the server HOME,
   PATH, TMPDIR, locale and zone; the PTY allowlist's API keys and
   `SSH_AUTH_SOCK` stay out.
3. **No host paths.** `redactHostPaths` (LspSession.ts) rewrites hover
   markdown, diagnostic messages and the stderr tail: repo paths become
   relative, others `…/<basename>`. The type of a symbol imported from
   outside the repository is still the type (documented in LOCAL-APP.md).
4. **Digest reconciliation.** `POST /api/repo/files` answers `digest`
   (SHA-256); every LSP answer and `/ws` frame names the digest it is about;
   the seam re-reads a card in place (same id, ordinal, anchor) before an
   answer about newer text lands, and drops it when they still disagree.
5. **Caps stated.** `LspHover.truncated`, `LspDefinitionResponse.total/
   omitted`, `LspDiagnosticsResponse.total`; the card prints `50 of 132
   shown`, the hover box `(cut at 4 KiB)`, the model `… and N more`; a
   definition outside the repository is stated as that, never "none".
6. **Catalog-gated gestures.** `FileCardBody` reads the catalog: the surface
   binds `code.hover` / `code.definition` only where they are registered; on
   the web it states `explainAbsent("code.hover").reason` once under the
   header on files a server would serve (`LSP_LANGUAGE_EXTENSIONS`, rpc).
   `parity-hosts` (a‴) sweeps a `.ts` card and `data-flow-activate`.
7. **Prompt honesty.** The code.* clause left the static sentence; it is
   `CODE_INTEL_LINE`, present only when `code.hover` is in the catalog;
   `WEB_HOST_LINE` names code intelligence as native-only.
8. **Budget floor.** `controller/turns.ts` `composeTurn`: the catalog
   degrades through stage 2, then the World bodies give way (each cut note
   says so), then stage 3 (namespaces and counts) — `InstructionsBudget.test`
   pins a session with three notes at `WORLD_BODY_BUDGET` and roles present
   under the cap. Measured: the empty-context native session already lands
   in stage 2 (11 557 prompt bytes, 14 313 composed).
9. **Worker pool.** `packages/smithers/ui/src/adapters/code-view/workerPool.ts`:
   pierre's pool with one worker, started on the first view, theme followed
   through `setRenderOptions`, probed (worker `error` or 15 s without
   `initialize` → main thread). Measured under bun/JSC: main-thread first
   tokenize of a 16 KiB TypeScript file 2.6 s, warm ~300 ms; pooled, the
   longest main-thread block is ~70 ms and a second file's synchronous
   render ~8 ms (`code-view.test.tsx` pins both under 300 ms). Vite emits the
   worker as `assets/worker-*.js` (833 kB iife, self-contained) referenced
   from the CodeSurface chunk, the same way the OPFS worker ships.
10. **One pierre instance per view.** The anchor no longer keys the frame;
    the scroll to a new anchor runs from a keyed sentinel's ref callback
    after pierre applied `selectedLines`; the test asserts the same
    `diffs-container` survives an anchor move with its tokens still coloured.
11. **Idle clock.** A request in flight (the first one carries the project
    load) restarts the host's idle timer instead of retiring the server
    under it (the load-dependent `LspHost.test` failure).

### Open questions for will (default in parentheses)

1. v1 languages: TypeScript only, or also rust-analyzer, gopls and pyright
   when found on PATH? (TypeScript only; the table gains the rows in L6 once
   the host is proven; never installed.)
2. Hover on pointer rest, or click-only? (Pointer rest 300 ms plus ⌘/Ctrl-click
   for definition; no keyboard chord in v1.)
3. `code.diagnostics` for the open file only, or a project-wide `code.
   diagnostics` with no path? (Open file only; project-wide waits.)
4. If the three flows push the prompt to stage 1, ship anyway or hold
   `code.diagnostics` for v1.1? (Ship; stage 1 is the designed degradation.)
5. Diff card: move to `PierreDiffView` in this program (L5) or leave it for
   the change lane? (Move it; same engine, one lane, ~40 lines.)

## Filed (plue, 2026-09-03)

#505 "LSP relay per workspace session", contract as §3 with plue's deltas:
`POST /workspace/sessions { workspace_id, kind: "lsp", language }` → one
session per workspace+language; `wss://…/workspace/sessions/{id}/lsp?
language=typescript`, subprotocol `lsp`, Bearer or sse-ticket, one JSON-RPC 2.0
message per text frame with a 1 MiB cap (or `{ seq, last, data }` fragments if
the 64 KiB cap stays), server pings; pre-upgrade 401/403/409/429 and `409
language_server_missing` carrying the install line verbatim; close codes
1000/1001/1006/1008/1011 with a typed reason on server exit; the terminal
open-rate limiter; guest registry with `typescript-language-server --stdio`
first (rust-analyzer, gopls, pyright in the NixOS base image); workspace folder
= the checkout; 10-minute idle shutdown; the workspace DTO gains
`lsp.languages`. Lane L6's `CloudLspClient.ts` reads exactly this.

## Live (plue, 2026-09-03, API tag 6d320ea92cd0)

#505 is in production (RFD-005, specs/workspaces.md §4.2). The wire, verified
with a recorded hover transcript:

- `POST /api/repos/{o}/{r}/workspace/sessions { workspace_id, kind: "lsp",
  language: "typescript" }` → 201 session row `{ id, workspace_id, status,
  kind: "lsp", language, idle_timeout_secs: 600, … }`; same (workspace,
  language) again → same id. 400 for an unknown kind or language
  ("language is required for kind lsp; one of: typescript").
- `GET wss://api.jjhub.tech/api/repos/{o}/{r}/workspace/sessions/{id}/lsp?
  language=typescript`, subprotocol `lsp`, Bearer PAT (no Origin needed for
  bearer). One JSON-RPC 2.0 message per text frame, 1 MiB per frame; larger
  as `{ seq, last, data }` fragments (seq from 1, reassembled to 16 MiB);
  binary frames refused (1003); server pings every 30 s.
- Pre-upgrade: 401; 403 origin; 409 `workspace_session_kind_mismatch`; 409
  session failed/stopped; 425 `workspace_session_pending` (Retry-After: 2);
  429 (shared per-user cap + open-rate limiter); 503 `guest_not_ready`; 409
  `language_server_missing` with message = the install line verbatim
  (`npm i -g typescript-language-server typescript`) and details
  `{ language, bin, install, searched }`; 500 when the server died before
  ready.
- Close: 1000 `language_server_exited: 0` / `language_server_idle` /
  `replaced by a newer client`; 1001 `lsp client too slow` (reconnect); 1008
  `access revoked: …` (final); 1011 `language_server_exited: <code>` (retry
  once) or `language_server_protocol_error`; 1002/1003/1009 client faults
  (final). Never a silent 1000.
- Lifecycle: the server process lives exactly as long as the socket; a
  reconnect is a fresh server (re-send `initialize` + `didOpen`); the session
  row is durable and deduplicated; idle 10 min; ends on suspend, delete,
  revocation. Guest cwd `/home/developer/workspace`, `rootUri`
  `file:///home/developer/workspace`.
- Client lifecycle: pending requests receive bounded automatic reconnects
  and keep their original deadlines. Terminal and idle closes reach listeners;
  the next act reconnects an idle closed session. Failed initialization closes
  its socket. Disposal rejects pending requests, settles diagnostic waits,
  aborts session acquisition and retry waits, and closes owned sockets.
- DTO: `WorkspaceSessionResponse.kind` (`terminal` | `lsp`) and `language`;
  `WorkspaceResponse.lsp: { languages: ["typescript"] }`.
