# Spec UI coverage

T-APP-10 wave 2 contract coverage: [Branch live](../branch-live.spec.ts) exercises the production `/branch T2` door with captured sleeping facts, durable burst and changed-file wire payloads, Files tab selection and file-row/presence-link navigation to captured bytes without waking, missing optional streams, and the authorized Fork binding. [Branch tree](../branch-navigation.spec.ts) exercises live presence from `branch:<machine-id>` and persisted navigation. These are test-only HTTP/WebSocket contracts; C-J3-01/C-J3-03/C-J3-09/C-J7-03/C-J10-04 and the legacy renderer cutover remain pending their composed providers and reference-host receipts.

T-APP-10 member attribution: composed PostgreSQL/live tests resolve durable numeric member IDs through the existing roster; the Branch browser fixture verifies the resolved SSH actor in Activity and Files. Five composed tests and two browser tests pass; guest burst ingestion still needs reference-host evidence.

T-APP-10 commit-family cutover: BranchView remains reachable while CommitCards.tsx, CommitsSeam.ts and their tests/commands are deleted. Recorded commit/commit-list cards and forms decode as titled retired history. The complete C-UI-13 replacement receipt still awaits WorkspaceCard cutover.

These hermetic UI scenarios do not replace reference-host qualification or check receipts.
Fixmes await the seeded DesignWorld and complete journey controls; standalone card components are insufficient.

C-UI-12 Members (T-UI-09): [install roster and keyboard Add/Role/Remove](C-UI-12-members.spec.ts) passed, including keyboard Cancel/OK in the inline Remove confirmation, pending read with usable Chat, and embedded/maximized light/dark at 1440/390; [Members stories](../view-stories.spec.ts) passed all 48 light/dark combinations at 1280/1440/390 with zero axe violations, plus keyboard Add/Role. Local Chromium evidence; CI receipt at the landed SHA remains outstanding.

