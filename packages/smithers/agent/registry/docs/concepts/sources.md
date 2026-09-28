---
title: "Sources and naming"
description: "What a discovery source is, how one directory becomes one flow, the difference between path-derived and frontmatter names, and the rules that decide a collision."
sidebar:
  order: 2
---

A source is one directory root plus the rules for reading it:

```ts
interface Source {
  readonly source: string
  readonly root: string
  readonly naming: "path" | "frontmatter"
  readonly system?: boolean | undefined
  readonly confinementRoot?: string | undefined
}
```

`source` is opaque caller-supplied metadata. Discovery never interprets it; it
copies the string onto every descriptor's `provenance`, so a catalog entry can
say which source produced it. The `smthrs` CLI uses `project` for a project's
own flows and `pack:<name>` for the flows a pack contributed.

## One directory, one flow

The scan walks the root and, in each directory, looks for one entry file. Three
names are recognized, in this order of precedence:

| File       | What it is                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `flow.ts`  | A module flow. Its metadata is parsed out of the default `Flow.make` value without evaluating the module. |
| `flow.mdx` | A markdown flow. Its metadata is the YAML frontmatter.                                                    |
| `SKILL.md` | The Agent Skills spelling of a markdown flow.                                                             |

A directory holding more than one of them uses the first and reports
`multiple_entry_files`. Directories named `.git` and `node_modules`, and any
directory whose name starts with a dot, are skipped. At the root of a
path-named source, `channels` and `connections` are skipped too, because those
are the host's own directories rather than flows.

Nothing stops a directory from holding both an entry file and further
subdirectories: `flows/review/flow.mdx` and `flows/review/read-pr/flow.ts` are
two flows, `review` and `review/read-pr`.

## Two ways a flow gets its name

`naming: "path"` derives the name from the directory segments below the root,
joined with `/`. This is the mode a project uses, and it makes the name a fact
about the tree rather than about a file's contents: `flows/deploy/status/flow.ts`
is the flow `deploy/status`. A `name` key in the file is ignored, and the scan
says so with `name_field_ignored` rather than letting an author believe the key
took effect. An entry file directly in the root has no segments to name it, so
it is refused with `root_level_entry`.

`naming: "frontmatter"` reads the `name` key out of the file, which is how a
foreign Agent Skills directory is scanned. The name must be 1 to 64 lowercase
ASCII letters, numbers, or single hyphens with no edge hyphens. An absent name
falls back to the directory name and reports `missing_name`. A blank or
non-string value falls back to the directory name and reports `invalid_name`.
A nonempty string is trimmed and retained, even if it violates the grammar or
64-character limit; those violations report `invalid_name`. Any retained name
that differs from its directory also reports `directory_name_mismatch`.

Look up the descriptor by its retained name. For example, `name: Review--PR` in
`review/SKILL.md` registers `Review--PR`, not `review`, and reports both
`invalid_name` and `directory_name_mismatch`.

## Ordered sources and the first-found rule

`Registry.layer` takes sources in caller order and scans them in that order.
The canonical order is system, project, plugin, then foreign sources. The first
descriptor to claim a name keeps it; a later one of the same name is dropped
and reported as a `duplicate_name` warning naming the file that won.

One collision is not a warning. A source declared `system: true` owns its
names outright, so a name that collides with a system source fails
construction with `RegistryError { code: "system_collision" }` in either
direction. A project cannot shadow a system flow, and a system source cannot
quietly take a name a project already used.

Packs merge under a different rule, because caller order is the wrong authority
for a set of installed directories. See [Load workflow packs](../guides/load-packs.md).

## The snapshot and refresh

A registry holds one snapshot. Reads are atomic per operation: each observes
one complete snapshot. A successful `refresh` between calls can replace or
remove a listed descriptor, so a later `get` may return a different descriptor
or fail with `not_found`. Retain the descriptors returned by `list` when you
need that catalog's values. Retaining them does not pin later registry calls
or filesystem contents. Cross-call consistency would require adding an
explicit snapshot handle to the API; none is currently exposed.

`refresh` rescans every configured source and replaces the snapshot only after
all of them succeed. A failed rescan leaves the previous complete snapshot
serving reads.

## Walking a real tree safely

Discovery follows symbolic links wherever the host `FileSystem.stat` does,
which is what the ordinary Node file system does. `Pack.sources` sets
`confinementRoot` to the pack root. When the host resolves that root's real
path, discovery skips a source root, descended directory, or selected entry
file whose real path is outside the root or cannot be resolved (a dangling,
looping, or unreadable link) with `outside_root`, before reading its contents. Links
within the pack remain eligible, including links outside the declared source
directory but inside the pack. Ordinary project sources leave `confinementRoot`
unset and retain unrestricted symlink traversal. Hosts that cannot resolve the
confinement root retain lexical manifest validation.

Two guards bound the walk:

- A visited-directory identity set, keyed on device and inode, refuses to
  descend into a directory already visited and reports `symlink_cycle`.
- A ceiling of `Discovery.maximumTraversalDepth` (32) entry-name segments
  reports `max_depth_exceeded` and stops. The entry-name path is the flow name,
  so a deeper tree is a loop or a mistake.

Without them a single `flows/a/b/loop -> flows` link yields one flow many times
over and terminates only when the operating system raises `ELOOP`.

Two more ceilings bound what one file can cost:

| Ceiling                    | Value  | What it bounds                                                                                                                                                                                                        |
| -------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Discovery.entrySizeLimit` | 4 MiB  | The size of an entry file discovery admits. A larger file is skipped with `entry_too_large` and contributes no descriptor, so a stray build artifact under `flows/` cannot exhaust the process at layer construction. |
| The metadata parse ceiling | 64 KiB | How much of an admitted file is decoded and parsed looking for frontmatter or module metadata. It bounds parsing only.                                                                                                |

The size ceiling is checked twice, because the first check trusts the host. A
`stat` size past the limit skips the file unread, which is the fast path an
ordinary file system takes. The bytes actually read are then measured against
the same limit, so a host whose `stat` under-reports or omits a size still gets
`entry_too_large` with the true byte count, and the entry is refused before it
is hashed, decoded, or parsed. An in-memory or remote `FileSystem` and a
special file are the hosts that need it.

## Reading it back

- [Discover a project's flows](../guides/discover-a-project.md): the task, with
  the layers written out.
- [Diagnose a flow that did not appear](../guides/diagnose-a-missing-flow.md):
  every warning code named here, and what to do about it.
