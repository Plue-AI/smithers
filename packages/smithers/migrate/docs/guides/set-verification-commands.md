---
title: "Set the commands that verify each unit"
description: "How the tool derives install, format, typecheck, and test commands from your project, and how to replace any of them when the derivation is wrong."
sidebar:
  order: 4
---

Every unit is verified before it is accepted, with four kinds of command plus
registry discovery. The tool derives them from your project. When the
derivation is wrong, an override is the only way to correct it, because the
model's shell is confined to exactly these command lines.

## What the derivation produces

| Kind      | Derived from                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| Install   | The `packageManager` field, else the lockfile: `bun install`, `pnpm install`, `yarn install`, or `npm install`.         |
| Format    | `dprint check` when the project has a `dprint.json`, else `prettier --check .` when it configures prettier.             |
| Typecheck | One `tsc --noEmit -p <path>` per `tsconfig.json`, excluding `tsconfig.test.json`, sorted by path.                       |
| Test      | `repoCommands.test` from `smithers.config.ts`, else the root `test` script run through the project's package manager.   |
| Discovery | The registry's own discovery scan over the flows directory. Not overridable: it is what proves a migrated flow is real. |

The formatter runs in check mode on purpose. A verification asks a question,
and a formatter that rewrites the repository answers it by editing files the
unit does not own.

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
these lines and the model's shell is confined to literal grants derived from
them. A command the tool never derived is a command the model can never run.

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

## One derivation serves the prompt and the grant

The same derivation builds the command list shown to the model, the list
recorded in the report, and the inputs to the `proc:spawn` grants the kernel
enforces. A grant names the kernel's own rendering of the argv it spawns. Only
lines that the capability grammar can represent literally become grants.

## Commands containing wildcard characters

The capability pattern grammar cannot represent literal `*` or `?` characters.
A command line containing either gets no agent process grant, including when
the character is quoted or backslash-prefixed. This prevents a shell glob such
as `tests/*` from granting appended commands or command substitutions.

Deterministic verification still executes the exact configured command. To let
the agent run it through its shell or `migrate/verify` self-check, put the glob
inside a package script and configure a literal line such as `npm run test`.

## Bounded output

Each verification command's streams keep their last 12 KB through a rolling
window, and the report says how many earlier bytes were dropped. The captured
output passes through the journal's shared redaction rules before it reaches
`report.json`; see
[The migration report](../concepts/report.md).
