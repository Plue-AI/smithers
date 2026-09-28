---
title: "Write a capability policy"
description: "Turn what a host should allow into GrantStore rules: the four rulesets, the hard veto, the resource each action names, and how to narrow authority for delegated work."
sidebar:
  order: 2
---

A policy is an ordered list of `Permission.Rule` values handed to
`GrantStore.make` or `GrantStore.layer` as `rules`. Each rule pairs a
capability pattern with `allow`, `deny`, or `ask`.

## Write the rules

```ts
import { Capability, GrantStore, Permission } from "@smthrs/kernel"

const policy = [
  // Read anything in the workspace.
  new Permission.Rule({
    effect: "allow",
    pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
  }),
  // Write anything in the workspace, except the lockfile.
  new Permission.Rule({
    effect: "allow",
    pattern: new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/**" })
  }),
  new Permission.Rule({
    effect: "deny",
    pattern: new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/pnpm-lock.yaml" })
  }),
  // Exactly `npm test`, nothing appended.
  new Permission.Rule({
    effect: "allow",
    pattern: new Capability.CapabilityPattern({ action: "proc:spawn", resource: "npm test" })
  })
]

const store = GrantStore.layer({ attended: false, rules: policy })
```

Rules are last-match-wins, so the deny above beats the broad write allow that
precedes it. Anything no rule matches defaults to `ask`, which an unattended
store reports as `permission_required`. You never need a catch-all deny; write
the allows.

## Name the resource each action actually checks

A rule only fires if its resource glob matches the resource the decorator
built. These are the resources the kernel names:

| Action                    | Resource                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs:read`, `fs:write`     | The canonical absolute path, with an inside-workspace path mapped back to the logical workspace root.                                                   |
| `proc:spawn`              | `CommandLine.resource(command)`: the rendered line; a chained shell line as `sh -c '<line>'`; `env <NAME>… --` for non-bootstrap environment overrides. |
| `net:get`, `net:post`     | The lowercased URL host for `https:`, and `<scheme>//<lowercased host>` for anything else.                                                              |
| `model:call`              | The same, with `/<model id>` appended.                                                                                                                  |
| `jj:status`               | `"."`                                                                                                                                                   |
| `jj:diff`                 | `<from>:<to>`                                                                                                                                           |
| `jj:snapshot`             | The commit message, or `""` when none was given.                                                                                                        |
| `jj:restore`, `jj:revert` | The change id.                                                                                                                                          |
| `jj:workspace-add`        | The canonicalized destination. This one also requires `fs:write` on the same resource.                                                                  |
| `jj:workspace-forget`     | The workspace name.                                                                                                                                     |
| `jj:op-restore`           | The operation id.                                                                                                                                       |
| `jj:root`                 | The canonicalized starting directory.                                                                                                                   |

Because `https` is the implicit scheme, a grant for `api.example.com` never
authorizes `http://api.example.com`. That is the point: a host grant cannot be
downgraded into a cleartext one.

A `*` in a `proc:spawn` resource matches any text, including `;` and line
breaks. A `shell: true` line with control syntax is checked as
`sh -c '<line>'`, and every pipeline stage is checked on its own, so `npm *`
covers the `npm` stage of `npm test | sh` but not the `sh` stage. Grant exact
command lines; `npm *` still runs any npm subcommand, including
`npm exec <anything>`.

The glob grammar has no escape character, so a resource that genuinely
contains `*` or `?` cannot be named exactly. Never build a pattern by
concatenating text an agent supplied. See
[resource globs](/pkg/capability/concepts/resource-globs) for the full
grammar and its edges.

## The configured ruleset has a veto

`MakeOptions.rules` accepts either a flat list or a nested one. The flat form
is the configured policy. In the nested form, the first ruleset is configured
policy and the rest are replayed remembered grants.

The configured ruleset carries a power the others do not: after it is reduced
by last-match-wins, an effective denial is a **hard veto** that no envelope
approval, run grant, or remembered grant can lift. A configured deny that a
later configured allow supersedes _within that same ruleset_ is not a veto, so
an operator can still write an exception after a broad denial.

Use it for the things no operator answering a prompt should be able to unlock:

```ts
const policy = [
  new Permission.Rule({
    effect: "allow",
    pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
  }),
  // No later grant of any kind reaches these.
  new Permission.Rule({
    effect: "deny",
    pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/.env*" })
  })
]
```

## Narrow authority for delegated work

A rule says what the policy permits. `CapabilitySet` says what the current
fiber may even ask for, and it only ever narrows:

```ts
import { Capability, CapabilitySet } from "@smthrs/kernel"

const readOnly = CapabilitySet.attenuate([
  new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
])

// Inside `untrusted`, every other capability fails with permission_denied and
// the reason "outside capability ceiling", whatever the rules say.
const scoped = readOnly(untrusted)
```

`attenuate` intersects the parent ceiling with one more any-of group, so the
child can narrow further and can never recover what it gave up. There is no
public widening operation. A run grant made by an attenuated fiber is
remembered with that fiber's ceiling and is filtered out for any capability the
ceiling would not allow, so authority cannot leak back up.

## Stay inside the bounds

One store retains at most 1,024 rules across all four rulesets. The constant is
exported as `GrantStore.maximumRules`, alongside
`maximumEnvelopePatterns` (256), `maximumPendingRequests` (1,024),
`maximumMetadataDepth` (16), `maximumMetadataMembers` (1,024),
`maximumMetadataBytes` (64 KiB), `maximumEventBytes` (256 KiB),
`maximumIdentityLength` (4,096), and `maximumCapabilityResourceLength`
(4,096). Exceeding one fails with `invalid_resolution` before any state
changes. Check against the exported constants rather than hardcoding the
numbers.

Decorator resources use UTF-16 code units: 4,096 is valid; 4,097 fails with
`GrantStoreError` code `invalid_resolution` before the grant check or guarded
host operation. Filesystem and process decorators project this error into
`PlatformError`; HTTP projects it into `HttpClientError`. The structured error
is retained as the cause. Jujutsu returns the typed `GrantStoreError` directly.
Filesystem canonicalization can read metadata before rejecting a resource.

## Related

- [How a grant decision is made](../concepts/grant-decisions.md): the order
  the rulesets are consulted in.
- [Answer permission requests](./answer-permission-requests.md): what to do
  with the `ask` the policy leaves behind.
