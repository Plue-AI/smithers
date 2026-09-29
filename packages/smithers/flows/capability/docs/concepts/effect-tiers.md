---
title: "Effect tiers"
description: "What sealed, compensable, and irreversible mean, why only a file write depends on its resource, and how lexical workspace containment decides that case."
sidebar:
  order: 3
---

A decision says whether an operation may happen. A tier says what happens if it
runs twice, or has to be undone. `Capability.tierOf` answers that second
question, and the answer drives two things: what an approval surface tells a
person they are agreeing to, and whether a retry needs an idempotency key.

## The three tiers

| Tier           | Meaning                                                        | Actions                                                                                                                                      |
| -------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `sealed`       | Observes without changing anything, so a repeat costs nothing. | `fs:read`, `net:get`, `model:call`, `memory:read`, `jj:status`, `jj:diff`, `jj:root`                                                         |
| `compensable`  | Changes state the run can undo from its own snapshot.          | `jj:snapshot`, `jj:restore`, `jj:workspace-add`, `jj:workspace-forget`, `jj:revert`, `jj:op-restore`, and an `fs:write` inside the workspace |
| `irreversible` | Leaves the run's reach. Nothing here can undo it.              | `net:post`, `net:private`, `proc:spawn`, `memory:write`, and an `fs:write` that escapes the workspace                                        |

`Capability.requiresIdempotencyKey` reports the one rule derived from the
tier: only `irreversible` effects need a key to retry safely. This includes
`memory:write`: unlike sealed `memory:read`, a retry needs an idempotency key.

```ts
import { Capability } from "@smthrs/capability"

Capability.tierOf(Capability.make("fs:write", "/workspace/out.txt"), { workspaceRoot: "/workspace" })
// "compensable"
Capability.tierOf(Capability.make("fs:write", "/etc/hosts"), { workspaceRoot: "/workspace" })
// "irreversible"
Capability.requiresIdempotencyKey("irreversible")
// true
```

`proc:spawn` is `irreversible` regardless of the command. The package cannot
know what a subprocess did, and a tier that guessed would be worse than one that
admits the operation left the run's reach.

## Why only a write depends on its resource

Every other action's tier follows from the action alone. A file write is the
one operation whose reversibility depends on where it lands: a write inside the
workspace is undone by restoring the workspace snapshot, and a write outside it
is not.

That makes `workspaceRoot` a security-relevant input rather than a convenience.
`Capability.TierOptions` carries it, and there is no default.

## Containment is lexical

`tierOf` decides containment by normalizing `.` and `..` segments in text. It
does not touch the filesystem, so:

- **Symlinks are invisible.** A resource whose first segment is really a
  symlink pointing outside the workspace still classifies as `compensable`. A
  caller that materializes workspace snapshots must resolve real paths before
  classifying a write.
- **Parent traversal is resolved, not trusted.** `a/../../outside` under
  `/workspace` classifies as `irreversible`, because the normalized path leaves
  the root.
- **A relative resource is resolved under the root.** With an absolute root,
  `src/a.ts` means `/workspace/src/a.ts`.
- **The root itself is inside.** `/workspace` under `/workspace` is
  `compensable`, with or without a trailing slash.
- **Text is compared exactly.** No case folding, so `/C:/Work/file` is not
  inside `/c:/work`.
- **Foreign-rooted text is outside.** A resource with a drive letter (`C:`),
  any backslash (`\\host\share\x`, `/workspace\evil`), or a leading `~` is
  never inside the workspace, because another host's resolver or a tilde
  expansion roots it elsewhere. A write to it is `irreversible`.

## A root with no boundary fails closed

A `workspaceRoot` that normalizes to `.` or to the empty string has no lexical
boundary at all, and `tierOf` classifies every write under it as
`irreversible`:

```ts
Capability.tierOf(Capability.make("fs:write", "file.txt"), { workspaceRoot: "." })
// "irreversible"
Capability.tierOf(Capability.make("fs:write", "file.txt"), { workspaceRoot: "work/.." })
// "irreversible"
```

Pass an absolute root. Passing `.` makes every write in the run irreversible,
which usually shows up as an approval prompt for a write that should have been
undoable. A relative root that survives normalization, such as `..`, does work,
but an absolute root is the one that says what you meant.

## Related

- [The authorization model](./authorization-model.md): how a request becomes a
  decision before it is classified.
- [Handle a permission failure](../guides/handle-a-permission-failure.md): the
  tier travels on `PermissionRequired`, which is what an approval surface reads.
