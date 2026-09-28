/**
 * Targets for the terminal UI: the typecheck, lint, format check, and the
 * unit and terminal suites.
 *
 * The suite replays a recorded cell run through the transcript fold, so a
 * change to `AgentEvent` that the screen no longer understands fails here.
 * It runs under Bun because the suite is written for `bun test`.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"

const cwd = "apps/tui"

/** The app, its recorded fixture, and the suite beside them. */
const sources = [
  Smithers.glob("//apps/tui/src/**/*.ts"),
  Smithers.glob("//apps/tui/src/**/*.tsx"),
  Smithers.glob("//apps/tui/test/**/*"),
  Smithers.glob("//apps/tui/e2e/**/*"),
  // Preloads `test/preload.ts`, which gives each run a private TMPDIR it removes.
  Smithers.file("//apps/tui/bunfig.toml")
]

/**
 * Checks the app and its suite against the package tsconfig.
 *
 * @since 1.0.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: sources,
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The transcript suite.
 *
 * @since 1.0.0
 * @category test
 */
// Coverage policy: assertion-only for the Bun suite until a whole-source
// denominator is measured. See scripts/repo-contract/README.md.
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["./test"]),
  srcs: sources,
  deps: [],
  cwd
})

/** The production terminal, command effects, cleanup, and packaged runtimes in tmux. */
const e2eTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["./e2e"]),
  timeout: "20m",
  srcs: sources,
  deps: [],
  cwd
})

/**
 * Lints the app sources against the package rule set.
 *
 * @since 1.0.0
 * @category lint
 */
const lint = Smithers.EsLint({
  sources: [Smithers.glob("src/**/*.ts"), Smithers.glob("src/**/*.tsx")],
  configs: [Smithers.file("eslint.config.js"), Smithers.file("//eslint.invariants.js")],
  deps: [],
  maxWarnings: 0,
  fix: false,
  cwd
})

/**
 * Checks formatting across the app, its suites, and its docs.
 *
 * @since 1.0.0
 * @category lint
 */
const fmt = Smithers.Dprint({
  sources: [Smithers.glob("**/*.{ts,tsx,json,md}")],
  config: Smithers.file("dprint.json"),
  deps: [],
  fix: false,
  cwd
})

/** Colocated source documentation consumed by the dedicated Astro site. */
const docsFiles = Smithers.Filegroup({ srcs: [Smithers.glob("docs/**/*.md")], cwd })
/** The real renderer and replay fixture used to execute documentation scripts. */
const recordingSources = Smithers.Filegroup({ srcs: [...sources, Smithers.file("package.json")], cwd })

