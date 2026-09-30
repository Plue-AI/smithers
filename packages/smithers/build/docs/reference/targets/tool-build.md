---
title: "ToolBuild"
description: "Runs one arbitrary build command for Rust, Zig, native addons, or any other toolchain. The deliberate escape hatch."
---

Runs one arbitrary command for Rust, Zig, native addons, or any other toolchain.
This is the deliberate escape hatch.

```ts
import { Smithers } from "@smthrs/targets"

const nativeLib = Smithers.ToolBuild({
  tool: "cargo",
  command: "cargo",
  args: ["build", "--release"],
  inputs: [Smithers.glob("src/**/*.rs"), Smithers.glob("Cargo.toml")],
  outputs: ["target/release"],
  deps: [],
  env: { CARGO_TERM_COLOR: "never" },
  cache: true,
  cwd: "packages/native"
})

export const Package = Smithers.Package({
  targets: { nativeLib }
})
```

## Attributes

| Name      | Type                     | Default  | Description                                                                                |
| --------- | ------------------------ | -------- | ------------------------------------------------------------------------------------------ |
| `tool`    | `string`                 | required | A name for the toolchain. Key material only; it does not reach argv.                       |
| `command` | `string`                 | required | The executable. Spawned directly, not through the package manager and not through a shell. |
| `args`    | `Array<string>`          | required | Arguments passed after the executable.                                                     |
| `inputs`  | `Array<Input.Declared>`  | required | Input declarations digested as key material.                                               |
| `outputs` | `Array<string>`          | required | Output paths, relative to `cwd`, digested after the run.                                   |
| `deps`    | `Array<Target.Target>`   | required | Dependency targets.                                                                        |
| `env`     | `Record<string, string>` | required | Environment merged over the host `process.env`.                                            |
| `cache`   | `boolean`                | required | Whether a green result is stored.                                                          |
| `cwd`     | `string`                 | `"."`    | Workspace-relative directory the command runs in.                                          |

## Command

```text
<command> <args...>
```

Then the shared output-capture step over `outputs`, sequenced behind the build
so the outputs are digested only after the tool has produced them.

## Inputs

Collected from the attrs: every declaration in `inputs`.

## Outputs

Success is `Outputs`:

```ts
{
  outputs: Array<{ path: string; fileCount: number; contentDigest: string }>
}
```

Each declared path is walked by the `CaptureOutputs` action. A directory
contributes every file beneath it and a plain file contributes itself. File
lists are sorted posix-relative paths with their content digests, so an
unchanged tree digests identically on every host.

Every declared output is required, as it is in Bazel. A command that exits zero
without creating one of them fails the target with an `OutputError` naming the
declaration, and nothing is stored in the cache. An empty directory is a valid
output and digests to zero files; a missing path is not an output at all.

With `cache: true`, a green run also stores every declared output in the local
artifact store, so a later hit restores deleted or changed outputs without
running the command. See [Caching](../../workspace/caching.md).

Capture never leaves the workspace. A declared path that resolves outside it, a
declared path that is a symbolic link, a link found anywhere beneath a declared
directory, and a path that is neither a plain file nor a directory each fail the
target instead of digesting content the workspace does not own.

### What a declaration may name

A declared path is checked where it is written, so a PACKAGE.ts that cannot name
an in-workspace output fails to load rather than failing at every execution. The
same check runs again at execution, because the paths also arrive through an
action payload and a cache entry. Refused:

- An absolute path, a path containing `..`, and an empty path.
- `.`, `./`, and any spelling that names the declaring directory rather than an
  output below it.
- Anything under `.flows` or `.git`. The cache directory is the result store: an
  output digested out of it would have a cache admission verify a stored entry
  against a copy of itself.
- Two declarations that resolve to the same output. `dist` and `./dist` collide.
- A declaration already covered by another. `dist` and `dist/index.js` would put
  one file in the manifest twice, under two digests that no longer have to
  agree. `dist` and `dist-types` are siblings and are fine.

### What capture bounds

File contents are not capped. An artifact may be any size and streams through
one fixed buffer, so a one-gigabyte output costs a fixed amount of heap. The
tree's metadata is what carries ceilings, because the manifest is held in memory
before it is digested: at most 200,000 files, 64 directories of nesting, 4096
bytes per relative path, and 8 MiB of relative paths in total. Passing any of
them fails the whole output. Capture never returns a truncated manifest.

Two names in one tree that differ only by Unicode normal form are refused rather
than digested, because they address one file on a normalizing filesystem and two
files elsewhere, and the manifest cannot record which.

### What capture cannot promise

Node exposes no `openat` and no way to read a directory through a descriptor
already proven to be the right one, so a traversal capability cannot be held
across syscalls. Instead an identity is observed for every directory and file
when its parent lists it, and re-checked at every later step: before a
directory's entries are read, after they are read, on the descriptor a file is
opened through, and again after that file has been read. A file is opened with
`O_NOFOLLOW` and `O_NONBLOCK` where the platform has them, so a symbolic link
swapped in after the listing is refused by the kernel and a FIFO swapped in the
same way cannot block the open; the descriptor's own `fstat` then refuses any
file that is not regular.

A path replaced inside one of those windows fails the whole output rather than
publishing a manifest assembled from two different trees. The window that stays
open is between the last check and the syscall it guards, and for an
intermediate directory it cannot be closed. This is not race freedom, and no
portable Node API can provide it.

The same `Output`, `Outputs`, and `captureOutputs` exports are used by
[TsBuild](ts-build.md) and [DtsBuild](dts-build.md).

## Channels

| Channel | Type                                           |
| ------- | ---------------------------------------------- |
| Success | `Outputs`                                      |
| Error   | `BuildError` (`Exec.ExecError \| OutputError`) |

## Key material

`capabilities` for this target is `["proc:spawn"]`, not the default
`["fs:read", "proc:spawn"]`.

## Status

|           |                         |
| --------- | ----------------------- |
| Kinds     | `build`                 |
| Cacheable | The `cache` attribute   |
| Executes  | Yes, through `ExecLive` |

## Notes

`env` is key material, so a value that varies per host or per run makes the
target re-key every time. Keep it to deterministic settings.

## See also

- [TsBuild](ts-build.md)
- [Dev](dev.md) for a long-lived process
- [Writing target definitions](../../extending/writing-targets.md)