| id | spec file | status | ticket |
| --- | --- | --- | --- |
| C-UI-12 · Setup/Settings | [C-UI-12.spec.ts](C-UI-12.spec.ts) | Empty/supplied model slot, zero dispatch, keyboard; 390px capacity line passed | T-UI-02 |
| C-FM-01 | [C-FM-01.spec.ts](C-FM-01.spec.ts) | fixme-before-implementation | T-FM-01 |
| C-FM-02 | [C-FM-02.spec.ts](C-FM-02.spec.ts) | fixme-before-implementation | T-FM-02 |
| C-MCH-12 | [C-MCH-12.spec.ts](C-MCH-12.spec.ts) | fixme-before-implementation | T-MCH-16 |
| C-UI-14 | [C-UI-14.spec.ts](C-UI-14.spec.ts) | fixme-before-implementation | T-UI-19 |
| C-J1-01 | [C-J1-01.spec.ts](C-J1-01.spec.ts) | fixme-before-implementation | T-INS-08 |
| C-J1-02 | [C-J1-02.spec.ts](C-J1-02.spec.ts) | passing: mounted install seam, live readiness, reload, squash/image fixes; reference Mac/LAN/OAuth evidence pending | T-APP-03 |
| C-J1-03 | [C-J1-03.spec.ts](C-J1-03.spec.ts) | partial: mirrored read-only File card during held machine build and reload; question journey pending | T-APP-15 |
| C-J1-04 | [C-J1-04.spec.ts](C-J1-04.spec.ts) | browser-pass 2026-10-06: private Draft admission/completion, served TODO reviewed-head Merge and reload; fresh macOS install/real execution/GitHub/timing pending | T-APP-02 |
| C-J1-05 | [C-J1-05.spec.ts](C-J1-05.spec.ts) | browser-pass 2026-10-07: install seam, keyboard, invalid login sends nothing, typed unknown-user refusal, live refresh, confirmation, reconnect; reference-host GitHub/LAN evidence pending | T-APP-06 |
| C-J1-06 | [C-J1-06.spec.ts](C-J1-06.spec.ts) | mounted install seam: Node/Go readiness, failure, live completion, reload and check evidence; [reference observer](../../real/fresh-repository.spec.ts) authored, Mac execution pending | T-MCH-10, T-FLW-02 |
| C-J2-01 | [C-J2-01.spec.ts](C-J2-01.spec.ts) | implemented — Chromium passed 2026-10-07 (no-tools model draft, unopened issue, edit/place/commit; composed router proof separate) | T-STK-09 |
| C-J2-02 | [C-J2-02.spec.ts](C-J2-02.spec.ts) | implemented — Chromium passed 2026-10-05 (mounted install seam; composed router proof separate) | T-STK-09 |
| C-J2-03 | [C-J2-03.spec.ts](C-J2-03.spec.ts) | fixme-before-implementation | T-STK-01 |
| C-J2-04 | [C-J2-04.spec.ts](C-J2-04.spec.ts) | fixme-before-implementation | T-STK-01 |
| C-J2-05 | [C-J2-05.spec.ts](C-J2-05.spec.ts), [receipt navigation](../learning-receipt.spec.ts) | Partial: mounted merged-TODO receipt navigation passes in Chromium; merge/background-learning journey remains fixme | T-STK-04 |
| C-J4-01 | [C-J4-01.spec.ts](C-J4-01.spec.ts) | fixme-before-implementation | T-APP-01 |
| C-J4-02 | [C-J4-02.spec.ts](C-J4-02.spec.ts) | passing app HTTP-seam proof: Answer, head-bound Merge (acceptance stays In review until terminal projection), Move, Retry, displayed-wait/head Bring in, durable pause/resume projections and pending execution; runtime pause/checkpoint backend, real flow/GitHub and reference-host timing remain pending | T-STK-02, T-STK-05, T-APP-02 |
| C-J4-03 | [C-J4-03.spec.ts](C-J4-03.spec.ts) | fixme-before-implementation | T-STK-04, T-REL-02 |
| C-J10-01 | [C-J10-01.spec.ts](C-J10-01.spec.ts) | fixme-before-implementation | T-GH-03, T-REL-02 |
| C-J10-02 | [C-J10-02.spec.ts](C-J10-02.spec.ts) | fixme-before-implementation | T-GH-04 |
| C-J10-03 | [C-J10-03.spec.ts](C-J10-03.spec.ts), [install Discard cases](C-UI-12-todo-install.spec.ts) | Passing Chromium install HTTP seam: stale Discard refresh, displayed wait/SHA binding, person confirmation, independent question, pending toast, usable Chat and reload; machine Bring in ancestry and full reference-host journey pending | T-GH-06 |
| C-J10-04 | [C-J10-04.spec.ts](C-J10-04.spec.ts) | fixme-before-implementation | T-STK-08 |
| C-J10-05 | [C-J10-05.spec.ts](C-J10-05.spec.ts) | fixme-before-implementation | T-GH-03 |
| C-J10-06 | [C-J10-06.spec.ts](C-J10-06.spec.ts) | passed: install HTTP seam, 120 s boundary, pending/deduplicated Retry, usable Chat, recovery and installation refusal; backend/reference-host qualification separate | T-GH-07 |
| C-J10-07 | [C-J10-07.spec.ts](C-J10-07.spec.ts) | fixme-before-implementation | T-GH-07, T-ACC-03 |
| C-J10-08 | [C-J10-08.spec.ts](C-J10-08.spec.ts) | fixme-before-implementation | T-GH-03, T-STK-05, T-MCH-14 |
| C-J10-09 | [C-J10-09.spec.ts](C-J10-09.spec.ts) | fixme-before-implementation | T-FLW-13, T-MCH-06, T-REL-02 |
| C-J3-01 | [C-J3-01.spec.ts](C-J3-01.spec.ts) | fixme-before-implementation | T-COL-06, T-APP-10, T-REL-02 |
| C-J3-02 | [C-J3-02.spec.ts](C-J3-02.spec.ts) | fixme-before-implementation | T-TRM-01, T-APP-12 |
| C-J3-03 | [C-J3-03.spec.ts](C-J3-03.spec.ts) | fixme-before-implementation | T-COL-04, T-COL-12, T-APP-10 |
| C-J3-04 | [C-J3-04.spec.ts](C-J3-04.spec.ts) | Browser contract: 1,000 interleaved edits in two member contexts, real boot and /file dispatcher, shared channel, carets, author colours and durable reload/Reapply; second-Mac machine qualification pending | T-COL-08, T-APP-14, T-APP-14a, T-COL-08a, T-COL-08b |
| C-J3-05 | [C-J3-05.spec.ts](C-J3-05.spec.ts) | browser-pass real seam HTTP fixture; composed two-worker Answer/Steer ordering and delegated Amend confirmation pass separately; guest model-turn timing pending reference host | T-STK-06 |
| C-J3-06 | [C-J3-06.spec.ts](C-J3-06.spec.ts) | fixme-before-implementation | T-TRM-03, T-ACC-02, T-TRM-07, T-COL-04, T-COL-06, T-REL-02 |
| C-J3-08 | [C-J3-08.spec.ts](C-J3-08.spec.ts) | fixme-before-implementation | T-APP-11, T-REL-02 |
| C-J3-09 | [C-J3-09.spec.ts](C-J3-09.spec.ts) | fixme-before-implementation | T-COL-05 |
| C-J3-10 | [C-J3-10.spec.ts](C-J3-10.spec.ts) | fixme-before-implementation | T-TRM-05, T-REL-02 |
| C-J5-01 | [C-J5-01.spec.ts](C-J5-01.spec.ts), [proposal → Draft](../flow-edit-proposal.spec.ts), [install versions](../flow-card-install.spec.ts) | proposal-to-Draft, install selection/reload, system/catalog refusal, Active-only Edit, and live Proposed → syncing → Active/failed-load projection pass; composed host show/edit and literal private Draft covered; joint real merge/load/pinning pending | T-FLW-03, T-FLW-04, T-FLW-05, T-FLW-11, T-APP-05, T-REL-02 |
| C-J5-02 | [C-J5-02.spec.ts](C-J5-02.spec.ts) | fixme-before-implementation | T-FLW-03, T-FLW-04, T-FLW-11 |
| C-J5-03 | [C-J5-03.spec.ts](C-J5-03.spec.ts), [receipt navigation](../learning-receipt.spec.ts) | Partial: receipt → Proposal → Make TODO → reload passes in Chromium; automatic learning, flow activation and sixth-TODO journey remain fixme | T-FLW-06, T-REL-02 |
| C-J6-01 | [C-J6-01.spec.ts](C-J6-01.spec.ts) | browser-pass (served delegated answer/steer/presence, member color, independent coding participant, reload and person replacement); full installed terminal/skill/confirmation journey fixme, reference-host pending | T-TRM-02, T-APP-09, T-REL-02 |
| C-J6-02 | [C-J6-02.spec.ts](C-J6-02.spec.ts) | partial: install confirmation seam, member press, reload and issuer attribution; composed CLI login/Merge and delegated Before keyboard confirmation covered separately; reference-host journey pending | T-ACC-04, T-APP-04, T-REL-02 |
| C-J7-01 | [C-J7-01.spec.ts](C-J7-01.spec.ts) | app HTTP-seam proof: private Before draft, stack order, Amend, retained identity and reload; composed PostgreSQL/browser proof: delegated Before and author-only keyboard confirmation; guest steer/ancestry and reference-host receipts pending | T-STK-02, T-STK-06, T-REL-02 |
| C-J7-02 | [C-J7-02.spec.ts](C-J7-02.spec.ts) | fixme-before-implementation | T-MCH-08, T-STK-05 |
| C-J7-03 | [C-J7-03.spec.ts](C-J7-03.spec.ts) | fixme-before-implementation | T-STK-08, T-REL-02 |
| C-J8-01 | [C-J8-01.spec.ts](C-J8-01.spec.ts) | fixme-before-implementation | T-FLW-06, T-REL-02 |
| C-J8-02 | [C-J8-02.spec.ts](C-J8-02.spec.ts) | browser-pass: composed install router, native Yrs/PostgreSQL, two editors, offline reload, saved state and old history; Mac install p95 qualification pending | T-COL-09 |
| C-J8-03 | [C-J8-03.spec.ts](C-J8-03.spec.ts) | passing: owner folder PUT, sync status, refusal retained, unavailable control absent; composed PostgreSQL worker and forced mid-pass race proof separate; reference Mac scenario passed at default 60 s interval on 677526019b; receipt .artifacts/checks/C-J8-03/20261007T043654Z/ (seeded native install, loopback GitHub provider) | T-FLW-12 |
| C-J8-04 | [C-J8-04.spec.ts](C-J8-04.spec.ts) | fixme-before-implementation | T-FLW-10 |
| C-J8-05 | [C-J8-05.spec.ts](C-J8-05.spec.ts) | fixme-before-implementation | T-FLW-10, T-COL-09 |
| C-J8-06 | [C-J8-06.spec.ts](C-J8-06.spec.ts) | partial: install Home live projection; [reference observer](../../real/wiki-generated-refresh.spec.ts) authored, Mac execution and canonical Retry/Dismiss pending; qualification remains fixme | T-FLW-02, T-APP-01, T-REL-02 |
| C-J11-01 | [C-J11-01.spec.ts](C-J11-01.spec.ts) | fixme-before-implementation | T-FLW-07, T-APP-07, T-REL-02 |
| C-J11-02 | [C-J11-02.spec.ts](C-J11-02.spec.ts) | fixme-before-implementation | T-APP-05, T-FLW-04, T-FLW-05, T-FLW-07 |
| C-J11-03 | [C-J11-03.spec.ts](C-J11-03.spec.ts) | passing Chromium: owner assignment, reload, durable model probe reconnect while Chat remains usable, model records, read-only instruction File card and actual recent-run models; composed Active-main prompt test passes; merged TODO/ongoing TODO journey pending | T-FLW-08 |
| C-J11-04 | [C-J11-04.spec.ts](C-J11-04.spec.ts) | fixme-before-implementation | T-FLW-07, T-REL-02 |
| C-APP-01 | [C-APP-01.spec.ts](C-APP-01.spec.ts) | browser-pass (Take over; PostgreSQL role/idempotency receipt; live toast qualification pending) | T-APP-02 |
| C-APP-02 | [C-APP-02.spec.ts](C-APP-02.spec.ts) | browser-pass (Edit, deduplication, reload, person Drop confirm, working step, daily admission limit, budget pause owner, outside-push Discard binding/deduplication/role gate; planner/multiplayer pending) | T-APP-02 |
| C-APP-03 | [C-APP-03.spec.ts](C-APP-03.spec.ts) | browser-pass (failure/slash Draft, literal recipe diff and read-only seed; reload with seed fallback and on the install; two-browser private Draft isolation; Settings name refusal and Draft with the design seed disabled; guest qualification pending) | T-APP-02, T-APP-03 |
| C-APP-04 | [C-APP-04.spec.ts](C-APP-04.spec.ts) | browser-pass: composer host admission, reload and read-only Earlier; authenticated packaged-host ordering, privacy, revocation and retired-route receipts | T-APP-16 |
| C-APP-03 | [C-APP-03.spec.ts](C-APP-03.spec.ts) | browser-pass (failure/slash Draft, main recipe, reload with seed fallback and on the install; Settings name refusal and Draft passed with the design seed disabled in settings-install.spec.ts; guest qualification pending) | T-APP-02, T-APP-03 |
| C-APP-04 | [C-APP-04.spec.ts](C-APP-04.spec.ts) | browser-pass: composer admission, reload and Earlier; packaged-host ordering, privacy, revocation and four retired writes; private-question retirement pending | T-APP-16 |
| C-APP-05 | [C-APP-05.spec.ts](C-APP-05.spec.ts) | browser-pass: real composed install, two members, author tab closes, host completes and both replay; author-only UI instructions use the typed flow | T-APP-16 |
| C-ACC-01 | [C-ACC-01.spec.ts](C-ACC-01.spec.ts) | partial: install-seam Member browser journey passed; exhaustive server/system matrix pending | T-ACC-02, T-ACC-03, T-ACC-04, T-APP-04, T-INS-08, T-TRM-02, T-CUT-03, T-STK-06 |
| C-ACC-02 | [C-ACC-02.spec.ts](C-ACC-02.spec.ts) | partial: composed PostgreSQL merge admission/settlement, stale revision and pending merge reload browser journeys passed; reference-host recovery pending | T-ACC-04, T-APP-04, T-STK-04 |
| C-ACC-03 | [C-ACC-03.spec.ts](C-ACC-03.spec.ts) | passing: removal, owner protection, retained TODO history | T-ACC-02 |
| C-ACC-04 | [C-ACC-04.spec.ts](C-ACC-04.spec.ts) | roster and sign-in refusal HTTP projections pass; composed OAuth qualification separate | T-ACC-01, T-ACC-02 |
| C-STK-01 | [C-STK-01.spec.ts](C-STK-01.spec.ts) | fixme-before-implementation | T-STK-01 |
| C-STK-02 | [C-STK-02.spec.ts](C-STK-02.spec.ts) | Partial: real Settings card → install dispatcher and HTTP/live scheduler positions pass; full machine/safe-idle journey remains fixme pending T-MCH-06 | T-STK-03 |
| C-STK-03 | [C-STK-03.spec.ts](C-STK-03.spec.ts), [current-flow Retry](todo-current-flow.spec.ts) | current-flow Retry passes; Stop/Resume pending | T-STK-05 |
| C-STK-04 | [C-STK-04.spec.ts](C-STK-04.spec.ts) | fixme-before-implementation | T-GH-03 |
| C-STK-05 | [C-STK-05.spec.ts](C-STK-05.spec.ts) | fixme-before-implementation | T-MCH-14 |
| C-STK-06 | [C-STK-06.spec.ts](C-STK-06.spec.ts) | passing install REST/live seam: rebased checks hold, retained review, reload, displayed-head merge; guest/tree/reference-host receipts separate | T-STK-12, T-FLW-11, T-STK-01, T-GH-09, T-MCH-14 |
| C-STK-07 | [C-STK-07.spec.ts](C-STK-07.spec.ts) | passing REST seam UI; complete folded backend and reference-host receipts remain separate | T-STK-04 |
| C-STK-08 | [C-STK-08.spec.ts](C-STK-08.spec.ts) | fixme-before-implementation | T-STK-01 |
| C-STK-13 | [C-STK-13.spec.ts](C-STK-13.spec.ts) | passing REST seam UI; complete folded backend and reference-host receipts remain separate | T-STK-04 |
| C-GH-01 | [C-GH-01.spec.ts](C-GH-01.spec.ts) | passing mounted install seam; explicit writer recovery on reload; real GitHub/LAN/reference-host receipts pending | T-GH-01 |
| C-GH-07 | [C-GH-07.spec.ts](C-GH-07.spec.ts) | fixme-before-implementation | T-GH-02 |
| C-GH-08 | [C-GH-08.spec.ts](C-GH-08.spec.ts) | HTTP seam: ten PRs, automatic refresh, responsive Chat; backend/native receipts separate | T-GH-02 |
| C-GH-09 | [C-GH-09.spec.ts](C-GH-09.spec.ts) | passing install REST/live seam: confirmed Drop, 202 stays working, late PR link, terminal reload; production-dispatcher crash receipt separate | T-GH-09, T-GH-01 |
| C-GH-13 | [C-GH-13.spec.ts](C-GH-13.spec.ts) | fixme-before-implementation | T-GH-04 |
| C-UI-01 | [C-UI-01.spec.ts](C-UI-01.spec.ts) | fixme-before-implementation | T-REL-02 |
| C-UI-02 | [C-UI-02.spec.ts](C-UI-02.spec.ts) | App copy journey and all 19 View modules / 272 fixtures pass: 2,176 inline/maximized, light/dark, 1440/390px renders; zero copy violations | T-CAT-01 |
| C-UI-03 | [notifications.spec.ts](../notifications.spec.ts) | passing: Chromium + WebKit, loopback/plain HTTP, live owned TODOs, gesture, hidden/visible, dedupe, click/focus, no console errors; Notification API recorded | T-APP-18 |

