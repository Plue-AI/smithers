# @smthrs/migrate

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect`, `@effect/platform-node` and
`@effect/platform-node-shared` as exact `4.0.0-rc.115` dependencies. Keep the
application on that version so all Smithers packages share one Effect runtime.

**Documentation:** https://migrate.smithers.sh

Upgrades a Smithers 0.x (JSX) project to the Smithers 1.0 authoring model and writes an auditable migration report.

`@smthrs/migrate` is not a compatibility library. It rewrites application source onto `Flow`, `Action`, and Effect, archives the sources it replaced, and records every construct it translated, every construct it refused to translate, and every decision left for you. It never recreates the JSX runtime, never embeds a scheduler in application code, never hides an untranslatable construct behind `any`, and never rewrites or resumes 0.x run state.

## Availability

Not on npm yet. Run it from a source checkout of the [smithers repository](https://github.com/smithersai/smithers):

```sh
git clone https://github.com/smithersai/smithers.git
cd smithers
pnpm install
pnpm --filter @smthrs/migrate build
alias smithers-migrate="node $PWD/packages/smithers/migrate/dist/esm/flow/bin.js"
```

## The shortest real example

```sh
smithers-migrate
```

That plans. It reads the project, decides what each unit of work would be, writes `.smithers-migrate/report.md`, and changes nothing else. Read the report, then decide whether to apply:

```sh
ANTHROPIC_API_KEY=... smithers-migrate --apply --seat anthropic:<model>
```

## Modes

| Mode    | What it does                                                                                                               |
| ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `scan`  | Reads the project and writes nothing.                                                                                      |
| `plan`  | Scans, plans the migration units, and writes only the report. The default.                                                 |
| `apply` | Checkpoints, transforms one unit at a time, verifies, archives the old sources, and writes the report. Requires `--apply`. |

Two gates stand before any edit, and both exit 3 with the project untouched. Persisted or live 0.x run state blocks until `--acknowledge-run-state`. A construct with no safe translation blocks until `--allow-unsafe <construct,...>`, and even then the rewrite leaves a `TODO(migrate-smithers-v1)` marker rather than an imitation.

## Install cost

`scan` and `plan` need `effect`, `@effect/platform-node`, and `typescript`, and nothing else. Every scanner module imports only those and Node built-ins.

`apply` runs the migration flow and its registry discovery check, so it also needs the flow-lane packages. They are `optionalDependencies`: a package manager installs them by default and `--no-optional` leaves them out. That flag also omits TypeScript 7's native compiler executable. A scan-only installation must supply its platform-specific compiler package separately, such as `@typescript/typescript-darwin-arm64@7.0.2` on Apple Silicon; otherwise keep optional dependencies enabled. `Checks.discovery` imports `@smthrs/registry` at call time, so importing `@smthrs/migrate` never loads the runtime.

## The scanner API

The root entry point exports these namespaces; each is also importable from `@smthrs/migrate/<Module>`. The [API reference](https://migrate.smithers.sh/reference/api/) names every export, its signature, and where to import it from.

| Module           | Description                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MigrateError`   | The single failure type, with the code the CLI maps onto an exit status.                                                                                 |
| `Constructs`     | The catalog of every 0.x construct application code can import, with its old source path.                                                                |
| `Mapping`        | The old-to-new mapping table, prop-driven class escalation, and the rewrite text for automatic rows.                                                     |
| `Detect`         | Packages, lockfiles, imports, pragmas, tsconfig chains, workflow and prompt files, components, UIs, tests, libraries, scripts, config, and integrations. |
| `RunState`       | Read-only detection of live and parked runs, SQLite databases, Postgres and PGlite settings, state directories, and the operator instructions.           |
| `Inventory`      | Per-file construct hits resolved through imports and `createSmithers` destructuring.                                                                     |
| `ZodSchemaHints` | Classifies zod chains and prints the `effect/Schema` equivalent for the safe subset.                                                                     |
| `PromptHints`    | Classifies MDX prompts and prints the template literal over `payload`.                                                                                   |
| `Units`          | Orders the migration into dependency, workflow, integration, and project units.                                                                          |
| `Checks`         | The deterministic post-transform checks, including registry discovery.                                                                                   |
| `Report`         | The report schema, its writers, and the deterministic Markdown renderer.                                                                                 |
| `Scan`           | The pipeline that composes every module above.                                                                                                           |

The editing half is reached by subpath, as `@smthrs/migrate/flow/Command`, because `import "@smthrs/migrate"` loads the scanners and nothing else. Deciding whether to migrate must not require installing the runtime.

