# @smthrs/ui

**Documentation:** https://ui.smithers.sh

Shared component library for Smithers UIs: shadcn component anatomy (compound
slots, CVA variant APIs, `asChild`, `data-slot` attributes) and Radix behavior,
styled entirely through theme tokens so every component is correct in light and
dark and honors `prefers-reduced-motion`.

`@smthrs/ui` is `private: true` and workspace-only at `1.0.0-rc.0`. It is not
published to any registry: `apps/app` and `apps/review` consume it through the
workspace.
Import it by its scoped name, `@smthrs/ui`; the unscoped `smthrs` package
publishes only a deprecation notice whose module throws on import.

Styling ships as CSS-in-TS (`smithersUiCss`) because the bundler this package is
built for drops `.css` imports. Render `<SmithersUiStyles />` once at the root;
every component also self-injects the composed sheet plus its lane CSS fragment
as a fallback. All classes are namespaced `sui-*`.

```tsx
import { Button, SmithersUiStyles, StatusPill } from "@smthrs/ui";
```

## Families

- Base primitives: `Button`, `Badge`, `Card`, `Input`, `Label`, `Alert`,
  `Table`, `Tabs`, `Dialog`, `Tooltip`, `Select`, `Progress`, `Separator`,
  `Skeleton`, `Spinner`, `EmptyState`, `SectionHeader`, `RowButton`, `KpiStat`,
  `StageStrip`, `CollapsiblePanel`, `DiffHunks`, `FileTree`, `Markdown`.
- Conversation: `Message` family, `MessageBranch` family, `Bubble` family,
  `MessageScroller` (drop-in and compound anatomy plus hooks), `CompactGroup`,
  `ConversationCheckpoint`, `ChatMessage`, `ChatTranscript`, `ChatComposer`,
  `Marker`, `Shimmer`.
- Prompt and attachments: `PromptInput` family with
  `usePromptInputAttachments`, and the `Attachment` compound.
- Reasoning and tools: `Reasoning`, `ChainOfThought`, `ToolCall`, `CodeBlock`
  (with header/filename/group/tabs), `AgentOutput`, `MessageResponse`,
  `parseAgentOutput`, `formatPartialJson`.
- Plans, tasks, queues: `Plan` family, `TaskItem`, `AgentTask` family,
  `Queue` family, `ActivityTimeline`.
- Approvals and checkpoints: `Confirmation` family, `ApprovalCard`,
  `Checkpoint` family.
- Sources and citations: `Sources`, `InlineCitation` with card/carousel/quote,
  `Suggestion`, `OpenInChat`.
- Agents and context: `AgentDefinition`, `AgentCard`, `ModelSelector`,
  `ModelBadge`, `ProviderBadge`, `ContextUsage` family.
- Coding artifacts: `Artifact`, `Snippet`, `PackageInfo`, `SchemaDisplay`,
  `StackTrace`, `TestResults`, `Commit`, `ChangeSummary`,
  `EnvironmentVariables`, `SecretField`.
- Sandbox previews: `Sandbox`/`SandboxHeader`/`SandboxStatus`/`SandboxActions`/`SandboxContent`,
  `WebPreview`, `JSXPreview`.
- Workflow canvas: `WorkflowCanvas` node/edge/controls/panel/toolbar/minimap
  anatomy.
- Vault: `BacklinksPanel`, `OutlineView`, the `wikilinks` and `graphModel`
  helpers, and the `createAutosaveDoc` / `useAutosaveDoc` autosave machine.
- Time: `RelativeTime`, `useRelativeTime`, `formatRelativeTime`.
- Calendar: `Calendar` with month, week, and agenda views.

Heavy renderers stay behind `@smthrs/ui/adapters/*` subpaths so the base barrel
tree-shakes clean: `pierre-diff-view`, `code-view`, `terminal`, `markdown-editor`,
`chart`, `knowledge-graph`. `tests/barrel-weight.test.ts` is the ratchet that keeps them
out of `src/index.ts`.