T-APP-18 wave 3 (2026-10-06): reference Mac WebKit rerun passed both origins
(2 passed, 0 failed). Mounted app/dispatcher coverage uses served HTTP/live
fixtures and records the Notification API; it does not expose an OS permission
dialog. C-UI-13 at its unit layer (`src/mainview/cards/ViewReachability.test.ts`)
passed alongside notification/controller/toast tests (68 passed, 0 failed).
| C-UI-04 | [C-UI-04.spec.ts](C-UI-04.spec.ts) | partial: served TODO rail keyboard Retry, Answer with bound TODO and Resolve with bound branch, approval/conflict notices and owner merge notice/Hide covered; shared-history actor lines and keyboard jump covered; saved global preference hiding covered; per-conversation preference writes and summaries remain fixme | T-APP-07 |
| C-UI-05 | [C-UI-05.spec.ts](C-UI-05.spec.ts) | fixme-before-implementation | T-COL-02 |

| C-UI-06 | [C-UI-06.spec.ts](C-UI-06.spec.ts) | passed: two install identities, live shared entries, author-only theme and independent card view reload; real-host acceptance separate | T-APP-16 |
| C-UI-07 | [native browser acceptance](C-UI-07-native.spec.ts), [HTTP contract regression](C-UI-07.spec.ts), [durable Context/Inspect projection](../context-inspect.spec.ts) | Linux browser → authenticated composed prompt → packaged model host → PostgreSQL/native store; four pinned sources, real run Inspect, tab closure, admission deduplication and reload; native confinement/provider refusal/fallback pass. Mac journey and reference timing receipts remain required. Run `SMITHERS_CONTEXT_BROWSER=1 go test ./internal/compose -run TestLocalSharedPreflightBrowser` with PostgreSQL and the built FFI library. | T-APP-17 |
| C-UI-08 | [C-UI-08.spec.ts](C-UI-08.spec.ts) | fixme-before-implementation | T-APP-22 |
| C-UI-09 | [C-UI-09.spec.ts](C-UI-09.spec.ts), [docs.spec.ts](../docs.spec.ts) | Wave 2 Chromium (2026-10-06): combined run 7 pass, 1 fail. Settings click/Enter/Space, origin exclusions, owner refusal and docs reload pass. Every-door case waits for T-APP-16 host-turn fixture integration: the retired HTTP agent fixture now yields a seeded answer instead of docs.read (line 28). Targeted docs/Settings suites: 45 pass, 0 fail. macOS WebKit and reference-install qualification pending. | T-APP-20, T-APP-24 |
| C-UI-10 | [C-UI-10.spec.ts](C-UI-10.spec.ts) | browser projection and local-own real-backend browser/SQL roles; complete operation inventory and install PUT /api/secrets form; independent production app dependency guards with zero transport/SQL effects and live 201 write controls; missing-isolation composed HTTP/SQL refusal; authenticated eligible app-agent/CLI refusal; viewer-only real API response excluded from recorded fast/coding selector and app model requests through the production chat host; app-agent scope/role precedence covered with a test-only host authorizer; combined real-install CLI scope/role precedence and positive branch-machine evidence pending | T-APP-21 |
| C-UI-11 | [C-UI-11.spec.ts](C-UI-11.spec.ts) | fixme-before-implementation | T-APP-15 |

C-J1-01 also has a passing test for the mounted Setup card: detected capacity,
ordered steps, Address admission, product words and reload. The full install check remains fixme.

C-UI-01 also exercises the mounted Home order menu and composer by keyboard.

| C-UI-12 | [C-UI-12.spec.ts](C-UI-12.spec.ts), [Draft and shell cases](../view-stories.spec.ts) | T-UI-01 primitives, T-UI-07 shell and Context item/Inspect styling passed (light/dark, 1280/390, keyboard), T-UI-10 Flow, T-UI-15 Branch states/recovery, T-UI-16 read-only Compare and recovery keyboard doors (light/dark, 1440/390), T-UI-17 terminal states (owner bytes, watcher/frozen input suppression, both themes at 1440/390) and T-UI-19 co-editing active; Draft passed (light/dark, 1440/390, keyboard); T-UI-04 TODO conflict/mobile/keyboard, Fork/Add to stack and real-seam question active; T-UI-08 shell passes light/dark at 1,179/1,180 px with pointer/Tab + Enter/Space; live resize preserves disclosure and emits one visibility receipt per breakpoint transition; remaining View matrix fixme | T-UI-01..T-UI-17, T-UI-19 |
| C-UI-13 | [C-UI-13.spec.ts](C-UI-13.spec.ts) | Card doors passed: Stack, TODO, Branch, Flow, Wiki, Settings, Members, Commands, Agent (seed and served HTTP providers); Setup and Run selection passed; Confirm passed (composed install, private live, keyboard/reload) | T-APP-01, T-APP-02, T-APP-03, T-APP-04, T-APP-05, T-APP-06, T-APP-07, T-APP-16, T-APP-15, T-FLW-07, T-FLW-08, T-UI-14 |
| C-CAT-01 | [C-CAT-01.spec.ts](C-CAT-01.spec.ts) | passing | T-CAT-01 |
| C-CAT-02 | [C-CAT-02.spec.ts](C-CAT-02.spec.ts), [composed Merge browser](../../real/catalog-merge.browser.ts), [composed TODO browser](../../real/confirm-merge.browser.ts) | 3 card doors pass; source CLI Merge pending/replay and private delivery/reload/keyboard cancellation pass through StartWithOptions, PostgreSQL and the GitHub fake, with no browser API/live interception; source CLI TODO create/read/Drop/steer plus Merge pending/replay and person-only admission pass against composed PostgreSQL and GitHub fake; real-host merge settlement remains separate | T-CAT-01 |
| C-CAT-03 | [C-CAT-03.spec.ts](C-CAT-03.spec.ts), [composed CLI/browser](../../real/confirm-merge.browser.ts) | installed generated skill and visible Commands pass; literal installed path/agent/excluded-group inventory passes in SkillsInstall.test.ts; real delegated TODO create/read/Drop and private approval pass | T-CAT-01 |
| C-UI-12 · Flow | [Flow browser case](C-UI-12.spec.ts), `FlowCard.install.test.tsx`, `compose/flow_reserved_catalog_integration_test.go` | Passed locally: keyboard version selection and Source/Plan/Run/Edit callbacks, failure disclosure, absent/disabled actions, Paper focus and overflow in light/dark at 1440/390; install `/flow` uses the real HTTP seam and persists member selection; authenticated composed `/api/flows` serves built-in and failed repository versions. CI receipt at the landed SHA remains outstanding. | T-UI-10 |
| C-UI-12 · Home | [Home cases](../home.spec.ts) | passing: sync health, keyboard menu, absent/disabled actions and hostile text in light/dark at 1440/390 | T-UI-06 |
| C-AGT-01 | [C-AGT-01.spec.ts](C-AGT-01.spec.ts) | fixme-before-implementation | T-AGT-01 |

