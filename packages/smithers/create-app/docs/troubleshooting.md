---
title: "Troubleshooting"
description: "The refusals @smthrs/create-app reports, grouped by the component that raises them: the router, the executable, the Vite plugin, the runtime composition, the test harness, and the scaffold."
---

Every refusal in this package names the file or the field that caused it. Find
the message and read the matching section.

## The router

`RouterError` carries one of three codes, and the walk stops at the first one.

### no AGENT.ts found for flows/chat or any ancestor

**What happened.** Code `missing_layer`. A flow has no ancestor layer file of
that kind, so its seat, sandbox, or tools cannot resolve. The app root must
provide all three: that requirement is what makes resolution terminate.

**What to change.** Add the named file at the app root, or at any directory
between the root and the flow. See
[Layer files](./concepts/layers.md).

### `<dir>` is outside the app root, so no AGENT.ts can resolve for it

**What happened.** Code `missing_layer`. A directory being resolved is not
inside the root the walk was given.

**What to change.** Check the `--root` flag or the plugin's `root` option. Both
paths are normalized before the ancestor walk, so a trailing separator is not
the cause.

### pane file name must match /^[a-z][a-z0-9-]*$/

**What happened.** Code `invalid_name`. A pane file, a page directory segment,
or a flow directory segment is not lowercase kebab-case. The message names the
file and says which of the three rules it broke.

**What to change.** Rename it. The grammar applies to page segments as well as
to panes and flows, because every segment reaches a generated import specifier
as well as a URL path. On a case-insensitive filesystem, renaming `Balance.tsx`
to `balance.tsx` may need two steps.

### `<a>` and `<b>` both resolve to `<key>`

**What happened.** Code `duplicate_name`. Two files claim one pane name, page
route, or flow id.

**What to change.** Delete or move one of them. Nothing wins by ordering: the
walk sorts the whole collected set before it routes anything, so the refusal
does not depend on what the filesystem hands back.

## smithers-routes

### --root expects a value

**What happened.** Exit code 2. A flag was given without a value, either as a
bare `--root` at the end of the argument list, as `--root --check`, or as
`--root=`.

**What to change.** Pass a value in either form: `--root <dir>` or
`--root=<dir>`.

### routes.gen.ts is out of date; run `pnpm routes`

**What happened.** Exit code 1 from `smithers-routes --check`. The generated
tables do not match what the router would write now.

**What to change.** Run `pnpm routes` and commit both files. Both are derived
data; edit what they are derived from. See
[The generated route tables](./concepts/generated-routes.md).

### this install has no dist/esm/routesBin.js

**What happened.** Exit code 1. The executable is running from inside a
`node_modules` directory, where Node refuses to strip types, and the compiled
generator is not there.

**What to change.** Reinstall `@smthrs/create-app`. From a source checkout the
shim runs the TypeScript source instead, so this message means the install is
incomplete rather than that the package is wrong.

## The Vite plugin

### PACKAGE.ts must export `App` from CreateApp({ ... })

**What happened.** The default manifest loader evaluated the app's `PACKAGE.ts`
through `tsx` and found no `App` export carrying a manifest.

**What to change.** Export `App` from `CreateApp({ ... })`. A `PACKAGE.ts` that
exports only `Package` is a valid build file and an invalid app declaration.
Alternatively pass the manifest to the plugin directly with the `manifest`
option, which also removes the `tsx` peer dependency.

### the manifest is read before configResolved ran

**What happened.** Something asked the plugin for a virtual module before Vite
resolved the config. In an ordinary Vite run this cannot happen; it shows up
when a host drives the plugin's hooks itself.

**What to change.** Await `configResolved` before calling `load`.

### smthrs-create-app: invalid_name: ... on stderr, and the tables did not update

**What happened.** The dev server's watcher saw a routed file appear or
disappear, the regeneration was refused, and the refusal was reported rather
than thrown. The listener runs inside chokidar's emit, where a throw would take
the dev server down instead of raising an overlay, so the previous tables stay
on disk.

**What to change.** Fix the tree the message names. Creating a capitalised pane
file, adding a second `flow.ts` for an existing id, and deleting the root
`AGENT.ts` each produce one. Pass `onRouterError` to send these reports
somewhere you will see them.

### smthrs-create-app: ENOSPC: could not write the route tables on stderr

**What happened.** The dev server's watcher saw a routed file appear or
disappear and the filesystem refused the write. A full disk or quota, a
read-only checkout, a locked file, and an exhausted descriptor table all
produce one. The previous tables stay on disk whole, because each table is
written to a `.tmp` file and renamed into place.

**What to change.** Fix what the message names: free space, permissions on the
app root, whatever holds the file open. The report is not routed through
`onRouterError`, which carries refused trees only. `ENOENT` is different: the
app root is gone, so the regeneration throws.

## The runtime composition

### TOOLS.ts grant[0].action is not a capability action

**What happened.** `LayerError` with the code `invalid_grant`. A `TOOLS.ts`
grant names an action the kernel's pattern grammar does not accept. The check
is here rather than deeper because an unknown action used to fail inside the
capability schema with a message that named neither the grant nor the field.

**What to change.** Use one of the kernel's pattern actions, such as a concrete
action, a family wildcard like `net:*`, or `*`. Because `action` is a closed
union, this is normally a compile error in the `TOOLS.ts` that declares it: a
runtime failure means the spec was built without `defineTools`.

