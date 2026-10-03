/**
 * Generated GitHub Actions CI workflow.
 *
 * The pipeline is a target graph and one verb over it. A job declares what it
 * REQUIRES ({@link CiToolchain.Toolchain}) and which targets it runs
 * ({@link TargetStep}); nothing in the declaration is a command. Every argv the
 * rendered workflow carries is produced here or by the declaration it came from:
 * the install by {@link PackageManager.install}, the interpreter version by the
 * declared {@link Runtime}, the Rust install by {@link RustToolchain.install},
 * the target invocation by {@link PackageManager.exec} over the CLI verb.
 *
 * That is the whole point of the rewrite this module went through. A PACKAGE.ts
 * file that spells `run: "node --test scripts/pack-release.test.mjs"` has put a
 * gate outside the build graph: it is not planned, not keyed, not cached, not
 * addressable, and not runnable locally by the same name CI uses. Bazel's answer
 * is that every check is a test target and CI is `bazel test //...`; this module
 * is that answer for GitHub Actions.
 *
 * @since 0.1.0
 */

import type { Action } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as CiToolchain from "./CiToolchain.ts"
import { DriftError, generateFile, resolveOutputPath, WriteFileError } from "./GeneratedFile.ts"
import { independentGateCondition } from "./GithubWorkflow.ts"
import * as Input from "./Input.ts"
import * as Nix from "./Nix.ts"
import * as PackageManager from "./PackageManager.ts"
import * as RemoteCache from "./RemoteCache.ts"
import * as RustToolchain from "./RustToolchain.ts"
import * as Secret from "./Secret.ts"
import * as Target from "./Target.ts"
import * as Verb from "./Verb.ts"

/**
 * How a CI workflow target treats its output file.
 *
 * - `check` — byte-compare the checked-in workflow against the rendered form,
 *   and fail on drift. The DEFAULT, matching every other generated root file.
 * - `write` — render the declared jobs and write the file.
 *
 * Only `write` touches the working tree, and only a target that declares it
 * gets it. `lint` maps `write` to `check` so no lint or CI run mutates a
 * workflow file.
 *
 * @category schemas
 * @since 0.1.0
 */
export const OutputMode = Schema.Literals(["write", "check"]).pipe(
  Schema.withConstructorDefault(Effect.succeed("check" as const))
)

/**
 * How a CI workflow target treats its output file.
 *
 * @category models
 * @since 0.1.0
 */
export type OutputMode = typeof OutputMode.Type

/**
 * The largest `--jobs` bound a generated pipeline step may declare. Higher is
 * a number no GitHub-hosted runner has the cores to honour, so it would be a
 * declaration that reads as a promise the pipeline cannot keep.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumParallelism = 256

/**
 * One invocation of the build system over part of the target graph.
 *
 * This is the ONLY thing a job can be declared to do. There is no free-form
 * command field anywhere in this schema: a step names a verb and a target
 * pattern, and the argv that runs them is rendered here from the declared
 * package manager. A gate that is not a target is a gate this declaration
 * cannot express, which is the constraint that keeps gates in the graph.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TargetStep = Schema.Struct({
  /** Operator-facing step name. Defaults to the verb and pattern it runs. */
  name: Schema.optional(Schema.NonEmptyString),
  /**
   * The CLI verb, as a typed {@link Verb.PipelineVerb} value. `Verb.Ci` is the
   * aggregate: one invocation that plans every kind over the pattern, rather
   * than four that re-plan the same graph.
   */
  verb: Verb.PipelineVerb,
  /**
   * The targets the verb runs over, in the CLI's label grammar: `//...`,
   * `//pkg/...`, `//pkg`, `//pkg:target`, `//:target`, or a recursive pattern
   * narrowed to one target name, `//pkg/...:target`. A pattern is a label,
   * not a command — the same kind of value {@link Input.file} takes — and it is
   * validated against that grammar before it is rendered.
   */
  pattern: Schema.NonEmptyString,
  /**
   * How many targets this invocation executes at once, rendered as `--jobs`.
   * Omitted leaves the CLI's own default, which sizes itself to the host. A
   * runner whose heavy suites carry finite per-test budgets needs a smaller
   * bound than the host suggests, because host parallelism starves them.
   */
  parallelism: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(maximumParallelism))
  )
})

/**
 * One invocation of the build system over part of the target graph.
 *
 * @category models
 * @since 0.1.0
 */
export type TargetStep = typeof TargetStep.Type

/**
 * One target invocation the pipeline must still perform.
 *
 * A gate is a claim about coverage that outlives the job list: "the docs verb
 * still runs over the packages". It is checked structurally against the declared
 * steps, not by matching text in the rendered YAML, so a gate cannot be
 * satisfied by a comment that happens to contain the right words.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Gate = Schema.Struct({
  /** Operator-facing name, used in the failure message. */
  name: Schema.NonEmptyString,
  verb: Verb.Verb,
  pattern: Schema.NonEmptyString,
  /** When present, the job id the invocation must appear in. */
  job: Schema.optional(Schema.NonEmptyString)
})

/**
 * One target invocation the pipeline must still perform.
 *
 * @category models
 * @since 0.1.0
 */
export type Gate = typeof Gate.Type

/**
 * The smallest `timeout-minutes` GitHub Actions runs. Zero and negative values
 * are a workflow the runner rejects.
 *
 * @category constants
 * @since 0.1.0
 */
export const minimumTimeoutMinutes = 1

/**
 * The largest `timeout-minutes` GitHub Actions honours. A larger value is
 * silently capped, so the rendered job would not enforce the timeout it
 * declares.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumTimeoutMinutes = 360

/**
 * One row of a job's platform matrix.
 *
 * A row is DATA, not a condition. GitHub offers two ways to let one platform be
 * red without failing the pipeline: a literal `continue-on-error: true` on the
 * whole job, which makes every platform advisory at once, and an expression
 * reading the matrix context, whose value each row supplies for itself. This
 * generator emits no per-row `if:` key (cache publication uses a whole-job guard
 * on a {@link Job.publishesToCache} job), so a per-platform allowance has to be
 * the second one: the advisory bit is carried in an `include:` row beside the
 * runner label, and the job renders `continue-on-error: ${{ matrix.advisory }}`
 * once. Promoting a platform from advisory to required is then one boolean in
 * PACKAGE.ts, and {@link validateJobs} checks the promotion rather than trusting
 * it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const MatrixRow = Schema.Struct({
  /**
   * The runner this row runs on. Exactly ONE runner label, not the label set
   * {@link Job.runsOn} accepts: a row's value is also its `include:` key, and
   * GitHub matches an include row against the base combination by value, so a
   * sequence there is a row whose advisory bit may or may not attach.
   */
  os: Schema.NonEmptyString,
  /**
   * Whether a red run of THIS row leaves the pipeline green.
   *
   * A platform is advisory exactly until it is proven green, and no longer.
   *
   * @default false
   */
  advisory: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false)))
})

/**
 * One row of a job's platform matrix.
 *
 * @category models
 * @since 0.1.0
 */
export type MatrixRow = typeof MatrixRow.Type

/**
 * One declared job.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Job = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.optional(Schema.NonEmptyString),
  /**
   * The runner, for a job that runs on one. A job declares this or
   * {@link Job.matrix}, never both and never neither.
   */
  runsOn: Schema.optional(Schema.NonEmptyString),
  /**
   * The platforms this job runs on, one row each, rendered as a build matrix.
   *
   * One declaration instead of a copy-pasted job per platform: the steps, the
   * toolchain, and the timeout are written once and every platform runs them.
   */
  matrix: Schema.optional(Schema.Array(MatrixRow)),
  /**
   * `timeout-minutes`, in the range GitHub Actions supports. Zero and negative
   * values are rejected by the runner, and anything above 360 is silently
   * clamped, so both render a job that does not do what it declares.
   */
  timeoutMinutes: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(minimumTimeoutMinutes),
      Schema.isLessThanOrEqualTo(maximumTimeoutMinutes)
    )
  ),
  /**
   * Whether a red run of this job leaves the pipeline green. A matrix job
   * carries the bit per row instead, in {@link MatrixRow.advisory}.
   */
  continueOnError: Schema.optional(Schema.Boolean),
  /**
   * Whether this job holds the write credential and publishes to the remote
   * cache.
   *
   * A publishing job is rendered with
   * `if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/<branch>' }}`
   * over the declared push branches, so no `pull_request` run of it can ever
   * receive the credential; every other job receives only the read credential.
   * The trust model is `packages/smithers/build/infra/CACHE-TRUST.md`: readers are
   * untrusted, writers are post-merge trunk jobs only. Absent means false.
   */
  publishesToCache: Schema.optional(Schema.Boolean),
  /** What the runner must provide before the first target runs. */
  toolchain: CiToolchain.Toolchain,
  steps: Schema.Array(TargetStep)
})

