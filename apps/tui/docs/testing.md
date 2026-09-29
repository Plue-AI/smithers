# TUI verification

Run from a checkout with the Node version in `.node-version`, Bun 1.4 or later,
Git, jj 0.39.0 or later, ripgrep, tmux, and the pinned Rust toolchain. Build the
native filesystem helper from the repository root:

```bash
cargo build --locked --release -p smithers-ffi --bin smithers-jj-export
```

`SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` can select an installed helper instead.
`TMUX_BIN` selects tmux when it is outside `PATH`. Install Vim to include the
interactive external-editor cases; those cases explicitly skip without it.
The test runner's `PATH` must select the pinned Node for packaged-runtime tests.

From `apps/tui`:

```bash
bun test ./test
bun test ./e2e
pnpm run typecheck
pnpm run lint
```

The workspace runner exposes the same suites as `//apps/tui:unitTests` and
`//apps/tui:e2eTests`. From the repository root, run
`pnpm exec smthrs test '//apps/tui:e2eTests'` with the prerequisites above.

The tmux suite runs the production renderer in private servers with an empty
configuration, explicit child environments, disposable projects, and private
conversation storage. It sends raw key bytes, captures the visible pane, and
checks files and saved receipts. Resizing changes the real PTY. Exit assertions
read the pane's exit status. Cleanup removes the suite's servers and files,
including leftovers from a killed previous run; it does not use personal tmux
sessions.

## Coverage

The TUI Bun suite remains assertion-only (see `PACKAGE.ts` and
`scripts/repo-contract/README.md`): Bun's loaded-source LCOV denominator changes
on unchanged sources and cannot establish a whole-production floor. The explicit
`coverage-roster.json` lists every `src/**/*.{ts,tsx}` owner source for the
Istanbul collector (`scripts/bun-coverage`), including unimported files with
zero hits. Use `node scripts/bun-coverage/run.mjs --root apps/tui --roster
apps/tui/coverage-roster.json --run /tmp/tui-coverage-new -- test ./test` from
the repository root to collect an LCOV/JSON report. This is measurement, not a
release gate: TUI child-launch paths (including detached descendants and
platform-specific cleanup described in the collector README) and missing
behavior tests remain unqualified; no numeric floor is claimed under #2392.

An earlier two-run qualification on a 77-source roster (Bun 1.4.1) kept the
same statement/function/branch/line denominators with and without
`test/surfaces.test.ts`: `src/surfaces.ts` 58/23/49/47 and the whole roster
8626/2205/10150/7133. Those historical reports contain all 77 sources, including zero-hit
`src/surfaces.ts` when its test is absent. Both commands published LCOV and JSON
without collector refusal, but Bun's suite exited 1 (75 failing tests and 67
errors in each run); these reports do **not** qualify a passing TUI gate.

| Area                    | Terminal evidence                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup and packaging   | Redirected-stream refusal, Node bundle, relocated compiled binary, embedded helper, dynamic project flows, shared Effect identity.                               |
| Composer and keys       | Input bursts across focus changes, Unicode, multiline input, history, help, completion, model picker, and terminal widths down to 40 columns.                    |
| Search                  | Commands, files, text matches, limits, saved conversations, and worker tabs; selecting an item preserves the draft.                                              |
| Conversations           | Continue, startup picker, names, compaction, fork, interrupted turns, queued follow-ups, torn tails, deep paths, and storage failures.                           |
| Shell and editor        | Included/excluded command output, nonzero exits, cancellation, process-group cleanup, Vim handoff, suspended editors, resize, and missing-editor errors.         |
| Views and changes       | Summary, diffs, split view, timeline history, custom panels, cards, mouse input, scrolling, and undo with refusal and restart cases.                             |
| Background workers      | Saved requests, duplicate input, unresolved execution, usable chat, completion toasts, steering, cancellation, retry controls, tree navigation, and worker undo. |
| Flows and approvals     | Discovery, live refresh, input forms, burst navigation, short panes, quoted values, durable parks, fallback models, approval/denial, and real completion.        |
| Extensions and monitors | Repository contributions, key conflicts, panel actions, hot reload, notable/routine updates, and shell-monitor cleanup on stop, quit, and conversation switch.   |
| Command effects         | Typed help/navigation/resume and worker stop/retry routes, clipboard recovery, compaction persistence, and budget counts in chat, reload, and print mode.        |

