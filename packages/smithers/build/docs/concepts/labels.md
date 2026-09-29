---
title: "Labels"
description: "The //package:target label grammar, package default targets, relative :target labels, and recursive //... patterns."
---

A label identifies one target. It combines a `PACKAGE.ts` file's path with a key
in its exported `Package.targets` map.

```text
//packages/greeter:lib
  ^^^^^^^^^^^^^ ^^^
  package path  target name
```

The package path is the `PACKAGE.ts` file's directory relative to the workspace
root, in posix form. The target name is the map key.

```ts
// packages/greeter/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"

const lib = S.Filegroup({ srcs: [S.file("src/index.ts")] })
export const Package = S.Package({ targets: { lib } })
```

## Grammar

| Form                | Meaning                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `//pkg/path:target` | The `Package.targets` key `target` at `pkg/path`                          |
| `//pkg/path`        | The default target of the package at `pkg/path`                           |
| `//`                | The default target of the root package                                    |
| `//...`             | Every target in the workspace                                             |
| `//pkg/path/...`    | Every target in the subtree rooted at `pkg/path`                          |
| `:target`           | The `Package.targets` key in the package containing the current directory |

A label must start with `//` or `:`. Anything else fails with
`label must start with // or :`.

## Package path normalization

Backslashes become forward slashes. Leading and trailing slashes are stripped. An
empty path and `.` both mean the workspace root. A path containing an empty, `.`,
or `..` segment fails with `invalid package path`.

```text
//packages/greeter      -> packages/greeter
//packages/greeter/     -> packages/greeter
//                   -> (root)
//packages/../flow   -> error
```

## Relative labels

A bare `:target` resolves in the package containing the current working
directory, computed relative to the workspace root.

```sh
cd packages/greeter
smithers-build test :test    # //packages/greeter:test
```

If the current directory is outside the workspace, or `--workspace` points
elsewhere, the current package falls back to the workspace root. A directory that
is genuinely outside the workspace fails with
`current directory is outside workspace`.

A `:target` label with a second colon fails with `invalid target label`. A `//`
label with a second colon fails the same way, and `//pkg:` with an empty name
fails with `target name is empty`.

## Package defaults

`//pkg` with no target selects the package's default. The workspace tries, in
order:

1. `lib`
2. `nodeModules`
3. The package directory's basename
4. `default`

If none of those exist and the package maps exactly one target, that target is
the default. Otherwise the label fails with
`package //<path> has no unambiguous default target`.

The root install target is conventionally named `nodeModules`, which is why `//`
resolves to it in a workspace that follows the convention.

## Recursive patterns

`//...` and `//pkg/...` select targets rather than one target. They load every
`PACKAGE.ts` in the selected subtree and return every target in their `Package` maps,
plus every target synthesized by a matching default target for a directory in the
subtree without its own `PACKAGE.ts`.

The prefix is a path prefix, not a glob. `//packages/...` selects
`packages/greeter`, `packages/greeter/internal`, and every other package beneath
`packages/`.

Recursive patterns are tolerant. A pattern that matches no target for a verb
plans an empty graph. An exact label that does not participate in the verb is an
error, because you named it deliberately.

## Where labels do not appear

Labels never appear in target attributes. A dependency is a direct import of
another `PACKAGE.ts` file's `Package` map, and the selected target value is placed
in the attrs. The planner derives the label afterwards, from the map key.

```ts
import { Smithers as S } from "@smthrs/targets"
import { Package as plan } from "../plan/PACKAGE.ts"

const lib = S.TsBuild({ deps: [plan.lib] /* ... */ })
export const Package = S.Package({ targets: { lib } })
```

See [Dependencies](dependencies.md).

## Label derivation

Deriving a label from a target value has two paths.

- The target was already indexed, because its `PACKAGE.ts` was loaded. The label
  comes from the index.
- The target was reached through a direct import and its module was never loaded
  as a package. The target call recorded its own `PACKAGE.ts` call-site path from the
  stack at construction time. The workspace loads that module and looks again.

If neither path resolves, the command fails with
`could not derive a label for <target>; export it from a PACKAGE.ts file`. The fix is
to register the target in the `Package.targets` map: a target absent from every
map has no label.

How a target learns its own source path, today by reading the construction
stack, is an open design question.

## Next

- [Target definitions and targets](targets.md)
- [Querying](../workspace/querying.md)