/**
 * One declared job.
 *
 * @category models
 * @since 0.1.0
 */
export type Job = typeof Job.Type

/**
 * Attributes for {@link GithubCiGen}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  /** @default "CI" */
  workflowName: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("CI"))
  ),
  /** @default ["main"] */
  pushBranches: Schema.Array(Schema.NonEmptyString).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>(["main"]))
  ),
  /** @default true */
  pullRequest: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(true))
  ),
  /** @default true */
  workflowDispatch: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(true))
  ),
  /**
   * Lightweight workflows can use `commit` to group by workflow, event, ref and
   * SHA without cancelling any run. Omitted or `ref` keeps the full workflow's
   * ref/PR grouping and honors `cancelInProgress`.
   */
  concurrency: Schema.optional(Schema.Literals(["ref", "commit"])),
  /** @default true */
  cancelInProgress: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(true))
  ),
  /**
   * The package manager every job installs the workspace with and runs the
   * smthrs binary through, so a workspace that switches managers gets
   * a regenerated workflow rather than a pipeline still calling pnpm.
   *
   * Omitted — which is what a PACKAGE.ts writes — the executor fills it in
   * from the `WORKSPACE.ts` declaration before the workflow is rendered, so
   * the generated pipeline and the local build always name the same manager.
   */
  packageManager: Schema.optional(PackageManager.PackageManager),
  /**
   * The declared secret overriding the root RemoteCache endpoint.
   *
   * A {@link Secret} declaration rather than two strings. The old pair named a
   * GitHub secret and, separately, the environment variable it landed in, which
   * let a workflow set a variable nothing read. One declaration names the
   * variable, and the generated step reads the repository secret of the same
   * name, so the two cannot disagree.
   */
  cacheUrlSecret: Schema.optional(Secret.Declaration),
  /**
   * The declared secret supplying the remote-cache bearer token. When
   * {@link cacheWriteTokenSecret} is also declared, this is the READ
   * credential, rendered into every job.
   */
  cacheTokenSecret: Schema.optional(Secret.Declaration),
  /**
   * The declared secret supplying the remote-cache WRITE bearer token.
   *
   * When declared, {@link cacheTokenSecret} is the read credential and this
   * entry is rendered only into jobs that declare
   * {@link Job.publishesToCache}, each guarded to post-merge push runs, so a
   * `pull_request` job can pull at full speed and publish nothing. The trust
   * model and rollout ordering are `packages/smithers/build/infra/CACHE-TRUST.md`.
   */
  cacheWriteTokenSecret: Schema.optional(Secret.Declaration),
  /**
   * The GitHub deployment environment holding the write credential, required
   * with {@link cacheWriteTokenSecret}.
   *
   * The `if:` guard only decides whether a job starts. A repository secret is
   * readable by any workflow a branch in the repository defines, including a
   * `pull_request` run of an edited workflow file, so the write credential
   * lives in an environment whose deployment branch policy admits only the
   * push branches, and every publishing job names it. GitHub then withholds
   * the secret from a job on any other ref, whatever its workflow says.
   */
  cacheWriteEnvironment: Schema.optional(Schema.String),
  /** The jobs the workflow declares. A generated workflow needs at least one. @default [] */
  jobs: Schema.Array(Job).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Job>>([]))
  ),
  /** The target invocations the pipeline must perform, in every mode. @default [] */
  gates: Schema.Array(Gate).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Gate>>([]))
  ),
  /**
   * Job ids the workflow must define. Checked against the render, so removing a
   * job without removing it here is a throw at plan time rather than a pipeline
   * that quietly stopped running a lane.
   */
  requiredJobs: Schema.Array(Schema.NonEmptyString).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /**
   * Declared workflow output path. This stays a string because outputs are
   * declared paths, not input references. `check` derives a read declaration
   * from the same output path for its non-writing view.
   *
   * @default ".github/workflows/ci.yml"
   */
  output: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed(".github/workflows/ci.yml"))
  ),
  /**
   * Workspace-relative path of the known-red list every step passes as
   * `--known-red`. A target the list names, with an owner and an expiry, is
   * still run and reported but does not fail the step; any other red target
   * does. Omitted, every red target fails its step.
   */
  knownRed: Schema.optional(Schema.NonEmptyString),
  /**
   * Whether every step also writes its per-label summary with
   * `--results-file` and each job uploads those files as the artifact
   * `smthrs-results-<job>-<index>-<attempt>`. A check receipt reads a label's
   * status from that artifact, never from the log.
   */
  results: Schema.optional(Schema.Boolean),
  mode: OutputMode
})

/**
 * Attributes for {@link GithubCiGen}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * The pinned action references the generator emits.
 *
 * They are constants of the implementation, not attrs. An action reference is
 * an argv by another name: a PACKAGE.ts file that could name one could name any
 * program the runner will fetch and execute, which is the surface this module
 * exists to close.
 *
 * @category constants
 * @since 0.1.0
 */
export const actions = {
  checkout: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262", // v4
  setupNode: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020", // v4
  setupBun: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6", // v2.2.0
  setupPnpm: "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86", // v6
  installTool: "taiki-e/install-action@e67fa11c4b9316fa714ddf0abed07a0c3143b95b", // v2
  setupGo: "actions/setup-go@40f1582b2485089dde7abd97c1529aa768e1baff", // v5
  foundryToolchain: "foundry-rs/foundry-toolchain@908c540300062bd5a7e473851cdb4282204cee09", // v1
  rustCache: "Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6", // v2
  uploadArtifact: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", // v4
  nixInstallerDeterminate: "DeterminateSystems/nix-installer-action@e50d5f73bfe71c2dd0aa4218de8f4afa59f8f81d", // v16
  nixInstallerCachix: "cachix/install-nix-action@13d8dd58da0234aa297dedd986986ccb8e7f3e24" // v31
} as const

/**
 * Immutable image manifests for the actionlint releases accepted above.
 *
 * @category constants
 * @since 0.1.0
 */
export const actionlintImages: Readonly<Record<CiToolchain.ActionlintRelease, string>> = {
  "1.7.11": "docker://rhysd/actionlint@sha256:6f03470d0152251d7f07f7c4dc019dbe7024c72cd952f839544c7798843efa8f"
}

/**
 * Control characters a rendered value may not carry. Tab and newline are
 * legitimate inside a script and are handled by the block-scalar form; the
 * rest are not. A carriage return is the one that bites: it survives into the
 * generated script and the shell then runs a command with a stray `\r`.
 */
const controlCharacter = /[\u0000-\u0008\u000B-\u001F\u007F]/

/** Quote string scalars consistently so YAML cannot reinterpret their type. */
const scalar = (value: string): string => {
  if (controlCharacter.test(value)) {
    throw new Error(`GithubCiGen: ${JSON.stringify(value)} contains a control character`)
  }
  return JSON.stringify(value)
}

/**
 * A `runs-on` flow sequence of plain runner labels, `[self-hosted, linux]`.
 * Quoting the whole sequence would turn a label set into a single nonexistent
 * label, so the sequence is re-rendered label by label and everything else is
 * quoted as one scalar.
 */
const runnerSequence = /^\[\s*([A-Za-z0-9_.-]+(?:\s*,\s*[A-Za-z0-9_.-]+)*)\s*\]$/

/**
 * Renders a runner, keeping a label set a sequence.
 *
 * Each label is judged on its own terms: a reserved label inside the sequence
 * (`[self-hosted, null]`) resolves to null and silently drops out of the label
 * set, so it is quoted while its neighbours stay plain.
 *
 * A value that OPENS a YAML flow collection without being a label set is
 * refused rather than quoted. Quoting `[self-hosted, my label]` or
 * `{group: g, labels: [x]}` would turn a collection into one label string that
 * no runner carries, which is a job that never picks up — a silent downgrade
 * exactly where the renderer must fail closed.
 */
const runner = (value: string): string => {
  const match = value.match(runnerSequence)
  if (match !== null) return `[${match[1]!.split(",").map((label) => scalar(label.trim())).join(", ")}]`
  if (value.startsWith("[") || value.startsWith("{")) {
    throw new Error(
      `GithubCiGen: ${
        JSON.stringify(value)
      } is not a runner label set; use one label, or [label, label] with labels of [A-Za-z0-9_.-]`
    )
  }
  return scalar(value)
}

