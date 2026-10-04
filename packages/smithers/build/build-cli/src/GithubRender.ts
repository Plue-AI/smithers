/**
 * Renders `Github.CiGen` declarations into GitHub Actions files.
 *
 * One `Github.CiGen` target owns a deterministic file set under its declaring
 * package directory (`.github` in the Force layout): one workflow YAML per
 * declared `Github.Workflow`, plus the shared composite setup action every
 * generated job starts with. Rendering is a pure function of the validated
 * declarations, the workspace toolchain declaration, and the package index's
 * labels — the same inputs produce the same bytes on every host and from
 * every working directory.
 *
 * `check` byte-compares the rendered set against the checked-in tree and is
 * the CiGen target's lint form; `write` publishes the rendered set
 * atomically. Hand-written files named in `preserve` are never written,
 * never deleted, and never reported as drift. Files inside the declared
 * `changes` write-set that the renderer no longer produces are stale
 * generated output: drift under `check`, removed under `write`. The renderer
 * refuses to write outside the declared write-set.
 *
 * @since 0.1.0
 */

import * as CronTarget from "@smthrs/targets/CronTarget"
import * as GithubTarget from "@smthrs/targets/GithubTarget"
import * as PackageManager from "@smthrs/targets/PackageManager"
import * as Runtime from "@smthrs/targets/Runtime"
import * as Target from "@smthrs/targets/Target"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as Data from "effect/Data"
import * as NodeCrypto from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as GitHooks from "./GitHooks.ts"

/**
 * The refusal codes one render, check, or write can fail with.
 *
 * @category models
 * @since 0.1.0
 */
export type ErrorCode =
  | "unlabeled_cigen"
  | "not_a_workflow"
  | "not_a_setup"
  | "invalid_workflow_name"
  | "duplicate_workflow_name"
  | "multiple_setups"
  | "unlabeled_run_target"
  | "invalid_label"
  | "duplicate_job_id"
  | "invalid_event_name"
  | "invalid_schedule"
  | "invalid_path"
  | "preserve_conflict"
  | "outside_write_set"
  | "write_failed"

/**
 * One typed CI-generation refusal.
 *
 * @category errors
 * @since 0.1.0
 */
export class GithubRenderError extends Data.TaggedError("smithers-build/GithubRenderError")<{
  readonly code: ErrorCode
  readonly message: string
}> {
  constructor(code: ErrorCode, message: string) {
    super({ code, message: `${code}: ${message}` })
  }
}

/**
 * Checks whether a value is a CI-generation refusal.
 *
 * @category guards
 * @since 0.1.0
 */
export const isGithubRenderError = (value: unknown): value is GithubRenderError => value instanceof GithubRenderError

/**
 * The one fact the renderer needs from the package index: a target's label.
 *
 * `PackageIndex` satisfies this shape structurally; tests may substitute a
 * map-backed fake.
 *
 * @category models
 * @since 0.1.0
 */
export interface LabelResolver {
  labelOf(target: Target.AnyTarget): string | undefined
  targets?(): ReadonlyArray<{ readonly label: string; readonly target: Target.AnyTarget }>
}

/**
 * One rendered file: a package-directory-relative POSIX path and its bytes.
 *
 * @category models
 * @since 0.1.0
 */
export interface RenderedFile {
  readonly path: string
  readonly content: string
}

/**
 * The complete rendered output of one `Github.CiGen` target.
 *
 * @category models
 * @since 0.1.0
 */
export interface CiRender {
  /** The CiGen target's own label, named in every generated header. */
  readonly label: string
  /** The workspace-relative package directory the paths resolve against. */
  readonly packageDir: string
  /** Every generated file, sorted by path. */
  readonly files: ReadonlyArray<RenderedFile>
  /** Hand-written paths the generator must never touch. */
  readonly preserve: ReadonlyArray<string>
  /** The declared write-set globs, package-directory-relative. */
  readonly changes: ReadonlyArray<string>
}

// ---------------------------------------------------------------------------
// YAML scalar rendering
// ---------------------------------------------------------------------------

/** Control characters a rendered value may not carry. */
const controlCharacter = /[\u0000-\u0008\u000B-\u001F\u007F]/

/** Quote string scalars consistently so YAML cannot reinterpret their type. */
const scalar = (value: string): string => {
  if (controlCharacter.test(value)) {
    throw new GithubRenderError("invalid_path", `${JSON.stringify(value)} contains a control character`)
  }
  return JSON.stringify(value)
}

/** Renders a `with:` map, keys and values both through {@link scalar}. */
const mapping = (entries: Readonly<Record<string, string>>, indent: string): ReadonlyArray<string> =>
  Object.entries(entries).map(([key, value]) => `${indent}${scalar(key)}: ${scalar(value)}`)

/**
 * The third-party actions the renderer emits, pinned to full commit SHAs.
 *
 * A tag such as `@v4` is mutable: whoever controls or compromises the action's
 * repository can move it and run code in every generated job, including the
 * setup step that receives the cache credentials. Each action is pinned to the
 * commit its tag named when it was last reviewed, with the tag kept as a
 * trailing comment. Bump a pin by resolving the new tag's commit.
 */
