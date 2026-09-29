---
title: "Scan a project without changing it"
description: "Read a 0.x project and get the full inventory, mapping decisions, and unit plan, without running the migration."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/migrate/docs/guides/scan-a-project.md"
---

Deciding whether to migrate must not cost you a rewrite, an install, or a
credential. Two modes read and report; neither edits.

## Read and report nothing to disk

```bash
smithers-migrate --scan
```

`scan` walks the project and prints a summary. It writes no file at all, not
even the report. Use it the first time you point the tool at a project, and any
time you want to know what changed since.

## Read and write the report

```bash
smithers-migrate
```

`plan` is the default mode. It does everything `scan` does, plans the migration
units, and writes `.smithers-migrate/report.json` and
`.smithers-migrate/report.md`. It changes nothing else. The report is the
artifact worth reading: see [The migration report](/concepts/report/).

## What a scan reads

The walk skips `node_modules`, `.git`, `.jj`, `dist`, `.flows`, and the 0.x
run-state directories, and covers:

- Every manifest: the root `package.json`, each workspace member,
  `.smithers/package.json`, and any manifest next to a workflow file. A
  dependency that only ever existed in Smithers 0.x is decided by name; one
  that exists in both trees is decided by version, against `<1.0.0-0`.
  This includes `@smthrs/ui`: 0.x versions migrate; `1.0.0-rc.1` and its
  imports remain intact, including in projects that also use `smthrs@0.35.0`.
- Every `effect` declaration in every manifest, and what the lockfile resolved
  `effect` to. Anything other than the pin this release was built against
  raises `effect-pin-conflict` naming the file and the field.
- Every import specifier, read with the TypeScript compiler API, classified
  `old`, `foreign`, `mdx`, or `relative`, plus both `@jsxImportSource`
  spellings and every tsconfig's `jsx`, `jsxImportSource`, and path mappings.
- Workflow files, prompt files, components, `<UI entry>` targets, tests,
  libraries, and the transitive closure of a workflow's relative imports.
- Old CLI invocations and `SMITHERS_*` environment names in `package.json`
  scripts, shell scripts, `Makefile`, `Justfile`, GitHub workflows,
  `bunfig.toml`, `Procfile`, compose files, and Markdown.
- `smithers.config.ts`, `.smithers/agents*`, `preload.ts`, `bunfig.toml`
  preloads, `gateway.ts`, `smithers.toon`, `listeners.json`, packs, asset type
  declarations, skills, evals, and integration seams.

## What a scan is guaranteed not to do

It never writes, never installs, never evaluates project code, and never opens
a database except in read-only mode. It never connects to Postgres: a Postgres
or PGlite backend is recorded from the settings that name it.

The read-only guarantee is what makes `scan` and `plan` safe on a project
nobody has decided about yet, and it is also why they need no provider
credentials.

## Install the scanner API

The scanner modules import only `effect`, `@effect/platform-node`,
`typescript`, and Node built-ins. Install the package with optional dependencies
enabled so TypeScript 7's platform-specific native compiler is available. Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

The optional `@smthrs/*` packages are installed too, but importing the scanners
does not load the migration runtime. See [Installation](/installation/)
for the dependency requirements.

## When a scan could not read everything

A directory the walk cannot list, one deeper than twelve levels, and a file
over 8 MB each raise an `incomplete-scan` warning naming the path. `scan` and
`plan` report those warnings; `apply` refuses to run against a plan built over
one, because a migration of an incomplete plan is a migration of the wrong
project. Fix the permission, or move the file, then scan again.

## Next steps

- [Read a project from your own script](/guides/embed-the-scanners/): the same scan
  as a library call.
- [Clear 0.x run state before you apply](/guides/clear-run-state/): what a
  `blocked` verdict means.