/**
 * Security review of the terminal host: the approval gate, the person's own
 * shell, credential redaction on every sink, owner-only session files, undo
 * writes, contributed UI actions, and child-process argv.
 *
 * @since 1.0.0
 * @category security
 */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "approval-gate",
      title: "Every consequential flow call and project launch waits on the grant store unless the operator chose all",
      threat: "A prompt-injected model or repository flow writes files, spawns processes or reaches the network on the person's machine without the y/n the person asked for with --approve ask or deny.",
      lookFor: [
        "A call path in host.ts, flow-control.ts or workspace.ts that runs a flow or worker without `Approvals.authorize` or `Approvals.check` when the mode is ask or deny.",
        "`Approvals.consequential` or `requests` classifying a proc:spawn, net:* or fs:write capability as sealed, or skipping a declared capability it cannot parse.",
        "A restored shell monitor in monitors.ts armed before `ports.authorize` settles, or armed after a refusal.",
        "The `armMs` delay, `edited`, or `key` letting a typed y, n or a answer a row that appeared mid-draft, or `a` granting a session-wide pattern broader than the workspace for fs:write.",
        "`Approvals.mode` accepting an unknown value, or print mode silently degrading ask to all."
      ],
      paths: ["src/approvals.ts", "src/host.ts", "src/flow-control.ts", "src/monitors.ts", "src/workspace.ts", "src/run.tsx", "src/app.tsx"]
    },
    {
      id: "write-path-containment",
      title: "An fs:write request names the path the write actually reaches after symlinks",
      threat: "A model writes through a workspace symlink to ~/.ssh or shell rc files while the approval row or a session grant says it stays inside the workspace.",
      lookFor: [
        "`real` in approvals.ts failing to follow a dangling last symlink, a relative link target, or `..` after a link, so `relative(root, target)` reports inside for an outside target.",
        "`Changes.touched` returning fewer paths than an edit, write or apply_patch input writes, so a named path escapes the request list.",
        "`project` granting a literal fs:write resource without `real`, or a glob resource narrower than `/**`."
      ],
      paths: ["src/approvals.ts", "src/changes.ts"]
    },
    {
      id: "shell-secret-redaction",
      title: "Credential values from the environment never reach the screen, the session file or the model through ! output",
      threat: "A `!printenv` or a command that echoes a token sends the person's API keys to the model provider and leaves them in session files.",
      lookFor: [
        "A path from child stdout or stderr to `onOutput`, the spill file, `Result.output` or `contextText` that bypasses `Output.redactor(env)`.",
        "`redactor` releasing a prefix of a secret split across two chunks, or the name pattern missing a credential variable such as a *_KEY or *_TOKEN name.",
        "Spill files written with a mode other than 0o600 or at a predictable name in a shared temp directory.",
        "`persisted` keeping a `!!` command's output or `fullOutputPath` in the session record."
      ],
      paths: ["src/shell.ts", "src/shell-output.ts", "src/context.ts", "src/session.ts"]
    },
    {
      id: "session-file-privacy",
      title: "Session, worker, eval and diagnostic files are owner-only and redacted before they reach disk",
      threat: "Another local user reads the person's prompts, diffs, shell output and tokens from ~/.smithers/tui.",
      lookFor: [
        "A mkdir without mode 0o700 plus chmod, or a file write or append without mode 0o600, in session.ts, log.ts or improve.ts.",
        "A `Session.Record` type written through `JSON.stringify` without `strings` redaction that can hold model or tool text rather than ids, paths or re-executed bytes.",
        "`directory` or `slug` letting a crafted cwd escape `root()` with `..` or an absolute component.",
        "Resume or fork reading a session file from another cwd's folder without matching its header cwd."
      ],
      paths: ["src/session.ts", "src/log.ts", "src/improve.ts", "src/workspace.ts"]
    },
    {
      id: "undo-write-containment",
      title: "Undo writes and deletes only the files the reversed calls changed, inside the workspace",
      threat: "A tampered or crafted patch receipt makes undo overwrite or unlink files outside the person's repository.",
      lookFor: [
        "`resolve(cwd, file.path)` in undo.ts accepting an absolute path or `..` from a patch's old or new file name without a containment check.",
        "`plan` writing any file when one path conflicts, or `commit` leaving a partial restore after a write error.",
        "A bash receipt, whose diff is repository-wide, being reversed and clobbering another worker's edits."
      ],
      paths: ["src/undo.ts", "src/changes.ts"]
    },
    {
      id: "contributed-action-authority",
      title: "Published panels, keys and status items run nothing until the person chooses them, and never a shell command",
      threat: "A model or repository flow publishes a panel or global key that launches flows or prompts on the person's behalf, or hijacks a built-in key.",
      lookFor: [
        "`Panels.Action` or `Extension.Contribution` gaining a variant that carries a command string or runs on publish rather than on selection.",
        "`Contributions` letting a runtime or repo owner override a built-in or plugin key, or exceed `limits`.",
        "`perform` in app.tsx starting a flow run that skips the approval gate the same flow gets from a model call."
      ],
      paths: ["src/extension.ts", "src/panels.ts", "src/contributions.ts", "src/app.tsx", "src/surfaces.ts"]
    },
    {
      id: "child-process-argv",
      title: "Helper processes run with argv arrays, and only the person's own ! line and $EDITOR go through a shell",
      threat: "A file name, flow input or model string that reaches git, jj, rg, the clipboard or the editor runs attacker-chosen shell code.",
      lookFor: [
        "A `spawn`, `execFile` or `Subprocess.spawn` call with `shell: true` or a template string built from a path, model output or flow input.",
        "The editor temp path spliced into the shell program in external.ts instead of passed as `$1`.",
        "A git or jj argument taken from input that could start with `-` and be read as an option."
      ],
      paths: ["src/external.ts", "src/clipboard.ts", "src/files.ts", "src/changes.ts", "src/subprocess.ts", "src/shell.ts", "src/search.ts"]
    },
    {
      id: "terminal-escape-injection",
      title: "Model, tool and command text cannot write raw terminal control sequences",
      threat: "A file or command output the agent reads rewrites the person's terminal, sets its title or clipboard via OSC 52, or spoofs an approval row.",
      lookFor: [
        "`clean` in shell-output.ts passing C1 controls, OSC, DCS or CSI sequences split across chunks.",
        "Transcript, panel or subagent views rendering model or tool text that has not passed through a sanitizer the renderer relies on."
      ],
      paths: ["src/shell-output.ts", "src/transcript-view.ts", "src/view.tsx", "src/app-view.tsx", "src/subagent-view.tsx", "src/panels.ts"]
    },
    {
      id: "repository-config-trust",
      title: "Files a cloned repository supplies never widen authority or run code before the person acts",
      threat: "A malicious repository the person opens the TUI in runs code or gains unapproved capabilities through its flows/, markdown agents, .smithers/home.json or AGENTS.md.",
      lookFor: [
        "Flow discovery or `describe` importing or executing a repository flow module rather than reading registry metadata.",
        "Approval rows in flow-control.ts computed from a flow's self-declared `capabilities` frontmatter that the engine does not also enforce, so an under-declared flow runs unprompted.",
        "A markdown agent's `flows:` widening its capabilities to `*` without the widened set reaching the approval request.",
        "`Home.read` or `Smithers` rows starting a flow on render or without the person selecting the row.",
        "AGENTS.md or CLAUDE.md text from the repository placed in the system prompt with authority to change approval mode or seats."
      ],
      paths: ["src/flows.ts", "src/flow-control.ts", "src/home.ts", "src/smithers.ts", "src/context.ts", "src/agents.ts", "src/host.ts"]
    },
    {
      id: "credential-routing",
      title: "Detected credentials reach only the provider they belong to",
      threat: "A credential file or API key read at startup is sent to another provider, logged, or shown in the model picker.",
      lookFor: [
        "`Models.detect` returning credential file contents or keys in a field that is rendered, logged or persisted.",
        "SMITHERS_TUI_SEAT or worker seat overrides routing an Anthropic or OpenAI key to an arbitrary endpoint.",
        "`Log.write` or a toast including an Error whose message holds a request header."
      ],
      paths: ["src/models.ts", "src/host.ts", "src/log.ts", "src/runtime.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, unitTests, e2eTests, lint, fmt, docsFiles, recordingSources, ...securityReview }
})
