---
title: "Return work from a sandbox"
description: "Capture what a session changed in its checkout with Sandbox.run, journal it as an action's result, and land it on the host as one jj change with SandboxMerge.apply."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sandbox/docs/guides/return-work-from-a-sandbox.md"
---

An agent that edits a repository on a provisioned machine leaves its work in
that machine's checkout. The machine is torn down when its scope closes, so the
work has to leave first, as a value the host can store and apply. This guide
does that in two steps that share one plain JSON value, `Work`:

```text
machine side                                    host side
------------                                    ---------
Sandbox.run(provider, { session }, body)
  acquire session
  resolve base (HEAD)  ----------------+
  run body on the machine              |
  capture: git diff base..tree         |
  release session                      v
       |                        Work = Changed { session, base, patch }
       |                             | Unchanged { session, base }
       +--> action result -------------> journal
                                             |
                                             v
                             SandboxMerge.apply(work, { repository, onto })
                               build commit on base (git plumbing)
                               jj rebase onto `onto`
                               -> Merged | Conflicted | Unchanged
```

`Sandbox.run` knows nothing about how work is merged, and `SandboxMerge.apply`
knows nothing about providers. Either side can run on a different host, after a
crash, or days later.

## Return work from the machine

`Sandbox.run` acquires one session, runs a body with the machine's
`ChildProcessSpawner`, `FileSystem`, `Path`, and `SandboxHealth`, and captures
the checkout before the machine is released. Declare the action's success with
`Sandbox.Sandboxed`, so the journal records the work beside the body's result:

```ts
import { Action } from "@smthrs/flow"
import { RemoteChildProcessSpawner, Sandbox, SandboxMerge } from "@smthrs/sandbox"
import * as Schema from "effect/Schema"

const Implement = Action.make("examples/Implement", {
  payload: { issue: Schema.Number },
  success: Sandbox.Sandboxed(Schema.String),
  error: Schema.Union([Sandbox.CaptureError, RemoteChildProcessSpawner.ProviderError])
})

const Land = Action.make("examples/Land", {
  payload: { issue: Schema.Number, work: Sandbox.Work },
  success: SandboxMerge.Outcome,
  error: SandboxMerge.MergeError
})

const implement = Implement.toLayer(({ issue }) => Sandbox.run(provider, { session: `issue:${issue}` }, agent(issue)))

const land = Land.toLayer(({ issue, work }) =>
  SandboxMerge.apply(work, {
    repository: "/srv/repo",
    onto: "main",
    message: `Fix #${issue}`,
    key: `issue:${issue}`
  })
)
```

`provider` is any `Sandbox.Provider`, and `agent(issue)` is an effect that
edits files through the host services it is given. A flow calls `Implement`,
then passes its `work` to `Land`.

The capture covers committed and uncommitted edits, new files, deletions,
renames, mode changes, and binary files. Files the checkout's `.gitignore`
excludes are not work. The checkout's own index and history are not changed.
A body that fails fails the run, and no work is captured.

## Apply work on the host

`SandboxMerge.apply` applies the patch to its own base, then rebases the result
onto `onto` in the host jj repository. The answer is one of:

| Outcome      | Meaning                                                       |
| ------------ | ------------------------------------------------------------- |
| `Merged`     | one conflict-free jj change on `onto`                         |
| `Conflicted` | one jj change on `onto` with jj conflicts recorded in `paths` |
| `Unchanged`  | the session changed nothing; nothing is applied               |

No working copy is read or written, so the repository can be a checkout other
people are editing. If the base is missing, `apply` runs `jj git fetch` once;
pass `fetch: ["--remote", "upstream"]` to choose a remote, or `fetch: false` to
never fetch.

## Choose a strategy

`apply` always lands the change first. The strategy decides what a conflict
means:

| Strategy                             | On conflict                                                          |
| ------------------------------------ | -------------------------------------------------------------------- |
| `SandboxMerge.recordConflicts`       | Default. Answers `Conflicted`; the change holds jj conflict markers. |
| `SandboxMerge.failOnConflict`        | Abandons the change and fails with `MergeError` reason `conflict`.   |
| `SandboxMerge.resolveWith(resolver)` | Runs `resolver`, then verifies its answer and reports `Merged`.      |

A resolver receives the `Conflicted` outcome and a `Repository` that runs `jj`
in the host repository, and answers `{ change }`, a jj revision holding the
resolution:

```ts
const strategy = SandboxMerge.resolveWith((conflicted, repository) =>
  resolveInWorkspace(conflicted.change, repository.path)
)
```

`resolveWith` accepts the answer only if it names exactly one commit that
descends from `onto` and nothing from `onto` to that commit holds a conflict.
Otherwise it fails with `resolution_rejected` and leaves the conflicted change
as it was.

## Durability

The work is part of the `Implement` action's journaled result. A crash after
the machine is gone loses neither the result nor the patch, and a resumed run
replays `Implement` from the journal without provisioning a machine.

`apply` is idempotent per `key`. The change id derives from the key (default:
the session, base, and patch), so applying twice answers the existing change
and lands nothing new. An apply interrupted between creating the change and
rebasing it finishes on the next attempt. Pass a `key` when a retry of the
machine side can produce a different patch for the same unit of work.

Host application shares the workspace/store fences with snapshots. The default
120-second deadline bounds fence acquisition only; an acquired application runs
to completion unless its caller cancels it. A missing base is fetched before
acquiring the fences and checked again inside them, so slow network fetches do
not block snapshots. Fence failures use `MergeError` reason `vcs_failed` with
the original `JjError` in `cause`, preserving its code and nested `lock_timeout`.

Host adapter imports share pending and successful loads. Rejected imports can
be retried, and cancelling a caller does not poison later applications.

## Requirements

- `git` in the guest.
- The checkout (default `Session.workdir`, or `checkout`) is the top of a git
  work tree. Otherwise `run` fails with `CaptureError` reason
  `not_a_repository`.
- The base is a commit the host has or can fetch.
- `jj` and `git` on the host's `PATH`, and a jj repository at `repository`.

## The base

`base` defaults to `HEAD`, resolved right after the provider hands over the
session. That is the commit the provider checked out, including any refresh it
did during acquisition. In a jj-colocated checkout, `HEAD` is the parent of the
working-copy change.

Never use a change made inside the guest as the base. The host cannot fetch it.
The issue-sweep flow recorded the guest's `@` after a `jj new main@origin`
refresh; that commit existed only in the guest, so every apply failed with
`Revision <id> doesn't exist`. Pass `base` only to name another revision the
host can fetch.

## Prior art

In 0.x, the `<Sandbox>` component's provider returned a `diffBundle`, and
`applyDiffBundle` (`packages/engine/src/effect/diff-bundle.js` at `v0.35.0`)
wrote it into the parent's tree with `git apply`. Commit `2716e98` removed it
with the JSX executor. `SandboxMerge` keeps the provider-neutral diff and lands
it as a jj change, so a conflict is recorded instead of failing the apply or
overwriting files.

## Read next

- [Place a flow body on a machine](/guides/place-a-flow-body-on-a-machine/).
- [Sessions and their keys](/concepts/sessions/).
