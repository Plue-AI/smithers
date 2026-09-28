import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/migrate"
})

const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/migrate",
  include: ["src/**"],
  checks: [
    {
      id: "agent-confinement-rules",
      title: "The rewrite agent's grant rules confine it to the project and away from run state",
      threat:
        "Instructions planted in a migrated 0.x source file steer the rewrite agent into reading run-state databases or writing outside the project root.",
      lookFor: [
        "A `rules` allow pattern built from a root that is not the branded absolute MigrationRoot, or a trailing-slash root that matches nothing.",
        "A run-state path, gateway state file, or custom `--report-dir` that gets no `fs:*` deny rule, or a deny placed where a later allow can override it.",
        "An `envelope()` or `hostLayer` change that grants the agent a flow or capability the grant store does not also check."
      ],
      paths: ["src/flow/Layers.ts", "src/flow/Transform.ts", "src/flow/Options.ts"]
    },
    {
      id: "agent-proc-spawn-grants",
      title: "The agent may spawn only the project's exact verification command lines",
      threat:
        "A prompt-injected rewrite agent runs an arbitrary shell command, or edits package.json or .git hooks so the unsandboxed verification run executes its code on the operator's machine.",
      lookFor: [
        "A `proc:spawn` allow derived from anything but `verificationCommands`, or a wildcard pattern produced from a command line containing `*` or `?`.",
        "A verification command resolved from a package.json script the agent can rewrite during the same unit before `Verify.run` executes it.",
        "Agent write access to `.git/`, `.jj/`, or package manager config that a later host-run jj, git, or install command would execute."
      ],
      paths: [
        "src/flow/Layers.ts",
        "src/flow/Verify.ts",
        "src/flow/Transform.ts",
        "src/Units.ts",
        "src/internal/CliScripts.ts"
      ]
    },
    {
      id: "exec-shell-quoting",
      title: "Commands with untrusted tokens run as argv or are POSIX-quoted, never interpolated into a shell line",
      threat:
        "A project path, unit id, or checkpoint ref containing shell metacharacters runs extra commands with the operator's privileges.",
      lookFor: [
        "An `Exec.run` call without `args`, so `shell: true`, whose command string includes a path, unit name, or change id.",
        "`CommandLine.quote` leaving a token with `'`, `$`, backtick, or newline unquoted.",
        "A git ref or jj revset built from a unit id without the `[^A-Za-z0-9._-]` sanitizer in `gitRef`."
      ],
      paths: [
        "src/flow/internal/Exec.ts",
        "src/internal/CommandLine.ts",
        "src/flow/Checkpoint.ts",
        "src/flow/Verify.ts",
        "src/flow/Contract.ts"
      ]
    },
    {
      id: "checkpoint-path-containment",
      title: "Backup, restore, and removal paths stay inside the project and never follow symlinks",
      threat:
        "A symlink or `..` path in the migrated project makes checkpoint restore or rollback overwrite or recursively delete the operator's files outside the project.",
      lookFor: [
        "`restore` or `backup` joining a manifest path to the root without rejecting `..` segments or absolute paths.",
        "A check-then-use gap between `refuseLink` and `fs.remove(..., { recursive: true })` or `fs.writeFile` on the same path.",
        "`privateDirectory` or `writeBackup` creating a component without `O_NOFOLLOW` or the 0700 mode."
      ],
      paths: ["src/flow/Checkpoint.ts", "src/internal/Fs.ts", "src/flow/internal/Pending.ts", "src/flow/Archive.ts"]
    },
    {
      id: "secret-redaction-to-model-and-report",
      title: "Dotenv values and credential-shaped command output never reach the model or report.json",
      threat:
        "A migration sends the operator's API keys from `.env*` files or verification output to the model provider or commits them in the report.",
      lookFor: [
        "A `.env*` file path the `sourceView` regex misses, such as `.envrc`, `env/.env.local`, or a Windows separator, so its raw text enters the brief.",
        "A command stdout or stderr tail written to the report or returned to the agent without `Redaction.redact`.",
        "Scan or Detect output that copies dotenv values, rather than assignment names, into warnings, hints, or the report.",
        "`rules` in `Layers.ts` granting `fs:*` on the whole root with no `fs:*` deny for `.env*` paths, so the agent's own `read` returns raw dotenv bytes that the Contract prompt only asks it not to open.",
        "A Repair round prompt that embeds verification stdout or stderr before `Redaction.redact` runs on it."
      ],
      paths: [
        "src/flow/Transform.ts",
        "src/flow/Layers.ts",
        "src/flow/Repair.ts",
        "src/flow/Verify.ts",
        "src/Report.ts",
        "src/Detect.ts",
        "src/flow/Contract.ts"
      ]
    },
    {
      id: "scan-walk-bounds",
      title: "The project walk stays in the project and is bounded on hostile trees",
      threat:
        "A migrated repository with symlink loops, links to `~/.ssh`, or deep directories makes the scanner read files outside the project into a prompt or hang the operator's run.",
      lookFor: [
        "A walk in `Fs.ts`, `Scan.ts`, or `Checkpoint.tree` that follows a symlink or reads a linked target's bytes instead of recording `symlink:<target>`.",
        "A recursion with no depth cap or no visited-set on real paths.",
        "A run-state reader in `RunState.ts` that opens a database or file outside the project without the operator's acknowledgement."
      ],
      paths: ["src/internal/Fs.ts", "src/Scan.ts", "src/flow/Checkpoint.ts", "src/RunState.ts", "src/Inventory.ts"]
    },
    {
      id: "operator-gates",
      title: "Run-state and unsafe-construct gates refuse before any write",
      threat:
        "A migration edits a project with live 0.x runs or untranslatable constructs without the operator passing `--acknowledge-run-state` or `--allow-unsafe`, corrupting their run state.",
      lookFor: [
        "A code path in `MigrateFlow.ts` or `Command.ts` that checkpoints, transforms, or archives before `Gate` returns clear.",
        "A lock in `Lock.ts` released on a token mismatch, or a stale lock taken over while its holder is alive.",
        "A missing `pending-unit.json` check letting a second run overwrite backups still needed for recovery."
      ],
      paths: [
        "src/flow/Gate.ts",
        "src/flow/MigrateFlow.ts",
        "src/flow/Command.ts",
        "src/flow/Lock.ts",
        "src/flow/internal/Pending.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
