---
title: "Capture the work a sandboxed child did"
description: "Turn on captureWork to get the guest's changes as a Sandbox.Work git patch, meet the git repository the workdir must be, and bound the patch."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/docs/guides/collect-a-workspace-diff.md"
---

A sandboxed child that only computes a value needs nothing here: read
`result.output`. This guide is for a child that writes files, where you also
want what it wrote.

## Ask for the work

`captureWork` is off by default, and `result.work` is then `null`. Turn it on
and `result.work` is a `Sandbox.Work`, the same value `Sandbox.run` returns:

- `Changed { session, base, patch }`: `patch` is a
  `git diff --binary --full-index --find-renames` from `base` to the workdir's
  final tree.
- `Unchanged { session, base }`: the guest left the tree at `base`.

```ts
import * as SandboxedFlow from "@smthrs/flows/SandboxedFlow"
import * as Effect from "effect/Effect"

const report = Effect.gen(function*() {
  const result = yield* SandboxedFlow.execute(Writer, { count: 3 }, {
    provider,
    session: "writer-1",
    entry: new URL("./child.ts", import.meta.url),
    captureWork: true
  })

  if (result.work?._tag === "Changed") console.log(result.work.patch)
})
```

The patch covers created, changed, deleted, and renamed files, mode changes,
symbolic links (as links, never their targets), and binary contents. Files the
workdir's `.gitignore` excludes are not work. The protocol's own files under
`.smithers-sandbox/` never appear: that directory carries its own `.gitignore`.

## The workdir must be a git repository

Capture runs `git` in the guest, so the session's workdir must be the top of a
git work tree and `git` must be on the guest's `PATH`. The base is the
workdir's `HEAD`, resolved as soon as the session is acquired and before
anything is written into the workspace. A provider that refreshes its checkout
during acquisition is measured from the commit it refreshed to, never from a
commit the guest made.

A workdir that is not a repository fails with `capture_failed` before the
guest runs:

| Message starts with | Cause                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| `not_a_repository`  | The workdir is not the top of a git work tree, or the guest has no `git`. |
| `base_unresolved`   | `HEAD` names no commit, as in a repository with no commits yet.           |
| `capture_failed`    | `git` failed while diffing.                                               |

A transport failure while running either script is `session_failed`.

This is a deliberate change from the stat snapshot `SandboxedFlow` used to
take, which listed changed files in any directory as path and byte pairs. One
capture contract now serves every sandbox caller, and its patch applies on the
host with `SandboxMerge.apply`.

## The work is data, not an applied change

Nothing on the host is modified. `result.work` is a value you decide what to do
with: land it with `SandboxMerge.apply`, attach it to a review, or throw it
away. A child that fails captures nothing.

## Bound what comes back

Any bound you omit keeps its default. Bounds are inclusive: exactly the
configured byte count is accepted. Byte limits count UTF-8 bytes.

| Bound         | Default | What it caps                     |
| ------------- | ------- | -------------------------------- |
| `resultBytes` | 5 MiB   | The result JSON the guest wrote. |
| `diffBytes`   | 100 MiB | The captured patch.              |

```ts
const bounded = SandboxedFlow.execute(Writer, { count: 3 }, {
  provider,
  session: "writer-1",
  entry,
  captureWork: true,
  limits: { diffBytes: 8 * 1024 * 1024 }
})
```

`SandboxedFlow.defaultLimits` is the resolved default object, readable if you
want to derive from it.

A larger patch fails the execution with `diff_overflow`, and a larger result
fails it with `result_overflow`. `diffBytes` bounds what the result carries
into the journal; the capture reads the whole patch before the bound is
checked. Result readback stops at the byte budget plus one: native filesystem
streams receive a bounded read request, and other providers run `head -c` in
the guest, so the guest image must provide `head` with `-c` support.

## Journal the work

`resultSchema(success)` builds the action's success schema as
`{ output, work, capabilityCeiling }`, and `CapturedWork` is the schema of
`work`. A result journaled without `work` decodes with `null`. The work is
plain tagged JSON, so a sandboxed action's whole result replays out of the
journal unchanged.

That is what makes a sandboxed execution work as
[one durable action](/guides/run-a-child-flow-in-a-sandbox/): a replay hands back
the same work without acquiring a machine.
