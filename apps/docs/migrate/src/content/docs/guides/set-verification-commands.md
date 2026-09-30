---
title: "Set the commands that verify each unit"
description: "How the tool derives install, format, typecheck, and test commands from your project, and how to replace any of them when the derivation is wrong."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/migrate/docs/guides/set-verification-commands.md"
---

Every unit is verified before it is accepted, with four kinds of command plus
registry discovery. The tool derives them from your project. When the
derivation is wrong, an override is the only way to correct it, because the
orchestrator runs these commands after the model answers.

`--apply` runs the project's own install, format, typecheck, and test commands
on your machine, package manager lifecycle scripts and `repoCommands.test`
included. Run it only on a trusted checkout or inside a sandbox.

## What the derivation produces

| Kind      | Derived from                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| Install   | The `packageManager` field, else the lockfile: `bun install`, `pnpm install`, `yarn install`, or `npm install`.           |
| Format    | `dprint check` when the project has a `dprint.json`, else `prettier --check .` when it configures prettier.               |
| Typecheck | One `tsc --noEmit -p <path>` per `tsconfig.json`, excluding `tsconfig.test.json`, sorted by path.                         |
| Test      | `repoCommands.test` from `smithers.config.ts`, else the root `test` script run through the project's package manager.     |
| Discovery | The registry's own discovery scan over the flows directory. Not overridable: confirms the registry can discover the flow. |

The formatter runs in check mode on purpose. A verification asks a question,
and a formatter that rewrites the repository answers it by editing files the
unit does not own.

## Required declaration checks

Before archiving an old workflow, migration also checks that its replacement
uses `export default Flow.make("<tag>", { description: "...", payload: {}, body: ... })`.
The tag must be a nonempty literal. A payload schema or field object (including
`{}` for no input) and a body are required. Legacy
object-first declarations and `model` or `flows` without a body fail even when
the project has no typecheck command. Failed replacements leave the original
source in place and record the failed check in the migration report.

These static checks do not execute generated code or prove its behavior.
Use the project's typecheck and tests to verify the implementation.

## Override any of them

```bash
smithers-migrate --apply --seat anthropic:<model> \
  --verify-install "pnpm install --frozen-lockfile" \
  --verify-format "make fmt-check" \
  --verify-typecheck "make typecheck" \
  --verify-test "make test"
```

`--verify-typecheck` is repeatable, once per command you want run:

```bash
smithers-migrate --verify-typecheck "tsc -p tsconfig.build.json" --verify-typecheck "tsc -p tsconfig.app.json"
```

One empty value runs no typecheck at all:

```bash
smithers-migrate --verify-typecheck ""
```

These flags matter more than convenience. A project whose typecheck lives in a
Makefile has no other way to be migrated, because every unit is verified with
these lines after the model answers. The model has no shell or verification tool.

## Derived commands get no shell

A derived command is an argv value: an executable and its literal arguments,
spawned with no shell in between. A tsconfig named `tsconfig.;rm -rf .json` is
one argument to `tsc`, not a line a shell reads.

An override is a string, and it keeps shell semantics, because you typed it.
That is the only place shell syntax is honored.

`smithers.config.ts`'s `repoCommands.test` is repository text, not operator
text, so it is accepted only when it is a plain line of words: no quotes, no
`$`, `;`, `|`, `&`, redirection, glob, or newline, and an executable that is
not a flag. A line the tool refuses is reported in the plan's notes, naming the
command that ran instead and the exact `--verify-test` value that runs the line
as written.

## Verification belongs to the host

The same derivation builds the command list shown to the model and recorded
in the report. The orchestrator runs those exact commands after each rewrite
and returns failures for repair. Agents edit through guarded filesystem flows;
no shell or `migrate/verify` tool is offered. Operator overrides keep their
shell syntax, including literal wildcard characters.

## Bounded output

Each verification command's streams keep their last 12 KB through a rolling
window, and the report says how many earlier bytes were dropped. The captured
output passes through the journal's shared redaction rules before it reaches
`report.json`; see
[The migration report](/concepts/report/).
