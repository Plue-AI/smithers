---
title: "Grant a capability safely"
description: "Derive an exact grant from a request with patternFromCapability, widen it deliberately with **, and prove the result covers what you meant before you store it."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/capability/docs/guides/grant-a-capability-safely.md"
---

A person approved one request. You now need a pattern that covers that request
and nothing more, or a wider one you widened on purpose. This guide is the
procedure, and the rule it enforces is short: never build a pattern by
concatenating text you did not write.

## Derive the exact grant

`Capability.patternFromCapability` is the only safe conversion from a request
to a grant:

```ts
import { Capability } from "@smthrs/capability"
import { Option } from "effect"

const request = Capability.make("proc:spawn", "npm install --offline")
const grant = Capability.patternFromCapability(request)

if (Option.isSome(grant)) {
  Capability.matches(grant.value, request)
  // true
  Capability.matches(grant.value, Capability.make("proc:spawn", "npm install --offline --force"))
  // false
}
```

The derived pattern matches that resource and nothing else, because the matcher
neither normalizes text nor folds case. Quotes, spaces, and newlines in the
resource are fine.

## Handle the refusal

`patternFromCapability` returns `Option.none()` in two cases: the resource is
longer than `Capability.maxResourceLength`, or it contains `*` or `?`. The
grammar has no escape for those characters, so any pattern the function could
return would grant more than the request. Refusing is the only honest answer.

When you get `Option.none()`, do one of these:

- Ask again next time. A one-time approval that is never remembered is correct
  for a resource the grammar cannot express.
- Canonicalize the resource in the adapter before constructing the
  `Capability`, and grant the canonical form. Trimming a query string off a URL
  is a decision about what you are granting, so make it where the URL is
  understood, not where the pattern is written.
- Widen deliberately, as described next, and record that you did.

## Widen on purpose

One widening is safe to write by hand, because it is grammar you control rather
than text an agent supplied:

```ts
// Every path under a directory you named.
new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/**" })
```

Do not widen a command the same way. `*` matches any text, including `;`,
`&&`, `|`, and newlines, so `proc:spawn` on `npm *` grants `npm exec <pkg>`,
`npm run <script>`, `npm install <attacker pkg>`, and, for any spawner that
hands the resource to a shell, `npm x; curl ... | sh`. Every one of those runs
arbitrary code. Grant each command exactly instead:

```ts
new Capability.CapabilityPattern({ action: "proc:spawn", resource: "npm test" })
new Capability.CapabilityPattern({ action: "proc:spawn", resource: "npm install --offline" })
```

Use `**`, not `*`, for a subtree. `/workspace/*` matches nested paths but
`Capability.subsumes` cannot prove it covers them. It proves only the identical
`/workspace/*` pattern, so an envelope built from `*` patterns re-asks for
every other resource. The reasoning is in
[Resource globs](/concepts/resource-globs/).

## Prove coverage before you store it

If the grant goes into an envelope that is checked ahead of a call, verify it
with `Capability.subsumes` rather than assuming:

```ts
const envelope = new Capability.CapabilityPattern({ action: "fs:*", resource: "/workspace/**" })
const claim = new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/src/a.ts" })

Capability.subsumes(envelope, claim)
// true
```

`subsumes` is conservative: a `false` means "not provable", not "definitely
not covered". Treat it as the gate, and rewrite the grant until it passes,
rather than falling back to `matches`, which answers a different question.

## What not to do

```ts
declare const directory: string // agent-supplied

// Wrong: one `*` anywhere in `directory` widens the grant.
new Capability.CapabilityPattern({ action: "fs:write", resource: `${directory}/**` })
```

The failure is silent. Nothing throws, the pattern looks like the one you
meant, and it grants a set you never inspected. If you must accept a directory
from outside, build a `Capability` from it first, derive the grant with
`patternFromCapability`, and append `/**` only to a resource that came back
`Option.some`.

## Related

- [Resource globs](/concepts/resource-globs/): why `*` cannot prove
  coverage, and why the text is never normalized.
- [Validate capability text from an untrusted source](/guides/validate-untrusted-text/):
  reading patterns out of config, an RPC, or a journal.
