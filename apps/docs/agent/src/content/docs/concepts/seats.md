---
title: "Seats"
description: "The declared seat string and the resolved seat record live in different places on purpose: a declaration is portable, and the credentialed half lives in the SeatResolver."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/docs/concepts/seats.md"
---

A seat is what a flow or an action declares to pick the model it runs on. It
has two halves, and they live in different places on purpose.

## The declared half

The declared half is an ordinary string, and the package ships no schema for
it. It is what a markdown flow's `model:` frontmatter carries and what
`AgentAction`'s `seat` option takes. It carries no credentials, no endpoint,
and no client: a declaration is portable, and a run that reads one out of a
repository must not be handed the keys with it.

`provider:modelId` (`anthropic:claude-sonnet-4-5`) is the convention the
resolver in [`@smthrs/cli`](https://cli.smithers.sh/reference/api/) understands, not a rule the agent
enforces. Nothing below the
resolver parses the string, so a host that installs its own resolver may accept
anything it likes, including a bare model id or a logical name like `fast` or
`reviewer`.

## The resolved half

`Seat.Seat` is the resolved half, and the only thing `Agent.run` accepts: a
provider `modelId`, a live `Model`, the `RouteResolver` that seals its requests,
and the model's context window in tokens so compaction has a real budget. They arrive
together because they are one fact: the model you stream from, the route its
requests are sealed under, and the budget its answers are compacted against.
`Seat.make` constructs one, and a `SeatResolver` implementation is what calls
it. A caller reaches a seat through the resolver, never by assembling one from
a model and a route it happened to hold.

`id` retains the declared string, for example `reviewer`. `modelId` names the
selected provider model, for example `claude-sonnet-4-5`. Generation and
compaction use `modelId`.

The context window must never be zero: zero is the controller's "compaction
disabled", and a resolver that resolves a window must not silently disable it.
`SeatResolver.contextWindowTokensFor` is the catalog of known models, with a
conservative floor for the rest.

## The seam between them

`SeatResolver` is the credentialed half of the composition, one method:
`resolve(id)`. The `smthrs` command line installs the resolver that reads keys
from the environment; a test installs one that answers with a scripted model
and never touches the network. Because the resolver owns the seat vocabulary,
the whole difference between a deterministic run and a live one is which
resolver is provided, and nothing above the seam changes.

A seat the host cannot serve is a typed `Seat.SeatUnresolved`, not a run that
fails halfway through. `AgentSession` resolves the declared seat at launch for
exactly this reason: a missing key refuses the launch as a typed failure
instead of failing an accepted run.

For the implementation walkthrough, see
[Resolve seats into live models](/guides/seat-resolvers/).

## Pin a subscription login

The native CLI resolver accepts `<seat>@<account>`, including aliases:

```ts
seat: "claude-code:opus@claude-9"
seat: "opus@claude-2"
seat: "sol@codex-3"
seat: "openai:gpt-6.1-sol@codex-default"
```

Accounts live under `SMITHERS_ACCOUNTS_DIR`, defaulting to
`~/.smithers/accounts`. Claude accounts select `CLAUDE_CONFIG_DIR`; Codex
accounts select `CODEX_HOME` and ChatGPT authentication. `codex-default`
selects `~/.codex`. Account names begin with `claude-` or `codex-` and contain
letters, digits, underscores, or hyphens.

A pinned login takes precedence over ambient API keys, pools, and proxies.
Claude accounts serve Claude Code seats and Claude aliases; Codex accounts
serve OpenAI and `codex:` seats and their aliases. The vendor CLI owns login
validation and execution. An unknown account, missing subscription
login, or incompatible seat fails with `SeatUnresolved` naming the account.
The resolved seat retains the complete declared ID for journaling.