C-UI-13 also has a passing UI projection for the mounted Setup
View; full reachability and remaining fixtures await their wiring tickets.

| C-AGT-02 | [C-AGT-02.spec.ts](C-AGT-02.spec.ts) | mounted-install contract fake: light/dark × 1280/390; real sessions and authenticated refusal pending T-AGT-02 | T-AGT-02, T-AGT-03 |
| C-COL-01 | [C-COL-01.spec.ts](C-COL-01.spec.ts) | fixme-before-implementation | T-COL-10, T-COL-03r, T-COL-08a, T-COL-08b, T-APP-14a |
| C-COL-02 | [C-COL-02.spec.ts](C-COL-02.spec.ts) | passing browser replay/gap; PostgreSQL upgrade, bearer revocation and rollback receipts; reference-host evidence pending | T-COL-02 |
| C-COL-03 | [C-COL-03.spec.ts](C-COL-03.spec.ts) | fixme-before-implementation | T-COL-03r, T-COL-03a, T-COL-03, T-STK-08, T-APP-14a |
| C-COL-04 | [C-COL-04.spec.ts](C-COL-04.spec.ts) | fixme-before-implementation | T-COL-03, T-TRM-07, T-MCH-11, T-COL-03a |
| C-COL-05 | [C-COL-05.spec.ts](C-COL-05.spec.ts) | fixme-before-implementation | T-COL-04, T-COL-04a, T-APP-10, T-APP-11 |

C-COL-05 also has a passing projection for the mounted Branch Files panel:
no changed rows before a write, and Alice's presence opens readable file content
by keyboard and retains it across reload. Watcher faults remain fixme.

| C-CUT-01 | [C-CUT-01.spec.ts](C-CUT-01.spec.ts) | passing UI projection (2026-10-06; isolated Chromium fixture); Appendix B Cut registry/catalog regression passes | T-CUT-01, T-CUT-03 |
| C-CUT-02 | [C-CUT-02.spec.ts](C-CUT-02.spec.ts), [authenticated journey](../../real/cut-history.spec.ts) | passing on Linux (2026-10-07): composed install, real authentication/PostgreSQL/native repository, Chromium reload, seven cut titles beside File/Run, member isolation and actual packaged-host model endpoint capture; browser-only archives remain covered | T-CUT-04 |
| C-DUR-01 | [C-DUR-01.spec.ts](C-DUR-01.spec.ts) | install REST/live seam: question and completed evidence survive reload, keyed Answer; host/database crash receipt separate | T-FLW-09, T-REL-04 |
| C-DUR-02 | [C-DUR-02.spec.ts](C-DUR-02.spec.ts) | install REST/live seam: explicit TODO and Run Retry, reload retains interrupted evidence; reference microVM crash receipt separate | T-FLW-09, T-REL-04 |
| C-DUR-03 | [C-DUR-03.spec.ts](C-DUR-03.spec.ts) | passing install REST/live seam: foreign push after reload, confirmed Drop, late PR link remains terminal; worker/microVM crash receipt separate | T-GH-09, T-FLW-09, T-REL-04 |
| C-DUR-04 | [C-DUR-04.spec.ts](C-DUR-04.spec.ts) | fixme-before-implementation | T-COL-03, T-COL-08, T-COL-09, T-REL-04, T-COL-03a, T-COL-04a, T-COL-04, T-COL-08a, T-COL-08b |

C-DUR-02 also has a passing projection for the mounted recorded interrupted run:
its Interrupted state and last edited phase survive reload without duplicate cards.
Machine-kill recovery and retry version pinning remain fixme.

| C-INS-01 | [C-INS-01.spec.ts](C-INS-01.spec.ts) | partial: clipboard absent/refused passes; origin journey awaits app-agent output and reference hosts | T-INS-04 |
| C-INS-03 | [C-INS-03.spec.ts](C-INS-03.spec.ts) | fixme-before-implementation | T-INS-04 |
| C-INS-05 | [C-INS-05.spec.ts](C-INS-05.spec.ts) | fixme-before-implementation | T-INS-01, T-INS-02 |
| C-INS-06 | [C-INS-06.spec.ts](C-INS-06.spec.ts) | fixme-before-implementation | T-INS-08 |
| C-J9-01 | [C-J9-01.spec.ts](C-J9-01.spec.ts) | browser-pass (Make TODO, literal answer save; live citations/SQL journey pending) | T-APP-02 |
| C-MCH-01 | [C-MCH-01.spec.ts](C-MCH-01.spec.ts) | fixme-before-implementation | T-MCH-04 |
| C-MCH-02 | [C-MCH-02.spec.ts](C-MCH-02.spec.ts) | fixme-before-implementation | T-MCH-06 |
| C-MCH-03 | [C-MCH-03.spec.ts](C-MCH-03.spec.ts) | fixme-before-implementation | T-MCH-07 |
| C-MCH-04 | [C-MCH-04.spec.ts](C-MCH-04.spec.ts) | Browser HTTP projection fixture; composed authenticated router + live Home covered by Go integration; combined built-bundle journey pending | T-MCH-01 |
| C-MCH-05 | [C-MCH-05.spec.ts](C-MCH-05.spec.ts) | fixme-before-implementation | T-MCH-09 |
| C-MCH-06 | [C-MCH-06.spec.ts](C-MCH-06.spec.ts) | fixme-before-implementation | T-MCH-11 |
| C-MCH-07 | [C-MCH-07.spec.ts](C-MCH-07.spec.ts) | card phase passed: Add/Replace, scope confirmation/cancellation, Delete confirmation/cancellation, live member rows, held writes, failure, duplicate, reload, roster loss/recovery and refused live-topic actions with usable Chat; machine phase fixme (reference host) | T-APP-13 / T-MCH-12 |

C-MCH-03 also has a passing mounted projection: reading Files and Activity
keeps the sleeping branch Asleep across reload. Runtime capture and wake counts remain fixme.

| C-MCH-08 | [C-MCH-08.spec.ts](C-MCH-08.spec.ts) | fixme-before-implementation | T-MCH-08 |
| C-MCH-09 | [C-MCH-09.spec.ts](C-MCH-09.spec.ts) | fixme-before-implementation | T-MCH-11 |
| C-MCH-10 | [C-MCH-10.spec.ts](C-MCH-10.spec.ts) | fixme-before-implementation | T-MCH-11 |
| C-MCH-11 | [C-MCH-11.spec.ts](C-MCH-11.spec.ts) | fixme-before-implementation | T-MCH-06 |
| C-MNT-01 | [C-MNT-01.spec.ts](C-MNT-01.spec.ts) | fixme-before-implementation | T-MNT-01 |
| C-MNT-02 | [C-MNT-02.spec.ts](C-MNT-02.spec.ts) | fixme-before-implementation | T-MNT-02 |

C-MCH-08 also has a passing mounted fork projection: Fork opens a
scratch branch with Add to stack and keeps the source Awake. Captured revision
and boot continuity still require reference-host qualification. Scratch metadata
is lost on reload in the seeded world; persistence remains tracked by T-MCH-08.

