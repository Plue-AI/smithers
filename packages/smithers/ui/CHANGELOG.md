# @smthrs/ui

## 1.0.0-rc.0

`@smthrs/ui` is `private: true` at this release: `apps/ui` and `flows/review`
consume it through the workspace.

### Added

- The rc.0 run status vocabulary. `accepted` and `parked` join the status table
  alongside every run-card phase `apps/ui` passes, and `hasStatusTone(status)`
  draws the distinction `statusClass` cannot: a status deliberately bucketed
  neutral against one the table never heard of. Nothing that already had a tone
  changed one. The table stays additive and drops no alias; the entries for
  outcomes rc.0 does not produce (`paused`, `continued`) carry a comment naming
  the real sources that still render them.
- Pass-through attributes the hosts asked for: `submitProps`/`stopProps` on
  `ChatComposer`'s Send and Stop buttons, and `nodeProps` on `FileTree` leaves.
  A `nodeProps` callback composes with the built-in selection handler rather
  than replacing it, and cannot overwrite the structural
  `type`/`data-slot`/`data-active` attributes the CSS keys on.
- `MarkdownEditor` gains an `escapeTabOrder` default so forward Tab is not
  trapped, an injectable `loadEditor` seam, an explicit
  `"loading" | "ready" | "failed"` editor state, and an `onError` callback
  carrying a stable `editor-load-failed` / `editor-create-failed` code with the
  original cause retained.
- A GitHub-flavored table rule in the `Markdown` renderer.
- `@smthrs/ui/adapters/knowledge-graph`: `KnowledgeGraph` moved out of the
  `vault` barrel and behind its own subpath, so the base barrel stops pulling
  `d3-force` into every consumer.
- `PromptInput` reports refused intake through `onError` with stable
  `max-files`, `max-file-size`, `accept`, `disabled`, `multiple` and
  `submit-failed` codes.
- The vault autosave machine reports failure with stable `read-failed` and
  `write-failed` codes and the original `cause`, so an unreadable external copy
  and a failed disk write are distinguishable from a real concurrent edit.
- Copy affordances (`CodeBlock`, `Snippet`, `SecretField`) accept an async copy
  callback and report failure with stable `clipboard-unavailable` and
  `clipboard-write-failed` codes.

### Fixed

- `statusClass("constructor")` resolved through `Object.prototype` to the
  `Object` constructor, which is truthy so `?? "muted"` never caught it, and
  React threw "Functions are not valid as a React child" on render. Every status
  table is now a frozen null-prototype container.
- `parseAgentOutput` overflowed the stack on cyclic or deeply nested provider
  output. Both traversals are bounded now and return the partial model.
- `MarkdownEditor` picked its fallback by sniffing `navigator.userAgent`, which
  made the WYSIWYG path unreachable from this package's own suite and silently
  downgraded real browsers whose user agent carried a matching token. It
  measures layout instead, and a real init failure renders the seeded textarea
  with `data-mode="failed"` rather than an empty div.
- `PromptInput` revoked its object URLs synchronously after a `void onSubmit`
  call, so an async handler read revoked blob URLs after its first `await`. The
  draft and its previews are now held until the handler settles, and a rejection
  keeps the draft instead of clearing it.
- `PromptInput` enforced `disabled` and `multiple` only on the hidden file
  input. `addFiles` is the single admission point now, so paste, drop, the
  document-level drop registry and the `usePromptInputAttachments().add` hook
  all honor them.
- The vault autosave conflict predicate compared content only, so an older
  on-disk copy read as a conflict. It implements the documented mtime-and-content
  conjunction, `saveNow` no longer exposes the internal force flag that skips
  conflict detection, and a `resetKey` change flushes a dirty machine after the
  commit instead of disposing it during render.
- The unified-diff parser added a phantom trailing context row on every
  newline-terminated patch, lost git-quoted paths entirely, and classified hunk
  headers by sniffing line text. Headers are tagged at parse time, quoted paths
  are decoded, and `detectBinary` reads structure so a text diff that ADDS the
  line `GIT binary patch` is no longer hidden behind a binary placeholder.