const pinnedActions = {
  checkout: { uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262", tag: "v4.4.0" },
  setupNode: { uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020", tag: "v4.4.0" },
  setupGo: { uses: "actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16", tag: "v6.5.0" },
  cache: { uses: "actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830", tag: "v4.3.0" },
  pnpm: { uses: "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1", tag: "v4.3.0" },
  bun: { uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6", tag: "v2.2.0" },
  rust: { uses: "dtolnay/rust-toolchain@6bed0761d98439e5a578e2877258200ad565ba87", tag: "stable" }
} as const

type PinnedAction = (typeof pinnedActions)[keyof typeof pinnedActions]

/** Renders one `- uses:` step line for a pinned action, tag as a comment. */
const usesLine = (indent: string, action: PinnedAction): string => `${indent}- uses: ${action.uses} # ${action.tag}`

// ---------------------------------------------------------------------------
// Declaration projection helpers
// ---------------------------------------------------------------------------

/** Strips the workspace-label prefix from a declared file path. */
const workspacePath = (path: string): string => path.startsWith("//") ? path.slice(2) : path

/**
 * The toolchain facts the composite setup action renders from.
 *
 * Every JavaScript field is optional because a workspace may have no
 * JavaScript in it: a Cargo workspace declares `toolchains` instead of the
 * runtime/packageManager/nodeModules trio, and its setup action installs a
 * Rust toolchain and nothing else. A workspace that declares both renders
 * both, in the order the fields appear here.
 */
interface Toolchain {
  /** `node-version` / `node-version-file` (exclusive) for setup-node, or bun. */
  readonly runtime:
    | { readonly kind: "node-version"; readonly version: string }
    | { readonly kind: "node-version-file"; readonly file: string }
    | { readonly kind: "bun"; readonly version: string }
    | { readonly kind: "go"; readonly file: string }
    | undefined
  /** The declared Rust toolchain layer, as the pin `dtolnay/rust-toolchain` reads. */
  readonly rust: { readonly channel: string | undefined; readonly file: string | undefined } | undefined
  /** The extra action that installs the package manager itself, if any. */
  readonly managerAction:
    | { readonly action: PinnedAction; readonly with?: Readonly<Record<string, string>> }
    | undefined
  /** The package-manager store the cache step saves, absent without one. */
  readonly store:
    | { readonly path: string; readonly prefix: string; readonly lockfile: string; readonly install: string }
    | undefined
  /** The argv prefix that runs a workspace-local binary. */
  readonly exec: ReadonlyArray<string>
}

/** The Rust layer facts, or undefined for a workspace that declares none. */
const rustFacts = (workspace: WorkspaceDeclaration.WorkspaceDeclaration): Toolchain["rust"] => {
  const layer = WorkspaceDeclaration.rustToolchain(workspace)
  if (layer === undefined) return undefined
  return {
    channel: layer.channel,
    file: layer.toolchain === undefined ? undefined : workspacePath(layer.toolchain.path)
  }
}

const runtimeFacts = (
  runtime: Runtime.Runtime | Runtime.NodeDeclaration | Runtime.BunDeclaration
): Toolchain["runtime"] => {
  if (Runtime.isBunDeclaration(runtime)) return { kind: "bun", version: runtime.version }
  if ("name" in runtime && runtime.name === "bun") return { kind: "bun", version: runtime.version }
  if ("name" in runtime && runtime.name === "node") return { kind: "node-version", version: runtime.version }
  // The WORKSPACE.ts NodeDeclaration: an exclusive version | manifest union.
  return runtime.manifest !== undefined
    ? { kind: "node-version-file", file: workspacePath(runtime.manifest.path) }
    : { kind: "node-version", version: runtime.version ?? "" }
}

const toolchainOf = (workspace: WorkspaceDeclaration.WorkspaceDeclaration): Toolchain => {
  const rust = rustFacts(workspace)
  const manager = workspace.packageManager
  if (workspace.runtime === undefined || manager === undefined) {
    const go = workspace.toolchains?.find((entry) => entry._tag === "GoToolchain") as
      | { readonly mod?: { readonly path?: string } }
      | undefined
    return {
      runtime: go === undefined ? undefined : { kind: "go", file: workspacePath(go.mod?.path ?? "go.mod") },
      rust,
      managerAction: undefined,
      store: undefined,
      exec: ["smithers-build"]
    }
  }
  const runtime = runtimeFacts(workspace.runtime)
  if (PackageManager.isYarnDeclaration(manager)) {
    return {
      runtime,
      rust,
      managerAction: undefined,
      store: {
        path: "~/.cache/yarn",
        prefix: "yarn-store-",
        lockfile: workspacePath(manager.lockfile.path),
        install: "yarn install --frozen-lockfile"
      },
      exec: ["yarn", "exec", "smithers-build"]
    }
  }
  if (PackageManager.isPnpmDeclaration(manager)) {
    // Workspace-era pnpm: the runtime comes from the workspace like yarn's,
    // and pnpm/action-setup reads the manifest's packageManager field when
    // the declaration carries no version pin.
    return {
      runtime,
      rust,
      managerAction: {
        action: pinnedActions.pnpm,
        ...(manager.version === undefined ? {} : { with: { version: manager.version } })
      },
      store: {
        path: "~/.pnpm-store",
        prefix: "pnpm-store-",
        lockfile: workspacePath(manager.lockfile.path),
        install: "pnpm install --frozen-lockfile"
      },
      exec: ["pnpm", "exec", "smithers-build"]
    }
  }
  switch (manager.name) {
    case "pnpm":
      return {
        runtime,
        rust,
        managerAction: { action: pinnedActions.pnpm, with: { version: manager.version } },
        store: {
          path: "~/.pnpm-store",
          prefix: "pnpm-store-",
          lockfile: PackageManager.lockfileName(manager),
          install: "pnpm install --frozen-lockfile"
        },
        exec: ["pnpm", "exec", "smithers-build"]
      }
    case "bun":
      return {
        runtime,
        rust,
        managerAction: { action: pinnedActions.bun },
        store: {
          path: "~/.bun/install/cache",
          prefix: "bun-store-",
          lockfile: PackageManager.lockfileName(manager),
          install: "bun install --frozen-lockfile"
        },
        exec: ["bun", "x", "smithers-build"]
      }
  }
}

// ---------------------------------------------------------------------------
// Composite setup action
// ---------------------------------------------------------------------------

const header = (label: string): string =>
  `# Generated by smithers-build from ${label}. Do not edit; run: smithers-build ${label} --write`

/**
 * The `export NAME=` grammar.
 *
 * A declared credential's environment name is written into the generated bash
 * as a bare word. `Secret.Declaration` in `@smthrs/targets` already holds the
 * same grammar, so a name reaching this check has already been refused once;
 * it is restated here because the shell injection it would enable is this
 * module's to prevent, not a schema's to remember.
 */
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Renders the shared composite setup action for one `Github.Setup` target. */
const renderSetupAction = (
  label: string,
  setup: (typeof GithubTarget.SetupAttrs)["Type"],
  workspace: WorkspaceDeclaration.WorkspaceDeclaration
): string => {
  const toolchain = toolchainOf(workspace)
  const lines: Array<string> = [header(label)]
  lines.push("name: setup")
  lines.push("description: Install the workspace toolchain and connect the smithers remote cache.")
  const inputs: Array<{ readonly name: string; readonly env: string }> = []
  if (setup.cacheUrl !== undefined) inputs.push({ name: "cache-url", env: setup.cacheUrl.env })
  if (setup.cacheToken !== undefined) inputs.push({ name: "cache-token", env: setup.cacheToken.env })
  if (inputs.length > 0) {
    lines.push("inputs:")
    for (const input of inputs) {
      lines.push(`  ${input.name}:`)
      lines.push(`    description: Exported to the job environment as ${input.env}.`)
      lines.push("    required: false")
      lines.push("    default: \"\"")
    }
  }
  lines.push("runs:")
  lines.push("  using: composite")
  lines.push("  steps:")
  if (toolchain.managerAction !== undefined) {
    lines.push(usesLine("    ", toolchain.managerAction.action))
    if (toolchain.managerAction.with !== undefined) {
      lines.push("      with:", ...mapping(toolchain.managerAction.with, "        "))
    }
  }
  switch (toolchain.runtime?.kind) {
    case "node-version":
      lines.push(usesLine("    ", pinnedActions.setupNode))
      lines.push("      with:", ...mapping({ "node-version": toolchain.runtime.version }, "        "))
      break
    case "node-version-file":
      lines.push(usesLine("    ", pinnedActions.setupNode))
      lines.push("      with:", ...mapping({ "node-version-file": toolchain.runtime.file }, "        "))
      break
    case "bun":
      // setup-bun installed the runtime above; nothing further to declare.
      break
    case "go":
      lines.push(usesLine("    ", pinnedActions.setupGo))
      lines.push("      with:", ...mapping({ "go-version-file": toolchain.runtime.file }, "        "))
      break
    case undefined:
      // A toolchain-only workspace: nothing to install for JavaScript.
      break
  }
  if (toolchain.rust !== undefined) {
    // The declared layer is the pin: the channel when the workspace names one,
    // and stable otherwise, which rustup then overrides from the pin file on
    // first use. A SHA-pinned rust-toolchain cannot infer the channel from its
    // ref, so the input is always explicit.
    lines.push(usesLine("    ", pinnedActions.rust))
    lines.push("      with:", ...mapping({ toolchain: toolchain.rust.channel ?? "stable" }, "        "))
  }
  if (toolchain.store !== undefined) {
    lines.push(usesLine("    ", pinnedActions.cache))
    lines.push(
      "      with:",
      ...mapping({
        path: toolchain.store.path,
        key: `${toolchain.store.prefix}\${{ hashFiles('${toolchain.store.lockfile}') }}`,
        "restore-keys": toolchain.store.prefix
      }, "        ")
    )
    lines.push(`    - run: ${scalar(toolchain.store.install)}`)
    lines.push("      shell: bash")
  }
  if (inputs.length > 0) {
    // GitHub substitutes `${{ ... }}` textually before bash parses the script,
    // so an input carrying a double quote, `$(...)`, a backtick, or a newline
    // used to escape the string and either run commands on the runner or
    // inject extra `NAME=VALUE` records into $GITHUB_ENV. These values are
    // cache credentials. Every input is bound through the step's `env:` map
    // instead, so no expression appears inside `run:`, and each record is
    // written with the documented heredoc form under a delimiter drawn at
    // runtime, which no value can predict.
    for (const input of inputs) {
      if (!environmentName.test(input.env)) {
        throw new GithubRenderError(
          "invalid_path",
          `${JSON.stringify(input.env)} is not an environment variable name`
        )
      }
    }
    const shellName = (input: { readonly name: string }): string =>
      `SMTHRS_INPUT_${input.name.replaceAll("-", "_").toUpperCase()}`
    lines.push("    - run: |")
    lines.push(`        if [ -n "$${shellName(inputs[0]!)}" ]; then`)
    lines.push(
      "          delimiter=\"smthrs_$(openssl rand -hex 16 2>/dev/null " +
        "|| od -An -tx1 -N16 /dev/urandom | tr -d ' \\n')\""
    )
    for (const input of inputs) {
      const variable = shellName(input)
      lines.push(`          case "$${variable}" in *"$delimiter"*) exit 1 ;; esac`)
      lines.push(`          printf '%s<<%s\\n' ${input.env} "$delimiter" >> "$GITHUB_ENV"`)
      lines.push(`          printf '%s\\n' "$${variable}" >> "$GITHUB_ENV"`)
      lines.push("          printf '%s\\n' \"$delimiter\" >> \"$GITHUB_ENV\"")
    }
    lines.push("        fi")
    lines.push("      shell: bash")
    lines.push("      env:")
    for (const input of inputs) {
      lines.push(`        ${shellName(input)}: \${{ inputs.${input.name} }}`)
    }
  }
  return `${lines.join("\n")}\n`
}

// ---------------------------------------------------------------------------
// Workflow rendering
// ---------------------------------------------------------------------------

/** The file-name grammar a declared workflow name must satisfy. */
const workflowName = /^[A-Za-z0-9_-]+$/

/** The event-name grammar the `cancelInProgress` sugar accepts. */
const eventName = /^[a-z][a-z_]*$/

/** Five whitespace-separated fields; GitHub validates the field contents. */
const cronExpression = /^\S+ \S+ \S+ \S+ \S+$/

/** GitHub job ids must start with a letter or `_`. */
const jobIdStart = /^[A-Za-z_]/

/** Derives a deterministic GitHub job id from a target label. */
const jobIdOf = (label: string): string => {
  const mangled = label.slice(2).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return jobIdStart.test(mangled) ? mangled : `run-${mangled}`
}

/** Largest Shell.Test shard fan-out reachable from one workflow run root. */
const shardCountOf = (target: Target.AnyTarget, seen = new Set<Target.AnyTarget>()): number => {
  if (seen.has(target)) return 1
  seen.add(target)
  const metadata = Target.metadata(target)
  const direct =
    metadata.target === "Shell.Test" && typeof (metadata.attrs as { readonly shards?: unknown }).shards === "number"
      ? (metadata.attrs as { readonly shards: number }).shards
      : 1
  return Math.max(direct, ...metadata.dependencies.map((dependency) => shardCountOf(dependency, seen)))
}

/** Appends one run value, rendering line arrays and multiline strings as one script. */
const renderRun = (lines: Array<string>, prefix: string, run: string | ReadonlyArray<string>): void => {
  const script = typeof run === "string" ? run : run.join("\n")
  if (!script.includes("\n")) {
    lines.push(`${prefix}run: ${scalar(script)}`)
    return
  }
  lines.push(`${prefix}run: |`)
  for (const line of script.split("\n")) lines.push(`${prefix}  ${line}`)
}

/** Appends one raw step without inserting checkout, setup, or another command. */
const renderStep = (lines: Array<string>, step: GithubTarget.Step): void => {
  const propertyIndent = "        "
  if (step.name !== undefined) lines.push(`      - name: ${scalar(step.name)}`)
  else if ("uses" in step) lines.push(`      - uses: ${scalar(step.uses)}`)
  else {
    const script = typeof step.run === "string" ? step.run : step.run.join("\n")
    if (script.includes("\n")) {
      lines.push("      - run: |")
      for (const line of script.split("\n")) lines.push(`          ${line}`)
    } else {
      lines.push(`      - run: ${scalar(script)}`)
    }
  }
  if (step.id !== undefined) lines.push(`${propertyIndent}id: ${scalar(step.id)}`)
  if (step.if !== undefined) lines.push(`${propertyIndent}if: ${scalar(step.if)}`)
  if (step.name !== undefined) {
    if ("uses" in step) lines.push(`${propertyIndent}uses: ${scalar(step.uses)}`)
    else renderRun(lines, propertyIndent, step.run)
  }
  if ("with" in step && step.with !== undefined) {
    lines.push(`${propertyIndent}with:`, ...mapping(step.with, `${propertyIndent}  `))
  }
  if ("shell" in step && step.shell !== undefined) {
    lines.push(`${propertyIndent}shell: ${scalar(step.shell)}`)
  }
  if ("workingDirectory" in step && step.workingDirectory !== undefined) {
    lines.push(`${propertyIndent}working-directory: ${scalar(step.workingDirectory)}`)
  }
  if (step.env !== undefined) lines.push(`${propertyIndent}env:`, ...mapping(step.env, `${propertyIndent}  `))
}

/** Appends policy shared by target-derived and raw-step jobs. */
const renderJobPolicy = (
  lines: Array<string>,
  workflow: (typeof GithubTarget.WorkflowAttrs)["Type"]
): void => {
  if (workflow.jobName !== undefined) lines.push(`    name: ${scalar(workflow.jobName)}`)
  if (workflow.condition !== undefined) lines.push(`    if: ${scalar(workflow.condition)}`)
  lines.push(`    runs-on: ${scalar(workflow.runsOn ?? "ubuntu-latest")}`)
  if (workflow.environment !== undefined) lines.push(`    environment: ${scalar(workflow.environment)}`)
}

/**
 * Renders one pull-request-shaped trigger under `on:`.
 *
 * `pull_request` and `pull_request_target` accept the same branch and activity
 * filters, so one writer serves both and a trigger the schema accepts cannot
 * reach the YAML for only one of them.
 */
const pushPullRequestEvent = (
  lines: Array<string>,
  event: "pull_request" | "pull_request_target",
  on: (typeof GithubTarget.On)["Type"]["pullRequest"]
): void => {
  if (on === undefined || on === false) return
  lines.push(`  ${event}:`)
  if (on === true) return
  if (on.branches !== undefined) {
    lines.push("    branches:")
    for (const branch of on.branches) lines.push(`      - ${scalar(branch)}`)
  }
  if (on.types !== undefined) {
    lines.push("    types:")
    for (const activity of on.types) lines.push(`      - ${scalar(activity)}`)
  }
}

/** Renders one workflow YAML for a validated `Github.Workflow` target. */
const renderWorkflow = (
  label: string,
  packageDir: string,
  workflow: (typeof GithubTarget.WorkflowAttrs)["Type"],
  runs: ReadonlyArray<{ readonly label: string; readonly target: Target.AnyTarget }>,
  setup: (typeof GithubTarget.SetupAttrs)["Type"] | undefined,
  toolchain: Toolchain
): string => {
  const lines: Array<string> = [header(label)]
  lines.push(`name: ${scalar(workflow.name)}`)
  lines.push("on:")
  pushPullRequestEvent(lines, "pull_request", workflow.on.pullRequest)
  pushPullRequestEvent(lines, "pull_request_target", workflow.on.pullRequestTarget)
  if (workflow.on.issues !== undefined) {
    lines.push("  issues:")
    if (workflow.on.issues.types !== undefined) {
      lines.push("    types:")
      for (const activity of workflow.on.issues.types) lines.push(`      - ${scalar(activity)}`)
    }
  }
  if (workflow.on.push !== undefined) {
    lines.push("  push:")
    lines.push("    branches:")
    for (const branch of workflow.on.push.branches) lines.push(`      - ${scalar(branch)}`)
  }
  if (workflow.on.schedule !== undefined) {
    lines.push("  schedule:")
    for (const cron of workflow.on.schedule) {
      if (!cronExpression.test(cron)) {
        throw new GithubRenderError(
          "invalid_schedule",
          `schedule ${JSON.stringify(cron)} is not a five-field cron expression`
        )
      }
      lines.push(`    - cron: ${scalar(cron)}`)
    }
  }
  if (workflow.on.release !== undefined) {
    lines.push("  release:")
    lines.push("    types:")
    for (const activity of workflow.on.release) lines.push(`      - ${scalar(activity)}`)
  }
  if (workflow.on.workflowDispatch === true) lines.push("  workflow_dispatch:")
  if (typeof workflow.on.workflowDispatch === "object") {
    lines.push("  workflow_dispatch:")
    const inputs = Object.entries(workflow.on.workflowDispatch.inputs)
    if (inputs.length > 0) lines.push("    inputs:")
    for (const [name, input] of inputs) {
      lines.push(`      ${scalar(name)}:`)
      if (input.description !== undefined) lines.push(`        description: ${scalar(input.description)}`)
      if (input.required !== undefined) lines.push(`        required: ${input.required ? "true" : "false"}`)
      if (input.default !== undefined) {
        lines.push(`        default: ${typeof input.default === "string" ? scalar(input.default) : input.default}`)
      }
      lines.push(`        type: ${input.type}`)
      if (input.options !== undefined) {
        lines.push("        options:")
        for (const option of input.options) lines.push(`          - ${scalar(option)}`)
      }
    }
  }
  if (workflow.concurrency !== undefined) {
    lines.push("concurrency:")
    lines.push(`  group: ${scalar(workflow.concurrency.group)}`)
    const cancel = workflow.concurrency.cancelInProgress
    if (typeof cancel === "boolean") {
      lines.push(`  cancel-in-progress: ${cancel ? "true" : "false"}`)
    } else {
      if (!eventName.test(cancel)) {
        throw new GithubRenderError(
          "invalid_event_name",
          `cancelInProgress ${JSON.stringify(cancel)} is neither a boolean nor an event name`
        )
      }
      lines.push(`  cancel-in-progress: \${{ github.event_name == '${cancel}' }}`)
    }
  }
  if (workflow.permissions !== undefined || workflow.affected) {
    lines.push(
      "permissions:",
      ...mapping({ contents: "read", ...workflow.permissions, ...(workflow.affected ? { actions: "read" } : {}) }, "  ")
    )
  }
  if (workflow.env !== undefined) lines.push("env:", ...mapping(workflow.env, "  "))
  lines.push("jobs:")
  const seen = new Set<string>()
  if (workflow.steps !== undefined) {
    const jobId = jobIdOf(`//:${workflow.name}`)
    seen.add(jobId)
    lines.push(`  ${jobId}:`)
    renderJobPolicy(lines, workflow)
    lines.push("    steps:")
    for (const step of workflow.steps) renderStep(lines, step)
  }
  for (const run of runs) {
    const runLabel = run.label
    if (!GitHooks.labelPattern.test(runLabel)) {
      throw new GithubRenderError("invalid_label", `${JSON.stringify(runLabel)} is not a renderable target label`)
    }
    const shards = shardCountOf(run.target)
    const jobId = jobIdOf(runLabel)
    if (seen.has(jobId)) {
      throw new GithubRenderError(
        "duplicate_job_id",
        `two run entries of workflow ${workflow.name} derive one job id ${jobId}`
      )
    }
    seen.add(jobId)
    lines.push(`  ${jobId}:`)
    if (workflow.jobName !== undefined) lines.push(`    name: ${scalar(workflow.jobName)}`)
    if (workflow.condition !== undefined) lines.push(`    if: ${scalar(workflow.condition)}`)
    lines.push(`    runs-on: ${scalar(workflow.runsOn ?? "ubuntu-latest")}`)
    if (shards > 1) {
      lines.push("    strategy:")
      lines.push("      matrix:")
      lines.push(`        shard: [${Array.from({ length: shards }, (_, index) => index + 1).join(", ")}]`)
      lines.push(`        total-shards: [${shards}]`)
      lines.push("    env:")
      lines.push("      SMTHRS_SHARD: \"${{ matrix.shard }}/${{ matrix.total-shards }}\"")
    }
    if (workflow.environment !== undefined) lines.push(`    environment: ${scalar(workflow.environment)}`)
    lines.push("    steps:")
    lines.push(usesLine("      ", pinnedActions.checkout))
    if (workflow.affected && workflow.on.pullRequest) lines.push("        with:", "          fetch-depth: 2")
    if (setup !== undefined) {
      lines.push(`      - uses: ./${packageDir}/actions/setup`)
      const withEntries: Record<string, string> = {}
      if (setup.cacheUrl !== undefined) withEntries["cache-url"] = `\${{ secrets.${setup.cacheUrl.env} }}`
      if (setup.cacheToken !== undefined) withEntries["cache-token"] = `\${{ secrets.${setup.cacheToken.env} }}`
      if (Object.keys(withEntries).length > 0) {
        lines.push("        with:", ...mapping(withEntries, "          "))
      }
    }
    const affected = workflow.affected === true && shards === 1
    const command = [
      ...toolchain.exec,
      ...(affected ? ["affected", "ci"] : []),
      `'${runLabel}'`,
      ...(affected ? ["--base-green"] : [])
    ].join(" ")
    lines.push(`      - run: ${scalar(command)}`)
    if (affected) {
      lines.push(
        "        env:",
        "          GITHUB_TOKEN: ${{ github.token }}",
        `          SMTHRS_CI_JOB: ${scalar(workflow.jobName ?? jobId)}`
      )
    }
  }
  return `${lines.join("\n")}\n`
}

// ---------------------------------------------------------------------------
// CiGen rendering
// ---------------------------------------------------------------------------

/** A package-directory-relative POSIX path, confined to the directory. */
const relativePath = (value: string, what: string): string => {
  const segments = value.split("/")
  if (
    value === "" || value.startsWith("/") || value.includes("\\") || value.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new GithubRenderError("invalid_path", `${what} ${JSON.stringify(value)} is not a confined relative path`)
  }
  return value
}

/**
 * Renders the complete file set one `Github.CiGen` target owns.
 *
 * @category rendering
 * @since 0.1.0
 */
export const render = (options: {
  readonly ciGen: Target.AnyTarget
  readonly workspace: WorkspaceDeclaration.WorkspaceDeclaration
  readonly resolve: LabelResolver
  readonly packageDir: string
}): CiRender => {
  const label = options.resolve.labelOf(options.ciGen)
  if (label === undefined) {
    throw new GithubRenderError("unlabeled_cigen", "the Github.CiGen target has no label; list it in a Package map")
  }
  const attrs = GithubTarget.ciGenAttrsOf(options.ciGen)
  const toolchain = toolchainOf(options.workspace)
  const workflowDirectory = (attrs.changes ?? [])
    .map((change) => change.replace(/\/\*\*$/, ""))
    .find((change) => change === "workflows" || change.endsWith("/workflows")) ?? "workflows"
  const files: Array<RenderedFile> = []
  const names = new Set<string>()
  let setupTarget: Target.AnyTarget | undefined
  for (const workflowTarget of attrs.workflows) {
    let workflow: (typeof GithubTarget.WorkflowAttrs)["Type"]
    try {
      workflow = GithubTarget.workflowAttrsOf(workflowTarget)
    } catch (cause) {
      throw new GithubRenderError(
        "not_a_workflow",
        `CiGen workflows entries must be Github.Workflow targets: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      )
    }
    if (!workflowName.test(workflow.name)) {
      throw new GithubRenderError(
        "invalid_workflow_name",
        `workflow name ${JSON.stringify(workflow.name)} is not usable as a file name`
      )
    }
    if (names.has(workflow.name)) {
      throw new GithubRenderError("duplicate_workflow_name", `two workflows declare the name ${workflow.name}`)
    }
    names.add(workflow.name)
    let setup: (typeof GithubTarget.SetupAttrs)["Type"] | undefined
    if (workflow.setup !== undefined) {
      if (setupTarget !== undefined && setupTarget !== workflow.setup) {
        throw new GithubRenderError(
          "multiple_setups",
          "the declared workflows name two distinct Github.Setup targets; share one"
        )
      }
      setupTarget = workflow.setup
      try {
        setup = GithubTarget.setupAttrsOf(workflow.setup)
      } catch (cause) {
        throw new GithubRenderError(
          "not_a_setup",
          `a workflow setup attr must be a Github.Setup target: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        )
      }
    }
    const runs = workflow.run.map((target) => {
      const runLabel = options.resolve.labelOf(target)
      if (runLabel === undefined) {
        throw new GithubRenderError(
          "unlabeled_run_target",
          `a run entry of workflow ${workflow.name} has no label; list it in a Package map`
        )
      }
      return { label: runLabel, target }
    })
    files.push({
      path: `${workflowDirectory}/${workflow.name}.yml`,
      content: renderWorkflow(label, options.packageDir, workflow, runs, setup, toolchain)
    })
  }
  // Cron is an inert package-level trigger declaration. A compact or expanded
  // CI generator in the same graph projects every labeled Cron into a normal
  // GitHub schedule workflow; no second scheduler or executor path exists.
  for (const row of options.resolve.targets?.() ?? []) {
    if (Target.metadata(row.target).target !== "Cron") continue
    const cron = CronTarget.attrsOf(row.target)
    const key = row.label.slice(row.label.lastIndexOf(":") + 1)
    const name = `cron-${key}`
    if (names.has(name)) {
      throw new GithubRenderError("duplicate_workflow_name", `Cron ${row.label} collides with workflow ${name}`)
    }
    names.add(name)
    const run = [...(cron.refresh ?? []), ...cron.run]
    const runs = run.map((target) => {
      const runLabel = options.resolve.labelOf(target)
      if (runLabel === undefined) {
        throw new GithubRenderError(
          "unlabeled_run_target",
          `a run entry of Cron ${row.label} has no label; list it in a Package map`
        )
      }
      return { label: runLabel, target }
    })
    files.push({
      path: `${workflowDirectory}/${name}.yml`,
      content: renderWorkflow(
        label,
        options.packageDir,
        GithubTarget.WorkflowAttrs.make({ name, on: { schedule: [cron.schedule] }, run }),
        runs,
        undefined,
        toolchain
      )
    })
  }
  if (setupTarget !== undefined) {
    files.push({
      path: "actions/setup/action.yml",
      content: renderSetupAction(label, GithubTarget.setupAttrsOf(setupTarget), options.workspace)
    })
  }
  const preserve = (attrs.preserve ?? []).map((path) => relativePath(path, "preserve entry"))
  for (const file of files) {
    if (preserve.includes(file.path)) {
      throw new GithubRenderError(
        "preserve_conflict",
        `${file.path} is both rendered and preserved; rename the workflow or drop the preserve entry`
      )
    }
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return {
    label,
    packageDir: options.packageDir,
    files,
    preserve,
    changes: [...(attrs.changes ?? [])]
  }
}

// ---------------------------------------------------------------------------
// Check and write
// ---------------------------------------------------------------------------

/** Compiles one write-set glob (`*` within a segment, `**` across them). */
const globToRegExp = (glob: string): RegExp => {
  let source = "^"
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!
    if (character === "*") {
      if (glob[index + 1] === "*") {
        source += ".*"
        index += 1
      } else {
        source += "[^/]*"
      }
    } else if ("\\^$.|?+()[]{}".includes(character)) {
      source += `\\${character}`
    } else {
      source += character
    }
  }
  return new RegExp(`${source}$`)
}

/** Whether a relative path falls inside the declared write-set. */
const insideWriteSet = (changes: ReadonlyArray<RegExp>, path: string): boolean =>
  changes.some((pattern) => pattern.test(path))

/** Lists every regular file under a directory, as sorted relative POSIX paths. */
const listFiles = async (directory: string): Promise<ReadonlyArray<string>> => {
  const found: Array<string> = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await Fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(NodePath.join(current, entry.name), relative)
      else if (entry.isFile()) found.push(relative)
    }
  }
  await walk(directory, "")
  return found.sort()
}