| C-MNT-03 | [C-MNT-03.spec.ts](C-MNT-03.spec.ts) | fixme-before-implementation | T-MNT-03 |
| C-MNT-04 | [C-MNT-04.spec.ts](C-MNT-04.spec.ts) | fixme-before-implementation | T-MNT-04 |
| C-MNT-05 | [C-MNT-05.spec.ts](C-MNT-05.spec.ts) | fixme-before-implementation | T-MNT-05 |
| C-MNT-06 | [C-MNT-06.spec.ts](C-MNT-06.spec.ts) | fixme-before-implementation | T-MNT-01, T-MNT-02, T-MNT-03, T-MNT-04, T-MNT-05 |
| C-PERF-01 | [C-PERF-01.spec.ts](C-PERF-01.spec.ts) | fixme-before-implementation | T-REL-01 |
| C-PERF-02 | [C-PERF-02.spec.ts](C-PERF-02.spec.ts) | fixme-before-implementation | T-COL-02, T-REL-01 |


Cycle 20: maintainer admission/reply surfaces and reference-host performance
evidence remain pending. Home production doors currently refuse with
“Home provider unavailable”; no passing mutation projection is claimed.
| C-PERF-03 | [C-PERF-03.spec.ts](C-PERF-03.spec.ts) | Browser contract: 200 ordered markers through mounted editors on a fake host; real LAN/disk qualification pending | T-COL-08, T-COL-08a, T-COL-08b, T-REL-01 |
| C-PERF-04 | [C-PERF-04.spec.ts](C-PERF-04.spec.ts) | fixme-before-implementation | T-COL-04, T-APP-11, T-REL-01 |
| C-PERF-05 | [C-PERF-05.spec.ts](C-PERF-05.spec.ts) | fixme-before-implementation | T-MCH-06, T-REL-01 |
| C-PERF-06 | [C-PERF-06.spec.ts](C-PERF-06.spec.ts) | fixme-before-implementation | T-STK-08, T-REL-01 |
| C-PRC-01 | [C-PRC-01.spec.ts](C-PRC-01.spec.ts) | fixme-before-implementation | T-PRC-01 |
| C-PRC-02 | [C-PRC-02.spec.ts](C-PRC-02.spec.ts) | fixme-before-implementation | T-PRC-02 |

Cycle 21: reference-host co-editing, SSH write, wake and rebase performance
qualification remains pending. C-PRC-01/02 are engineering-only checks folded
into their implementing tickets; terminal projections require isolated live
fixtures and do not qualify gate correctness or publication refusal.

| C-PRC-03 | [C-PRC-03.spec.ts](C-PRC-03.spec.ts) | implemented (engineering CLI; host qualification pending) | T-PRC-03 |
| C-REL-01 | [C-REL-01.spec.ts](C-REL-01.spec.ts) | passing UI projection including LAN startup, positional laptop login and recovery commands with provider refusal; reference-host qualification pending | T-DOC-01 |
| C-REL-02 | [C-REL-02.spec.ts](C-REL-02.spec.ts) | fixme-before-implementation | T-INS-05, T-INS-08 |
| C-REL-03 | [C-REL-03.spec.ts](C-REL-03.spec.ts) | fixme-before-implementation | T-INS-07 |
| C-REL-04 | [C-REL-04.spec.ts](C-REL-04.spec.ts) | fixme-before-implementation | T-REL-03 |
| C-REL-05 | [C-REL-05.spec.ts](C-REL-05.spec.ts) | fixme-before-implementation | T-REL-02 |

Cycle 22: release install, upgrade/restore and 24-hour login qualification need
live reference-host fixtures. Docs are not mounted; receipt and scorecard checks
are engineering-only terminal projections, not passing qualification evidence.

| C-REL-06 | [C-REL-06.spec.ts](C-REL-06.spec.ts) | fixme-before-implementation | T-INS-07 |
| C-SEC-01 | [C-SEC-01.spec.ts](C-SEC-01.spec.ts) | fixme-before-implementation | T-MCH-12, T-FLW-01 |
| C-SEC-02 | [C-SEC-02.spec.ts](C-SEC-02.spec.ts) | fixme-before-implementation | T-FLW-01, T-INS-02, T-INS-08, T-FLW-11, T-STK-12, T-MCH-14 |
| C-SEC-03 | [C-SEC-03.spec.ts](C-SEC-03.spec.ts) | implemented — Chromium passed 2026-10-07 (outsider refusal before Draft/model; composed role matrix separate) | T-STK-09, T-MNT-01, T-MNT-02, T-MNT-03, T-MNT-04, T-MNT-05 |
| C-SEC-04 | [C-SEC-04.spec.ts](C-SEC-04.spec.ts) | setup HTTP projection passes; backend and reference-host qualification separate | T-ACC-01, T-INS-06, T-INS-08 |
| C-SEC-05 | [C-SEC-05.spec.ts](C-SEC-05.spec.ts) | fixme-before-implementation | T-TRM-02 |

Cycle 23: cross-Mac backup and production security fixtures remain pending.
These UI projections do not qualify root scans, process isolation, admission
transactions, setup-token races or terminal credential boundaries.

| id | spec file | status | ticket |
| --- | --- | --- | --- |
| C-SPK-02 | [C-SPK-02.spec.ts](C-SPK-02.spec.ts) | fixme-before-implementation | T-MCH-02 |
| C-SPK-03 | [C-SPK-03.spec.ts](C-SPK-03.spec.ts) | fixme-before-implementation | T-COL-01, T-COL-11 |
| C-SPK-05 | [C-SPK-05.spec.ts](C-SPK-05.spec.ts) | fixme-before-implementation | T-MCH-01 |
| C-SPK-06 | [C-SPK-06.spec.ts](C-SPK-06.spec.ts) | fixme-before-implementation | T-INS-03 |
| C-SPK-07 | [C-SPK-07.spec.ts](C-SPK-07.spec.ts) | fixme-before-implementation | T-COL-01, T-COL-11 |
| C-SPK-08 | [C-SPK-08.spec.ts](C-SPK-08.spec.ts) | fixme-before-implementation | T-TRM-06 |

Cycle 24: spike terminal projections await disposable reference-host fixtures.
C-SPK-02 retains the accepted NO decision; shared homes are not a pending feature.
Transport, memory, signing, co-editing and remote-session qualification require raw live evidence.

| id | spec file | status | ticket |
| --- | --- | --- | --- |
| A-CMD-K | [A-CMD-K.spec.ts](A-CMD-K.spec.ts) | passing | T-APP-02 |
| A-HELP | [A-HELP.spec.ts](A-HELP.spec.ts) | passing | T-CAT-01 |
| A-DOCS | [A-DOCS.spec.ts](A-DOCS.spec.ts) | passing Chromium: /docs and keyboard toc navigation | T-APP-20 |
| A-STOP | [A-STOP.spec.ts](A-STOP.spec.ts) | passing | T-APP-02 |
| A-SEARCH | [A-SEARCH.spec.ts](A-SEARCH.spec.ts) | passing | T-APP-02 |
| A-STACK | [A-STACK.spec.ts](A-STACK.spec.ts) | fixme-before-implementation | T-APP-01 |

Cycle 25: Appendix A starts with ⌘K, /help, /docs, /stop, /search and /stack.
Docs and the production stack provider remain pending. Passing command tests
cover plain chat, admitted help rows, an empty search and the idle stop boundary;
they do not qualify live answer cancellation or repository-grounded answers.

| id | spec file | status | ticket |
| --- | --- | --- | --- |
| A-TODO-NEW | [A-TODO-NEW.spec.ts](A-TODO-NEW.spec.ts) | fixme-before-implementation | T-STK-01 |
| A-TODO-FROM-ISSUE | [A-TODO-FROM-ISSUE.spec.ts](A-TODO-FROM-ISSUE.spec.ts) | implemented — mounted install draft/edit/commit | T-STK-09 |
| A-TODO | [A-TODO.spec.ts](A-TODO.spec.ts) | fixme-before-implementation | T-APP-02 |
| A-TODO-ANSWER | [A-TODO-ANSWER.spec.ts](A-TODO-ANSWER.spec.ts) | fixme-before-implementation | T-STK-01 |
| A-TODO-STEER | [A-TODO-STEER.spec.ts](A-TODO-STEER.spec.ts) | fixme-before-implementation | T-STK-06 |
| A-TODO-AMEND | [A-TODO-AMEND.spec.ts](A-TODO-AMEND.spec.ts) | fixme-before-implementation | T-STK-02, T-STK-06 |