## Documentation

The published site at https://ui.smithers.sh is built from `docs/`.

- [`docs/README.md`](./docs/README.md) - the overview and the family index.
- [`docs/installation.md`](./docs/installation.md) - entry points and peer
  requirements.
- [`docs/quickstart.md`](./docs/quickstart.md) - one surface, end to end.
- [`docs/concepts/`](./docs/concepts/styling.md) - how styling ships, theme
  tokens, component anatomy, and the adapters boundary.
- [`docs/guides/`](./docs/guides/style-a-host-application.md) - task-shaped
  how-tos.
- [`docs/api.md`](./docs/api.md) - every public export.
- [`docs/reference/contracts.md`](./docs/reference/contracts.md) - failure
  codes, resource limits, and the object-URL ownership rule.
- [`docs/troubleshooting.md`](./docs/troubleshooting.md) - symptoms, causes,
  and fixes.
- [`CHANGELOG.md`](./CHANGELOG.md) - release history.

JSDoc on each exported symbol in `src/` is the per-symbol source of truth. The
pages above are hand-written; no generator produces them.
`tests/docs-links.test.ts` is the gate over them: every relative link has to
resolve, and no file in this package may name the unscoped specifier.

## Gates

```sh
pnpm --filter @smthrs/ui test    # bun test tests
pnpm --filter @smthrs/ui run check    # tsc -p tsconfig.json --noEmit
```

Both are declared in `PACKAGE.ts` as `//packages/smithers/ui:unitTests` and
`//packages/smithers/ui:check`. This package does not run vitest, coverage thresholds,
eslint or dprint; `PACKAGE.ts` records the package-specific tooling boundary.

Every export condition points at a `.ts` or `.tsx` source, so `tsc --noEmit` is
the only thing between a type error and a consumer's build.

Four suites hold the invariants the docs promise:

- `tests/barrel-weight.test.ts` bundles `src/index.ts` in a fresh Bun
  subprocess and fails when `recharts`, `@xterm`, `@milkdown`, `@pierre/diffs`,
  or `d3-force` reaches the output. It also asserts a minimum bundle size, the
  presence of `node_modules/react`, and a control entry point that must contain
  each dependency, because a negative assertion passes against an empty bundle.
  The subprocess is load-bearing: Bun's bundler shares its file cache with the
  test runner's module registry, so an in-process `Bun.build` after another
  suite imported the same modules reads crossed content.
- `tests/css-contract.test.ts` reads the shipped string and enforces the
  namespace, the absence of a `:root` block, the token-only color rule, the
  byte-equal light fallbacks, and the geometry scales.
- `tests/provenance.test.ts` holds the shadcn catalog: every lane file on disk
  must be listed, and every export a lane declares must resolve in the module
  it names.
- `tests/docs-links.test.ts` resolves every relative link in the package's
  Markdown and fails on any file that names the unscoped specifier.

`bunfig.toml` preloads `tests/happy-dom-preload.ts`. Radix resolves its
SSR-safe `useLayoutEffect` shim at module load, so happy-dom has to be
registered before any test file imports `radix-ui`.

## Shared client logic

DOM and OpenTUI clients import renderer-neutral logic through explicit subpaths:

- `@smthrs/ui/flow-form`: schema fields, hints, drafts, required inputs, and typed submission.
- `@smthrs/ui/flow-arguments`: file-flow JSON and quoted `key=value` arguments.
- `@smthrs/ui/command-line`: repository tokens, command normalization, slash parsing, and submit routing.
- `@smthrs/ui/clock`: stable React clock subscriptions for wall and observed engine time.
- `@smthrs/ui/run-command`: opaque run references and source-card routing.

These entrypoints do not import the DOM component barrel. Forms retain one
schema-derived model; each client owns its controls and persistence. File-flow
arrays use JSON to preserve spaces and structured values. Positional command
lists retain their space-separated grammar.