/**
 * One file's drift classification.
 *
 * @category models
 * @since 0.1.0
 */
export type FileStatus = "clean" | "stale" | "missing" | "unexpected" | "preserved"

/**
 * One classified file row of a check report.
 *
 * @category models
 * @since 0.1.0
 */
export interface CheckEntry {
  readonly path: string
  readonly status: FileStatus
}

/**
 * The result of byte-comparing a rendered set against the checked-in tree.
 *
 * @category models
 * @since 0.1.0
 */
export interface CheckReport {
  readonly clean: boolean
  readonly entries: ReadonlyArray<CheckEntry>
}

/**
 * Byte-compares the rendered file set against the tree under `root`.
 *
 * A rendered file that matches is `clean`; different bytes are `stale`; an
 * absent file is `missing`. A file inside the declared write-set that is
 * neither rendered nor preserved is `unexpected` stale generated output.
 * Preserved files are reported `preserved` and never count as drift.
 *
 * @category checking
 * @since 0.1.0
 */
export const check = async (root: string, rendered: CiRender): Promise<CheckReport> => {
  const directory = NodePath.join(root, rendered.packageDir)
  const entries: Array<CheckEntry> = []
  for (const file of rendered.files) {
    let status: FileStatus
    try {
      const existing = await Fs.readFile(NodePath.join(directory, file.path), "utf8")
      status = existing === file.content ? "clean" : "stale"
    } catch {
      status = "missing"
    }
    entries.push({ path: file.path, status })
  }
  const patterns = rendered.changes.map(globToRegExp)
  const renderedPaths = new Set(rendered.files.map((file) => file.path))
  for (const path of await listFiles(directory)) {
    if (renderedPaths.has(path)) continue
    if (rendered.preserve.includes(path)) {
      entries.push({ path, status: "preserved" })
      continue
    }
    if (insideWriteSet(patterns, path)) entries.push({ path, status: "unexpected" })
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return {
    clean: entries.every((entry) => entry.status === "clean" || entry.status === "preserved"),
    entries
  }
}

/**
 * The result of publishing a rendered set.
 *
 * @category models
 * @since 0.1.0
 */
export interface WriteReport {
  readonly wrote: ReadonlyArray<string>
  readonly unchanged: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
  readonly preserved: ReadonlyArray<string>
}

/**
 * Publishes the rendered file set under `root`, atomically per file.
 *
 * Every rendered path must fall inside the declared `changes` write-set when
 * one is declared. Each file lands via a same-directory temporary name and
 * rename, so a reader sees the old bytes or the new bytes, never a torn
 * write. Files inside the write-set that are neither rendered nor preserved
 * are stale generated output and are removed. Preserved files are never
 * written and never removed.
 *
 * @category writing
 * @since 0.1.0
 */
export const write = async (root: string, rendered: CiRender): Promise<WriteReport> => {
  const directory = NodePath.join(root, rendered.packageDir)
  const patterns = rendered.changes.map(globToRegExp)
  if (rendered.changes.length > 0) {
    for (const file of rendered.files) {
      if (!insideWriteSet(patterns, file.path)) {
        throw new GithubRenderError(
          "outside_write_set",
          `${file.path} falls outside the declared changes write-set`
        )
      }
    }
  }
  const wrote: Array<string> = []
  const unchanged: Array<string> = []
  for (const file of rendered.files) {
    const absolute = NodePath.join(directory, relativePath(file.path, "rendered path"))
    try {
      const existing = await Fs.readFile(absolute, "utf8")
      if (existing === file.content) {
        unchanged.push(file.path)
        continue
      }
    } catch {
      // Absent: fall through to the write below.
    }
    const temporary = `${absolute}.tmp-${process.pid}-${NodeCrypto.randomBytes(4).toString("hex")}`
    try {
      await Fs.mkdir(NodePath.dirname(absolute), { recursive: true })
      await Fs.writeFile(temporary, file.content, "utf8")
      await Fs.rename(temporary, absolute)
    } catch (cause) {
      await Fs.rm(temporary, { force: true }).catch(() => undefined)
      throw new GithubRenderError(
        "write_failed",
        `${file.path} could not be published: ${cause instanceof Error ? cause.message : String(cause)}`
      )
    }
    wrote.push(file.path)
  }
  const removed: Array<string> = []
  const preserved: Array<string> = []
  const renderedPaths = new Set(rendered.files.map((file) => file.path))
  for (const path of await listFiles(directory)) {
    if (renderedPaths.has(path)) continue
    if (rendered.preserve.includes(path)) {
      preserved.push(path)
      continue
    }
    if (!insideWriteSet(patterns, path)) continue
    try {
      await Fs.rm(NodePath.join(directory, path))
    } catch (cause) {
      throw new GithubRenderError(
        "write_failed",
        `stale generated file ${path} could not be removed: ${cause instanceof Error ? cause.message : String(cause)}`
      )
    }
    removed.push(path)
  }
  return { wrote, unchanged, removed, preserved }
}
