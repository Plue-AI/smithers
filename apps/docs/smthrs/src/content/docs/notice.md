---
title: "Why importing smthrs throws"
description: "The planned smthrs@1.0.0-rc.1 notice, its import behavior, and the difference between checkout and npm availability."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smthrs-deprecation/docs/notice.md"
---

The `smthrs@1.0.0-rc.1` source checkout defines one error, raised while the module
evaluates once this candidate is published:

```text
smthrs 1.0 is a migration notice, not a runtime.
Smithers 1.0 ships as @smthrs/* packages. Install @smthrs/flows (authoring and engine)
and @smthrs/cli (the `smthrs` command), then run `smthrs migrate` in a 0.x project.
Migration guide: https://smithers.sh/migration/1.0
```

Those four lines are the whole package.

## What each line means

**"a migration notice, not a runtime."** Nothing here runs a flow. The module
body throws and returns nothing to the importer.

**"Install @smthrs/flows and @smthrs/cli."** `@smthrs/flows` is the aggregate
that replaces the facade's runtime half: the authoring primitives, the durable
engine, and the stores. `@smthrs/cli` replaces its command half and publishes
the `smthrs` executable, with `smithers` as an alias of the same binary.

**"then run `smthrs migrate` in a 0.x project."** The upgrade is a source
migration, not a version bump. `smthrs migrate` scans the project, plans it as
units, and rewrites each unit against the 1.0 API.

**"Migration guide."** The procedure and the complete removal list live on
[smithers.sh](https://smithers.sh/docs/migration/1.0/). This site covers the package; that guide covers
the upgrade.

## Why it throws instead of resolving

The module declares no exports at all. Evaluation always throws, so a declared
export would be a name the published types offer and the runtime can never hand
back. That drift, a program that type-checks and then fails at run time, is
what the 0.x umbrella was guarded against, and it would be a strange thing for
its removal notice to reintroduce. The published `index.d.ts` declares no
importable surface, so a 0.x import fails to type-check as well as to run.

Throwing also puts the message where the failure is. A 0.x import that resolved
to an empty module would fail later, somewhere else, as an undefined value with
no explanation attached.

## How the package is published

Six manifest decisions decide what an install gets and carry the notice to a
person rather than to a log nobody sees.

| Decision                          | Why it is that way                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sideEffects: true`               | A bundler told this module is side-effect free may drop the import, and dropping the import drops the notice.                                                                                                                                     |
| `exports` is `.` and nothing else | Every 0.x subpath fails to resolve instead of resolving to something new. See [Troubleshooting](/troubleshooting/).                                                                                                                            |
| `bin` is `smthrs` and `smithers`  | Both names run `@smthrs/cli`'s own executable, so `npx smthrs <verb>` works. A global install links both names onto `PATH`. If another package already owns a global `smithers`, npm refuses with `EEXIST`; `npm install -g --force` replaces it. |
| One dependency, exact-pinned      | `@smthrs/cli` at this package's own version, never a range, so an install cannot pull a later or squatted CLI. Installing the notice installs the CLI and its dependencies.                                                                       |
| Both entry points throw           | `dist/esm/index.js` throws on `import`, and `dist/cjs/index.js` throws on `require`.                                                                                                                                                              |
| `engines.node` is `>=26.4.0`      | Matches the [Node version Smithers 1.0 requires](https://smithers.sh/docs/migration/compatibility/). Lowering it would let the notice install where the packages it names cannot run.                                                                                      |

A dynamic `import()` rejects with the error rather than throwing at the call
site, because the throw happens while the module evaluates. A `require` of the
CommonJS entry throws where you called it. Both carry the same four lines.

A static named or default import never reaches the throw. Node rejects
`import { Workflow } from "smthrs"` while it links the module graph, before any
module evaluates, with a `does not provide an export named` SyntaxError that
carries no notice. Nothing in this package can run during linking, so that
error is documented rather than avoided; see
[Troubleshooting](/troubleshooting/).

## Publication status

At the 2026-09-29 registry check, `npm view smthrs dist-tags version --json`
reported only `latest: 0.35.0`; `npm view @smthrs/flow dist-tags version --json`
returned 404. Neither `smthrs@next` nor `smthrs@1.0.0-rc.1` is an installable
notice yet. Use the source checkout and its workspace dependencies to inspect
or test this candidate; do not treat a source build as an npm publication.
The manifest requests the `next` tag for a future release, while `latest`
continues to install 0.x until an actual release changes that tag.
