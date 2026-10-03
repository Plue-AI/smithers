# C-UI-11 Kept card capabilities: File-card code intelligence and the webpage reader

Proves: mvp.md §8 ("Webpage reader card; code intelligence in file cards": Keep), §1.4 (the File card keeps code intelligence), Appendix B `code.hover`, `code.definition`, `code.diagnostics`, `browser.open`; AGENTS.md "Keep browser IDE code intelligence and the general webpage reader" · spec.md §7.6 (row 3), §8.4.4, §14.3 (File), §14.3.0 · Layer: e2e · Stage: S1, R · Tickets: T-APP-15, T-APP-11
Automation: `apps/app/e2e/real/file-intelligence.spec.ts` (new) · Runs in: reference host, once on the S1 build and again on the release build with S2 and S3

## Setup
- Install at the commit under test. Ben (member) signed in.
- Scratch repository `smithers-mvp-canary/<date>`, TypeScript: `src/a.ts` declares `export function add(x: number, y: number): number` on line 3; `src/b.ts` calls `add(1, "2")` on line 5, a type error.
- TODO T1 Working on its item branch, so the branch's machine is awake.
- A static page `page.html` served from the browser Mac, titled "Reader canary", with one paragraph "Reader canary body".
- The keyboard-only guard of C-UI-01 is active.

## Steps
1. Ben opens `src/b.ts` on T1's branch in the File card.
2. He moves the cursor onto `add` on line 5 and requests hover.
3. He requests go to definition on `add`.
4. He reads the diagnostics on `src/b.ts`.
5. Release build only: let T1's branch sleep (T1 paused, §8.4.2). Open `src/b.ts` on it again and request hover.
6. Ben runs `/browser.open <page.html URL>`.

## Pass when
- Step 2: a hover shows `add(x: number, y: number): number` within 3 s of the request (the first request may start the language server; the time is recorded).
- Step 3: the File card shows `src/a.ts` with the cursor on line 3.
- Step 4: exactly one error diagnostic marks line 5, naming the argument type mismatch.
- Each gesture raises its catalog flow (`code.hover`, `code.definition`, `code.diagnostics`) with `{path, line, col}`, recorded in the flow log.
- Step 5: the file renders from the captured snapshot, no `machine_requests` row appears (§8.4.4), and hover binds no gesture, with no error toast, spinner or dead click.
- Step 6: a reader card shows the title "Reader canary" and the paragraph "Reader canary body".
- Steps 1–6 complete with the keyboard alone.

## Fail when
- Hover, definition or diagnostics show nothing, or the wrong place, on an awake branch.
- A code-intelligence request wakes a sleeping branch.
- The reader card errors or shows no page text.
- The release build loses a capability the S1 build had.

## Evidence
`.artifacts/checks/C-UI-11/<UTC timestamp>/<build>/`: video, the flow log of the three gestures, hover timing, screenshots of steps 2–4 and 6, the `machine_requests` count for step 5, and the commit and install version.
