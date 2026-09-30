---
title: "Adoption: the Smithers monorepo"
description: "A worked case of smithers build running a real TypeScript monorepo: what the graph covers, which gates became targets, and what is still outside it."
---

Examples importing `buildAndCheckPackage` use the [local helper defined here](../reference/targets/standard-package.md). Create that file in your repository before using those examples.

The Smithers monorepo runs its own CI through smithers build. This page is the
worked case: what a large TypeScript workspace looks like once the build graph
owns the pipeline, and what is honestly still outside it. Read it before you
decide how far to take the same move in your own repository.

## What the graph covers

**One declaration produces targets for every package.** The root `PACKAGE.ts`
declares:

```ts
import { buildAndCheckPackage } from "./package-targets.ts"
export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/{*,*/*,*/*/*}",
  macro: buildAndCheckPackage
})
```

A directory with a `package.json` and no `PACKAGE.ts` of its own synthesizes the
standard set: `lib` (TsBuild), `check` (Typecheck), `test` (Vitest), `lint`
(EsLint), `fmt` (Dprint), and `docs` (DocsParity). Packages whose build is not
conventional write a `PACKAGE.ts` by hand instead. A test loads every committed
`PACKAGE.ts` on each run, so a change to the declaration surface cannot silently
invalidate one. See [Default targets](../extending/default-rules.md).

**The gates are the same gates.** `lib` plus `check` covers what the packages'
`check` scripts covered, `lint` plus `fmt` covers their lint scripts, and `test`
runs the same Vitest configs including their coverage thresholds. Nothing was
loosened to fit the graph.

**The graph is the CI lane.** The required CI job runs
`smithers-build ci "//packages/..."` rather than a list of recursive package
scripts. Whatever passes locally under one label passes in CI under the same
label.

Workspace, script, and package-documentation gates run in independent required
Ubuntu jobs. They read the cache; only the isolated publisher writes it. Main
keeps the newest pending full run per ref. Release retains all three gates.

**The workflow file is generated.** `.github/workflows/ci.yml` is declared with
[GithubCiGen](../reference/targets/github-ci-gen.md) in `mode: "check"`: one
target regenerates it, and every other verb fails on drift. Nothing in the
declaration is a command. A job states what the runner must provide and which
targets it runs, and the generator derives every step. The CI job also lints the
`ci` target itself, so the workflow describing the pipeline is drift-checked by
the pipeline.

**Root-level gates became targets in the packages that own them.** The release
scripts, the browser-bundle guard, the Rust gates and the WebAssembly
reproducibility rebuild, the end-to-end suites, and the offline eval suite are
each a target declared beside the code they check.
[NodeTest](../reference/targets/node-test.md),
[NodeBinary](../reference/targets/node-binary.md), and
[CargoLint and CargoTest](../reference/targets/cargo.md) exist because those
gates needed them. Before that move, each one was a `run:` string in a workflow:
not planned, not keyed, not addressable by label, and not runnable locally under
the name CI used. See
[Writing build files](writing-build-files.md#build-files-declare-targets-never-commands).

**One file stayed hand-written.** `pnpm-workspace.yaml` is authoritative rather
than generated, because pnpm may carry settings the target schema cannot
express, and generating it would create a drift check nothing could satisfy.
The lockfile and install declarations still parse it, validate its `packages`
list, and digest it along with every selected member manifest, so a membership
change still invalidates dependency resolution.

## What is still outside it

**The workhorse targets are not cached.** TsBuild, Typecheck, Vitest, EsLint,
and Dprint remain non-cacheable. Their action-backed execution keys now identify
the declared package-manager and runtime executable bytes, including shebang
interpreters, alongside the lockfile, config, source, and dependency inputs.
That does not yet identify every installed compiler, runner, lint tool, or
dprint plugin, or restore every produced output. A declared
[Nix environment](../concepts/environments.md) contributes identity but does
not make these targets cacheable. See [Caching](caching.md) for the complete
input contract and remaining acceptance evidence for #1871.

**Clean-slate builds are not reproduced.** The pipeline used to wipe every
`dist` tree before building. The graph rebuilds from declared inputs instead, so
a stale artifact would now surface as a `TsBuild` key that failed to change when
it should have, rather than being swept away.

**Local entry points still use package scripts.** The recursive pnpm scripts
remain for local use. Nothing in CI calls them, and they retire when the local
commands move to `smithers-build` as well.

## What the migration order was

The sequence that worked, and the one worth copying:

1. Declare targets for every package, and verify the graph plans them.
2. Run the graph beside the existing pipeline until the two agree.
3. Make the graph the required lane and delete the parallel one.
4. Move the remaining workflow strings into targets, adding a target type when
   a gate does not fit an existing one.
5. Complete input contracts, then opt targets into caching.

Steps 1 through 4 buy addressability: one label, one behavior, locally and in
CI. Step 5 is what buys wall-clock time, and it comes last because a cache keyed
on an incomplete input contract is worse than no cache at all.