Cycle 26: production TODO admission, issue drafts, question answers, steers and amendments remain pending. A-TODO-NEW also verifies mounted private draft opening and discard. Draft editing lost fields after blur and values after reload in Chromium; the retained persistence regression awaits T-APP-02.

| id | spec file | status | ticket |
| --- | --- | --- | --- |
| A-TODO-STOP | [A-TODO-STOP.spec.ts](A-TODO-STOP.spec.ts) | fixme-before-implementation | T-STK-05 |
| A-TODO-RESUME | [A-TODO-RESUME.spec.ts](A-TODO-RESUME.spec.ts) | fixme-before-implementation | T-STK-05 |
| A-TODO-RETRY | [A-TODO-RETRY.spec.ts](A-TODO-RETRY.spec.ts) | fixme-before-implementation | T-STK-05 |
| A-TODO-DROP | [A-TODO-DROP.spec.ts](A-TODO-DROP.spec.ts) | partial: mounted Drop confirms; durable capture/fold journey remains fixme | T-STK-05 |
| A-STACK-MOVE | [A-STACK-MOVE.spec.ts](A-STACK-MOVE.spec.ts) | fixme-before-implementation | T-STK-02 |
| A-MERGE | [A-MERGE.spec.ts](A-MERGE.spec.ts) | passing REST seam UI; complete folded backend and reference-host receipts remain separate | T-STK-04 |

Cycle 27: TODO pause, resume, retry, drop, stack reorder and merge await durable production journey projections. Hermetic scenarios do not replace machine, GitHub or reference-host receipts.

All six also exercise mounted command projections: Stop hides during a question,
Resume retains the attempt, Retry refuses a working TODO, Drop removes it,
Move preserves refs, and Merge opens the person's review before merging.
Full durable journey scenarios retain fixmes.

| id | spec file | status | ticket |
| --- | --- | --- | --- |
| A-BRANCHES | [A-BRANCHES.spec.ts](A-BRANCHES.spec.ts) | fixme-before-implementation | T-APP-10, T-COL-06 |
| A-BRANCH | [A-BRANCH.spec.ts](A-BRANCH.spec.ts) | fixme-before-implementation | T-APP-10, T-COL-06 |
| A-BRANCH-FORK | [A-BRANCH-FORK.spec.ts](A-BRANCH-FORK.spec.ts) | fixme-before-implementation | T-MCH-08 |
| A-BRANCH-ADD-TO-STACK | [A-BRANCH-ADD-TO-STACK.spec.ts](A-BRANCH-ADD-TO-STACK.spec.ts) | fixme-before-implementation | T-MCH-08, T-STK-05 |
| A-BRANCH-REBASE | [A-BRANCH-REBASE.spec.ts](A-BRANCH-REBASE.spec.ts) | fixme-before-implementation | T-STK-08 |
| A-TERMINAL | [A-TERMINAL.spec.ts](A-TERMINAL.spec.ts) | fixme-before-implementation | T-TRM-01, T-APP-12 |

Cycle 28: six branch and terminal command scenarios await live providers and durable recovery. Mounted tests cover the branch tree (the `/branches` handler is absent), ref opening, fork, scratch placement, rebase activity, and owned versus watched terminal controls. Seeded projections do not replace reference-host receipts.

| id | spec file | status | ticket |
| --- | --- | --- | --- |
| A-FILE | [A-FILE.spec.ts](A-FILE.spec.ts) | fixme-before-implementation | T-COL-08, T-APP-14 |
| A-FILES | [A-FILES.spec.ts](A-FILES.spec.ts) | fixme-before-implementation | T-APP-10, T-COL-04 |
| A-DIFF | [A-DIFF.spec.ts](A-DIFF.spec.ts) | fixme-before-implementation | T-STK-01, T-COL-04 |
| A-REVIEW | [A-REVIEW.spec.ts](A-REVIEW.spec.ts) | fixme-before-implementation | T-FLW-13, T-APP-16 |
| A-PR | [A-PR.spec.ts](A-PR.spec.ts) | fixme-before-implementation | T-STK-01, T-GH-03 |
| A-ISSUES | [A-ISSUES.spec.ts](A-ISSUES.spec.ts) | fixme-before-implementation | T-STK-09, T-GH-02 |

Cycle 29: file co-editing, live file lists and diffs, teammate PR review, PR evidence and issue sync retain full pending scenarios. Six mounted command projections exercise reads, keyboard navigation and review confirmation cancellation; these do not qualify live providers.

| id | spec file | status | ticket |
| --- | --- | --- | --- |
| A-ISSUE | [A-ISSUE.spec.ts](A-ISSUE.spec.ts) | fixme-before-implementation | T-GH-02 |
| A-ISSUE-NEW | [A-ISSUE-NEW.spec.ts](A-ISSUE-NEW.spec.ts) | fixme-before-implementation | T-GH-09, T-APP-02 |
| A-ISSUE-COMMENT | [A-ISSUE-COMMENT.spec.ts](A-ISSUE-COMMENT.spec.ts) | fixme-before-implementation | T-GH-09 |
| A-WIKI | [A-WIKI.spec.ts](A-WIKI.spec.ts) | fixme-before-implementation | T-COL-09 |
| A-WIKI-PAGE | [A-WIKI-PAGE.spec.ts](A-WIKI-PAGE.spec.ts) | fixme-before-implementation | T-COL-09 |
| A-WIKI-SAVE | [A-WIKI-SAVE.spec.ts](A-WIKI-SAVE.spec.ts) | browser-pass (literal slash save, reload deduplication, missing-answer refusal) | T-APP-02 |

Cycle 30: issue reads, creation and comments await live GitHub qualification; wiki reads and page creation await durable shared storage. Saving an answer still refuses because its page-write operation is absent. The filled issue form did not create an issue; its full regression remains pending with T-GH-09 and T-APP-02. Six mounted tests cover form cancellation, direct command projections and the honest save refusal.

| id | spec file | status | ticket |
| --- | --- | --- | --- |
| A-FLOWS | [A-FLOWS.spec.ts](A-FLOWS.spec.ts) | fixme-before-implementation | T-FLW-03, T-APP-05 |
| A-FLOW | [A-FLOW.spec.ts](A-FLOW.spec.ts) | fixme-before-implementation | T-FLW-03, T-FLW-04, T-APP-05 |
| A-FLOW-EDIT | [A-FLOW-EDIT.spec.ts](A-FLOW-EDIT.spec.ts) | mounted edit, prefill, install proposal/reload and system/catalog refusal pass; joint merge/Active pending | T-FLW-05, T-FLW-03, T-FLW-04 |
| A-FLOW-RUN | [A-FLOW-RUN.spec.ts](A-FLOW-RUN.spec.ts) | fixme-before-implementation | T-FLW-01, T-INS-02, T-CAT-01 |
| A-FLOW-NEW | [A-FLOW-NEW.spec.ts](A-FLOW-NEW.spec.ts) | fixme-before-implementation | T-CAT-01, T-FLW-03 |
| A-RUNS | [A-RUNS.spec.ts](A-RUNS.spec.ts) | fixme-before-implementation | T-FLW-07, T-COL-02 |

Cycle 31: repository flow listing, failed activation, edit-to-merge, typed execution, creation and durable attention retain full pending scenarios. Five mounted tests cover seeded lists, version selection, slash edit drafts, missing-input run forms and active run cards. `/flow.new` is absent. The Edit button preserves its flow-name prefill while the form asks only for Request; its regression passes under T-FLW-05. Seeded projections do not qualify live activation or durable providers.

| id | spec file | status | ticket |
| --- | --- | --- | --- |
| A-RUN | [A-RUN.spec.ts](A-RUN.spec.ts) | fixme-before-implementation | T-FLW-07, T-COL-02 |
| A-GITHUB | [A-GITHUB.spec.ts](A-GITHUB.spec.ts) | fixme-before-implementation | T-GH-07 |
| A-MONITOR | [A-MONITOR.spec.ts](A-MONITOR.spec.ts) | fixme-before-implementation | T-FLW-07 |
| A-DEBUG-API | [A-DEBUG-API.spec.ts](A-DEBUG-API.spec.ts) | fixme-before-implementation | T-APP-21 |
| A-RUN-INSPECT | [A-RUN-INSPECT.spec.ts](A-RUN-INSPECT.spec.ts) | fixme-before-implementation | T-FLW-07 |
| A-FLOW-SOURCE | [A-FLOW-SOURCE.spec.ts](A-FLOW-SOURCE.spec.ts), [install Source continuation](../flow-card-install.spec.ts) | mounted source, unavailable-catalog refusal without a Draft/TODO, and confirmed Draft-to-branch Source/reload pass; S2/S3 editing pending | T-APP-05, T-FLW-04, T-FLW-05 |