- `PierreDiffView` showed every file when `selectedPath` matched none of them.
- Calendar `Home` and `End` targeted Sunday and Saturday regardless of
  `weekStartsOn`, moving focus out of the visible row in a Monday-first grid.
- Wikilinks were rewritten inside valid double-backtick code spans, and a `~~~`
  line closed an open ``` fence. One CommonMark-aware scanner now backs both
  `wikilinksToMarkdown` and `parseWikilinks`.
- `RelativeTime` threw `RangeError` on a timestamp `Date` cannot hold, and
  `formatRelativeTime` promised a "just now" string it never emitted.
- `MessageScroller` observers missed a viewport that mounted after its provider;
  the transcript empty state stayed hidden when a conditional child collapsed to
  `false`; a test suite that started failing while on screen stayed closed; a
  click on a collapsible panel's title text did not toggle it; and the checkpoint
  trigger needed its own tooltip provider.
- A tool call read the record it was spread from rather than its own result and
  error.
- `chart.tsx` refused to interpolate an unsafe chart id into its style block,
  and `chartSeriesColor` threw on a non-finite index instead of clamping.
- `SecretField`'s `maskLength` had no ceiling, so a large value allocated a
  proportionally large string and `Infinity` threw.
- `SchemaDisplay` recursed without bound, so a schema whose `properties` pointed
  back at itself overflowed the stack during render.
- `formatJsonSafe` had no depth, size or output bound and echoed host error text
  into the rendered string.
- `MessageScroller` accepted `fade`, `hideJumpToLatest`, `jumpToLatestLabel` and
  `contentClassName` and silently dropped all four whenever an ambient
  `MessageScrollerProvider` was mounted above it, so the same call had different
  semantics depending on composition. The provider's unread `streaming` prop is
  gone.
- Plan compound parts rendered outside `<Plan>` produced controls wired to a
  no-op default context. They throw a named misuse error now, matching
  `Checkpoint`.

### Changed

- `Checkpoint`'s action vocabulary is restricted to the operations rc.0 actually
  has. the release policy rules that a checkpoint at rc.0 is a
  pinned git tree per cell call, and that replay, fork and rewind exist only as
  the `@smthrs/time-travel` library API; `restore` and `return-to-live` had no
  rc.0 counterpart at all and are gone.
- The `PlanStep` data model is `PlanStepModel`. `PlanStep` is the component.
- `src/index.ts` lists the `vault` and `calendar` exports by name instead of
  re-exporting their subdirectory barrels, and forwards `DEFAULT_THEME_KEY` and
  `themeRegistry` so `resolvePalette`'s return type is enumerable without a
  second dependency.
- Documentation is colocated: `docs/architecture.md` and `docs/contracts.md`
  replace the second copy of the layering notes that lived in `src/README.md`
  and drifted from the root README independently.

### Gates

- `PACKAGE.ts` declares `//packages/ui:check` (a `tsc --noEmit` typecheck) beside
  `//packages/ui:unitTests`, and `package.json` gained the matching `check`
  script, so root `pnpm run check` no longer skips the package. The tsconfig
  named `bun-types` while `@types/bun` was installed, so `tsc -p` had never been
  able to run at all.
- `tests/barrel-weight.test.ts` bundles `src/index.ts` for the browser and fails
  on `recharts`, `@xterm`, `@milkdown`, `@pierre/diffs` or `d3-force` reaching
  the base barrel. It replaces the deleted `scripts/check-ui-architecture.mjs`,
  which was the adapters rule's only enforcer.
- `tests/provenance.test.ts` checks every lane manifest against the module it
  names, replacing the single hand-written check that covered one lane of
  fifteen.
- `tests/docs-links.test.ts` resolves every relative link in the package's own
  Markdown and fails on any subpath written against the unscoped `smthrs`
  package, which at rc.0 publishes only a notice whose module throws on import.
  The scoped `@smthrs/ui` is the only importable name. The colocated docs had
  shipped three links to a `docs/contracts.md` that was never written, and no
  gate noticed, because `scripts/check-ui-architecture.mjs` had been the only
  checker of this package's documentation claims.
- This package runs `bun test` and declares no eslint or dprint target;
  `PACKAGE.ts` records the package-specific tooling boundary.
