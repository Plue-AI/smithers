---
title: "Read a project from your own script"
description: "Call the scanners directly to inventory a 0.x project, classify its constructs, or render your own report, without running the migration."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/migrate/docs/guides/embed-the-scanners.md"
---

The read-only half of this package is an ordinary Effect library. Use it when
you want the inventory in your own tooling: a dashboard over several
repositories, a CI check that fails when a project still imports the 0.x
facade, or a report rendered your way.

Nothing here writes to the project, installs anything, evaluates project code,
or opens a database except read only.

## Install the scanner API

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

Keep optional dependencies enabled: TypeScript 7 supplies the native compiler
the scanners need through a platform-specific optional package. See
[Installation](/installation/) for the dependency requirements.

The scanners import `effect`, `@effect/platform-node`, `typescript`, and Node
built-ins, and nothing else.

## Scan a project and render its report

`Scan.scan` composes every scanner into one result, and `Scan.toReport` renders
that result as the same report the CLI writes:

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Report from "@smthrs/migrate/Report"
import * as Scan from "@smthrs/migrate/Scan"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const program = Effect.gen(function*() {
  const result = yield* Scan.scan(process.cwd())
  return Scan.toReport(result, "plan", new Date().toISOString())
}).pipe(Effect.provide(platform))

const report = await Effect.runPromise(program)
console.log(Report.toMarkdown(report))
```

Every scanner requires `FileSystem.FileSystem` and `Path.Path`, so the platform
layer is the only composition you need. Every one fails with
[`MigrateError`](/troubleshooting/), so a missing file arrives as a typed
failure rather than an untyped defect.

`generatedAt` is a parameter rather than a clock read, because the report is
deterministic: two scans of an unchanged project produce identical bytes except
for that timestamp.

`Report.toJson(report)` is the other rendering, and it is what `report.json`
holds.

## Find the constructs that have no safe translation

`Detect.scan` reads the project, `Inventory.scan` resolves each file's
constructs through its imports, and `Mapping.classify` classes one hit:

```ts
import * as Detect from "@smthrs/migrate/Detect"
import * as Inventory from "@smthrs/migrate/Inventory"
import * as Mapping from "@smthrs/migrate/Mapping"
import * as Effect from "effect/Effect"

const unsafe = Effect.gen(function*() {
  const detection = yield* Detect.scan(process.cwd())
  const hits = yield* Inventory.scan(detection)
  return hits.filter((hit) => Mapping.classify(hit) === "unsafe")
})
```

Each hit carries `file`, `line`, `column`, `construct`, the props present, and
the prop values a mapping decision needs.
`Mapping.classifyWithReason(hit)` returns the class with the reason attached,
which is what the report prints.

## Check the run state without touching it

```ts
import * as Detect from "@smthrs/migrate/Detect"
import * as RunState from "@smthrs/migrate/RunState"
import * as Effect from "effect/Effect"

const verdict = Effect.gen(function*() {
  const detection = yield* Detect.scan(process.cwd())
  const state = yield* RunState.scan(process.cwd(), detection)
  return { verdict: state.verdict, instructions: state.instructions }
})
```

The verdict is `clean`, `history-only`, or `blocked`, and `instructions` are
the operator texts in the order they have to be acted on. `RunState.roots`
turns a report into the project-relative directories the run state lives in.

## Plan the units yourself

`Units.plan` takes what the three scanners produced and returns the ordered
unit plan:

```ts
import * as Units from "@smthrs/migrate/Units"

const units = Units.plan({ detection, inventory, hints: { zod: [], prompt: [] } })
```

Pass the real hints from `ZodSchemaHints.hints(detection)` and
`PromptHints.hints(detection)` when you want the plan the tool itself builds;
`Scan.scan` does exactly that. `Units.verifyCommands(detection)` returns the
install, format, typecheck, and test commands the same derivation produces, so
you can print what a migration would run before you run one.

## Convert a schema or a prompt

The two hint modules are pure text functions and need no filesystem:

```ts
import * as PromptHints from "@smthrs/migrate/PromptHints"
import * as ZodSchemaHints from "@smthrs/migrate/ZodSchemaHints"

ZodSchemaHints.print("z.object({ name: z.string() })")
PromptHints.print("Summarize {props.topic}.")
```

`print` returns `undefined` for a zod chain outside the safe subset;
`ZodSchemaHints.classify(chain)` says why. See
[The mapping table](/concepts/mapping/).

## What you cannot reach from here

The editing half is under `@smthrs/migrate/flow/`, needs the optional
`@smthrs/*` packages, and is documented in
[Run the migration as a durable flow](/guides/run-as-a-durable-flow/).
`@smthrs/migrate/internal/*` and `@smthrs/migrate/flow/internal/*` are blocked
in the export map.