The unit suite separately exercises parsing, projections, persistence,
capabilities, worker scheduling, cancellation, and recovery. Terminal fixtures
replace model responses or deliberately hold host work unresolved; the production
UI still handles its real keys and persisted state. Replay cases execute their
cells and filesystem/shell effects against disposable projects. Packaged-runtime
cases execute both the Node bundle and the compiled binary for the current host.

A passing local run proves behavior on its tested platform and dependencies.
It does not establish live provider quality, hosted deployment health, other
operating systems, or every possible terminal configuration. Report skips and
failures with the result. The audit is tracked in
[#2074](https://github.com/smithersai/smithers/issues/2074).

The current roster has 79 sources. A focused collection of
`test/harness-cli.test.ts`, `test/harness.test.ts`, and
`test/harness-codex.test.ts` passes 10 tests and exercises every statement,
function, and branch arm in `src/harness-cli.ts`. This selection retains the
whole roster as its denominator and does not qualify whole-TUI coverage.

## Parked worker retry controls

```bash
bun test ./test/parked-retry-controls.test.ts
```

This regression suite delegates and retries through the runtime bindings with
real session files. A controlled host delays the cancelled worker's completion
until before or after its replacement finishes. It checks Stop, Steer, saved
outcomes, and cancellation intent across retries. This proves lifecycle ordering,
not live provider or terminal behavior.

## Audit: 2026-09-27

Executed on macOS 26.6.2 arm64 with Node 26.5.0, Bun 1.4.2, tmux 3.5a,
jj 0.40.0, and Vim:

- Native unit suite: **781 passed**, zero failures or skips.
- tmux suite: **145 passed** across 12 files, zero failures or skips.
- Workspace gate `//apps/tui:e2eTests`: executed the same **145** cases and
  returned `ok: true`, with one target run and zero failures or skips.
- TUI typecheck, lint, and formatting: passed.
- Playground unit suite: **11 passed**; Astro check: zero diagnostics.
- Browser recovery/provider suite and **44** executable recordings: passed;
  **27** TUI animations refreshed on the main site.
- Main-site checks: **78 passed**, 309 built pages, 855 required URLs, zero
  failures. Generated documentation and documentation fleet checks: clean.
- Live provider smoke: a chat answer and delegated README read completed and
  persisted successful outcomes; the README stayed unchanged.

The live smoke is one provider observation, not a model-quality benchmark.
The complete tmux run includes relocated Node and compiled binaries for this
host; other platforms were not rerun in this audit. Product fixes received a
[code-aware Fable review](https://github.com/smithersai/smithers/issues/2290#issuecomment-5859687948).
The authored wiki source is updated; its verified refresh failed at the citation
service and remains tracked in
[#1923](https://github.com/smithersai/smithers/issues/1923#issuecomment-5859581609).

## Documentation checks

Author guides in `apps/site/src/content/docs/docs/tui/` and the TUI tabs of
`docs/learn/`. The Commands and Keys pages are generated from the runtime
registries. From the repository root:

```bash
pnpm --filter @smithers/tui-docs sync:reference
pnpm --filter @smithers/tui-docs test
pnpm --filter @smithers/tui-docs check
pnpm --filter @smithers/tui-docs record
pnpm --filter @smithers/tui-docs build
pnpm --filter @smithers/tui-docs test:browser
pnpm --filter @smithers/site run capture:learn tui
node apps/site/scripts/generate-llms.mjs
pnpm --filter @smithers/site run check:docs
```

Recordings use the separate Python PTY driver, execute the Markdown scripts,
and retain transcripts, artifact hashes, and receipts only after their assertions
pass. The browser suite exercises the playground with a controlled HTTP provider.
See [recordings](README.md) for the additional toolchain. Documentation generation
and a local site build do not publish the repository wiki; its existing Cloud
workflow retains separate source and review receipts.
