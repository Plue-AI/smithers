---
title: "Troubleshooting"
description: "Every typed refusal NodeRuntime and SandboxedFlow raise, plus the capability denials and replay surprises a host meets first: the symptom, what caused it, and what to change."
---

Every failure these two modules report is typed, and most of them are a decision
the host made, stated back plainly. Find the tag or the code and read the
matching section. The full schemas are in the [API reference](./api.md).

## RuntimeConfigurationError

**Symptom.** `layer`, `make`, `layerHost`, or `storage` throws before opening
anything. The error carries `code: "invalid_runtime_configuration"`, a `field`
naming the option that was wrong, and a message.

**Cause.** Validation is eager: the composition is built when the function is
called, so a bad option fails at wiring time rather than at some arbitrary later
scope. `field` exists so an embedder can tell an empty `filename` from an empty
`owner.hostId` without reading prose.

| `field`             | What it refuses                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `filename`          | An empty or non-string SQLite filename.                                                  |
| `workspaceRoot`     | An empty or non-string workspace root, including `storage`'s second argument.            |
| `owner.hostId`      | An empty or non-string host id, or an `options.owner` that is omitted or `null`.         |
| `isAlive`           | An `isAlive` that is not a function. A function is the one option a schema cannot check. |
| `signals`           | A `signals` value that is not an array, or a name that cannot be installed.              |
| `shutdownTimeoutMs` | Anything that is not a safe integer from 0 through 2,147,483,647.                        |
| `rules`             | A `rules` value that is not an array, or a policy list whose members are not arrays.     |

**Fix.** Correct the named field. Note that nothing was created: a refused
configuration never opens a database, and a refused signal list never installs a
listener.

## NodeRuntime cannot install signal SIGKILL

**Symptom.** A `RuntimeConfigurationError` on `signals` naming the signal.

**Cause.** `SIGKILL` and `SIGSTOP` cannot be caught, and an unknown name is not
a signal at all. Both are refused before the first listener is installed, so you
never get a half-installed handler set.

**Fix.** Name catchable signals, or pass `signals: []` and wire your own. See
[Shut a host down](./guides/shut-a-host-down.md).

## PermissionRequired: an action was refused with no rule to point at

**Symptom.** An action that reads a file or spawns a process fails with
`@smthrs/capability/PermissionRequired`, code `permission_required`, carrying
the exact capability it asked for.

**Cause.** `layerHost` builds its grant store unattended: there is no operator
to prompt, so a capability that no rule allows or denies cannot be escalated,
and the store refuses it immediately. The default decision is neither allow nor
deny; it is "ask", and there is nobody to ask.

**Fix.** Add a rule to `HostOptions.rules` that allows the capability the error
names, scoped as narrowly as the work needs:

```ts
import { Capability } from "@smthrs/flows"

const rules = [
  new Capability.Permission.Rule({
    effect: "allow",
    pattern: new Capability.Capability.CapabilityPattern({
      action: "fs:read",
      resource: `${workspaceRoot}/**`
    })
  })
]
```

## PermissionDenied: a rule refused it on purpose

**Symptom.** `@smthrs/capability/PermissionDenied`, code `permission_denied`,
with a reason of `denied by permission policy`.

**Cause.** A rule matched and its effect was `deny`. This is different from the
previous case: policy answered, and the answer was no.

**Fix.** If the denial is wrong, change the rule. Note the asymmetry when
`rules` is a list of rulesets rather than a flat list: `rulesets[0]` is the
configured policy and its effective denial is a hard veto, while every later
ruleset is applied last-match-wins. An allow in a later ruleset cannot lift a
deny in the first one.

## The engine takes snapshots even though I denied jj

**Symptom.** A compensable action still records a Jujutsu pre-image after
`jj:*` was denied to actions.

**Cause.** This is intended. Engine snapshot bookkeeping uses a private `Jj`
service, and `HostOptions.rules` governs only action-facing authority. An action
that asks for `Jj` directly is still refused; the engine's own bookkeeping is
not routed through the action's grants.

**Fix.** Nothing to change. If you need the engine to stop snapshotting, that is
a tier decision on the action, not a capability rule.

## The run returned a stale value

**Symptom.** A second run over the same database returns the previous answer,
and the action's implementation never ran.

**Cause.** `executionId` names one execution. A completed execution is answered
from the journal, which is the whole point of durability: a restart resumes
instead of repeating.

**Fix.** Use a new `executionId` for a new execution. Reuse it when you mean a
resume.

## queue_overflow: the journal admission queue is full

**Symptom.** A journal write fails with `queue_overflow`.

**Cause.** The runtime's journal queue has capacity 1,024 and rejects overflow
rather than dropping events. Dropping would make a later replay wrong, so the
write fails loudly instead.

**Fix.** Reduce the write rate, or compose the journal yourself through
[`@smthrs/journal`](/api/journal) with different capacity and overflow settings,
using `NodeRuntime.storage` or `layer` as the seam.

## SandboxedFlowError

Every sandboxed refusal is one error class with a `code` that names it, and a
message that quotes the guest's stdout and stderr where they help. The tail of
each stream is quoted, cut at 4 KiB and marked when it was cut.

| `code`              | What happened                                                                                                         | What to change                                                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bundle_failed`     | esbuild could not bundle the `entry` module.                                                                          | Check that `entry` is a `file:` URL or an absolute path to a real module, and that its imports resolve. A remote URL is not a valid entry.                                                             |
| `session_failed`    | The provider could not acquire the machine, or a file or process operation on it failed.                              | Read the message: it names which operation, whether it was writing the bundle, writing the request, spawning the runtime, reading the result back, listing the workspace, or reading one changed file. |
| `guest_failed`      | The guest runtime exited non-zero. Exit 126 or 127 means the image has no runnable runtime, and the message names it. | Put `node` 22 or later, or `bun`, on the guest's `PATH`. Nothing is installed for you. For any other non-zero exit, read the quoted stderr.                                                            |
| `flow_failed`       | The child flow ran and reported a failure, or the entry exports no flow with the requested tag.                       | The message carries the child's error as its tag and fields, not a stack trace. An "exports no flow tagged" message means the entry module does not export the flow you passed.                        |
| `result_unreadable` | The guest exited 0 but wrote no result, or wrote something that is not the protocol's JSON.                           | Usually the runtime ran something other than the bundle. Check the `runtime` command line and the quoted stdout.                                                                                       |
| `result_invalid`    | The guest's `output` does not decode through the flow's success schema.                                               | The host's declaration has drifted from the one the guest bundled: same tag, different success schema. Rebuild against one declaration.                                                                |
| `result_overflow`   | The result JSON is larger than `limits.resultBytes` (5 MiB by default).                                               | Return less, or raise the bound. The message quotes both numbers.                                                                                                                                      |
| `diff_overflow`     | The diff exceeds `limits.files` or `limits.diffBytes`.                                                                | Narrow what the child writes, or raise the bound. The message quotes the limit; a byte refusal also quotes the measured total.                                                                         |
| `diff_unsafe`       | A changed or deleted path is not a plain workspace-relative path.                                                     | The guest named a file with a backslash, a `.` or `..` segment, or a drive prefix. Rename it in the child.                                                                                             |
| `deadline_exceeded` | The whole session outlived `options.timeout`, ten minutes by default.                                                 | Raise the timeout or shorten the child. The machine is released either way.                                                                                                                            |

## A file the child edited is missing from the diff

**Symptom.** `collectDiff` was on, the child rewrote a file, and it is not in
`result.diff`.

**Cause.** Change detection compares sizes by path against a snapshot taken
before the guest ran. A file rewritten in place at exactly its previous size is
the one edit it misses, and that can only happen on a reattached workspace.

**Fix.** Have the child write to new paths, or compute the change inside the
child and return it in `output`. See
[Collect the files a sandboxed child wrote](./guides/collect-a-workspace-diff.md).

## Two executions fought over one machine

**Symptom.** A sandboxed execution's machine disappears under it, or two
executions appear to share a workspace.

**Cause.** A session key is an exclusive claim. Two live executions with one key
share a machine, and the first to finish tears it down under the other.

**Fix.** Derive the key from both the parent `executionId` and the action's
`callId`. The engine preserves `callId` across retries and resume and assigns
distinct identities to parallel calls, even with identical payloads. The parent
id alone gives every call in one execution the same machine:

```ts
SandboxedFlow.toLayer(RunChild, Child, ({ executionId, callId }) => ({
  provider,
  session: `child:${executionId}:${callId}`,
  entry
}))
```

## A type error names a registry service the layer does not provide

**Symptom.** `NodeRuntime.layerHost<..., MyCatalog, never, never>(options, registerFlows)`
does not compile.

**Cause.** That is the point. The registry-taking form is a separate overload,
not a defaulted parameter, so a call that names a registry type must also pass
the registry layer. A default would compile and hand back a layer that claims to
provide `MyCatalog` while providing nothing.

**Fix.** Pass the registry layer as the third argument, or drop the registry
type parameters. See
[Discover flows from a registry](./guides/discover-flows-from-a-registry.md).

## `node:sqlite` ended up in a browser bundle

**Symptom.** A browser or edge build pulls in `node:sqlite` or
`node:child_process`.

**Cause.** Something imported `@smthrs/flows/NodeRuntime` or
`@smthrs/flows/SandboxedFlow`. The root entry point is browser-safe; those two
subpaths are not, which is exactly why they are subpaths.

**Fix.** Keep both out of shared code. Durable execution is supported only on
Node.js 26.4.0 or later with local SQLite; a browser can author and inspect
declarations through the root entry point.
