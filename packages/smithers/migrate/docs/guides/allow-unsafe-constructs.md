---
title: "Accept constructs with no safe translation"
description: "What makes a construct unsafe, what --allow-unsafe changes and what it does not, and how to find the markers the rewrite leaves behind."
sidebar:
  order: 3
---

Some 0.x constructs have no honest 1.0 rewrite. The tool classes them `unsafe`,
refuses `apply` until you say otherwise, and even then refuses to imitate them.

## Find out which ones your project uses

```bash
smithers-migrate
```

The report's "Mapping decisions" section carries one row per distinct
construct, with its class. Every `unsafe` row is a construct that blocks a
unit. The unit itself is reported with status `blocked`, and the summary counts
it.

A run that reaches the gate names them and tells you the flag that accepts
them:

```text
smthrs migrate: 2 constructs have no safe translation: gateway.ts, zodToTable.
Rerun with --allow-unsafe gateway.ts,zodToTable to accept a TODO marker and a
report entry for each, or --allow-unsafe all.
```

It exits 3 and leaves the project untouched. Exit 3 means parked for a
decision, not failed.

## Name what you accept

```bash
smithers-migrate --apply --seat anthropic:<model> --allow-unsafe gateway.ts,zodToTable
```

Or accept everything the scan found:

```bash
smithers-migrate --apply --seat anthropic:<model> --allow-unsafe all
```

Prefer the named form. It is a list you wrote after reading the report, and a
construct the scan finds later is one you have not seen yet: `all` waives it
too.

## What the flag does not do

`--allow-unsafe` releases the gate. It does not buy a translation. For each
unsafe construct the rewrite leaves:

- a `TODO(migrate-smithers-v1): <construct>` marker at the site, and
- an `unsupported` entry in the report, with the file, the line, and the
  closest thing 1.0 offers.

Every `unsupported` entry also becomes a `must` follow-up on the report's
checklist. After the run, find the work with the marker:

```bash
grep -rn "TODO(migrate-smithers-v1)" .
```

## Why the class is not fixed per construct

A prop can raise a construct's class. `<Task>` is translatable and
`<Task hijack>` is not, so the class belongs to the occurrence. When one file
holds both, the report's row for `Task` carries the worse class and the union
of the reasons. See [The mapping table](../concepts/mapping.md).

## The decisions the tool will not make even with the flag

Agent pools are yours whatever you pass. A `ClaudeCodeAgent`, `CodexAgent`,
`OpenCodeAgent`, or `fallbackAgents` hit becomes an `unresolved` entry offering
subscription auth through the flows harness or an API seat, and the rewrite is
forbidden to collapse a pool into a single seat. Which subscriptions your
project spends is not a decision a migration gets to make.
