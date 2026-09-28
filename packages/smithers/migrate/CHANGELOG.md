# @smthrs/migrate

## [Unreleased]

### Fixed

- Leave dependency versions with unsafe numeric core components unresolved
  instead of classifying rounded major, minor, or patch values.
- Compare numeric prerelease identifiers exactly, including values beyond
  JavaScript's safe integer range, instead of treating rounded values as equal.
- Generate `smthrs flow start <flow>` rather than the unrelated root `run`
  command. Translate `--input` to `--data` and bare `-d` to `--detached`;
  recognize the legacy `-d <literal JSON object>` data form without changing
  it into detached execution. Preserve quoted inputs and environment values.
- Share one checked script mapper between manifest rewrites and migration
  snippets. Recognize command positions rather than rewriting quoted prose,
  and preserve simple command lists. Unsupported flags, dynamic flow paths,
  conflicting input flags, remote-detached combinations, shell control grammar
  and redirections leave the entire original script unchanged with a report
  entry. Missing workflow arguments are no longer silently claimed migrated.
- Recognize literal package-runner version/tag suffixes, report unsupported
  wrappers, and distinguish real shell assignments from quoted command names.
  CLI inventory hits without a checked rewrite are guided, not automatic;
  the `ps` and `cancel` targets are explicitly guided until implemented.

## [1.0.0-rc.0] - 2026-09-01

### Security

- Derived verification commands are argv values spawned with no shell, so a
  repository file name can no longer be executed as shell syntax; only an
  operator `--verify-*` override keeps shell semantics. The derived formatter
  runs in check mode.
- The grant rules deny every filesystem action (`fs:*`) on 0.x run-state paths
  and their subtrees, so the agent cannot read a database or a log into a
  model call.
- `root`, `--report-dir`, and `--flows-dir` are validated before anything is
  read: normalized, project-relative, non-overlapping, not under a reserved or
  run-state directory, with symlink ancestors resolved, and the report
  directory holding only the tool's own files (`invalid-layout`).
- The prompt fences every source, hint, snippet, and command output with a
  fence the content cannot close, and the contract states that quoted project
  text is data.
- Command output is bounded while a command runs: each stream keeps its last
  12 KB through a rolling window and counts what it dropped, so a verification
  command that prints without end costs the process nothing but the tail.

### Fixed

- A target that existed before the migration is restored byte for byte when a
  unit fails; the checkpoint records every declared path as present with its
  digest or as absent, verifies backups and restored bytes against those
  digests, and fails closed on any removal or read that is not a typed
  `NotFound`.
- The archive and the deterministic rewrites run before the final
  verification; the final tree is verified, confined, and run-state checked
  again, and the report records that final verification.
- A sealed plan (`MigrateFlow.planSeal`) is recomputed immediately before the
  first checkpoint; a project whose bytes changed since planning is refused
  with `stale-plan`, naming the changed paths.
- Unit artifacts are named injectively (readable id plus an id digest), are
  read back only for the unit they were written for, and a planned unit with no
  recorded outcome is reported `failed`, so an incomplete apply exits 1.
- A unit whose own steps fail with a `MigrateError` (a checkpoint, archive,
  or verification that could not run) is recorded as a failed unit carrying
  the error's code and message, and the run continues with the next unit
  instead of losing every finished one; `no-vcs` still refuses the whole run.
- `Detect.classifyPackage` treats a versionless `@smthrs/*` specifier as old
  only when it is a `file:` or `link:` path; `workspace:*`, `catalog:`, `*`,
  `latest`, and `npm:` aliases are not 0.x. The global-state paths are joined
  with one separator whatever `HOME` and `TMPDIR` end with, tsconfig and
  manifest readers share one JSON-with-comments scanner that also drops
  trailing commas, `Archive.pinFor` refuses to write `"*"` for a package it
  has no pin for, a seat provider named after an inherited object property is
  refused, and a relative root is refused through the package's own error
  rather than thrown from a layer.
- `ZodSchemaHints.print` refuses a top-level `.optional()` or `.default()`
  (the chain stays guided) instead of printing the bare schema; a top-level
  `.describe()` becomes an annotation.
- Postconditions require the files they inspect to exist, cover all six
  dependency fields, and require a root `.gitignore`, which the project unit
  now owns and creates when absent.
- Every `effect` declaration in every manifest, and every version a lockfile
  resolved `effect` to, is judged against the exact release pin; a range, a
  later prerelease, and manifests that disagree each raise `effect-pin-conflict`
  naming the file and field.
- A scan that could not list a directory, would not descend past the depth
  limit, or skipped a file above the size limit records an `incomplete-scan`
  warning per path, and `apply` refuses an incomplete plan with
  `unsupported-project`; `scan` and `plan` still report it.
- The three state paths a host derives from `SMITHERS_HOME`, `HOME`, and
  `TMPDIR` travel on the payload as `state` and reach the run's own scan, so
  global and gateway run state is found by the flow and not only by a scanner
  called by hand; no other environment reaches the payload.
- The zod printer refuses what it cannot translate faithfully instead of
  printing something else: a non-string record key, a nested optional or
  default, and a `min`/`max` on a kind with no such check. Array lengths and
  numeric bounds are told apart by kind. `printField` carries a top-level
  default or optional into a payload field.
- Generated TypeScript stays valid: an identifier that would start with a
  digit is prefixed, keys and tags are quoted, a step group whose ids would
  print as one identifier is refused, and a `Timer` duration is emitted as a
  number, a duration string, or refused when it is an expression.
- A detected 0.x database is `history-only` even with no rows; the approved
  package list is derived from every `@smthrs/*` module the mapping table
  targets, `@smthrs/core` included, so a rewrite is never told to reach for a
  package it may not install; `Command.isMigrateError` guards on the class and its
  code rather than a `_tag` string; nested internal modules are excluded from
  the export map; `sideEffects` names the executable; the report and
  `--version` carry the package's release version.

### Added

- Added the Smithers 0.x project scanner: construct catalog, semantic mapping,
  package and import detection, read-only run-state detection, construct
  inventory, zod and prompt hints, unit planning, deterministic post-transform
  checks, and the migration report.
- The package owns its documentation. `docs/api.md` and the JSDoc of every
  public module are the only sources of
  `docs/pages/migration/migrate-tool.md`, which `scripts/docs.mjs` writes and
  whose `--check` form the `docsPages` target in `PACKAGE.ts` runs as part of
  the workspace `ci` step; the page now carries a generated exports table, so
  a documented export cannot go unlisted.
- The report's Verification section says that command output is captured
  verbatim into `report.json` and asks the operator to read it before
  committing the report, because a failing 0.x command can print a secret and
  nothing here can tell one from a stack frame.
- No maintainer machine path ships to a reader. The 0.x checkout the construct
  catalog was generated from is named by `SMITHERS_0X_CHECKOUT` and the
  external pack the golden scan runs over by `SMITHERS_MIGRATE_PLUE_PACK`,
  which `test/PlueGolden.test.ts` now reads.
