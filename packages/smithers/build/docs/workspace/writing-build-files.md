---
title: "Writing build files"
description: "How a PACKAGE.ts declares targets, why a build file never carries a command, and how imports become dependency edges."
---

Examples importing `buildAndCheckPackage` use the [local helper defined here](../reference/targets/standard-package.md). Create that file in your repository before using those examples.

A `PACKAGE.ts` file is a TypeScript module. The CLI imports it through the
programmatic `tsx` loader with `tsconfig: false`, then reads its `Package`
export.

One constraint comes from that loader. `tsconfig: false` means no tsconfig is
read, so compiler options declared in the workspace do not apply: a `paths` alias
does not resolve, and a relative import names the real file, extension included,
as in `import { Package } from "../plan/PACKAGE.ts"`.

## Targets are keys of the Package map

A `PACKAGE.ts` exports one value named `Package`. Every key of its `targets` map
becomes a label: the package path plus that key.

```ts
// packages/greeter/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"

const cwd = "packages/greeter"
const sources = S.glob("src/**/*.ts")
const tests = S.glob("test/**/*.test.ts")

const lib = S.TsBuild({
  srcs: [sources],
  entries: [S.file("src/index.ts")],
  deps: [],
  tsconfig: S.file("tsconfig.json"),
  tool: { name: "tsc" },
  format: "dual",
  outDir: "dist",
  cwd
})

const test = S.Vitest({
  tests: [tests],
  sources: [sources],
  deps: [lib],
  config: S.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

const lint = S.EsLint({
  sources: [sources, tests],
  deps: [],
  configs: [S.file("eslint.config.js"), S.file("//eslint.jsdoc.js")],
  maxWarnings: 0,
  fix: false,
  cwd
})

export const Package = S.Package({ targets: { lib, test, lint } })
```

`sources` and `tests` are module-local bindings, so they never become labels.
They are still declared inputs of the targets that reference them. A target left
out of the map has no label either: omission is the only privacy mechanism.

A key must match `[A-Za-z_][A-Za-z0-9._-]*`. A `file()` or `glob()` value placed
directly in the map is wrapped in a `Filegroup`, so the key still labels exactly
one target.

Beside `Package`, a module may export a `PackageDefaults` value to declare
synthesis. See [Default targets](../extending/default-rules.md).

## Build files declare targets, never commands

A build file says what the workspace has. It never says how to run it.

```ts
// Wrong. This is a gate outside the build graph.
const ci = S.GithubCiGen({
  jobs: [{ id: "test", steps: [{ run: "node --test scripts/pack-release.test.mjs" }] }]
})

// Right. The gate is a target, and the pipeline names it.
// scripts/PACKAGE.ts
const packManifest = S.NodeTest({
  runner: S.testRunner([S.file("//scripts/pack-release.test.mjs")]),
  srcs: [S.glob("//scripts/**/*.mjs")],
  deps: []
})

export const Package = S.Package({ targets: { packManifest } })

// PACKAGE.ts
const ci = S.GithubCiGen({
  jobs: [{ id: "test", toolchain, steps: [{ verb: S.Verb.Test, pattern: "//scripts/..." }] }]
})
```

A raw argv in a build file, a `run:` string or an executable name or a shell
fragment, is a gate the build system does not know about. It is not planned,
not keyed, not cached, not addressable by label, and not runnable locally by the
name CI uses. It also pins the interpreter and the package manager at the call
site, so the workspace can no longer switch either by editing one declaration.

**Argv rendering belongs in target implementations.** `PackageManager.install()`
renders `pnpm install --frozen-lockfile --ignore-scripts`; `Runtime.test()`
renders `node --test`; `RustToolchain.install()` renders
`rustup toolchain install`. A declaration passes the toolchain in and the
implementation asks it for the argv.

Bazel is the prior art the rule comes from: a `BUILD` file has no way to write a
command at all, every check is a test target, and CI is one verb over the graph
(`bazel test //...`). If a gate does not fit an existing target type, add a
target type. [`NodeTest`](../reference/targets/node-test.md),
[`NodeBinary`](../reference/targets/node-binary.md), and
[`CargoLint` and `CargoTest`](../reference/targets/cargo.md) all exist because a
pipeline needed one. Or reach for
[`ToolBuild`](../reference/targets/tool-build.md), the deliberate escape hatch,
and say in review why the toolchain does not deserve a type of its own.

The schemas enforce this where the pressure is highest.
[`GithubCiGen`](../reference/targets/github-ci-gen.md) has no attribute anywhere
that accepts a command, an action reference, or a shell script: a job declares
what it requires and which targets it runs, and the generator derives every
step.

## Target calls