Cycle 32: live run recovery, GitHub stale/refused sync, the full monitor,
API playground and collaborative flow-source editing retain complete pending
scenarios. Mounted projections cover run opening and reload, Inspect with the
composer available, seeded sync health and source reads. `/monitor` and
`/debug-api` are absent; seeded projections do not qualify live providers.

| id | spec file | status | ticket |
| --- | --- | --- | --- |
| A-FLOW-PLAN | [A-FLOW-PLAN.spec.ts](A-FLOW-PLAN.spec.ts) | fixme-before-implementation | T-APP-05, T-FLW-04, T-FLW-05, T-FLW-07 |
| A-AGENTS | [A-AGENTS.spec.ts](A-AGENTS.spec.ts) | fixme-before-implementation | T-FLW-08 |
| A-AGENT | [A-AGENT.spec.ts](A-AGENT.spec.ts) | fixme-before-implementation | T-FLW-08 |
| A-SETTINGS | [A-SETTINGS.spec.ts](A-SETTINGS.spec.ts) | fixme-before-implementation | T-APP-15, T-INS-08 |
| A-SECRETS | [A-SECRETS.spec.ts](A-SECRETS.spec.ts) | fixme-before-implementation | T-ACC-03, T-APP-04 |
| A-MEMBERS | [A-MEMBERS.spec.ts](A-MEMBERS.spec.ts) | fixme-before-implementation | T-ACC-02, T-APP-06, T-REL-02 |

Cycle 33: plan preview, factory agent configuration, install settings, secrets and member admission retain full pending scenarios. Mounted Plan missing-input, Settings and Members projections are checked separately; seeded reads do not qualify live providers.

| id | spec file | status | ticket |
| --- | --- | --- | --- |
| A-SSH | [A-SSH.spec.ts](A-SSH.spec.ts) | fixme-before-implementation | T-TRM-03, T-APP-10 |
| A-SIGN-IN | [A-SIGN-IN.spec.ts](A-SIGN-IN.spec.ts) | fixme-before-implementation | T-ACC-02, T-REL-02 |
| A-SIGN-OUT | [A-SIGN-OUT.spec.ts](A-SIGN-OUT.spec.ts) | fixme-before-implementation | T-ACC-02, T-REL-02 |
| A-THEME | [A-THEME.spec.ts](A-THEME.spec.ts) | passing | T-REL-02 |

Cycle 34: the final four Appendix A commands exhaust the unwritten catalog. SSH command parity awaits implementation; the mounted branch copy button is checked with keyboard and clipboard assertions. Sign-in and sign-out retain pending live GitHub/session qualification; mocked browser handoffs are checked separately. Theme covers explicit light, bare toggle, reload and repeated explicit selection. All engineering check IDs and Appendix A commands now have specs; fixmes remain outstanding evidence.

| id | spec file | status | ticket |
| --- | --- | --- | --- |
| C-RMT-01 | [C-RMT-01.spec.ts](C-RMT-01.spec.ts) | fixme-before-implementation | T-RMT-01 |
| C-RMT-02 | [C-RMT-02.spec.ts](C-RMT-02.spec.ts) | fixme-before-implementation | T-RMT-02 |
| C-RMT-03 | [C-RMT-03.spec.ts](C-RMT-03.spec.ts) | fixme-before-implementation | T-RMT-03 |
| C-RMT-04 | [C-RMT-04.spec.ts](C-RMT-04.spec.ts) | fixme-before-implementation | T-RMT-04 |
| C-RMT-05 | [C-RMT-05.spec.ts](C-RMT-05.spec.ts) | fixme-before-implementation | T-RMT-05 |
| C-RMT-06 | [C-RMT-06.spec.ts](C-RMT-06.spec.ts) | fixme-before-implementation | T-RMT-04 |

Cycle 7 standing lane: six new remote-computer checks retain pending UI
scenarios. Computers, worker admission and Runs on are absent. The old SSH
mechanism is superseded pending controller/worker reconciliation (§8.13.0);
reference-rig, isolation, transport, capacity and credential receipts remain
required. Cloud qualification stays in stage 2. C-RMT-06 also needs VT-x enabled
on beaver and a rig fixture for the configuration-only flag transition.

T-UI-14 (2026-10-05): `/help` passes through the production dispatcher and
CardRenderers in light/dark at 1440/390 px, inline/maximized and after reload.
The repository contents seam supplies a live `/release-notes` row and summary;
listing neither launches that flow nor evaluates repository code.
Commands stories pass keyboard disclosure (Tab, Enter, Space, visible focus),
muted policy marks, inert metadata, fixture screenshots and edited action input.
The broad C-UI-12/13 fixmes still await the other Views and their wiring tickets.

T-UI-14 wave 2 (2026-10-06): both C-UI-13 `/help` browser cases passed again,
including live repository rows, inline/maximized/reload, light/dark and 1440/390 px.


| Check subset | Spec | Status | Ticket |
| --- | --- | --- | --- |
| C-UI-13 Commands | [C-UI-13.spec.ts](C-UI-13.spec.ts) | passed: /help, registry and repository rows, inline/maximized/reload, light/dark, 1440/390 | T-UI-14 |
| C-UI-12 Commands | [Commands stories](../view-stories.spec.ts) | passed: keyboard disclosure/focus, policies, inert text, action input | T-UI-14 |
| C-UI-12 Debug API | [Debug API stories](../view-stories.spec.ts) | passed: all 15 states, light/dark, 1280/1440/390, axe/overflow; Enter/Space selection and Send; POST/PUT/PATCH/DELETE confirmation, disabled/absent actions, inert response/failure text | T-UI-22 |
| C-UI-12 Docs | [Docs stories](../view-stories.spec.ts) | passed: 8 stories, light/dark, 1280/1440/390px, axe/overflow, keyboard focus, anchors, inert HTML/unsafe links and missing/disabled gestures; rendered links reach the real flow seam in DocsCard.test.tsx; absent/disabled navigation also removes native link targets and restores keyboard links when enabled; production mounting is active (C-UI-09 agent fixture remains blocked on T-APP-16) | T-UI-21 |
| C-UI-12 Secrets | [Secrets stories](../view-stories.spec.ts) | passed: 11 stories, light/dark, 1440/390, axe/overflow; Add/Replace/Cancel clear Value, redacted callbacks, absent/disabled actions, optional Hosts, inert names, keyboard Delete | T-UI-18 |
| C-UI-12 · TODO install | [TODO install case](C-UI-12-todo-install.spec.ts) | Keyboard Fork submits the displayed TODO source through the real app flow to POST /api/branches; keyboard Open branch from REST TODO through the composed app provider to the live Branch card; Branch tabs survive reload; keyboard item title returns through the real TODO flow/REST seam; owner Discard confirms the displayed wait/head, persists an idempotent request while HTTP is unresolved and settles from the served projection; stale Discard refreshes the newer push and reconfirms with its SHA; simultaneous conflict/moved-off/outside-push waits retain order, inert paths/actors and mobile layout; Enter/Space Resolve opens the real Branch seam; unavailable execution controls stay absent; 4 passed | T-UI-04, T-GH-06 |
| C-UI-12 Proposal | [Proposal stories](../view-stories.spec.ts) | passed: open/accepted/dismissed/read-only, hostile refs, zero/one/multiple lessons, keyboard callbacks; light/dark, 1440/390, axe and overflow | T-UI-20; install mounting and lessons source await T-FLW-06 |

T-MCH-08 scratch Diff has a passing install HTTP contract and browser projection in [scratch-diff.spec.ts](../scratch-diff.spec.ts): fork revision, unresolved read, duplicate input and reload. C-J7-02 remains pending for Add to stack/Confirm/Drop; C-MCH-08 remains pending for real capture and source boot continuity.

T-UI-15 pass 3: Branch states pass at 1440/390 px in light/dark; Enter/Space controls, tabs/SSH and missing/disabled/hostile cases pass (5 browser tests). Live Branch tab selection also passes keyboard and reload through the install app fixture (1 browser test). These fixtures do not establish machine execution or design-owner acceptance.

