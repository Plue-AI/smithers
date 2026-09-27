---
title: "@smthrs/capability"
description: "Capability values, glob patterns, effect tiers, and typed permission failures: the vocabulary a program uses to decide whether one operation may proceed, with no state and no enforcement of its own."
---

`@smthrs/capability` describes what a program is about to do, then decides
whether it may. A `Capability` names one exact operation, such as `fs:write` on
`/workspace/out.txt`. A `CapabilityPattern` names a set of operations someone
approved, such as `fs:write` on `/workspace/**`. One pure function reduces
ordered rules over those two values into `allow`, `deny`, or `ask`.

## The problem it solves

Anything that runs code on someone else's behalf, an agent, a plugin host, a CI
job, faces the same question before every side effect: is this particular
operation permitted right now. Answer it with a boolean at the call site and
you have nothing to show a person, nothing to write to a log, and nothing to
replay. The answer also widens the first time a resource is built by pasting
strings together, and nothing throws when it does.

This package makes the question a value, and then refuses to guess about it:

- A request that no rule matched is `ask`, never `allow`. Silence is not
  consent.
- A rule too expensive to match is `deny`, so an undecidable rule can never
  fall through to a later allow.
- A resource the glob grammar cannot express exactly, one containing `*` or
  `?`, yields `Option.none()` instead of a pattern that would grant more than
  was asked for.
- A workspace root with no lexical boundary classifies every write as
  `irreversible` rather than assume the write can be undone.

Reach for it when permission decisions have to outlive the call that made them:
the same request text must mean the same thing in an operator's policy file, in
an approval prompt, and in a recorded run replayed six months later.

The package holds no state. It reads no files, opens no sockets, and enforces
nothing. It answers three questions, "what was asked for", "does a rule cover
it", and "what would it cost to undo", and leaves acting on the answers to the
caller.

## Install

Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

## Decide one request

Rules are ordered and the last match wins, so a policy reads top to bottom the
way an operator wrote it:

```ts
import { Capability, Permission } from "@smthrs/capability"

const rule = (effect: Permission.RuleEffect, action: Capability.PatternAction, resource: string) =>
  new Permission.Rule({ effect, pattern: new Capability.CapabilityPattern({ action, resource }) })

const policy = [
  rule("allow", "fs:read", "/workspace/**"),
  rule("allow", "fs:write", "/workspace/**"),
  rule("deny", "fs:write", "/workspace/.git/**")
]

Permission.evaluate([policy], Capability.make("fs:read", "/workspace/README.md"))
// "allow"
Permission.evaluate([policy], Capability.make("fs:write", "/workspace/.git/config"))
// "deny"

const deploy = Capability.make("net:post", "https://api.example.test/deploy")
Permission.evaluate([policy], deploy)
// "ask": nothing matched it, so a person has to answer
```

## Suspend what a person has to answer

An `ask` becomes a typed failure the caller raises instead of proceeding. It
carries the effect tier, which is what an approval surface shows a person and
what decides whether a retry needs an idempotency key:

```ts
const tier = Capability.tierOf(deploy, { workspaceRoot: "/workspace" })
// "irreversible"
Capability.requiresIdempotencyKey(tier)
// true

const suspended = Permission.permissionRequired({
  requestId: "req-1",
  capability: deploy,
  tier,
  meta: { flow: "deploy", attempt: 1 }
})

Permission.formatError(suspended)
// "permission_required: net:post:https://api.example.test/deploy (tier irreversible, request req-1)"
```

The resource in that line came from whatever asked for it. `formatError`
escapes control characters and caps each field, so a resource containing a
newline cannot forge a second log line.

## How this fits with @smthrs/flows

This package is one piece of the Smithers durable flow engine, whose whole
surface is re-exported by [`@smthrs/flows`](/api/flows). If you already depend
on that barrel, this vocabulary is its `Capability` namespace and you do not
need to install anything else:

```ts
import { Capability } from "@smthrs/flows"

Capability.Permission.evaluate([policy], Capability.Capability.make("fs:read", "/workspace/README.md"))
// "allow"
```

Install `@smthrs/capability` on its own when the vocabulary is all you want.
Its one runtime dependency is [`@smthrs/canonical`](/api/canonical) and its one
peer is `effect@4.0.0-rc.115`. It has no engine, no storage, and no I/O.

Within that engine, this package is deliberately the leaf of the permission
kernel: it holds the words, never the enforcement.
[`@smthrs/kernel`](/api/kernel) owns the grant store, the layers that decorate
host services such as `FileSystem`, and the journal that records what a person
approved. Keeping the two apart is what lets a protected service such as
[`@smthrs/jj`](/api/jj) declare `JjError | PermissionError` in its own error
channel without depending on the kernel, which already depends on it.

`@smthrs/flows` is in turn the library behind the `smithers` command line tool,
[`@smthrs/cli`](/api/cli), which runs durable flows and prompts a person when a
step needs permission this package decided it does not have.

## Where to go next

- [Installation](./installation.md): runtime requirements, the two import
  forms, and what the export map keeps private.
- [Quickstart](./quickstart.md): turn operator text into a policy, decide three
  requests, and produce the failure a suspended request raises.
- [The authorization model](./concepts/authorization-model.md): how ordered
  rulesets reduce to one decision, and why a configured `deny` is final.
- [Resource globs](./concepts/resource-globs.md): what `*`, `?`, and `**` mean,
  and the three edges that decide whether a grant covers what you meant.
- [Effect tiers](./concepts/effect-tiers.md): what `sealed`, `compensable`, and
  `irreversible` mean, and why only a file write depends on its resource.
- [Grant a capability safely](./guides/grant-a-capability-safely.md): derive a
  grant from an approved request instead of writing one by hand.
- [Handle a permission failure](./guides/handle-a-permission-failure.md): the
  three typed failures, and what each one asks the caller to do.
- [Validate capability text from an untrusted source](./guides/validate-untrusted-text.md):
  read patterns out of config, an RPC, or a journal without widening anything.
- [API reference](./api.md): every export of the `Capability` and `Permission`
  modules.
- [Troubleshooting](./troubleshooting.md): each refusal, what it means, and
  what to change.