A target call takes exactly one object: the target's attributes. The attrs are an
Effect `Schema.Struct`, so the call validates them and applies constructor
defaults. Passing an unknown key or the wrong type is a type error and a runtime
decode failure.

Every attribute value is key material. A `cwd` change, a flag flip, or a
different tool re-keys the target.

The target call itself performs no I/O. It builds a flow, walks the decoded attrs
for declared inputs and target references, and attaches planner metadata.

## Imports are dependency edges

Import a target and put it in an attrs value. The target collector walks the whole
attrs object, at any depth, through arrays and plain objects.

```ts
import { buildAndCheckPackage } from "./package-targets.ts"
// packages/app/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"
import { Package as greeter } from "../greeter/PACKAGE.ts"

const { lib, test, lint } = buildAndCheckPackage({ deps: [greeter.lib], cwd: "packages/app" })

export const Package = S.Package({ targets: { lib, test, lint } })
```

Every catalog target has a `deps` attribute typed as `Schema.Array(Target.Target)`,
which is the conventional place to put edges. Nothing requires it: a target
value in any attribute becomes an edge.

Labels never appear in attrs. See [Dependencies](../concepts/dependencies.md).

## Declared inputs

`glob()`, `file()`, and `gitDiff()` create inert values. They read nothing at
module-evaluation time. The planner expands and digests them during discovery.

```ts
const sources = S.glob("src/**/*.ts")
const generated = S.glob("src/**/*.ts", { exclude: ["src/**/*.gen.ts"] })
const config = S.file("vitest.config.ts") // package-relative
const rootConfig = S.file("//eslint.jsdoc.js") // workspace-relative
const changes = S.gitDiff("origin/main")
```

Reuse one declared value across several targets. Each target digests it
independently, and equal content always produces an equal digest. See
[Inputs](../concepts/inputs.md).

## Macros

A macro is an ordinary function that returns targets. It is not a target, has no
identity in the graph, and produces no node of its own.

```ts
import { buildAndCheckPackage } from "./package-targets.ts"
// packages/plan/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"

const { lib, test, lint } = buildAndCheckPackage({ deps: [], cwd: "packages/plan" })

export const Package = S.Package({ targets: { lib, test, lint } })
```

The map key is the target name, so renaming is renaming a key:

```ts
import { buildAndCheckPackage } from "./package-targets.ts"
const standard = buildAndCheckPackage({ deps: [], cwd: "packages/plan" })

export const Package = S.Package({
  targets: { build: standard.lib, check: standard.test }
})
```

Mix a macro with extra target calls in the same file:

```ts
import { buildAndCheckPackage } from "./package-targets.ts"
const standard = buildAndCheckPackage({ deps: [flow], cwd: "packages/engine" })

const dependencyPolicy = S.DepsLint({
  packageJson: S.file("package.json"),
  sources: [S.glob("src/**/*.ts"), S.glob("test/**/*.ts")],
  deps: [standard.lib],
  tool: "knip",
  ignoreDependencies: ["@effect/platform-node"],
  ignoreBinaries: [],
  cwd: "packages/engine"
})

export const Package = S.Package({
  targets: { lib: standard.lib, test: standard.test, lint: standard.lint, dependencyPolicy }
})
```

See [Writing macros](../extending/writing-macros.md).

## The root PACKAGE.ts

The root file carries workspace-level declarations.

```ts
import { buildAndCheckPackage } from "./package-targets.ts"
// PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"

export const rootJSDocConfig = S.file("//eslint.jsdoc.js")

export const packageDefaults = S.PackageDefaults({
  directories: "packages/*",
  macro: buildAndCheckPackage
})

const scripts = S.Filegroup({ srcs: [S.glob("//scripts/**/*.mjs")] })

export const Package = S.Package({ targets: { scripts } })
```

A shared `file()` export like `rootJSDocConfig` is a plain declared value. Other
`PACKAGE.ts` files import it and put it in their attrs.

The toolchain does not live here. It lives in the workspace declaration, which
targets resolve their runtime and package manager from at plan time. See
[the workspace reference](../reference/config.md).

## Rules to follow

- Do not read the filesystem, spawn a process, or await anything at module scope.
  Discovery imports these modules, and the model assumes evaluation is pure.
- Do not put one target value under two keys of the map. Discovery refuses it.
- Give every tool-running target a `cwd` when it belongs to a package. The
  default is the workspace root.
- Keep `SecurityReview` check paths pointed at files in the current checkout.
  A missing path fails workspace discovery, including unrelated targets.
- Keep `PACKAGE.ts` imports to `@smthrs/targets`, other `PACKAGE.ts` files, and
  standard TypeScript. Anything else runs at discovery time on every command.

## Next

- [Running targets](running-targets.md)
- [Target definitions and targets](../concepts/targets.md)
- [Target catalog](../reference/targets/README.md)