### TOOLS.ts grant[0].resource is N characters; the limit is 4096

**What happened.** `LayerError` with the code `invalid_grant`. A grant's
resource pattern is longer than the kernel's bound.

**What to change.** Shorten the pattern, or split the grant into several
narrower ones.

## The test harness

### no fixture at `<path>`

**What happened.** A replay run found no recorded transcript. Replay is the
default, so a test with no fixture has nothing to run against.

**What to change.** Record one with `SMTHRS_RECORD=1`, then commit it. See
[Test a flow](./guides/test-a-flow.md).

### flow "chat" is not routed. Known flows: ...

**What happened.** The `flow` option does not match any routed flow id. The
message lists the ids the router did find.

**What to change.** Run `pnpm routes` if you have just added the flow, check
the directory name against the id you passed, and check the `root` option if
the test does not run from the app root.

### cachedModelTest cannot run flows/x/flow.mdx

**What happened.** The flow is a markdown flow. It routes, and it appears in
`routes.gen.ts`, but the test harness has no loader for one.

**What to change.** Write the flow as a `flow.ts` if you want it covered by the
offline suite.

### AGENT.ts must export `Agent` built by defineAgent

**What happened.** A layer file exported the right name with the wrong value.
Every spec carries a `_tag`, and the harness reads it, so
`export const Agent = 42` is refused here instead of failing much later inside
the agent host with a message that names neither the file nor the field.

**What to change.** Build the export with the matching constructor:
`defineAgent`, `defineSandbox`, or `defineTools`.

### SMTHRS_RECORD=1 needs a live model

**What happened.** A recording run reached a test that declares no `live`
function.

**What to change.** Add `live: () => ...` returning a `Model` bound to a real
provider, or record only the tests that have one. The `aomi` template's
`test/support/liveModel.ts` is the worked example.

### recording produced no model calls

**What happened.** A recording run finished without reaching the model, so
there was nothing to write. The guard exists because a fixture truncated to
`{"calls": []}` replays as a model that answers nothing.

**What to change.** Check that the flow actually calls the model on this
payload, and that the seat resolved. The committed fixture is untouched.

### `<path>` is not valid JSON, or is not a @smthrs/testing fixture

**What happened.** The fixture failed to parse, or parsed and failed to decode
against the fixture schema. Both failures name the path first and keep the
original error as the cause.

**What to change.** Record the fixture again. A fixture that decoded before and
does not now usually means the schema moved.

## The scaffold

### unknown template "nope"; available: default

**What to change.** Pass `--template default`. The available list is read from
the resolved `@smthrs/create-app`, so it reflects the installed package.

### "Ledger App" is not a usable app name

**What to change.** Use a directory name matching
`^[a-z0-9][a-z0-9._-]*$`. The directory's base name becomes the app name, the
Worker name, and the substituted `__APP_NAME__`.

### `<dir>` is not empty

**What to change.** Scaffold into a new or empty directory. An existing empty
directory is fine; anything in it is not, because the copy would merge into a
tree you did not expect it to touch.

### create-app templates ship in @smthrs/create-app; install it and try again

**What happened.** The CLI could not resolve `@smthrs/create-app/package.json`
through Node, so it has no template directory to read.

**What to change.** Run the command from a checkout, or from a project where
the package is installed.

## Running the app

### The agent says a pane is not registered

**What happened.** `ui/pane` was called with a name the binding's pane list
does not hold. The refusal lists the names that are registered.

**What to change.** Routing a pane makes it exist; the tool binding decides
whether it is callable. Add the name to the list the `ui` source was built
with, or build that source from `paneNames` in `routes.gen.ts`. See
[Add a pane](./guides/add-a-pane.md).

### /api/turn answers 503 host_unconfigured

**What happened.** The Worker has no connection for the seat in `AGENT.ts`. The body's `message` names the
missing binding. No stream opened and no model ran.

**What to change.** Set the named secret with `wrangler secret put`, or in
`.dev.vars` for `pnpm dev`. See
[Deploy to Cloudflare](./guides/deploy-to-cloudflare.md).

### /api/turn answers 400 flow_not_chat or flow_not_routed

**What happened.** The request named a flow the router did not find, or one
without `chat: true`. `flow_not_routed` lists the ids it did find.

**What to change.** Post `{ flow, payload }` with a routed chat flow's id.

### wrangler deploy fails on virtual:smthrs-app/manifest

**What happened.** `wrangler deploy` was given a `--config` flag. Wrangler
follows the build's `.wrangler/deploy/config.json` redirect only when no
`--config` is set, so with the flag it bundles the Worker entry point with
esbuild alone, and that bundle cannot resolve the Vite plugin's virtual module
reached from `routes.gen.ts`.

**What to change.** Run `wrangler deploy` from the app root with no `--config`.
The flag is still correct for `wrangler secret put`, which does not go through
the build. See [Deploy to Cloudflare](./guides/deploy-to-cloudflare.md).

### Effect service tags do not match across packages

**What happened.** Two copies of `effect` reached one bundle. A package graph
can contain more than one physical installation, so a config that does not
deduplicate can load the module twice, and a `Context` tag from one copy does
not satisfy a requirement declared with the other.

**What to change.** Both templates set `resolve.dedupe` in `vite.config.ts` and
`vitest.config.ts`. Keep `effect` there, and `react` and `react-dom` in the
Vite config, so hooks and tags stay identical across packages.