/**
 * The only GitHub expressions this generator emits, and the only ones it needs.
 *
 * They are constants of the implementation, exactly like {@link actions}: a
 * matrix job's `runs-on` and `continue-on-error` read the row GitHub is
 * currently running, and nothing in {@link Attrs} can put an expression here.
 * They are rendered PLAIN rather than through `scalar`, because a quoted
 * `continue-on-error` value is a string GitHub coerces rather than the boolean
 * the row declares, and the plain form is the one GitHub documents.
 *
 * @category constants
 * @since 0.1.0
 */
export const matrixExpressions = {
  os: "${{ matrix.os }}",
  advisory: "${{ matrix.advisory }}"
} as const

/**
 * Whether a matrix's rows keep running after one of them goes red.
 *
 * A constant, and `false`. A platform matrix asks which platforms are green;
 * cancelling the remaining rows the moment one fails throws away the answer,
 * which is the whole reason the matrix exists.
 *
 * @category constants
 * @since 0.1.0
 */
export const matrixFailFast = false

/**
 * One runner label, the only `os` a matrix row may carry.
 *
 * The same character set {@link runnerSequence} allows inside a label set,
 * which excludes whitespace, quotes, and `$`, so a row can carry no GitHub
 * expression and no YAML collection.
 */
const runnerLabel = /^[A-Za-z0-9_.-]+$/

/**
 * Renders a `with:` or `env:` map.
 *
 * The KEY goes through `scalar` too. A key is declared a string just as a value
 * is, and YAML resolves a plain `NO:`, `ON:`, or `Y:` to a boolean, so an
 * environment variable named `NO` would reach the runner as the key `false`.
 */
const mapping = (
  entries: Readonly<Record<string, string>>,
  indent: string
): ReadonlyArray<string> => Object.entries(entries).map(([key, value]) => `${indent}${scalar(key)}: ${scalar(value)}`)

/**
 * The `if:` of every gate step: it runs after an earlier gate went
 * red, but never after a failed setup step or a cancellation.
 *
 * @category rendering
 * @since 0.1.0
 */
export const independentGate = `\${{ ${independentGateCondition} }}` as const

/**
 * One rendered YAML step.
 *
 * Deliberately not exported and deliberately not part of {@link Attrs}: this is
 * the generator's own output shape, and the only code that constructs one is
 * this module.
 */
