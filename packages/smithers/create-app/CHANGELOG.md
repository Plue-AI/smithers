# @smthrs/create-app

**Documentation:** https://create-app.smithers.sh

## [Unreleased]

### Added

- Added `@smthrs/create-app/worker`: `turnResponse` runs a routed chat flow for
  one `POST /api/turn` under workerd and streams `TurnFrame` NDJSON back.
- `@smthrs/create-app/worker` adds `runFlow` and `resolvePipelineFlow` for
  pipeline flows (refused as `flow_not_pipeline` when the flow is a chat flow),
  and `TurnHost.observe`, which sees every frame, the terminal one included,
  as the run produces it.

### Fixed

- Security: `turnResponse` takes a `TurnEndpoint` whose required `authorize`
  runs before the body is read (401), and reads the body through a 64 KiB cap
  (413) as `application/json` only (415). The `default` template requires
  `Authorization: Bearer <APP_API_TOKEN>` on `/api/turn`. The new
  `@smthrs/create-app/http` subpath exports `authorized`, `readJson`, and
  `MAX_BODY_BYTES`, which the `aomi` template now uses instead of its own copy.
- Security: an `error` frame or `host_unconfigured` body carries only a typed
  error's message; a defect or host-callback throw is logged on the server and
  reaches the reader as `The turn failed.`
- Security: `brandCss` refuses a token or font value that could end its
  declaration or rule, and a `googleFonts` entry outside the `family=` grammar.
- Security: a recording whose text contains the value of a credential-named
  environment variable is not written as a fixture.
- The `default` template's `/api/turn` runs the chat flow instead of answering
  HTTP 501. It answers 503 `host_unconfigured` until the seat's provider key
  and `AI_GATEWAY_API_KEY` are set.
- The `aomi` template's Worker runs real turns and pipeline runs on
  `@smthrs/create-app/worker` instead of streaming a canned turn. The
  `APP_MOCK_TURN` switch, the mock turn, and the mock flow run are gone. A turn
  needs the seat's key, `AI_GATEWAY_API_KEY`, and `TEVM_FORK_RPC_URL`; without
  one it answers 503 `host_unconfigured` naming the secret. Deployments delete
  the `APP_MOCK_TURN` var and set the two new secrets.
- The `aomi` chat fixture replays again: it was recorded against an older cell
  contract and failed as unscripted.

## [1.0.0-rc.1] - 2026-09-22

### Changed

- Release candidate 1 with the workspace package train.

## [1.0.0-rc.0]

### Added

- Added `@smthrs/create-app`, its application templates, and the `create-app`
  scaffold command exposed by `@smthrs/build-cli`.
- Added `PACKAGE.ts`, so the package's lint, check, test, circular, and build
  gates run in CI rather than only by hand.
- Added package-owned documentation under `docs/`, published at
  https://create-app.smithers.sh: the routing grammar, the layer resolution
  order, the API reference, and the Cloudflare deploy guide.
- Added `@smthrs/create-app/routesBin`, the body of the `smithers-routes`
  executable, so its flags and exit codes are held to the package's coverage
  thresholds instead of living in an uninstrumented child process.
- Added a bundle test that proves the runtime class of every published subpath,
  because this package is in neither inventory of the frozen browser contract.
- Added the aomi template's `worker/guard.ts`: an optional `APP_API_TOKEN`
  credential, a 64 KiB request-body cap, and a session-id rule that stops a
  caller addressing the session registry's own Durable Object.
- Added the aomi template's `worker/stream.ts`, one cleanup path that runs on
  close, source error, and cancel.
- Added a second test target, `//packages/smithers/create-app:templates`, which
  runs the templates' own suites from this package against workspace sources.
  Every test for the scaffolded Worker's credential check, body cap, session-id
  rule, stream cleanup, and turn cancellation lives under `template/`, which no
  gate ran.
- Added `isRouteSegment` and `routeSegmentGrammar` to `@smthrs/create-app/app`:
  one spelling of the route-name grammar, imported by the router and by the
  aomi template's promote tool instead of copied into each.
- Added `test/docsParity.test.ts`, which fails when `docs/api.md` names a
  subpath the package does not serve, a constructor it does not export, or a
  `smithers-routes` flag its usage text does not document. It also holds the
  `BrandToken` count, the optional peer ranges and install pins, the template
  file counts, target labels, and this changelog's first release heading to
  the source they describe.

### Fixed

- Generated import bindings are numbered rather than derived from the route, so
  two legal routes can no longer collapse onto one binding and emit a module
  that does not parse.
- Every generated import specifier is a JSON string literal, and every page
  directory segment is name-checked, so no file path can inject a statement
  into a generated module.
- `resolveLayer` normalizes its boundary and refuses a directory outside the
  root, instead of spinning forever on a root that carries a trailing
  separator.
- The router walks with `readdirSync(dir, { withFileTypes: true })` and never
  follows a symbolic link, so a dangling or self-referential link is ignored
  rather than raising a raw `ENOENT` or recursing to `ELOOP`.
- A pane is matched only directly under `<app>/panes/`, so a deeper file is the
  page its location names.
- `smithers-routes` runs the built `dist/esm/routesBin.js` only when it is
  installed under `node_modules`, where Node refuses to strip types, and the
  working tree's source everywhere else. Preferring `dist` whenever it existed
  meant a source checkout ran the last compiled generator after any `pnpm
  check`, and reported success either way.
- A failed recording no longer overwrites a committed fixture, and a successful
  one is written through a temporary file and renamed. Both endings are pinned
  by tests that start from known bytes and assert them afterwards.
- A recorded provider failure is serialized into the fixture and rebuilt field
  for field on replay instead of collapsing into `invalid_provider_output`.
- A `RouterError` raised by the Vite plugin's watcher is reported rather than
  thrown out of chokidar's emit, so a refused tree no longer takes the dev
  server down.
- `loadManifest` derives its `parentURL` from the app root, so the CommonJS
  build's lowered `import.meta` no longer makes it unusable.
- A layer or flow export is checked against the `_tag` its constructor stamps,
  and a malformed fixture fails with the fixture path in the message.
- The aomi template's turn stream cancels its inner reader and clears the
  session's `busy` flag on every ending, so a client disconnect no longer
  leaves a session refusing every later turn with 409.

### Changed

- `ToolsGrant.action` is `@smthrs/capability`'s closed pattern-action union
  rather than `string`, so an unknown action is a compile error in the
  `TOOLS.ts` that declares it.
- `defineTools` takes an options object like the other three constructors.
- Both templates pin every `@smthrs/*` dependency at the version the workspace
  publishes, and a test holds them there.
- The `default` template ships a working replayed test, an honest `/api/turn`
  stub, and deployment instructions that no longer imply a wired agent host.
- `runFlowRun` takes the routed flow table through an injectable loader, the
  way `worker/turn.ts` takes its implementation, and no longer imports
  `routes.gen.ts` at module scope. The generated table pulls every flow, layer
  file, and tool module in behind it.
- The aomi template no longer declares `@smthrs/ui-styleguide`. Nothing
  imported it, because `@smthrs/ui` resolves those token names itself, so it
  was one fewer private package a scaffold could not install. A test holds each
  template's private dependencies: the published `default` template has none,
  and `aomi` has only `@smthrs/ui`.