## The report

`plan` and `apply` write `.smithers-migrate/report.json` and `.smithers-migrate/report.md` (`--report-dir` moves them). The Markdown is deterministic for a given JSON, so two runs diff cleanly. Its sections, in order: summary, run state and operator instructions, project detection, construct inventory, mapping decisions, units, verification, manual follow-ups, and the commands that restore each checkpoint.

On Linux, TypeScript 7.0.2 can print `context canceled` when its syntax-only compiler sessions close. A successful `plan` can include these shutdown messages alongside exit 0 and a complete report. The migration CLI preserves this upstream stderr output.

Commit `report.md`. It is the record of what the tool changed, what it could not translate, and what a person still has to decide.

Read the verification output before you commit it. Each command's last 12 KB of stdout and stderr is captured verbatim into `report.json` and rendered into `report.md`, and a failing install or test suite in a 0.x project prints whatever it prints: a registry token, a value read from `.env`, a CI credential. The tool does not redact it, because it cannot tell a secret from a stack frame.

## What a unit is allowed to write

A unit declares its sources and its targets, and that is the only place it may write. A checkpoint (jj change, git ref, or file copy) is taken before the unit starts, along with a digest of the whole tree, and a write outside the unit's file set fails the unit and restores it. The agent cannot read run state at all: the grant rules deny every filesystem action on each 0.x run-state path, so a database, an execution log, or a subscription file is refused before its bytes reach a model call. [Checkpoints and confinement](https://migrate.smithers.sh/concepts/checkpoints/) has the whole guarantee, including what a rollback removes and what it puts back byte for byte.

A verified unit archives what the migration replaced. `package.json`, `tsconfig*.json`, and `.gitignore` are rewritten in place and never moved; every other source of a workflow or project unit moves to `.smithers-migrate/archive/<original path>`. Before a unit is called `migrated` it has to satisfy the postconditions of its kind, and then the whole verification runs again over the final tree.

## Flags

`--scan`, `--allow-no-vcs`, `--keep-old-sources`, `--unit <id,...>`, `--max-repair-rounds`, `--report-dir`, `--flows-dir`, and `--json` do what their names say. `--report-dir` and `--flows-dir` name directories inside the project: a plain relative path with no `.` or `..` segment, not under `.flows`, `.git`, `.jj`, or `node_modules`, and not inside each other. Any violation fails with `invalid-layout` and exit 1 before a byte is read.

`--verify-install`, `--verify-format`, `--verify-typecheck` (repeatable), and `--verify-test` replace the commands the detection ladder derives from the manifests and the lockfile. They matter more than a convenience: every unit is verified with these lines and the agent's shell is granted exactly them, so a project whose typecheck lives in a Makefile has no other way to be migrated. One empty value, `--verify-typecheck ""`, runs no typecheck at all.

A derived command is an executable and its arguments, spawned with no shell: a tsconfig named `tsconfig.;rm -rf .json` is one argument to `tsc`, not a line a shell reads. The derived formatter runs in check mode (`dprint check`, `prettier --check .`), because a verification asks a question and a formatter that rewrites the repository answers it by editing files the unit does not own. Only an operator override keeps shell semantics, because the operator typed it.

## Provider credentials

`apply` runs a model-backed rewrite, so it needs a seat and a key. The seat is a role: the flow declares `migrate`, and the resolver maps it onto the `provider:model` you name with `--seat`. No model id is hard-coded anywhere in this package, so a run with no seat and no key refuses by name instead of guessing. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `OPENROUTER_API_KEY` are the three variables it reads. `scan` and `plan` need no credentials at all.

## Documentation

https://migrate.smithers.sh covers the installation shapes, the quickstart, migration units, checkpoints, the mapping table, the report, the guides, every failure code, and the full API reference.

The operator walkthrough for the whole 0.x upgrade, including every removed CLI verb and flag, is [Upgrade from 0.x to 1.0](https://smithers.sh/docs/migration/1.0/).

### Zod default fields

Automatic schema hints preserve defaults for missing and explicit `undefined`
inputs and require decoded output keys during encoding. Default-field snippets
need `Schema`, `Effect`, and `SchemaGetter` from their corresponding `effect/*`
modules. The printer leaves optional/nullish default combinations, checked
fallback domains, and incompatible literal or required-object defaults guided: a
rewrite must preserve Zod's default bypass behavior and decoded types. Defaults
on unknown/any schemas are also guided because they permit absent encoded
outputs. Plain
optional and nullish fields remain supported.