interface RenderedStep {
  readonly name?: string
  /** Marks the last setup step, whose conclusion {@link independentGate} reads. */
  readonly id?: "setup"
  /**
   * The step's `if:`. Diagnostic collection/upload runs `always()`: it must
   * survive a failed required gate. Every gate runs {@link independentGate}.
   */
  readonly condition?: "always()" | typeof independentGate
  readonly uses?: string
  readonly run?: string
  /** The shell that runs `run`. Unset, GitHub picks bash on Linux and macOS and pwsh on Windows. */
  readonly shell?: string
  readonly with?: Readonly<Record<string, string>>
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Renders one step as the YAML lines of a `steps:` item, at `indent`.
 *
 * The single renderer for every step shape this module produces, which is why
 * it is exported: a shape no caller builds today is still one line away from
 * being built, so each shape is asserted here rather than only through the
 * jobs that happen to exist.
 *
 * @category rendering
 * @since 0.1.0
 */
export const renderStep = (step: RenderedStep, indent: string): ReadonlyArray<string> => {
  const lines: Array<string> = []
  const fields: Array<string> = []
  if (step.name !== undefined) fields.push(`name: ${scalar(step.name)}`)
  if (step.id !== undefined) fields.push(`id: ${step.id}`)
  if (step.condition !== undefined) fields.push(`if: ${step.condition}`)
  if (step.uses !== undefined) fields.push(`uses: ${scalar(step.uses)}`)
  if (step.run !== undefined) {
    fields.push(step.run.includes("\n") ? "run: |" : `run: ${scalar(step.run)}`)
  }
  if (step.shell !== undefined) fields.push(`shell: ${scalar(step.shell)}`)
  if (step.uses === undefined && step.run === undefined) {
    throw new Error("a CI step must declare uses or run")
  }
  lines.push(`${indent}- ${fields[0]}`)
  const inner = `${indent}  `
  // A blank script line is emitted blank, not as indentation alone, so a
  // generated file carries no trailing whitespace.
  const body = (): void => {
    for (const line of step.run!.split("\n")) lines.push(line === "" ? "" : `${inner}  ${line}`)
  }
  // A block scalar owns every line below it until the indentation drops back,
  // so the body follows its `run: |` key immediately, whether that key opened
  // the step or came after one. Emitted after the remaining fields instead, a
  // nameless multi-line step reads as an empty `run` and a `shell` that
  // swallowed the script.
  if (fields[0] === "run: |") body()
  for (const field of fields.slice(1)) {
    lines.push(`${inner}${field}`)
    if (field === "run: |") body()
  }
  if (step.with !== undefined && Object.keys(step.with).length > 0) {
    lines.push(`${inner}with:`, ...mapping(step.with, `${inner}  `))
  }
  if (step.env !== undefined && Object.keys(step.env).length > 0) {
    lines.push(`${inner}env:`, ...mapping(step.env, `${inner}  `))
  }
  return lines
}

/**
 * One package-path or target-name component of a target pattern.
 *
 * A component starts with a letter, a digit, or `_`, which rejects the
 * option-like forms (`--help`, `-x`) whose only effect in a generated command
 * is a green no-op, and rejects `.` and `..` traversal along with them. It
 * carries no shell metacharacter, no `*`, no whitespace, and no quote.
 */
const patternComponent = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

/** Whether every component of a package path is a supported one. */
const packagePath = (path: string): boolean => path.split("/").every((part) => patternComponent.test(part))

/**
 * Whether a string is a target pattern the CLI's label grammar accepts.
 *
 * The supported forms are exactly `//...`, `//pkg/...`, `//pkg`, `//pkg:target`,
 * `//:target`, and the two recursive patterns narrowed to one target name,
 * `//...:target` and `//pkg/...:target`. Everything else is refused, which is
 * what makes the generated command safe to render: `*` never reaches the shell
 * to be expanded against the checkout, `--help` never turns a step into a usage
 * message that exits 0, and `//a/../b`, `//a//b`, and `//a:b:c` never become a
 * pattern the CLI would reject at run time instead of at plan time.
 *
 * @category validation
 * @since 0.1.0
 */
export const targetPattern = (pattern: string): boolean => {
  if (!pattern.startsWith("//")) return false
  const body = pattern.slice(2)
  // The target suffix is split off first, so `//pkg/...:target` is one form
  // rather than a package literally named `pkg/...`.
  const colon = body.indexOf(":")
  if (colon !== -1 && body.indexOf(":", colon + 1) !== -1) return false
  const head = colon === -1 ? body : body.slice(0, colon)
  const target = colon === -1 ? undefined : body.slice(colon + 1)
  if (target !== undefined && !patternComponent.test(target)) return false
  if (head === "...") return true
  if (head.endsWith("/...")) {
    const prefix = head.slice(0, -4)
    return prefix !== "" && packagePath(prefix)
  }
  if (target === undefined) return head !== "" && packagePath(head)
  return head === "" || packagePath(head)
}

/**
 * Renders a validated pattern as ONE shell word.
 *
 * `targetPattern` already excludes the single quote, so the single-quoted form
 * is always well formed, and it is a literal word in every default GitHub
 * Actions shell — `bash` on Linux and macOS, `pwsh` on Windows. Nothing inside
 * is expanded, so a pattern is passed to the CLI exactly as declared.
 */
const shellArgument = (pattern: string): string => `'${pattern}'`

/** The install argv every job that installs the workspace runs. */
const installArgv = (attrs: Attrs): ReadonlyArray<string> =>
  PackageManager.install(attrs.packageManager, { frozen: true, ignoreScripts: true })

/**
 * Renders one target invocation as a shell command.
 *
 * The workspace binary is resolved through the declared package manager, so the
 * CLI that runs is the one the lockfile pinned, never a fetched one.
 * CI retains plain failure diagnostics even when its noninteractive streams
 * select the agent audience; quiet summaries alone hide the failing tests.
 *
 * @category rendering
 * @since 0.1.0
 */
export const stepCommand = (attrs: Attrs, step: TargetStep, nix?: CiToolchain.NixSetup | undefined): string => {
  if (step.verb.name === "review") {
    throw new Error("GithubCiGen: model review requires a trusted review host and an explicitly pinned policy")
  }
  return [
    ...developPrefix(nix),
    ...PackageManager.exec(attrs.packageManager, ["smthrs", Verb.command(step.verb)]),
    shellArgument(step.pattern),
    ...(step.parallelism === undefined ? [] : ["--jobs", String(step.parallelism)]),
    ...(attrs.knownRed === undefined ? [] : ["--known-red", shellArgument(attrs.knownRed)]),
    // GITHUB_ACTION is unique per step within a job, so no two steps share a file.
    ...(attrs.results === true ? ["--results-file", `"$RUNNER_TEMP/${resultsDirectory}/$GITHUB_ACTION.json"`] : []),
    "--verbose"
  ].join(" ")
}

/**
 * Whether a string is a workspace-relative file path that renders as one
 * single-quoted shell word: relative, with no `..` segment, and no quote,
 * whitespace, or control character.
 *
 * @category rendering
 * @since 1.0.0
 */
export const relativeFilePath = (path: string): boolean =>
  /^[A-Za-z0-9._/-]+$/.test(path) && path.split("/").every((part) => part !== "" && part !== "..")

/**
 * The `nix develop <environment> --command` prefix every command of a job
 * with a Nix environment runs behind, so the tools the command spawns come
 * from the closure and never from the runner image.
 */
const developPrefix = (nix: CiToolchain.NixSetup | undefined): ReadonlyArray<string> =>
  nix === undefined ? [] : ["nix", "develop", ...Nix.developArguments(nix.environment), "--command"]

/**
 * The extra `nix.conf` lines a declared binary cache adds, each value a
 * `secrets.<NAME>` expression the workflow reads at run time.
 */
const nixExtraConf = (nix: CiToolchain.NixSetup): string | undefined => {
  if (nix.substituter === undefined || nix.publicKey === undefined) return undefined
  return [
    `extra-substituters = \${{ secrets.${nix.substituter.env} }}`,
    `extra-trusted-public-keys = \${{ secrets.${nix.publicKey.env} }}`
  ].join("\n")
}

/** The steps that install Nix and, when declared, trust a binary cache. */
const nixSteps = (nix: CiToolchain.NixSetup): ReadonlyArray<RenderedStep> => {
  const extraConf = nixExtraConf(nix)
  switch (nix.installer) {
    case "determinate":
      return [{
        name: "Install Nix",
        uses: actions.nixInstallerDeterminate,
        ...(extraConf === undefined ? {} : { with: { "extra-conf": extraConf } })
      }]
    case "cachix":
      return [{
        name: "Install Nix",
        uses: actions.nixInstallerCachix,
        ...(extraConf === undefined ? {} : { with: { extra_nix_config: extraConf } })
      }]
  }
}

/** The setup action for the declared package manager, when it needs one. */
const managerSetupAction = (declared: PackageManager.PackageManager | undefined): string | undefined => {
  switch (PackageManager.required(declared).name) {
    case "pnpm":
      return actions.setupPnpm
    // Bun is installed by its own runtime setup; a second action would install
    // the same program twice.
    case "bun":
      return undefined
  }
}

/** Text a generated shell script may echo, single-quoted. */
const echoableText = /^[A-Za-z0-9 ,.:;()/@_=+-]+$/

/** Renders one diagnostic line of a generated shell script. */
const diagnostic = (text: string): string => {
  if (!echoableText.test(text)) {
    throw new Error(`GithubCiGen: ${JSON.stringify(text)} is not usable as a generated diagnostic`)
  }
  return `echo '${text}' >&2`
}

/**
 * Renders one declared value as a single shell word.
 *
 * Validation at the declaration boundary already refuses shell syntax; quoting
 * here is the second guard, so a value that ever slips past the first one is
 * still one word and still the word that was declared.
 */
const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** The steps one declared interpreter installation renders to. */
const runtimeSteps = (
  setup: CiToolchain.RuntimeSetup,
  manager: PackageManager.Name
): ReadonlyArray<RenderedStep> => {
  switch (setup.name) {
    case "node":
      return [
        {
          uses: actions.setupNode,
          with: {
            // The declaration carries exactly one of the two, so the job either
            // names the release or points at the file that does, never both.
            ...(setup.versionFile === undefined
              ? { "node-version": setup.release as string }
              : { "node-version-file": setup.versionFile }),
            ...(setup.cachePackageStore && manager === "pnpm" ? { cache: manager } : {})
          }
        },
        ...(setup.npmRelease === undefined ? [] : [{
          name: "Install certified npm",
          shell: "bash",
          run: [
            `npm install --global ${shellWord(`npm@${setup.npmRelease}`)} --ignore-scripts --no-audit --no-fund`,
            `test "$(npm --version)" = ${shellWord(setup.npmRelease)}`
          ].join("\n")
        }])
      ]
    case "bun":
      return [{ uses: actions.setupBun, with: { "bun-version": setup.release } }]
  }
}

/**
 * The steps a job's declared requirements render to, in the order a runner
 * needs them.
 *
 * Checkout first, because nothing else can read the tree, and with whatever
 * the job declared about it: its submodules, and the history depth a target
 * that diffs against a base revision needs. Workflow linting next,
 * because it is the cheapest failure and needs nothing installed. Then the
 * package manager, the interpreters, and the install, because the install needs
 * both. Then the toolchains a suite spawns, and last the assertions about the
 * runner image itself.
 *
 * @category rendering
 * @since 0.1.0
 */
export const toolchainSteps = (attrs: Attrs, job: Job): ReadonlyArray<RenderedStep> => {
  const needs = job.toolchain
  // The checkout `with:` map is assembled from the declared requirements, in a
  // fixed key order, so two jobs asking for the same thing render the same
  // bytes. A job that asks for neither renders a bare `uses:` step, exactly as
  // before this map existed.
  const checkoutWith: Record<string, string> = {
    ...(needs.submodules ? { submodules: "recursive" } : {}),
    ...(needs.fetchDepth === undefined ? {} : { "fetch-depth": String(needs.fetchDepth) })
  }
  const steps: Array<RenderedStep> = [{
    uses: actions.checkout,
    ...(Object.keys(checkoutWith).length === 0 ? {} : { with: checkoutWith })
  }]
  if (needs.workflowLint !== undefined) {
    steps.push({
      name: "Validate GitHub Actions workflows",
      uses: actionlintImages[needs.workflowLint.release],
      with: { args: needs.workflowLint.workflows.join(" ") }
    })
  }
  // Language toolchains go BEFORE the package manager and its install.
  // `actions/setup-go` prepends its own bin directories to PATH, which
  // displaced the pnpm shim corepack had put there: the job's own
  // `pnpm exec smthrs` still resolved, but every nested target the
  // build tool spawned died with `spawn pnpm ENOENT` in under a second. That
  // took 51 targets down at once and read like 51 defects. Installing them
  // first leaves the package manager's setup last, so its PATH entry wins.
  if (needs.go !== undefined) {
    steps.push({
      name: "Install Go",
      uses: actions.setupGo,
      with: { "go-version": needs.go.release }
    })
  }
  if (needs.foundry !== undefined) {
    steps.push({
      name: "Install Foundry",
      uses: actions.foundryToolchain,
      with: { version: needs.foundry.release }
    })
  }
  if (needs.docker !== undefined) {
    // This toolchain step has no `if:` key, so its script detects the runner: a
    // runner with no docker daemon, or one whose daemon already reports the
    // containerd snapshotter (`docker info` names the storage driver
    // `overlayfs` then, `overlay2` otherwise), runs nothing. The existing
    // daemon.json is merged rather than replaced, because the hosted image
    // configures the daemon there and dropping that would change every other
    // docker invocation in the job.
    steps.push({
      name: "Enable the containerd image store",
      shell: "bash",
      run: [
        "if command -v docker >/dev/null 2>&1 && [ \"$(uname -s)\" = Linux ] \\",
        "  && [ \"$(docker info --format '{{.Driver}}' 2>/dev/null)\" != overlayfs ]; then",
        "  if [ -f /etc/docker/daemon.json ]; then",
        "    merged=\"$(jq '.features[\"containerd-snapshotter\"] = true' /etc/docker/daemon.json)\"",
        "  else",
        "    merged='{ \"features\": { \"containerd-snapshotter\": true } }'",
        "  fi",
        "  printf '%s\\n' \"$merged\" | sudo tee /etc/docker/daemon.json >/dev/null",
        "  sudo systemctl restart docker",
        "  docker info --format 'docker storage driver: {{.Driver}}'",
        "fi"
      ].join("\n")
    })
  }
  if (needs.nix !== undefined) {
    // The environment supplies the package manager and the interpreters, so
    // no setup action runs; the install itself runs inside the dev shell.
    steps.push(...nixSteps(needs.nix))
    if (needs.install) steps.push({ run: [...developPrefix(needs.nix), ...installArgv(attrs)].join(" ") })
  } else {
    const managerSetup = managerSetupAction(attrs.packageManager)
    if (needs.install && managerSetup !== undefined) steps.push({ uses: managerSetup })
    const manager = PackageManager.required(attrs.packageManager).name
    for (const setup of needs.runtimes) steps.push(...runtimeSteps(setup, manager))
    if (needs.install) steps.push({ run: installArgv(attrs).join(" ") })
  }
  if (needs.rust !== undefined) {
    steps.push({
      name: "Install pinned Rust toolchain",
      run: RustToolchain.install(needs.rust.toolchain).join(" ")
    })
    // Registry state and compiled dependencies, keyed on Cargo.lock. A native
    // dependency build dominates a Rust job's time without it.
    if (needs.rust.cache) steps.push({ uses: actions.rustCache })
  }
  if (needs.cargoBinaries !== undefined && needs.cargoBinaries.length > 0) {
    if (!needs.rust?.cache) steps.push({ uses: actions.rustCache })
    for (const binary of needs.cargoBinaries) {
      const platforms = binary.platforms.map((platform) =>
        platform === "darwin" ? "Darwin" : platform === "win32" ? "MINGW*|MSYS*" : "Linux"
      ).join("|")
      steps.push({
        name: `Install native ${binary.binary}`,
        shell: "bash",
        run: [
          `case "$(uname -s)" in ${platforms})`,
          "  native_suffix=''",
          "  case \"$(uname -s)\" in MINGW*|MSYS*) native_suffix='.exe';; esac",
          `  rustup toolchain install ${shellWord(binary.toolchain)} --profile minimal`,
          `  cargo +${binary.toolchain} build --locked -p ${shellWord(binary.package)} --bin ${
            shellWord(binary.binary)
          }`,
          "  mkdir -p \"$RUNNER_TEMP/smithers-native\"",
          `  native_path="$RUNNER_TEMP/smithers-native/${binary.binary}$native_suffix"`,
          `  install -m 755 "target/debug/${binary.binary}$native_suffix" "$native_path"`,
          "  if [ \"$native_suffix\" = '.exe' ]; then native_path=\"$(cygpath -w \"$native_path\")\"; fi",
          `  printf '%s=%s\\n' ${shellWord(binary.environment)} "$native_path" >> "$GITHUB_ENV"`,
          "esac"
        ].join("\n")
      })
    }
  }
  if (needs.jj !== undefined) {
    steps.push({
      name: "Install jj",
      uses: actions.installTool,
      with: { tool: `jj-cli@${needs.jj.release}` }
    })
    if (needs.jj.colocate) {
      steps.push({ name: "Initialize colocated jj repository", run: "jj git init --colocate" })
    }
  }
  if (needs.ripgrep !== undefined) {
    steps.push({
      name: "Install ripgrep",
      uses: actions.installTool,
      with: { tool: `ripgrep@${needs.ripgrep.release}` }
    })
  }
  if (needs.apt !== undefined) {
    // This toolchain step has no `if:` key, so its script detects the runner: a
    // runner without apt-get (macOS, Windows) runs nothing and stays green.
    // That needs the script to reach a POSIX shell: GitHub runs `run:` under
    // pwsh on Windows, which rejects `if command -v` as a parse error before
    // the guard can decide anything, so the step names bash, which every
    // hosted image ships.
    //
    // Installing bubblewrap is not enough to make it work. `bwrap` unshares a
    // network namespace and then brings up loopback, which needs CAP_NET_ADMIN
    // inside the new user namespace, and ubuntu-24.04 restricts unprivileged
    // user namespaces through AppArmor. Every confined target therefore died
    // with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`, 74
    // tests on the required row, for a mechanism the host had installed and
    // would not let run. The sysctl lifts exactly that restriction, on a
    // throwaway VM, so the suite exercises real confinement instead of
    // reporting which host it ran on. It is guarded twice: `bubblewrap` has to
    // be among the declared packages, and the key has to exist on this kernel.
    const sandboxSetup = needs.apt.packages.includes("bubblewrap")
      ? [
        "  if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then",
        "    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
        "  fi"
      ]
      : []
    steps.push({
      name: "Install system packages",
      shell: "bash",
      run: [
        "if command -v apt-get >/dev/null 2>&1; then",
        `  sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends ${
          needs.apt.packages.map(shellWord).join(" ")
        }`,
        ...sandboxSetup,
        ...(needs.apt.packages.includes("openssh-server") ? ["  sudo install -d -m 0755 /run/sshd"] : []),
        "fi"
      ].join("\n")
    })
  }
  if (needs.postgres !== undefined) {
    // Targets inherit PATH but not arbitrary variables, so the binaries reach
    // the storage matrix through GITHUB_PATH. One step serves the platform
    // matrix by detecting the runner, under bash for the reason the apt step
    // gives. The Debian package would create and start a cluster nobody uses;
    // the matrix starts its own, so the default cluster is switched off.
    const release = needs.postgres.release
    steps.push({
      name: "Install PostgreSQL",
      shell: "bash",
      run: [
        "case \"$(uname -s)\" in",
        "  Linux)",
        "    sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends postgresql-common",
        "    sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null",
        "    echo 'create_main_cluster = false' | sudo tee -a /etc/postgresql-common/createcluster.conf >/dev/null",
        `    sudo apt-get install -y -qq --no-install-recommends ${shellWord(`postgresql-${release}`)}`,
        `    pg_bin=/usr/lib/postgresql/${release}/bin path_entry="$pg_bin" floor=${release}`,
        "    ;;",
        "  Darwin)",
        `    HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install --quiet ${
          shellWord(`postgresql@${release}`)
        }`,
        `    pg_bin="$(brew --prefix ${shellWord(`postgresql@${release}`)})/bin" path_entry="$pg_bin" floor=${release}`,
        "    ;;",
        "  MINGW*|MSYS*)",
        `    pg_bin="$(cygpath -u "\${PGBIN:?the runner image names no PostgreSQL in PGBIN}")" path_entry="$PGBIN" floor=${CiToolchain.postgresFloor}`,
        "    ;;",
        "  *) echo \"no PostgreSQL install for $(uname -s)\" >&2; exit 1 ;;",
        "esac",
        "version=\"$(\"$pg_bin/initdb\" --version)\"",
        "major=\"${version#*) }\"",
        "major=\"${major%%[!0-9]*}\"",
        "if [ -z \"$major\" ] || [ \"$major\" -lt \"$floor\" ]; then",
        "  echo \"$version is not PostgreSQL $floor or later\" >&2",
        "  exit 1",
        "fi",
        "echo \"$version\"",
        "printf '%s\\n' \"$path_entry\" >> \"$GITHUB_PATH\""
      ].join("\n")
    })
  }
  if (needs.browser !== undefined) {
    const executable = needs.browser.executable
    steps.push({
      name: "Assert the runner ships the declared browser",
      run: [
        `if [ ! -x ${shellWord(executable)} ]; then`,
        `  ${diagnostic(`${executable} is missing from this runner image.`)}`,
        `  ${diagnostic(needs.browser.reason)}`,
        "  exit 1",
        "fi",
        `${shellWord(executable)} --version`
      ].join("\n")
    })
  }
  return steps
}

/**
 * The steps a job's declared artifact upload renders to.
 *
 * Only these diagnostic steps use `always()`: GitHub otherwise skips them
 * after the failure they need to explain. Required gates retain their normal
 * failure semantics. An empty upload is allowed only when no source is required.
 *
 * @category rendering
 * @since 0.1.0
 */
export const artifactSteps = (upload: CiToolchain.ArtifactUpload): ReadonlyArray<RenderedStep> => {
  const artifact = CiToolchain.validatePath(upload.artifact, "artifact name")
  const root = `"$RUNNER_TEMP/${artifact}"`
  const copies = upload.sources.map((source) => {
    const from = CiToolchain.validatePath(source.from, "artifact source")
      .split("*")
      .map((part) => `'${part}'`)
      .join("*")
    const destination = source.as === undefined
      ? root
      : `"$RUNNER_TEMP/${artifact}/${CiToolchain.validatePath(source.as, "artifact destination")}"`
    if (source.required === true) {
      // `from` has already passed path validation, so the diagnostic is safe to quote.
      const missing = `echo 'Required artifact source is missing: ${source.from}' >&2; exit 1`
      if (!source.from.includes("*")) {
        return `if [ ! -e ${from} ]; then ${missing}; fi\ncp -R -- ${from} ${destination}`
      }
      return [
        "artifact_source_found=false",
        `for f in ${from}; do if [ -e "$f" ]; then artifact_source_found=true; cp -R -- "$f" ${destination}; fi; done`,
        `if [ "$artifact_source_found" = false ]; then ${missing}; fi`
      ].join("\n")
    }
    // A green run often leaves nothing to collect: an unexpanded glob must not
    // fail the job (PR #1631: the e2e suites passed and the bare `cp` of
    // /tmp/smithers-*.png exited 1). Guard each source on existence; a source
    // that exists but fails to copy still fails the step loudly.
    //
    // The loop is what a GLOB needs, and only a glob. `for f in 'apps/reports'`
    // iterates one quoted literal, which shellcheck reports as SC2041 through
    // the actionlint the workflow-lint step runs, so the required job goes red
    // over a fixed path that needs no expansion at all. A fixed source renders
    // the existence guard on its own.
    if (!source.from.includes("*")) return `if [ -e ${from} ]; then cp -R -- ${from} ${destination}; fi`
    return `for f in ${from}; do if [ -e "$f" ]; then cp -R -- "$f" ${destination}; fi; done`
  })
  return [
    { name: `Collect ${upload.artifact}`, condition: "always()", run: [`mkdir -p ${root}`, ...copies].join("\n") },
    uploadStep(`Upload ${upload.artifact}`, artifact, artifact, upload.sources.some((source) => source.required === true) ? "error" : "ignore")
  ]
}

/** The `$RUNNER_TEMP` directory every step's `--results-file` writes into. */
const resultsDirectory = "smthrs-results"

/** The always-run upload of `$RUNNER_TEMP/<directory>` as the artifact `name`; one shape for every upload. */
const uploadStep = (stepName: string, name: string, directory: string, ifNoFiles: "error" | "ignore"): RenderedStep => ({
  name: stepName,
  condition: "always()",
  uses: actions.uploadArtifact,
  with: { name, path: `\${{ runner.temp }}/${directory}`, "if-no-files-found": ifNoFiles }
})

/**
 * A job's per-step results files. The name carries the run attempt, since an
 * artifact name cannot repeat within a run and a rerun uploads again, and the
 * matrix index only for matrix jobs, where `strategy.job-index` is defined.
 */
const resultsUpload = (jobId: string, matrix: boolean): RenderedStep =>
  uploadStep(
    "Upload smthrs results",
    `${resultsDirectory}-${jobId}-${matrix ? "${{ strategy.job-index }}" : "0"}-\${{ github.run_attempt }}`,
    resultsDirectory,
    "error"
  )

/** The empty results record each job writes before its setup steps. */
const resultsMarker: RenderedStep = {
  name: "Start smthrs results",
  shell: "bash",
  run: `mkdir -p "$RUNNER_TEMP/${resultsDirectory}" && printf '%s\\n' '{"version":1,"results":[]}' > "$RUNNER_TEMP/${resultsDirectory}/attempt.json"`
}

/** GitHub's own job-id shape: a letter or `_`, then letters, digits, `-`, `_`. */
const jobIdShape = /^[A-Za-z_][A-Za-z0-9_-]*$/

/**
 * Rejects a job whose runner declaration this generator cannot render.
 *
 * A job runs on ONE runner or over a matrix of them, never both and never
 * neither: `runs-on` and the matrix are two descriptions of the same thing, and
 * a job with neither is one GitHub refuses to schedule. The rows themselves are
 * checked the way every other rendered value is — a row carries one runner
 * label, so a matrix cannot smuggle in a YAML collection or a GitHub expression
 * — and a repeated platform is refused because GitHub would run the row twice
 * while its two `include:` rows disagree about the advisory bit.
 */
const validateJobRunners = (job: Job): void => {
  if (job.matrix === undefined) {
    if (job.runsOn === undefined) {
      throw new Error(`GithubCiGen: job ${JSON.stringify(job.id)} declares no runs-on and no matrix`)
    }
    return
  }
  if (job.runsOn !== undefined) {
    throw new Error(
      `GithubCiGen: job ${JSON.stringify(job.id)} declares both runs-on and a matrix; declare one`
    )
  }
  if (job.continueOnError !== undefined) {
    throw new Error(
      `GithubCiGen: job ${
        JSON.stringify(job.id)
      } declares continue-on-error beside a matrix; the advisory bit belongs to the row`
    )
  }
  if (job.matrix.length === 0) {
    throw new Error(`GithubCiGen: job ${JSON.stringify(job.id)} declares an empty matrix`)
  }
  const platforms = new Set<string>()
  for (const row of job.matrix) {
    if (!runnerLabel.test(row.os)) {
      throw new Error(
        `GithubCiGen: ${JSON.stringify(row.os)} is not a runner label; use one label per matrix row`
      )
    }
    if (platforms.has(row.os)) {
      throw new Error(
        `GithubCiGen: job ${JSON.stringify(job.id)} repeats the matrix platform ${JSON.stringify(row.os)}`
      )
    }
    platforms.add(row.os)
  }
}

/** Whether every lane of a job is allowed to be red. */
const isWhollyAdvisory = (job: Job): boolean =>
  job.matrix === undefined ? job.continueOnError === true : job.matrix.every((row) => row.advisory)

/**
 * Rejects declared jobs GitHub Actions would refuse, shadow, or run empty, and
 * declarations this generator cannot render.
 *
 * Every target here is a shape the Actions contract already forbids or a
 * declaration that would render a pipeline doing less than it claims: duplicate
 * job ids render duplicate YAML mapping keys (GitHub keeps the last, and a gate
 * could match the one that never runs), a job needs at least one target step,
 * and a job that runs a target step without installing the workspace has no
 * binary to run it with.
 */
/**
 * One push branch, as a literal inside a single-quoted GitHub expression.
 *
 * The set excludes quotes, whitespace, `$`, and `{`, so a branch name can
 * carry no expression and cannot close the quote it is rendered inside. A
 * branch outside it is refused rather than escaped: the guard is a security
 * boundary, and an escaping scheme is a second grammar to get wrong.
 */
const publishBranchName = /^[A-Za-z0-9._/-]+$/
/** A GitHub environment name the generated YAML carries without quoting surprises. */
const environmentName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * The split write-credential declaration, checked as a whole.
 *
 * Each refusal is a workflow that would do less than it declares or hold more
 * than it should: a publishing job with no write credential publishes nothing,
 * a write credential no job uses is a trunk that silently stops publishing,
 * equal read and write names are one credential wearing two names (both cache
 * services refuse the value-level analogue), and a publishing job whose guard
 * can never be true is a job that never runs.
 */
const validatePublishing = (attrs: Attrs): void => {
  const publishing = attrs.jobs.filter((job) => job.publishesToCache === true)
  if (attrs.cacheWriteTokenSecret === undefined) {
    if (attrs.cacheWriteEnvironment !== undefined) {
      throw new Error(
        "GithubCiGen: cacheWriteEnvironment is declared but no cacheWriteTokenSecret is; declare the write credential or drop the environment"
      )
    }
    if (publishing.length > 0) {
      throw new Error(
        `GithubCiGen: job ${
          JSON.stringify(publishing[0]!.id)
        } declares publishesToCache but no cacheWriteTokenSecret is declared; declare the write credential or drop the flag`
      )
    }
    return
  }
  if (publishing.length === 0) {
    throw new Error(
      "GithubCiGen: cacheWriteTokenSecret is declared but no job declares publishesToCache; the trunk would silently stop publishing to the cache"
    )
  }
  if (attrs.cacheWriteEnvironment === undefined || !environmentName.test(attrs.cacheWriteEnvironment)) {
    throw new Error(
      "GithubCiGen: cacheWriteTokenSecret needs cacheWriteEnvironment, the GitHub environment (letters, digits, \".\", \"_\", \"-\") " +
        "that holds it with a deployment branch policy admitting only the push branches; a repository secret reaches every branch's workflows"
    )
  }
  if (
    attrs.cacheTokenSecret !== undefined &&
    RemoteCache.normalizeTokenEnv(attrs.cacheTokenSecret.env) ===
      RemoteCache.normalizeTokenEnv(attrs.cacheWriteTokenSecret.env)
  ) {
    throw new Error(
      "GithubCiGen: cacheTokenSecret and cacheWriteTokenSecret name the same variable; a reader holding the write credential can publish, so the two must differ"
    )
  }
  if (attrs.pushBranches.length === 0) {
    throw new Error(
      `GithubCiGen: job ${
        JSON.stringify(publishing[0]!.id)
      } declares publishesToCache but the workflow has no push branches, so its guard can never be true`
    )
  }
  for (const branch of attrs.pushBranches) {
    if (!publishBranchName.test(branch)) {
      throw new Error(
        `GithubCiGen: push branch ${
          JSON.stringify(branch)
        } cannot be embedded in the publish guard; use letters, digits, ".", "_", "/", and "-"`
      )
    }
  }
}

const validateJobs = (attrs: Attrs): void => {
  const ids = new Set<string>()
  const required = new Set(attrs.requiredJobs)
  validatePublishing(attrs)
  for (const job of attrs.jobs) {
    validateJobRunners(job)
    // A lane named in `requiredJobs` is a lane the pipeline promises to run.
    // One that is advisory everywhere fails nothing, so naming it required
    // states a guarantee the rendered workflow does not carry — the same
    // silent downgrade `requiredJobs` exists to catch when a job disappears.
    if (required.has(job.id) && isWhollyAdvisory(job)) {
      throw new Error(
        `GithubCiGen: required job ${
          JSON.stringify(job.id)
        } is advisory on every platform; drop it from requiredJobs or make a lane required`
      )
    }
    if (!jobIdShape.test(job.id)) {
      throw new Error(
        `GithubCiGen: ${JSON.stringify(job.id)} is not a valid job id; use letters, digits, "-", and "_"`
      )
    }
    if (ids.has(job.id)) {
      throw new Error(`GithubCiGen: duplicate job id ${JSON.stringify(job.id)}`)
    }
    ids.add(job.id)
    if (job.steps.length === 0) {
      throw new Error(`GithubCiGen: job ${JSON.stringify(job.id)} runs no targets`)
    }
    if (!job.toolchain.install) {
      throw new Error(
        `GithubCiGen: job ${
          JSON.stringify(job.id)
        } runs targets through the workspace binary but declares install: false`
      )
    }
    // The attrs schema already bounds this. It is checked again here because
    // `render` is exported and callable with an attrs value the schema never
    // constructed, and a job whose timeout the runner rejects or silently caps
    // is exactly the plan-time-visible red pipeline this target refuses to emit.
    if (
      job.timeoutMinutes !== undefined &&
      (!Number.isInteger(job.timeoutMinutes) ||
        job.timeoutMinutes < minimumTimeoutMinutes ||
        job.timeoutMinutes > maximumTimeoutMinutes)
    ) {
      throw new Error(
        `GithubCiGen: job ${
          JSON.stringify(job.id)
        } declares timeout-minutes ${job.timeoutMinutes}; GitHub Actions supports a whole number from ${minimumTimeoutMinutes} to ${maximumTimeoutMinutes}`
      )
    }
    for (const step of job.steps) {
      if (!targetPattern(step.pattern)) {
        throw new Error(
          `GithubCiGen: ${
            JSON.stringify(step.pattern)
          } is not a target pattern; use //..., //pkg/..., //pkg, //pkg:target, //:target, or a recursive pattern narrowed to one target name such as //pkg/...:target`
        )
      }
      if (!Verb.isPipelineVerb(step.verb)) {
        throw new Error(`GithubCiGen: job ${JSON.stringify(job.id)} declares a step with no CLI verb`)
      }
      if (
        step.parallelism !== undefined &&
        (!Number.isInteger(step.parallelism) || step.parallelism < 1 || step.parallelism > maximumParallelism)
      ) {
        throw new Error(
          `GithubCiGen: parallelism ${step.parallelism} is not a whole number from 1 to ${maximumParallelism}`
        )
      }
    }
  }
  if (attrs.knownRed !== undefined && !relativeFilePath(attrs.knownRed)) {
    throw new Error(
      `GithubCiGen: knownRed ${
        JSON.stringify(attrs.knownRed)
      } is not a workspace-relative file path; use letters, digits, ".", "_", "-", and "/" with no ".." segment`
    )
  }
  const missingJobs = attrs.requiredJobs.filter((id) => !ids.has(id))
  if (missingJobs.length > 0) {
    throw new Error(
      `GithubCiGen: the rendered workflow is missing required jobs: ${missingJobs.join(", ")}`
    )
  }
}

/**
 * Whether one declared step performs a gate's invocation.
 *
 * `Verb.Ci` covers the verbs the aggregate command plans over the same
 * pattern, and only those. It does NOT cover `Verb.Review`: `ci` does not plan
 * review targets, so a `ci` step accepted as a review gate would be a coverage
 * claim the pipeline never checks — exactly the silent downgrade gates exist
 * to catch. Nothing else is inferred either: a gate on `//packages/...` is not
 * satisfied by a step on `//...`, because a wider pattern is a different claim
 * and the point of a gate is that the claim was checked, not guessed.
 *
 * @category validation
 * @since 0.1.0
 */
export const satisfiesGate = (step: TargetStep, gate: Gate): boolean =>
  step.pattern === gate.pattern &&
  (step.verb.name === gate.verb.name ||
    (step.verb.name === "ci" && Verb.all.some((verb) => verb.name === gate.verb.name)))

/**
 * The declared gates no declared job performs.
 *
 * A job that declares {@link Job.publishesToCache} satisfies nothing here: it
 * renders behind a push-only `if:` guard, so GitHub skips it on every pull
 * request and a gate it alone carried would go unchecked exactly where gates
 * matter.
 *
 * @category validation
 * @since 0.1.0
 */
export const missingGates = (attrs: Attrs): ReadonlyArray<Gate> =>
  attrs.gates.filter((gate) =>
    !attrs.jobs.some((job) =>
      job.publishesToCache !== true &&
      (gate.job === undefined || job.id === gate.job) &&
      job.steps.some((step) => satisfiesGate(step, gate))
    )
  )

/**
 * Renders cache host state for every generated target step.
 *
 * A declared secret becomes one environment entry whose value is the repository
 * secret of the same name. The value is a GitHub expression, so the credential
 * exists only inside the runner; nothing about it is written into the workflow
 * file or into this target's key.
 */
const cacheEnvironment = (attrs: Attrs): Readonly<Record<string, string>> => {
  const env: Record<string, string> = {}
  if (attrs.cacheUrlSecret !== undefined) {
    env[attrs.cacheUrlSecret.env] = `\${{ secrets.${attrs.cacheUrlSecret.env} }}`
  }
  if (attrs.cacheTokenSecret !== undefined) {
    env[RemoteCache.normalizeTokenEnv(attrs.cacheTokenSecret.env)] = `\${{ secrets.${attrs.cacheTokenSecret.env} }}`
  }
  return env
}

/**
 * Renders the write-credential entry, for publishing jobs alone.
 *
 * At most one entry, on the same terms as {@link cacheEnvironment}: the
 * declared name keyed to the repository secret of the same name. `render`
 * merges it only into the step env of a job that declares
 * {@link Job.publishesToCache}, never into the shared map.
 */
const writeCacheEnvironment = (attrs: Attrs): Readonly<Record<string, string>> =>
  attrs.cacheWriteTokenSecret === undefined ? {} : {
    [RemoteCache.normalizeTokenEnv(attrs.cacheWriteTokenSecret.env)]:
      `\${{ secrets.${attrs.cacheWriteTokenSecret.env} }}`
  }

/**
 * The `if:` expression guarding a publishing job to post-merge push runs.
 *
 * Rendered PLAIN rather than through `scalar`, on the same terms as
 * {@link matrixExpressions}: a quoted expression is a string GitHub coerces
 * rather than the condition the job declares. The branch names inside it are
 * held to {@link publishBranchName} by `validatePublishing`, so nothing here
 * can open an expression or close a quote.
 */
const publishGuard = (attrs: Attrs): string => {
  const refs = attrs.pushBranches.map((branch) => `github.ref == 'refs/heads/${branch}'`)
  const condition = refs.length === 1 ? refs[0]! : `(${refs.join(" || ")})`
  return `\${{ github.event_name == 'push' && ${condition} }}`
}

/**
 * Renders the workflow YAML from attrs, deterministically.
 *
 * It FAILS CLOSED. A render throws at plan time, rather than emitting a
 * pipeline that silently checks less than the repository requires, when it
 * would drop a declared gate, drop a declared required job, declare a job that
 * runs no targets or cannot run them, emit a pattern outside the CLI's label
 * grammar, or emit a job shape GitHub Actions rejects. That refusal is the whole
 * reason this target can own a workflow file at all.
 *
 * @category rendering
 * @since 0.1.0
 */
export const render = (attrs: Attrs): string => {
  if (attrs.jobs.length === 0) {
    throw new Error("GithubCiGen: write mode needs at least one declared job")
  }
  if (attrs.pushBranches.length === 0 && !attrs.pullRequest && !attrs.workflowDispatch) {
    throw new Error("GithubCiGen: write mode needs at least one workflow trigger")
  }
  if (attrs.concurrency !== undefined && attrs.concurrency !== "ref" && attrs.concurrency !== "commit") {
    throw new Error("GithubCiGen: concurrency must be ref or commit")
  }
  validateJobs(attrs)
  const missing = missingGates(attrs)
  if (missing.length > 0) {
    throw new Error(
      `GithubCiGen: the rendered workflow does not run ${
        missing.map((gate) => `${gate.name} (${gate.verb.name} ${gate.pattern})`).join(", ")
      }; declare the step or drop the gate`
    )
  }
  const triggers: Array<string> = []
  if (attrs.pushBranches.length > 0) {
    triggers.push("  push:", `    branches: [${attrs.pushBranches.map(scalar).join(", ")}]`)
  }
  if (attrs.pullRequest) triggers.push("  pull_request:")
  if (attrs.workflowDispatch) triggers.push("  workflow_dispatch:")
  const lines: Array<string> = [
    `name: ${scalar(attrs.workflowName)}`,
    "on:",
    ...triggers,
    "concurrency:",
    // One group per PR and one per pushed branch. GitHub keeps at most one
    // running and one pending run in a group and replaces the pending one
    // with each new push, so a busy branch always has one full run in flight
    // and the newest commit next, and a verdict lands every run length. A
    // run per commit (#2071) queued faster than runners drained it and no
    // main run completed for hours (#2085). Superseded PR runs are cancelled;
    // a branch's in-progress run always finishes.
    attrs.concurrency === "commit"
      ? "  group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}-${{ github.sha }}"
      : "  group: ci-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.ref }}",
    `  cancel-in-progress: ${
      attrs.concurrency !== "commit" && attrs.cancelInProgress ? "${{ github.event_name == 'pull_request' }}" : "false"
    }`,
    // Least privilege: no generated job writes through the default token, so
    // every job reads the repository and nothing else. Secrets reach a job
    // only through its declared step environment.
    "permissions:",
    "  contents: read",
    "jobs:"
  ]
  const cacheEnv = cacheEnvironment(attrs)
  const writeEnv = writeCacheEnvironment(attrs)
  for (const job of attrs.jobs) {
    // A publishing job carries the write credential, so the whole job is
    // guarded to post-merge push runs and its steps get the write entry. Every
    // other job receives the shared entries and a PR publication namespace.
    const publishes = job.publishesToCache === true
    // Namespace PR results even during a shared-token rollout. The Worker
    // must still enforce read-only credentials: a client can omit this guard.
    const jobEnv = publishes ? { ...cacheEnv, ...writeEnv } : {
      ...cacheEnv,
      ...(attrs.pullRequest && Object.keys(cacheEnv).length > 0 ?
        {
          SMITHERS_CACHE_NAMESPACE:
            "${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || '' }}"
        } :
        {})
    }
    const hasJobEnv = Object.keys(jobEnv).length > 0
    // A job id is a mapping KEY, and YAML resolves a plain `no:` or `on:` to a
    // boolean just as it does a value, so an id that reads as one is quoted.
    lines.push(`  ${scalar(job.id)}:`)
    if (job.name !== undefined) lines.push(`    name: ${scalar(job.name)}`)
    // The matrix comes before `runs-on`, because `runs-on` reads it. The rows
    // are emitted in declaration order, twice: once as the platform list the
    // matrix expands, and once as the `include:` rows that attach each
    // platform's advisory bit.
    if (job.matrix !== undefined) {
      lines.push(
        "    strategy:",
        `      fail-fast: ${matrixFailFast}`,
        "      matrix:",
        `        os: [${job.matrix.map((row) => scalar(row.os)).join(", ")}]`,
        "        include:"
      )
      for (const row of job.matrix) {
        lines.push(`          - os: ${scalar(row.os)}`, `            advisory: ${row.advisory}`)
      }
      lines.push(`    runs-on: ${matrixExpressions.os}`)
    } else {
      lines.push(`    runs-on: ${runner(job.runsOn!)}`)
    }
    if (publishes) {
      lines.push(`    if: ${publishGuard(attrs)}`, `    environment: ${scalar(attrs.cacheWriteEnvironment!)}`)
    }
    if (job.timeoutMinutes !== undefined) lines.push(`    timeout-minutes: ${job.timeoutMinutes}`)
    if (job.matrix !== undefined) {
      lines.push(`    continue-on-error: ${matrixExpressions.advisory}`)
    } else if (job.continueOnError !== undefined) {
      lines.push(`    continue-on-error: ${job.continueOnError}`)
    }
    lines.push("    steps:")
    const rendered: Array<RenderedStep> = [
      // First, before any setup can fail: every leg of every attempt uploads at
      // least this empty record, so a rerun leg that dies early supersedes its
      // earlier attempt's results instead of inheriting them (#3663).
      ...(attrs.results === true ? [resultsMarker] : []),
      ...toolchainSteps(attrs, job)
    ]
    // Gates are independent, so a red one must not skip the ones after it. No
    // setup step declares an `if:`, so the last one concludes `success` only
    // when every setup step did: gates never run over a failed install. Every
    // job renders the same shape, so release.yml copies any gate verbatim.
    rendered.push({ ...rendered.pop()!, id: "setup" })
    for (const step of job.steps) {
      rendered.push({
        ...(step.name === undefined ? {} : { name: step.name }),
        condition: independentGate,
        run: stepCommand(attrs, step, job.toolchain.nix),
        ...(hasJobEnv ? { env: jobEnv } : {})
      })
    }
    if (job.toolchain.artifacts !== undefined) rendered.push(...artifactSteps(job.toolchain.artifacts))
    if (attrs.results === true) rendered.push(resultsUpload(job.id, job.matrix !== undefined))
    for (const step of rendered) lines.push(...renderStep(step, "      "))
  }
  return `${lines.join("\n")}\n`
}

/**
 * Generates the GitHub Actions CI workflow from PACKAGE.ts attrs.
 *
 * The workflow is a generated root file, on the same terms as `tsconfig.json`:
 * PACKAGE.ts is the only description of the pipeline, `write` renders it, and
 * `check` — the default — fails on drift. A pipeline that lives in two places,
 * a PACKAGE.ts declaration and a hand-maintained YAML file, is two descriptions
 * of one thing, free to disagree.
 *
 * Every step the workflow carries is derived, never authored. A job declares
 * what it requires and which targets it runs; {@link toolchainSteps} turns the
 * requirements into checkout, setup, and install steps, and
 * {@link stepCommand} turns each target step into one
 * `<manager> exec smthrs <verb> '<pattern>'` invocation. There is no attribute
 * anywhere in {@link Attrs} that accepts a command, an action reference, or a
 * shell script, so a gate that is not a target cannot be added to the pipeline
 * without first becoming one.
 *
 * The `lint` verb maps `write` to `check` through `attrsForKind`, so no lint
 * or `ci` run mutates a workflow file. Only `check` is cacheable; the output
 * file is a declared input there, so editing the workflow re-keys the target.
 *
 * Generated command example:
 *
 * ```yaml
 * - run: pnpm exec smthrs ci '//packages/...' --jobs 2
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export const GithubCiGen = Target.make("GithubCiGen", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["build", "lint"],
  error: Schema.Union([WriteFileError, DriftError]),
  cache: (attrs) => attrs.mode !== "write",
  inputs: (attrs) => attrs.mode === "write" ? [] : [Input.file(`//${resolveOutputPath(attrs.output)}`)],
  attrsForKind: (kind, attrs) =>
    kind === "lint" && attrs.mode === "write" ? { ...attrs, mode: "check" as const } : attrs,
  implementation: (
    attrs
  ): Node.Node<
    void,
    WriteFileError | DriftError,
    | Action.Requirement<"smithers-build/write-file">
    | Action.Requirement<"smithers-build/check-file">
  > => generateFile(attrs.mode, { path: resolveOutputPath(attrs.output), contents: render(attrs) })
})
