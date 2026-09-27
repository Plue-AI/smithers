---
title: "@smthrs/migrate"
description: "The Smithers 0.x to 1.0 migration tool: it rewrites a JSX-era project onto Flow, Action, and Effect, one recoverable unit at a time, and writes an auditable report of every decision."
---

`@smthrs/migrate` upgrades a Smithers 0.x project, the one built on JSX
workflows and the `smthrs` facade, to the Smithers 1.0 authoring model. It
rewrites your application source onto `Flow`, `Action`, and Effect, archives
the sources it replaced, and writes a report that records every construct it
translated, every construct it refused to translate, and every decision left
for you.

It is not a compatibility library. It never recreates the JSX runtime, never
embeds a scheduler in application code, never hides an untranslatable construct
behind `any`, and never rewrites or resumes 0.x run state.

```bash
smithers-migrate
```

Not on npm yet; [Installation](./installation.md) runs it from a source
checkout.

That command plans. It reads the project, decides what each unit of work would
be, writes `.smithers-migrate/report.md`, and changes nothing else. You read
the report, then decide whether to run `--apply`.

## The three modes

| Mode    | What it does                                                                        | What it writes               |
| ------- | ----------------------------------------------------------------------------------- | ---------------------------- |
| `scan`  | Reads the project and reports what is in it.                                        | Nothing.                     |
| `plan`  | Scans, then plans the migration units. The default.                                 | The report.                  |
| `apply` | Checkpoints, rewrites one unit, verifies it, archives the old sources, and repeats. | The project, and the report. |

Only `apply` edits anything, and only when you pass `--apply`.

## Where this sits in Smithers

`@smthrs/migrate` is a tool you run once, not part of the runtime you end up
on. What it produces is a project that runs on [`@smthrs/cli`](/api/cli), the
`smthrs` executable every Smithers command lives under: `smthrs flow start` to
start a flow, `smthrs flow list` to list the flows a project has, `smthrs doctor` to check
one. Install that package after the migration to use what the migration wrote.

You can also install it first. `@smthrs/cli` carries this same tool as the
[`smthrs migrate`](/cli/migrate) verb, over the same entry point and the same
flags. Reach for `smithers-migrate` when the project is still on 0.x, and for `smthrs migrate` when the CLI is
already there. [Installation](./installation.md) covers the two differences
between them.

## Two gates stand before any edit

`apply` refuses twice, exits 3, and leaves the project untouched, because each
refusal is a decision only a person can make:

- **0.x run state.** A 1.0 runtime can neither read nor resume a 0.x run
  database, whether its runs are live, parked, or finished. Pass
  `--acknowledge-run-state` once you have dealt with it. See
  [Clear 0.x run state before you apply](./guides/clear-run-state.md).
- **Constructs with no safe translation.** Pass `--allow-unsafe <name,...>` or
  `--allow-unsafe all`. Even then the rewrite leaves a
  `TODO(migrate-smithers-v1)` marker rather than an imitation. See
  [Accept constructs with no safe translation](./guides/allow-unsafe-constructs.md).

## The scanners are a library too

Importing `@smthrs/migrate` loads the read-only half of the tool and nothing
else. Every module below imports only `effect`, `@effect/platform-node`,
`typescript`, and Node built-ins, so deciding whether to migrate never means
installing the 1.0 runtime.

| Module           | What it reads or decides                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `MigrateError`   | The single failure type, with the code the CLI maps onto an exit status.                                                   |
| `Constructs`     | The catalog of every 0.x construct application code can import, with the Smithers 0.x file that defined it.                |
| `Mapping`        | What each construct becomes, the class of the rewrite, and the rewrite text for automatic rows.                            |
| `Detect`         | Packages, lockfiles, imports, pragmas, tsconfig chains, workflow and prompt files, components, tests, scripts, and config. |
| `RunState`       | Read-only detection of live and parked runs, SQLite databases, Postgres settings, and the operator instructions.           |
| `Inventory`      | Per-file construct hits, resolved through imports and `createSmithers` destructuring.                                      |
| `ZodSchemaHints` | Classifies a zod chain and prints the `effect/Schema` equivalent for the safe subset.                                      |
| `PromptHints`    | Classifies an MDX prompt and prints the template literal over `payload`.                                                   |
| `Units`          | Orders the migration into dependency, workflow, integration, and project units.                                            |
| `Checks`         | The deterministic post-rewrite checks, including registry discovery.                                                       |
| `Report`         | The report schema, its writers, and the deterministic Markdown renderer.                                                   |
| `Scan`           | The pipeline that composes every module above into one result.                                                             |

The migration flow itself, the half that edits, is reached by subpath as
`@smthrs/migrate/flow/Command` and its `@smthrs/*` dependencies are optional.
[Installation](./installation.md) covers both halves.

## Where to go next

- [Installation](./installation.md): how to run the tool, and the two install
  shapes it has.
- [Quickstart](./quickstart.md): scan, read the report, apply, and verify one
  project end to end.
- Concepts: [migration units](./concepts/units.md),
  [the mapping table](./concepts/mapping.md),
  [checkpoints and confinement](./concepts/checkpoints.md), and
  [the report](./concepts/report.md).
- Guides: [scan without changing anything](./guides/scan-a-project.md),
  [clear 0.x run state](./guides/clear-run-state.md),
  [accept unsafe constructs](./guides/allow-unsafe-constructs.md),
  [set the verification commands](./guides/set-verification-commands.md),
  [recover a failed unit](./guides/recover-a-failed-unit.md),
  [read a project from your own script](./guides/embed-the-scanners.md), and
  [run the migration as a durable flow](./guides/run-as-a-durable-flow.md).
- [Troubleshooting](./troubleshooting.md): every failure code, what causes it,
  and what to change.
- [API reference](./api.md): every public export, with signatures.

The operator walkthrough for the whole 0.x upgrade, including every removed CLI
verb and flag, lives on the main site at
[Upgrade from 0.x to 1.0](/docs/migration/1.0). This site documents the tool.
