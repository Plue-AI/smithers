---
title: "Quickstart"
description: "Decide one request against a policy: parse operator patterns into rules, evaluate a capability, classify its effect tier, and render the failure a suspended request produces."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/capability/docs/quickstart.md"
---

This quickstart turns three lines of operator configuration into a policy, runs
three requests through it, and produces the typed failure a host raises when a
request needs a person. Nothing here talks to a filesystem, a network, or a
model: the package decides, and the caller acts.

## Prerequisites

- Node.js 26.4.0 or later.
- The package installed. Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

## Parse the configured patterns into rules

Operators write patterns as text. `Capability.parsePattern` reads that text
back, and it returns `Option.none()` rather than guessing, so an unusable line
fails at load rather than at the first request:

```ts
import { Capability, Permission } from "@smthrs/capability"
import { Option } from "effect"

const configured: ReadonlyArray<string> = [
  "fs:read:/workspace/**",
  "fs:write:/workspace/**",
  "proc:spawn:npm install"
]

const ruleFor = (effect: Permission.RuleEffect, declared: string): Permission.Rule => {
  const pattern = Capability.parsePattern(declared)
  if (Option.isNone(pattern)) {
    throw new Error(`Not a capability pattern: ${declared}`)
  }
  return new Permission.Rule({ effect, pattern: pattern.value })
}

const policy = configured.map((declared) => ruleFor("allow", declared))
```

`proc:spawn:npm install` reads as the action `proc:spawn` and the resource
`npm install`.
The action is the first two colon-separated components; everything after them,
colons included, is the resource.

## Decide three requests

`Permission.evaluate` takes ordered rulesets and one exact capability:

```ts
const requests = [
  Capability.make("fs:read", "/workspace/README.md"),
  Capability.make("proc:spawn", "npm install"),
  Capability.make("net:post", "https://api.example.test/deploy")
]

for (const request of requests) {
  console.log(Capability.format(request), Permission.evaluate([policy], request))
}
```

```text
fs:read:/workspace/README.md allow
proc:spawn:npm install allow
net:post:https://api.example.test/deploy ask
```

The first two are covered. The third matched no rule, and the default for an
unmatched request is `ask`, not `deny` and never `allow`.

## Classify the effect and suspend the request

An `ask` decision means a person has to answer. Before you ask, classify what
the operation costs, because the tier is what an approval surface shows and
what decides whether a retry needs an idempotency key:

```ts
const deploy = Capability.make("net:post", "https://api.example.test/deploy")
const tier = Capability.tierOf(deploy, { workspaceRoot: "/workspace" })
// "irreversible"
Capability.requiresIdempotencyKey(tier)
// true

const suspended = Permission.permissionRequired({
  requestId: "req-1",
  runId: "run-7",
  capability: deploy,
  tier,
  meta: { flow: "deploy", attempt: 1 }
})

console.log(Permission.formatError(suspended))
```

```text
permission_required: net:post:https://api.example.test/deploy (tier irreversible, request req-1)
```

`meta` is journal-safe context: only JSON-representable values are accepted,
and construction takes a deep-frozen snapshot rather than retaining your object.
`Permission.formatError` escapes control characters and caps each field, so an
agent-chosen resource cannot forge a second log line.

## Add a rule the run cannot talk its way past

`evaluate` takes a list of rulesets. `rulesets[0]` is configured policy; later
rulesets are the grants a session or a tool has accumulated. Within all of them
the last matching rule wins, with one exception: once configured policy reduces
to `deny`, no later grant lifts it.

```ts
const guarded = [...policy, ruleFor("deny", "fs:write:/workspace/.git/**")]
const session = [ruleFor("allow", "fs:write:/workspace/.git/config")]
const write = Capability.make("fs:write", "/workspace/.git/config")

Permission.evaluate([guarded], write)
// "deny"
Permission.evaluate([guarded, session], write)
// "deny"
Permission.evaluate([guarded, session], Capability.make("fs:read", "/workspace/.git/config"))
// "allow"
```

The read still succeeds. The deny rule names the action `fs:write`, so it never
selects a read, and the `fs:read:/workspace/**` allow still covers the path.

## What just happened

You built a policy out of text, reduced it to one decision per request, and
turned the undecided request into a typed failure a host can raise, a surface
can display, and a journal can store. Three properties did the work, and each
one is a deliberate refusal to guess:

- An unparseable pattern is `Option.none()`, not a default.
- An unmatched request is `ask`, not `allow`.
- A configured `deny` is final, not the current leader.

## Next steps

- [The authorization model](/concepts/authorization-model/): how a decision
  is reduced, and where it fails closed.
- [Grant a capability safely](/guides/grant-a-capability-safely/): turn the
  request you just suspended into a grant that covers it and nothing more.
- [Resource globs](/concepts/resource-globs/): what `*`, `?`, and `**` mean,
  and the three edges the grammar does not make obvious.
