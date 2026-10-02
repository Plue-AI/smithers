---
title: "Declaration loading"
description: "Shared runtime dependencies, early conflict diagnostics, CommonJS evaluation, and the lifetime of declaration modules."
sidebar:
  order: 7
---

`PACKAGE.ts`, `WORKSPACE.ts`, and their helpers execute trusted repository code
inside the CLI process. Loading a declaration is not a sandbox boundary.

## Shared runtime dependencies

Use the CLI installed in the workspace. Wherever declarations install `effect`,
`@smthrs/targets`, `@smthrs/plan`, `@smthrs/core`, or `@smthrs/flow`, Node must
select the same physical packages as the CLI. Equal version strings or equal
`Symbol.for` brands do not establish module identity. Separate Effect copies
have different schema sentinels; separate plan copies have different continuation
tables.

Before evaluation, the loader checks the declaration files and their statically
discovered relative-import closure. Node's default package lookup performs this
check independently of the current resolve hooks. A conflict fails with
`declaration_dependency_mismatch`, including the importing file and the two
manifest paths. Resolution failures carry `declaration_dependency_unresolved`,
name their original cause in the message, and preserve it as the cause.

This preflight checks physical package selection. It does not certify arbitrary
custom loaders, absolute runtime URLs, query-string module copies, dynamic
imports, or the private dependencies of third-party helpers. The existing ESM hooks still maintain the
shared runtime across tsx evaluation namespaces. Those hooks also retain the
existing dependency-free bootstrap behavior; removing them requires a separate
change to the evaluation lifetime and bootstrap contract.

## Scaffolding and installation

Scaffold into an empty directory, then install the workspace's dependencies
before evaluating declarations. A globally installed CLI does not supply a
workspace-local runtime contract merely because its versions match. Prefer
`pnpm exec smithers-build` after installation. Check an `init`-generated manifest before installing, because `init` can
create a manifest without dependency declarations.

## Module formats and CommonJS callers

Declare `"type": "module"` in new workspaces. Use static ES-module imports in
declarations. The current declaration loader still handles existing workspaces
whose manifest omits `type`.

tsx's supported CommonJS registration handles nested `require` calls and
TypeScript syntax, including a declaration's static `file:` URL import.
CommonJS dependencies resolve from the caller's installed packages. build-cli
does not replace `Module._resolveFilename` or alias CommonJS dependency lookup.
NodeNext relative `.js` imports use tsx's TypeScript extension handling.

## Evaluation lifetime

The workspace discovery probe and full package graph use separate tsx
namespaces. The full graph evaluates the workspace again and shares one
declaration instance for every reference inside that graph. Do not rely on a
declaration side effect running once across the probe and full load.

The package loader memoizes a successful graph by the content digest of its
declarations and statically discovered helpers. Editing a helper re-evaluates
the graph in a fresh namespace. Failed imports are not retained in that graph
cache. A future loader using ordinary ESM imports needs a different reload
boundary, because native ESM caching does not invalidate transitive helpers.
