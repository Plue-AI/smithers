---
title: "Load workflow packs"
description: "Scan a set of installed packs into one registry: the pack.json manifest, the path confinement rules, the content address a lock file records, the compatibility grammar, and the precedence that decides a shared name."
sidebar:
  order: 6
---

A pack is a directory with a `pack.json` manifest: the shareable unit a project
installs rather than copies. `Discovery` already answers "what flows are in
this directory", so a pack adds the three things a shareable directory needs
and a bare directory cannot carry: a name and version so a descriptor can say
where it came from, a content address so a lock file can pin exactly the bytes
that were installed, and a compatibility range so a pack written against a
newer runtime is refused at load rather than halfway through a run.

## The manifest

```json
{
  "name": "review-pack",
  "version": "1.2.0",
  "flows": ["flows"],
  "skills": ["skills"],
  "requires": { "smithers": ">=1.0.0" }
}
```

`flows` and `skills` are directory paths relative to the pack root, each
scanned exactly the way an ordinary registry source is. They are paths rather
than flow names on purpose: a manifest listing names would need re-editing
whenever a flow was added, and the pack digest would then not change when one
was.

`Pack.read(fs, path, dir)` decodes it and returns the manifest, the directory,
and any `unknown_pack_key` warnings. A manifest that is missing, unparseable,
or incomplete fails `RegistryError { code: "invalid_pack" }` rather than
half-loading, because the manifest is what names the pack in every descriptor's
provenance. The unknown-key warnings matter: a misspelled `requires` would
otherwise disable the compatibility gate in silence. Spread that result into an
`Installed` and add `origin`, and the registry reports them from
`warnings()` beside every scan warning the pack produced.

## Scan a set of packs

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import * as Layer from "effect/Layer"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const discovery = Discovery.layer.pipe(Layer.provide(platform))

const registry = Registry.layerFromPacks(
  [
    { manifest: projectManifest, dir: "/repo/.flows/review-pack", origin: "local" },
    { manifest: vendoredManifest, dir: "/repo/node_modules/review-pack", origin: "installed" }
  ],
  { runtimeVersion: "1.0.0" }
).pipe(Layer.provide([discovery, platform]))
```

`runtimeVersion` is required rather than optional because it is the only thing
`requires.smithers` can be checked against. An optional field would silently
skip the check for every caller that forgot it, which is the one failure mode a
compatibility range exists to prevent.

Every descriptor a pack contributes carries `provenance.pack` with the pack
name, version, and origin, so a catalog entry says where it came from.

To scan a project's own flows and its packs together, pass both to
`Registry.layer`, or use `Registry.layerProject({ root, packs })`, which is
that composition. A project source is scanned first, so a project flow shadows
a pack flow of the same name and reports it as `duplicate_name`.

## Precedence is the origin, not the list order

Packs do not merge first-found. Every `local` pack outranks every `installed`
one, so a project pack shadows a vendored flow of the same name wherever the
host happened to list it. An ordered source list cannot express that: it merges
first-found, so an installed source listed first would win a name the project
defines.

The loser is reported, not dropped: a `DiscoveryWarning { code: "shadowed" }`
naming both packs and versions, read back through `registry.warnings()`.

`local` is a pack the project owns, checked in or linked into the working tree.
`installed` is one a package manager put there.

## Compatibility is checked before anything is scanned

Every pack's `requires.smithers` is checked before the first directory is
walked, so a pack written against a newer runtime fails at load rather than at
the first call into one of its flows, and not after the directories of an
earlier pack have already been read.

The grammar is `*`, an inclusive hyphen range (`1.0.0 - 2.0.0`), and
whitespace-separated conjunctions of bare, `=`, `>=`, `>`, `<=`, `<`, `^`, and
`~` comparators. Whitespace may separate an operator from its version, and a
version with one or two components is zero-filled, so `>= 1.0.0`, `>=1.0`, and
`^1` all read.

`^` and `~` read the way npm reads them:

| Range    | Accepts | Refuses |
| -------- | ------- | ------- |
| `^1.2.0` | `1.9.0` | `2.0.0` |
| `^0.2.3` | `0.2.9` | `0.9.0` |
| `^0.0.3` | `0.0.3` | `0.0.4` |
| `~1.2.0` | `1.2.9` | `1.3.0` |

`x` components and `||` unions are not read. A range the parser cannot read is
refused rather than assumed compatible, and it is refused as its own
`RegistryError { code: "unreadable_pack_range" }`, so an operator can tell a
dialect this runtime cannot parse from a pack that genuinely needs a newer one.
A readable but unsatisfied range is `incompatible_pack`.

Prerelease and build suffixes are ignored on both sides, so a `1.0.0-rc.4`
runtime satisfies a range written against `1.0.0`. A pack's compatibility
question is about the release line, and comparing the prerelease tag as well
would refuse every release candidate from a range written against its own
release.

`Pack.compatible(range, runtimeVersion)` is the same check as a predicate, and
`Pack.checkCompatible(pack, path, runtimeVersion)` is the effect that fails naming
the pack, its range, and the runtime.

## A pack contributes only from inside itself

A pack is third-party content, so this module holds exactly one piece of
filesystem policy: source roots, descended directories, and selected entry
files stay inside the pack root when the host can resolve their real paths.

| Rule                                                                                                                                    | Where it is enforced                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A manifest entry is a relative path with no empty, `.`, or `..` segment, no NUL byte, no backslash, no leading `/`, and no drive prefix | `Pack.read`, as a decode refusal that fails `invalid_pack` naming the offending entry                                                       |
| A resolved entry stays under the resolved pack root                                                                                     | `Pack.sources`, so a directly constructed `Installed` value is checked too                                                                  |
| A manifest source root's real path stays under the pack root's real path                                                                | `Pack.sources`, wherever the host can answer `realPath`, so a symlinked escape is refused alongside a lexical one                           |
| Every descended directory and selected entry file stays under the pack root's real path                                                 | `Discovery.scan`, using `Source.confinementRoot` from `Pack.sources`; escapes are skipped with `outside_root` before reading their contents |

The check is repeated in `Pack.sources` because callers may construct an
`Installed` value without decoding a manifest first. Nested directory links
and symlinked `flow.ts`, `flow.mdx`, and `SKILL.md` files are checked, so an
outside target contributes no descriptor for body loading or executable
catalog import. Links within the pack remain eligible. Once the pack root's
real path resolves, a target whose real path cannot be resolved is refused as
well; hosts that cannot resolve the pack root retain lexical manifest
validation. These checks apply during discovery. They do not sandbox module
imports or protect against concurrent filesystem changes.

## The content address

`Pack.digest(manifest, files)` is what a lock file records:

```ts
import * as Pack from "@smthrs/registry/Pack"

const address = Pack.digest(manifest, [
  { path: "flows/review/flow.mdx", contents: reviewSource },
  { path: "pack.json", contents: manifestSource }
])
```

It covers the manifest and every measured file by its own content hash under a
validated pack-relative path. Entries are ordered by path and then by content
digest, so reading the same bytes in a different order produces the same
digest, and editing one flow body changes it. Duplicate paths are retained
rather than collapsed. An unsafe path throws a `TypeError`.

File contents are UTF-8 text. Measuring binary resources is outside this
contract, and measuring the files at all is the caller's job.

## What is not in this package

The `pack add`, `remove`, `list`, `update`, and `eject` verbs are CLI surface.
This module is the runtime contract underneath them: manifests, confinement,
addressing, compatibility, and merge order.
