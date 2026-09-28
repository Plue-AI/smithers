---
title: "Resource globs"
description: "The capability pattern grammar: what * and ? match, why a trailing wildcard is optional, and the three edges that decide whether a grant covers what you meant."
sidebar:
  order: 2
---

A capability pattern is an action selector and a resource glob. The action
selector is one of an exact action (`fs:read`), a namespace family (`fs:*`), or
the whole-authority `*`. The resource glob is matched against the whole
resource, and this page is about that half.

## The grammar

| Form                        | Matches                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| a literal character         | itself, byte for byte over UTF-16 code units                                               |
| `*`                         | any run of code units, path separators and newlines included                               |
| `?`                         | exactly one code unit, so an astral character such as an emoji needs two                   |
| a space then `*` at the end | additionally, the bare resource with no trailing text, so `npm *` also grants `npm`        |
| `**`                        | the same as `*` when matching; beyond equality, the only form `Capability.subsumes` proves |

Every other character is literal. `.`, `+`, `(`, `[`, `^`, `$`, and `|` have no
special meaning: the matcher is a two-pointer glob walk, not a regular
expression, so a pattern like `a*a*a*a*b` is linear work rather than a
backtracking hazard.

```ts
import { Capability } from "@smthrs/capability"

const grant = new Capability.CapabilityPattern({ action: "proc:spawn", resource: "npm *" })

Capability.matches(grant, Capability.make("proc:spawn", "npm"))
// true
Capability.matches(grant, Capability.make("proc:spawn", "npm install pkg"))
// true
Capability.matches(grant, Capability.make("proc:spawn", "npmx"))
// false
```

The optional trailing wildcard exists so a command grant reads the way an
operator writes it. `npm *` means "npm, with any arguments", including none.

That makes `npm *` a grant to run arbitrary code, not a grant to run npm. `*`
matches `;`, `&&`, `|`, and newlines as readily as it matches arguments, so the
grant covers `npm exec <pkg>`, `npm install <attacker pkg>`, and, for a spawner
that passes the resource to a shell, `npm x; curl ... | sh`. Grant commands
exactly, such as `npm test`, and keep trailing wildcards for resources whose
every expansion you accept.

## Edge one: there is no escape

The grammar has no escape character, so a resource that genuinely contains `*`
or `?` cannot be granted exactly. This is the sharpest edge in the package,
because the pattern still looks exact:

```ts
Capability.matches(
  new Capability.CapabilityPattern({ action: "net:get", resource: "https://api.test/v1?k=1" }),
  Capability.make("net:get", "https://api.test/v1Xk=1")
)
// true
```

The operator wrote a URL and got a one-character wildcard. Two rules follow.
Never build a pattern by concatenating text an agent supplied, and derive exact
grants with `Capability.patternFromCapability`, which returns `Option.none()`
for a resource the grammar cannot express. The procedure is in
[Grant a capability safely](../guides/grant-a-capability-safely.md).

## Edge two: the text is compared exactly

Matching performs no path normalization and no case folding. A backslash is an
ordinary character that never matches `/`, `A:/x` never matches `a:/X`, and
`/workspace/**` does not cover `/workspace\evil`:

```ts
Capability.matches(
  new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/**" }),
  Capability.make("fs:write", "/workspace\\evil")
)
// false
```

That is deliberate. Normalizing slashes once turned `C:/x\..\..\etc\passwd`
into a path inside a `C:/x/**` grant. The supported hosts are POSIX, so the
matcher treats every resource as opaque text and leaves canonicalization to the
adapter that builds the capability. If your resources need normalizing, do it
before you construct the `Capability`, once, in one place.

One exception fails closed. A filesystem capability (`fs:read`, `fs:write`)
whose absolute resource still has a `.` or `..` segment was never
canonicalized, and text matching would let `/workspace/**` select
`/workspace/../etc/passwd`. No pattern selects such a capability, and none
selects a relative resource whose `..` climbs above its start (`../x`).
`Permission.evaluate` returns `deny` for both, and `Capability.subsumes` never
proves such a pattern is covered:

```ts
Capability.matches(
  new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/**" }),
  Capability.make("fs:write", "/workspace/../etc/passwd")
)
// false
```

A relative resource is a flow's declared scope, which the host resolves
against the workspace root later. `.`, `./src/./out`, and `src/a/../out` stay
valid: a pattern selects one only when it selects both the text and its
lexical normal form. `**` selects `.`, and `src/**` selects `src/a/../out` but
not `src/a/../../etc`, whose normal form is `etc`.

## Edge three: matching and proving are not the same

`Capability.matches` decides one request. `Capability.subsumes` asks a
different question: does this pattern provably cover that whole set. It is
conservative and answers `false` for any relationship its syntactic checks
cannot prove, which is what a capability envelope needs.

`subsumes` proves a resource relationship in exactly three cases: the two
resources are identical, the covering resource is `**`, or the covering
resource ends in `/**` and the covered resource starts with that prefix and a
separator. A single `*` qualifies only through the first case, so it proves
the identical pattern and nothing else:

```ts
const wanted = new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/src/a.ts" })

Capability.subsumes(
  new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/*" }),
  wanted
)
// false
Capability.subsumes(
  new Capability.CapabilityPattern({ action: "fs:*", resource: "/workspace/**" }),
  wanted
)
// true
```

So `/workspace/*` matches `/workspace/src/a.ts` but can never be shown to cover
it. A run whose envelope is built from `*` patterns asks for permission it
already has every time a request names any resource other than the `*` pattern
itself. Write `**` whenever a pattern has to prove coverage.

Action selectors follow the same shape: `*` covers everything, `fs:*` covers
every `fs:` action and `fs:*` itself, and an exact action covers only itself.

`Capability.mayOverlap` asks the converse question: can these two patterns
select a common capability. It is conservative in the other direction and
answers `true` for anything it cannot prove disjoint, so a `deny` rule keeps
applying to a claim whose overlap the grammar cannot settle. Only literal text
proves disjointness, from two literal resources that differ or from literal
prefixes that disagree before the first `*` or `?`:

```ts
const claimed = new Capability.CapabilityPattern({ action: "fs:read", resource: "a/b/**" })

Capability.subsumes(
  new Capability.CapabilityPattern({ action: "fs:read", resource: "a/*/x" }),
  claimed
)
// false, coverage is unprovable
Capability.mayOverlap(
  new Capability.CapabilityPattern({ action: "fs:read", resource: "a/*/x" }),
  claimed
)
// true, disjointness is unprovable
Capability.mayOverlap(
  new Capability.CapabilityPattern({ action: "fs:read", resource: "vendor/*" }),
  claimed
)
// false, the literal prefixes disagree
```

## Cost and the bound

Matching costs O(pattern length times resource length) in the worst case. Both
resources are capped at `Capability.maxResourceLength` (4096 UTF-16 code
units) at construction, parsing, and decode, so an adapter must reject or
summarize a longer host value before authorization rather than carrying it in.

`Capability.maxMatchWork` is the square of that cap and guards structural
inputs that evaded the check. `Capability.matches` returns `false` past the
budget, because a grant must never widen, and `Permission.evaluate` turns the
same case into `deny`. `Capability.withinMatchBudget` reports whether a pair is
decidable at all.

## Related

- [The authorization model](./authorization-model.md): how matched rules become
  one decision.
- [Grant a capability safely](../guides/grant-a-capability-safely.md): deriving
  a grant from a request instead of writing one by hand.
