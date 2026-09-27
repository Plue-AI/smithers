---
title: "The command surface"
description: "The unified public parser and the retained Effect compatibility tree."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/concepts/command-surface.md"
---

The public `smthrs` command tree is `Cli.makeCli`: Incur parses Zod schemas,
then Effect supplies execution and durable services. It combines target
execution, `flow`, `runs`, `approvals`, and operator groups. See the
[canonical command reference](/reference/cli/) for current names,
formatting, and project selection.

The executable routes hidden flat aliases through the retained `Command.cli`
Effect tree; the implementation notes below describe that compatibility path.
Its legacy catalog names
every verb that ships and every verb that was removed, so a script written
against Smithers 0.x is told what happened to each spelling instead of getting
a parser error.

## Three modes, decided before parsing

The executable inspects the raw argument vector before it builds anything:

1. **A document.** If the first flag is `--help` or `--version`, the command
   tree renders the document and nothing else runs. No project is resolved, no
   flow directory is scanned, no database is opened. That scan stops at the
   first flag that is not one of the two, because a value spelled `--help` is a
   value, not a request for help.
2. **A refusal.** `Unsupported.refusal(argv)` recognises a removed 0.x verb and
   fails with one sentence and exit 1. Refusing here, rather than from a hidden
   command, is what keeps a refusal from creating `.flows/` and opening two
   databases on its way to saying the verb is gone.
3. **The MCP server.** `--mcp` is a mode, not a verb, because every MCP client
   configures a launch command rather than a subcommand. Incur serves the
   same command tree the verbs use.

Anything else runs the command tree. Even then the durable layer belongs to
the handler the parse selects, not to the program: `Command.provide` builds
`NodeControl.layer` inside the chosen handler, so a typo, an unknown flag, or a
missing argument stays file-free.

A verb neither list holds is refused as unknown, and that refusal gains one
line: `Did you mean: smithers <verb>?` when Jev picks a shipped verb with at
least 0.7 confidence, or `Could not ask Jev for a suggestion: <reason>` when
the evaluator could not answer, never a string-distance guess.

## Required input

When stdin is a terminal, omitting a required positional argument opens a
clack prompt. `plan` and `up` show the discovered flow picker; other verbs ask
for the missing value. Prompts use stderr, so stdout remains the document.
Cancelling a prompt exits 130 without submitting the command. With piped stdin,
a missing argument exits 2, names the argument, and points to `--wizard` for
guided input. Optional arguments keep their documented defaults.

A nonexistent or inaccessible `--root` exits 2 and names the path. A command
group such as `memory`, `claude`, or `mcp` without a subcommand also exits 2
and lists its subcommands; use `--help` to request help with exit 0.

## The shipped list

`Verb.shipped` is the catalog. Every entry carries its `--help` line, its
aliases, and the reserved `system/` flow id when the control catalog reserves
one. `Verb.subcommands` is the same list minus `completions`, which
`effect/unstable/cli` provides as the global `--completions <shell>` flag
rather than as a subcommand.

The contract is that a verb either ships with a handler or is removed and says
so. Neither list may omit a verb, and no verb may appear on both.

Six aliases survive, and all six are hidden from `--help` so the help document
shows the canonical surface only:

| Alias | Canonical form |
| --- | --- |
| `resume <run-id>` | `runs resume <run-id>` |
| `workflow list` | `flow list` |
| `inspect`, `why` | `runs show` |
| `events` | `runs logs --json` |
| `gateway` | `serve` |

## The global flags

Every verb accepts the shared flag set, declared once on the root command:

| Flag | Value | Meaning |
| --- | --- | --- |
| `--root` | path | The project to act on, instead of walking up from the working directory. |
| `--remote` | URL | The control plane to act on. Falls back to `SMITHERS_REMOTE`. |
| `--json` | none | Print the machine document instead of the human rendering. |
| `--quiet` | none | Suppress banners and progress on stderr; stdout documents still print. |
| `--mcp-config` | path | The JSON array of MCP servers the local executor projects into a run's flow catalog. |
| `--backend` | name | Hidden. `sqlite` is a no-op; any other value exits 1. |

`effect/unstable/cli` adds `--help`, `--version`, `--wizard`,
`--completions <shell>`, and `--log-level <level>`.

`--root`, `--remote`, and `--mcp-config` are read from raw argv
by `NodeControl.makeConfig` before the parser runs, because the durable layers
are built from them. They are declared on the command tree as well so the
parser accepts them.

Over MCP the host owns the connection. A tool argument spelling `remote` is refused with exit 2, so a connected client cannot aim the
host's `SMITHERS_TOKEN` at a control plane it chose. An MCP session reaches
the host-configured `SMITHERS_REMOTE`, using its saved Smithers login or
`SMITHERS_TOKEN`. Login and destination configuration are host-only operations.

`--quiet` never suppresses the stdout document. It is safe to combine with
`--json` when a script wants the machine document without banners or progress
on stderr.

## The removed list

`Unsupported.removedVerbs` names every 0.x verb that is gone, with the group
it belonged to and the reason, and `Unsupported.removedFlags` does the same for
flags. Each refusal is one sentence and a link into the migration page's anchor
for that name, never a usage error:

```text
smthrs replay was removed in 1.0.0-rc.0: time travel is a library API
(@smthrs/time-travel) and worktree lanes are deferred.
See https://smithers.sh/migration/1.0#replay
```

The table holds only names the CLI no longer answers. A 0.x spelling the
canonical tree reissued with a new meaning is not a removal: `graph`, `eval`,
`review`, `test`, `runs`, and `show` all run today. Listing them would force
the router, the help assertion, and the site generator to keep the same
exclusion list by hand, so a host can map `removedVerbs` straight to names
without filtering it.

Three refusals behave slightly differently, and each is deliberate:

- `gateway` survives as the `serve` alias, so only `gateway status` and
  `gateway stop` refuse. It is registered as a command group rather than an
  alias because an alias has no subcommands, and `gateway status` would
  otherwise reach the parser as a stray positional argument.
- `workflow list` survives as a `flow list` alias, so only the other `workflow`
  subcommands refuse.
- `--backend sqlite` names the one backend that ships and is accepted as a
  no-op. Any other value, from the flag or from `SMITHERS_BACKEND`, exits 1
  with `unsupported_database`. `Environment.unsupportedBackend` owns that
  distinction.

A flow id beginning with `system/` is refused the same way.
`Unsupported.isReservedFlow` is the test: the control catalog reserves those
ids for command-line verbs, and 1.0.0-rc.0 ships a body for none of them, so a
launch would park with nothing to run.

## Where the per-verb reference lives

The reference for each verb, with its arguments, flags, output, exit codes, and
verbatim `--help` text, is on smithers.sh under `/cli/<verb>`: for example
[`smthrs flow`](https://smithers.sh/docs/reference/cli/flow/), [`smthrs runs`](https://smithers.sh/docs/reference/cli/runs/), and
[`smthrs approvals`](https://smithers.sh/docs/reference/cli/approvals/). Those pages are generated from the parser the
executable runs, so they describe the binary you installed.

See [the CLI reference index](/reference/cli/).
