---
title: "Troubleshooting"
description: "The typed failures @smthrs/registry reports: every DiscoveryError, RegistryError, and ExecutableError code, what causes it, and what to change."
---

Every failure this package reports is typed and carries a stable `code` and a
`message`. The fields around them differ by family, so each section below opens
with what its failures always carry and what they carry only when the failure
is about a file. Find the code and read the matching section.

The three failure types are `DiscoveryError`, `RegistryError`, and
`ExecutableError`. Each carries a `_tag` prefixed `flows/registry/`, which is
the stable schema identifier a decoder matches on, so
`flows/registry/DiscoveryError` is this package's error and not another
package's.

Non-fatal diagnostics are not here. A scan that survives a bad entry reports a
`DiscoveryWarning` instead, and those are in
[Diagnose a flow that did not appear](./guides/diagnose-a-missing-flow.md).

## DiscoveryError

Raised by `Discovery.scan`, and therefore by any registry layer built over it.
A scan either produces a complete `SourceScan` or fails; there is no partial
scan.

Every `DiscoveryError` carries `module` and `method`, the operation that raised
it, and `path`, the source root the scan was refused at. `cause` carries the
host error when one was raised.

### root_missing

**What happened.** The source root does not exist.

**What to change.** Use `Registry.layerProject` for a project's optional
`flows/` directory, or set `optionalRoot: true` on that source. A missing root
then produces an empty scan on construction and refresh, so flows added later
remain discoverable. Access errors still fail, and declared pack roots stay
required. See [Discover a project's flows](./guides/discover-a-project.md).

### invalid_root

**What happened.** The source root exists and is not a directory.

**What to change.** Point the source at a directory. A file path here is a
configuration mistake, not a tree with no flows in it.

### read_failed

**What happened.** The root could not be accessed, inspected, or listed.
`cause` carries the host error.

**What to change.** Fix the permission, the mount, or the broken link. This is
about the root itself: an unreadable directory found during the walk is a
`unreadable` warning, and the scan continues.

## RegistryError

Raised while constructing a registry, looking one up, loading a body, or
rendering a prompt.

Every `RegistryError` carries `module` and `method`, the operation that raised
it: a `not_found` from `runPrompt` says `runPrompt`, not the `loadBody` it
delegates the body read to. `path` is present when the failure is about a file,
which is every code below except `not_found`, `system_collision`, and
`not_prompt_flow`; those are about a name the snapshot does not hold, and there
is no file to name.

### not_found

**What happened.** `get`, `loadBody`, or `runPrompt` named a flow the snapshot
does not hold.

**What to change.** Check the name against `list()`. A path-named source names
a flow by its directory path below the root, so `flows/deploy/status/flow.ts`
is `deploy/status`, not `status`. If the file was added after the registry was
built, call `refresh()`. Use `getOption` where absence is an ordinary answer
rather than a failure.

### system_collision

**What happened.** A flow name is claimed by both a source declared
`system: true` and another source, in either direction. Construction fails
rather than resolving it silently.

**What to change.** Rename the project flow, or stop declaring the source as a
system source. Ordinary sources resolve a shared name first-found with a
`duplicate_name` warning; the system rule exists precisely so that a system
name is never quietly shadowed and never quietly shadows.

### body_unavailable

**What happened.** One of two things:

- The body file could not be read at the path the descriptor records.
- The file was read and its SHA-256 did not match the digest discovery
  recorded, so the body changed after the scan.

**What to change.** For a missing file, check whether the flow was moved or
deleted since the registry was built. For a changed file, call `refresh()`:
that is what adopts the new bytes. The check is not defensive noise. A body
that no longer matches its declaration is a flow whose capabilities, effects,
and description the catalog now describes wrongly, and running it would run
something nobody admitted.

`Executable.fromDescriptor` raises the same condition as
`ExecutableError { code: "body_unavailable" }`.

### not_prompt_flow

**What happened.** `runPrompt` named a module-backed flow. Only a markdown body
renders as a prompt.

**What to change.** Use `loadBody`, which answers `FlowBodyModule` with the
module path, and run the module through `Executable`. Branch on
`descriptor.body._tag` when the caller does not know which kind it has.

### invalid_pack

**What happened.** One of three things:

- A `pack.json` is missing, is not valid JSON, or does not decode as a
  manifest.
- A manifest names a `flows` or `skills` entry that is not a safe
  pack-relative path, or one that resolves outside the pack root.
- A pack declares a source directory that could not be scanned.

**What to change.** The message names the pack and the offending entry. A path
must be relative, with no empty, `.`, or `..` segment, no NUL byte, no
backslash, no leading `/`, and no drive prefix, and its real path must stay
inside the pack root. A declared directory the pack does not ship is a broken
installation: reinstall the pack. See
[Load workflow packs](./guides/load-packs.md).

### incompatible_pack

**What happened.** A pack's `requires.smithers` range is readable and this
runtime does not satisfy it. The check runs before anything is scanned.

**What to change.** Upgrade the runtime, or install a pack version that
supports it. The message names the pack, the range, and the runtime version it
was checked against. Prerelease suffixes are ignored on both sides, so a
`1.0.0-rc.4` runtime does satisfy a range written against `1.0.0`; if you are
seeing this on a release candidate, the range genuinely excludes this line.

### unreadable_pack_range

**What happened.** A pack's `requires.smithers` range is in a dialect this
parser does not read. `x` components and `||` unions are the usual causes.

**What to change.** Rewrite the range in the supported grammar: `*`, an
inclusive hyphen range, or whitespace-separated bare, `=`, `>=`, `>`, `<=`,
`<`, `^`, and `~` comparators. This is a separate code from
`incompatible_pack` on purpose, so an operator can tell an unparseable
declaration from a pack that genuinely needs a newer runtime.

## ExecutableError

Raised while making one descriptor runnable, before the flow exists. It carries
`flow`, the descriptor's name, and `available`, the delegates the host has
registered. `delegate` is present when the refusal is about one named delegate,
and `path` when it is about the descriptor's file. This family has no `module`
or `method`: `flow` is what identifies the refusal, and every one of them is
raised by the same bridge.

### missing_delegate

**What happened.** The descriptor delegates to a flow name no registered flow
provides. `delegate` names it and `available` lists what is registered.

**What to change.** Register a flow under that tag, or fix the `flows:`
declaration. A descriptor that names no flow delegates to
`Executable.defaultAgent` (`"agent"`), so a host with no agent driver sees this
for every model-backed skill; register one, or rename the fallback with
`Options.agent`.

This is raised deliberately before the body is loaded. A flow whose delegate
nobody registered is not runnable on this host whatever its body says, and
refusing at dispatch instead would surface an empty `AnyOf` issue naming
nothing.

### ambiguous_delegate

**What happened.** The descriptor names several flows and declares no `model`,
so there is nothing to choose between them.

**What to change.** Declare a `model`, which makes the several names a list of
what the model may call and routes the flow to the agent driver, or name one
flow. The bridge refuses rather than guessing which of several is the runner.

### body_unavailable

**What happened.** The body file could not be read, or its bytes no longer
match the digest discovery recorded.

**What to change.** The same as the registry code of that name: refresh the
registry to adopt an edited body, or restore the file.

### invalid_layer

A module exports `layer`, but the value is not an Effect `Layer`, or it exports
a replacement `Action.Implementations` table. Export
`Declared.toLayer(...)`, `AgentAction.layer`, or their `Layer.mergeAll(...)`
composition directly; the host supplies the action table.

### missing_service

The exported module layer asks for a service that this host does not provide.
The refusal's `service` field names its Effect key. Provide that dependency
inside the exported layer or select a host that supplies it. A direct
`Executable.fromDescriptor` call with an exported layer also requires a scoped
host context with `FlowRuntime` already provided.

### layer_failed

The exported module layer failed during construction. Read the cause and fix
its initialization. No action handler is executed to validate the layer.

### invalid_module

**What happened.** The module at the descriptor's path loaded and its default
export is not a `Flow.make` value.

**What to change.** Default-export the flow. A module flow's entry file is read
without evaluation during discovery and imported for real here, so a file whose
metadata parses can still fail this check.

## The catalog reports instead of raising

`Executable.catalog` and `Executable.layer` collect every `ExecutableError`
into `Catalog.refused` rather than failing. `flows/` is a directory a person
edits, so one file in it is routinely mid-edit or wrong, and failing the
catalog would take every command that touches the catalog down with it,
including the ones that only list flows.
`Executable.layer` also logs a warning for each refusal and provides the whole
`Catalog` as a service, so a host can print what it declined instead of letting
an operator discover it from a launch that fails inside the runtime.

`Executable.fromDescriptor` and `fromRegistry` do raise, because a caller
asking for one named flow should be told why it will not run.
