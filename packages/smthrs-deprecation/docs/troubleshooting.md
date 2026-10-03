---
title: "Troubleshooting"
description: "The errors a 0.x project hits when smthrs@1.0.0-rc.0 is installed, including the ones that never print the notice: a static named import rejected while linking, subpath resolution failures, a jsxImportSource pragma, a missing command, and an install that silently stays on 0.x."
---

Most projects never see the notice first. Something else fails earlier, and
this page is how to recognize those failures as the same thing. Every fix ends
at the same place: the [1.0 migration guide](/migration/1.0).

## `does not provide an export named` on `import { ... } from "smthrs"`

**Symptom.** A 0.x source file imports a name from the root specifier, Node
rejects the import with a SyntaxError, and the notice is nowhere in the
output:

```text
SyntaxError: The requested module 'smthrs' does not provide an export named 'Workflow'
```

`import smthrs from "smthrs"` fails the same way, naming `'default'`.

**Cause.** The module declares no exports, and the notice is thrown while the
module body evaluates. Node links a static import before it evaluates
anything: each imported name is checked against the module's export table, and
a name that is not there is rejected on the spot. That rejection comes first,
so the body that throws the notice never runs. Only an import that reaches
evaluation prints the notice: a bare `import "smthrs"`, a namespace import, a
dynamic `import()`, or a CommonJS `require`. Declaring the 0.x names would
avoid the SyntaxError only by letting a 0.x project type-check against values
the runtime can never hand back, which is the drift
[the notice exists to prevent](./notice.md).

**Fix.** Read it as the notice. Smithers 1.0 ships as `@smthrs/*` packages:
depend on `@smthrs/flows` for authoring and the engine and
`@smthrs/cli` for the `smthrs` command, then run `smthrs migrate` in the
project to rewrite the import. The full procedure is the
[1.0 migration guide](/migration/1.0).

## ERR_PACKAGE_PATH_NOT_EXPORTED on a `smthrs/...` subpath

**Symptom.** An import of a 0.x subpath fails to resolve, with no migration
text anywhere in the message:

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './jsx-runtime' is not defined by "exports" in .../node_modules/smthrs/package.json
```

**Cause.** Only the root specifier `smthrs` reaches this package's module, and
only an import that evaluates it throws the notice. The package
exports `.` and nothing else, so `smthrs/jsx-runtime`,
`smthrs/jsx-dev-runtime`, `smthrs/ui`, `smthrs/gateway-react`, and every other
0.x subpath fail at resolution, before any module of this package evaluates.

**Fix.** Read it as the notice. Smithers 1.0 publishes no JSX runtime and no
umbrella subpaths, so there is nothing behind those specifiers to import.
Migrate the project: `smthrs migrate` rewrites the imports and drops the JSX
settings for you.

## TypeScript fails on `smthrs/jsx-runtime` before anything imports `smthrs`

**Symptom.** A 0.x project fails to typecheck or build the moment
`smthrs@1.0.0-rc.0` is installed, and the failing specifier is one nothing in
your source wrote.

**Cause.** `jsxImportSource: "smthrs"` makes every `.tsx` file resolve
`smthrs/jsx-runtime`, so the compiler reaches that subpath before your first
import statement runs. This is the error most 0.x projects see first.

**Fix.** It means what the notice means. If the project's `.tsx` sources still
have to compile while you work, reinstall `smthrs@0.35.0` first: 0.x is on the
`latest` dist-tag and still publishes the JSX runtime. Then migrate, and let
the migration's final unit remove the pragma along with the dependency.

## `npm install smthrs` installed 0.35.0, not the notice

**Symptom.** You expected the 1.0 packages, and got a 0.x install.

**Cause.** `smthrs@0.35.0` keeps the `latest` dist-tag until Smithers 1.0.0 is
final. Release candidates publish under `next`.

**Fix.** This is working as intended, and it is why an unattended
`npm install smthrs` cannot break a 0.x project. To reach 1.0, depend on the
packages by name: `@smthrs/flows` for the engine and `@smthrs/cli` for the
command. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/docs/installation.md#install-the-cli).

## `smthrs: command not found` after installing this package

**Symptom.** The package installed, and no `smthrs` executable appeared.

**Cause.** A local install puts this package's `smthrs` and `smithers`
executables in `node_modules/.bin`, not on `PATH`. An install that resolved the
`latest` dist-tag got `smthrs@0.35.0` instead of this package.

**Fix.** Run `npx smthrs@next <verb>`, or install the command line, which owns
both spellings of the executable. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/docs/installation.md#install-the-cli).

## The build succeeded and the notice never printed

**Symptom.** A bundled application still imports `smthrs`, nothing throws, and
the import appears to have vanished from the output.

**Cause.** A bundler that treats the module as side-effect free may drop an
import whose binding is unused, and dropping the import drops the notice. The
manifest declares `sideEffects: true` for exactly this reason, so a bundler
that dropped it was told otherwise by its own configuration.

**Fix.** Take the missing throw as the finding. The import resolves to a
package with no runtime, so remove it and depend on the `@smthrs/*` package
the code actually needs. Check the bundler's side-effect settings for a rule
that overrides package manifests.

## `smthrs migrate` refuses the project

**Symptom.** The command exits without migrating and names 0.x run state, an
unsafe construct, or a project under no version control.

**Cause.** Each is a gate, not a bug: a decision the tool will not make for
you.

**Fix.** The three refusals, the flags that accept each one, and the exit
codes are documented in the [1.0 migration guide](/migration/1.0) and the
[`smthrs migrate`](/cli/migrate) reference. Run-state refusals have no
override: finish, archive, or discard those runs with the 0.x CLI first.