T-UI-15 pass 5: the Branch matrix checks serious/critical axe violations and saves named screenshot attachments for all 17 cases in light/dark at 1440/390 px (68 screens). Design-owner copy acceptance remains pending; screenshots and automated copy checks are engineering receipts, not approval.

T-UI-15 wave 2: Branch tabs support ArrowLeft/ArrowRight wrapping and Home/End focus movement through `onView`, without action dispatch. Six targeted browser tests pass, including the 68-screen named Branch matrix and keyboard navigation in both themes at 1440/390 px. The broader Branch story scan passes 31 stories at 1280/1440/390 px in both themes (186 screens), with no overflow or serious/critical axe violations. The three targeted View/card/seam files pass 1,151 tests; app typecheck passes. Design-owner acceptance and real-host machine execution remain external evidence.

T-APP-16 wave 2 browser receipts: `entry-row.spec.ts` covers prompt/answer EntryRow rendering and reload; `branch-navigation.spec.ts` covers the served nested branch tree, retired Branches card removal, Earlier, durable view selection on reload, and a literal journal archive with no turn admission. These do not replace the full C-APP-04 shared-host acceptance.
T-APP-04 Confirm proof: `TestConfirmationsBrowserPostgres` drives [the browser journey](../../real/confirm-merge.browser.ts) against PostgreSQL and the default install router, without browser API mocks. Passed 2026-10-06: private audience, Commit/Drop keyboard presses, admission toast through queued work and reload, other-member refusal, delegated id/state-only results. Review & merge remains pending its transactional consumer and recovery acceptance.

T-APP-04 additional Confirm coverage: [install contract cases](C-UI-13-confirm-install.spec.ts) passed (7): keyboard Commit, Amend, Bring in and Discard with a 202 keeps progress running until the subject settles, suppresses repeated presses, and leaves chat usable; Review & merge respects member role, current head, required checks and failed optional checks. Amend reconnects using the admitted prompt revision and settles only when its exact text is observed. Bring in and Discard reconnect to the admitted branch wait and settles only when that wait disappears. Retry restores running progress after an unavailable response and remains deduplicated while a successful admission awaits private live delivery. These use test-only live/HTTP fixtures; the PostgreSQL browser journey above remains the production composition proof.
T-APP-16 shared read receipt: `shared-conversation.spec.ts` renders the install HTTP projection with author attribution and reload. `SharedConversationApp.test.tsx` fences pending reads across account/branch changes; `TestBranchConversationQueueMutationInstall` verifies the additive author login through the authenticated PostgreSQL router. Composer cutover remains pending.
T-APP-04 additional Confirm coverage: [install contract cases](C-UI-13-confirm-install.spec.ts) passed (4): keyboard Commit and Amend with a 202 keeps progress running until the subject settles, suppresses repeated presses, and leaves chat usable; Review & merge respects member role, current head, required checks and failed optional checks. Amend reconnects using the admitted prompt revision and settles only when its exact text is observed. Retry restores running progress after an unavailable response and remains deduplicated while a successful admission awaits private live delivery. These use test-only live/HTTP fixtures; the PostgreSQL browser journey above remains the production composition proof.
T-APP-16 shared read receipt: `shared-conversation.spec.ts` renders the install HTTP projection with author attribution and reload. `SharedConversationApp.test.tsx` fences pending reads across account/branch changes; `TestBranchConversationQueueMutationInstall` verifies the additive author login through the authenticated PostgreSQL router. The install composer now uses durable host admission.

T-APP-16 prompt receipt: install composer uses only the canonical prompt body, acknowledges persisted requests before unresolved admission, deduplicates, retains progress through host completion and reconnects after reload. Mounted tests cover server queue PATCH/DELETE/restore, own-turn Stop, and retry after refusal. The browser executor and all five Bun write mounts are removed. Upstream restored the backend private-question route pending scoped-reader and private-Draft parity; it is not a completed five-route backend cutover.

T-APP-16 view-state receipt: `C-UI-06.spec.ts` passes two browser identities with HTTP/live contract fixtures. `shared-conversation.spec.ts` passes scroll-anchor and maximized-card restoration on reload. Writes retain Home preferences and exclude the read-only queue and UI instructions. Author-only theme instructions survive reload without reapplying completed instructions. PostgreSQL privacy remains covered separately by the composed-router checks.

T-APP-03 wave 2: [owner pre-approval default](C-APP-03-settings.spec.ts) passed (1): the served install field `todo_preapprove_default` toggles through the owner-only typed Settings flow, persists after reload, and can be disabled. Test-only HTTP provider; production setting attribution, creation inheritance and standing merge qualification remain T-STK-04 dependencies.

T-APP-03 wave 2 revalidated C-UI-13 Setup and Commands (2 passed, 1 unrelated all-card skip): Setup explicitly boots the install capability and checks its This Mac only / Network controls before and after reload.

T-FLW-07 additional contract coverage: [install monitor](C-J11-01-monitor-install.spec.ts) exercises authenticated run snapshots through `/run.inspect`, native phases and interrupted state, journal tab reads/restoration, GET-only replay, a historical frame retained through a live refresh while its scrub read is unresolved, coalesced matching journal reads, an unresolved `/monitor` list read with usable chat, background runs, and topic refusal. This uses test-only HTTP/WebSocket contracts; native run ingest, host projections and the full C-J11-01/C-J11-04/C-UI-13 checks remain pending.
T-APP-03 rerun: C-UI-13 now runs each card door independently without fixme. Flow and Agent doors use served HTTP fixtures; other doors retain the seed provider. This is app projection evidence, not production provider or reference-host qualification.

| C-UI-12 Confirm | [Confirm stories](../view-stories.spec.ts) | Keyboard approval/Cancel forward supplied revision bindings; disabled/absent actions, stale approval and receipts; light/dark at 1440/390; View DOM tests pass. Install activation remains T-APP-04. | T-UI-05 |
T-APP-03 pass 3: the image Draft uses the ticket title “Add figlet to the machine image”. C-APP-03 asserts the literal one-file recipe diff and private browser isolation, including independent Settings refusal, creation and discard. Settings retains a saved daily allowance when an older GET completes during its PUT; the seam regression also retains newer live-frame fencing. These are app-boundary receipts with test-only HTTP providers, not guest, merge, OAuth or reference-install qualification.

T-APP-04 merge admission additionally passes the Confirm browser contract: a person press receives 202 pending, disables repeated presses while merging, survives reload without another merge request, and ends only from the confirmed TODO/private approval projection. PostgreSQL/GitHub-fake service tests and composed install HTTP tests cover the separate admission and settlement boundaries; reference-host recovery and the full C-ACC-02 browser journey remain pending.

T-ACC-04 removes the C-ACC-02 and C-J6-02 browser fixmes using the install live confirmation seam. The browser contracts cover stale expiry, a fresh revision held by required checks, a person press, pending admission, reload, settlement and issuer attribution. These mocked transport projections supplement the composed PostgreSQL/CLI/GitHub-fake boundaries; they do not replace a real-host journey or the full C-ACC-01 command ledger.
T-APP-16 integrated receipts (2026-10-06): native repository library built on Linux; real PostgreSQL, authenticated composed router and packaged model host pass shared preflight/fallback, ordered replay, revocation, private context and catalog/confirmation dispatch. `TestBranchConversationTabClose` passes the real two-member Chromium case. Model and GitHub endpoints are fakes; no real microVM or reference-Mac evidence is claimed. Browser contract checks C-APP-04, C-APP-05 and C-UI-06 pass. The private `/api/agent/turn` restoration in `01d1fff750` supersedes the earlier five-404 receipt.

T-UI-15 wave 3 recovery: 117 Branch-focused View DOM tests, all six targeted Branch story browser checks, app typecheck, and C-UI-12 Branch's 68-screen light/dark desktop/phone axe/overflow matrix pass on this Linux lane. Story callbacks prove the props-only View seam; install execution remains with the wiring tickets. Design-owner visual/copy approval remains pending.
T-APP-16 wave 3 receipts (2026-10-07): the composed PostgreSQL/packaged-host crash test restarts a killed worker after delegated mint and after host lease acquisition, rejects the old bearer, closes the old lease and completes generation 2 once. The real two-member Chromium tab-close case passes again. Contract-browser C-APP-04, C-APP-05 and C-UI-06 pass; reference-Mac and real microVM acceptance remain pending. The unrelated restored-form focus assertion in `form-focus.spec.ts:98` fails in the broader browser run.
T-ACC-03 wave 2 adds the Member install-seam journey and C-ACC-02 current-check/pending-merge reload evidence. Exhaustive retained-route/system authorization and reference-host recovery remain separate pending evidence.
