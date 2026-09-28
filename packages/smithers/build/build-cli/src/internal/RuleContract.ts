/**
 * Internal contracts between package planning and rule execution.
 *
 * This module owns planned payloads and shared node fields. Public target
 * schemas still own declarations; Planner owns graph and key vocabulary.
 *
 * @since 1.0.0
 */

import type * as AgentTarget from "@smthrs/targets/AgentTarget"
import type * as Anvil from "@smthrs/targets/Anvil"
import type * as BundlerTarget from "@smthrs/targets/BundlerTarget"
import type * as Compose from "@smthrs/targets/Compose"
import type * as Docker from "@smthrs/targets/Docker"
import type * as Input from "@smthrs/targets/Input"
import type * as Secret from "@smthrs/targets/Secret"
import type * as Target from "@smthrs/targets/Target"
import type * as GitSubmoduleExec from "../GitSubmoduleExec.ts"
import type * as OverlayExec from "../OverlayExec.ts"
import type * as Planner from "../Planner.ts"
import type * as RepoResolution from "../RepoResolution.ts"
import type * as ServiceSupervisor from "../ServiceSupervisor.ts"

/**
 * The mode one node executes under: `execute` for plain tool runs and
 * builds, `check` for the non-mutating drift verdict of Diff and Generate,
 * `write` for their applying form. Modes are distinct key material.
 *
 * @category models
 * @since 0.1.0
 */
export type Mode = "execute" | "check" | "write"

/**
 * One crate of an expanded crate set: the manifest that declares it, the name
 * it declares, and that manifest's content digest.
 *
 * The digest is key material: a crate set is a view over what the manifests
 * say, so an edit to a manifest that changes membership — or that changes the
 * metadata a filter reads — re-keys every target that ran over the set.
 *
 * @category models
 * @since 0.1.0
 */
export interface CrateRow {
  readonly manifest: string
  readonly name: string | undefined
  readonly digest: string
}

/**
 * One reduced `S.Test` operand as the executor evaluates it.
 *
 * @category models
 * @since 0.1.0
 */
export type TestOperandPlan =
  | { readonly kind: "sources"; readonly sources: ReadonlyArray<Compose.AnchoredSource> }
  | { readonly kind: "closure"; readonly entries: ReadonlyArray<Compose.AnchoredSource> }
  | { readonly kind: "bundler-files"; readonly label: string }

/**
 * The per-rule execution data a lane node carries beyond the shared shell
 * fields. Exactly one variant per lane rule; `undefined` for the W2 core
 * rules.
 *
 * @category models
 * @since 0.1.0
 */
export type LaneData =
  | { readonly kind: "fetch"; readonly url: string; readonly sha256: string }
  | {
    readonly kind: "serve"
    readonly readiness?: ServiceSupervisor.Readiness | undefined
    readonly health?: ServiceSupervisor.Health | undefined
    readonly stop?: ServiceSupervisor.Stop | undefined
  }
  | { readonly kind: "docker-service"; readonly attrs: (typeof Docker.ServeAttrs)["Type"] }
  | { readonly kind: "anvil-fork"; readonly attrs: (typeof Anvil.ForkAttrs)["Type"] }
  | { readonly kind: "closure"; readonly entries: ReadonlyArray<Compose.AnchoredSource> }
  | { readonly kind: "files-test"; readonly left: TestOperandPlan; readonly right: TestOperandPlan }
  | { readonly kind: "files-digest"; readonly targetLabel: string; readonly expectedPath: string }
  | { readonly kind: "bundler-resolve"; readonly payload: BundlerTarget.ResolvePayload }
  | { readonly kind: "bundler-build"; readonly payload: BundlerTarget.BuildPayload; readonly graphLabel: string }
  | {
    readonly kind: "agent"
    readonly flavor: "lint" | "diff" | "pr"
    readonly payload: AgentTarget.LintPayload | AgentTarget.DiffPayload
    /** Structural gate identity → planned gate label, in declared order. */
    readonly gateLabels: ReadonlyArray<readonly [string, string]>
    /** Planned labels of the `data` members that are targets (filegroups the prompt renders). */
    readonly dataLabels: ReadonlyArray<string>
  }
  | { readonly kind: "git-commit" }
  | { readonly kind: "ci-gen" }
  | { readonly kind: "github-decl" }
  | { readonly kind: "npm-pack"; readonly manifestPath: string }
  | {
    readonly kind: "native-file"
    readonly flavor: "copy" | "literal"
    readonly source?: string
    readonly sourceLabel?: string
    readonly text?: string
  }
  | { readonly kind: "submodules"; readonly plan: GitSubmoduleExec.Plan }
  | {
    readonly kind: "markdown-code-blocks"
    readonly file: string
    readonly languages: ReadonlyArray<string>
    /** Pages whose titled fences are written beside the page's files, never compiled on their own. */
    readonly context: ReadonlyArray<string>
  }
  | {
    readonly kind: "docs-check"
    /** Workspace-relative path of the committed stamp sidecar. */
    readonly stamp: string
    /** Workspace-relative path of the generated page the stamp judges. */
    readonly output: string
    /** Provenance recorded in the stamp and never compared. */
    readonly producer: string | undefined
    /**
     * The `inputs` attr as the planner resolved it: every file row, with the
     * digest the plan keyed on, sorted by path. Computed at plan time so the
     * verdict reads the same bytes the node's own key does.
     */
    readonly files: ReadonlyArray<Input.FileDigest>
  }
  | { readonly kind: "published"; readonly manifestPath: string }
  | {
    readonly kind: "api-compat"
    readonly baselineLabel: string
    readonly surfaceLabel: string
    readonly manifestPath: string
  }
  | { readonly kind: "overlay" }
  | { readonly kind: "outward"; readonly required: ReadonlyArray<string> }
  | { readonly kind: "inert" }
  /** A declared rule this executor has no runner for; the plan always refuses it. */
  | { readonly kind: "unimplemented" }
  | { readonly kind: "memory-retain" }
  | {
    readonly kind: "cargo"
    /** One resolved cargo argv per selected crate; empty when the crate set is. */
    readonly commands: ReadonlyArray<ReadonlyArray<string>>
    /** Files this target delivers, workspace-relative; `Cargo.Fetch` only. */
    readonly outFiles: ReadonlyArray<string>
    /** The crate set this target expanded to, when it declared one. */
    readonly crates: ReadonlyArray<CrateRow> | undefined
    /** The workspace-relative binaries this build produces, for tool edges. */
    readonly binaries: ReadonlyArray<string>
  }
  | {
    readonly kind: "repo-target"
    readonly resolution: RepoResolution.Resolution
    readonly git: RepoResolution.GitState
  }

/**
 * One planned PACKAGE.ts node. Structurally a {@link Planner.PlannedTarget}
 * so the existing scheduler accepts the work list unchanged.
 *
 * @category models
 * @since 0.1.0
 */
export interface SharedFields extends Planner.PlannedTarget {
  readonly mode: Mode
  readonly packagePath: string
  /** The declaration object itself, for rule bodies that consume validated attrs. */
  readonly declaration: Target.AnyTarget
  /** Labels of the Serve targets this node's `services` attr acquires. */
  readonly serviceDeps: ReadonlyArray<string>
  /**
   * Bundler builds only: the key material with the graph dependency's key
   * left as `PackageExec.graphKeySentinel`. Execution derives the effective key
   * from it once the resolved graph digest is known.
   */
  readonly keyTemplate: Planner.KeyMaterial | undefined
  readonly refusal: string | undefined
  readonly sandbox: "none" | { readonly network?: boolean | "loopback" | undefined } | undefined
  readonly secrets: ReadonlyArray<Secret.HttpCredential>
  /** Tool outputs are identified after their producers settle, before cache lookup. */
  readonly targetExecutablePaths?: ReadonlyArray<string>
  readonly argv: ReadonlyArray<string> | undefined
  /** Shell.Test fan-out count; each shard owns a distinct key and execution. */
  readonly shards: number
  /** Declaration-specific process timeout, already reduced to milliseconds. */
  readonly timeoutMs: number
  /**
   * The workspace-relative directory the tool spawns in. `bin`-form tools
   * run from the declaring package (their configs resolve upward and their
   * scope is the package); `shell`, `bun`, and script forms run from the
   * workspace root, which their text is written against.
   */
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  /**
   * Environment names whose declared value is a workspace-relative path made
   * absolute immediately before spawn. The relative form is what keys the
   * node, so two checkouts of the same tree agree on the key while each child
   * still receives a path it can use.
   */
  readonly absoluteEnv: ReadonlyArray<string>
  readonly bunTemplate:
    | { readonly template: string; readonly consts: Readonly<Record<string, string>>; readonly bunPath: string }
    | undefined
  readonly writeSet: ReadonlyArray<string>
  /**
   * Workspace-relative paths a rule discovered for itself that the spawned
   * tool must be able to read.
   *
   * A rule whose work is named by import patterns rather than by `S.file`
   * declarations — `Go.*` is the one today — has no declared inputs to derive
   * a read set from, so it reports the closure it planned over here and the
   * confinement admits exactly that.
   */
  readonly readSet: ReadonlyArray<string>
  /**
   * Absolute host paths outside the workspace the spawned tool reads. A git
   * submodule whose `.gitmodules` url is a local repository is the one source
   * today; the confinement binds each read-only.
   */
  readonly externalReads: ReadonlyArray<string>
  readonly outDirs: ReadonlyArray<string>
  readonly outFiles: ReadonlyArray<string>
  /** Consumer-scoped source substitutions applied only in a scratch workspace. */
  readonly overlays: ReadonlyArray<OverlayExec.Replacement>
  readonly emit:
    | ReadonlyArray<{
      readonly path: string
      readonly value: { readonly kind: "bytes"; readonly text: string } | {
        readonly kind: "link"
        readonly target: string
      }
    }>
    | undefined
  /** Generate stdout form: workspace-relative destination for captured stdout. */
  readonly stdoutPath: string | undefined
  readonly members: ReadonlyArray<string>
  readonly aliasOf: string | undefined
  readonly materializeOf: string | undefined
  readonly gateDeps: ReadonlyArray<string>
  readonly cleanOutDirs: ReadonlyArray<string>
  readonly cleanPaths: ReadonlyArray<string>
}

/** A command that names its executable.
 * @category models
 * @since 1.0.0
 */
export type Argv = readonly [string, ...ReadonlyArray<string>]

type Variant<Family extends string, Rule extends string, Lane> = {
  readonly family: Family
  readonly rule: Rule
  readonly lane: Lane
}
type Lane<Kind extends LaneData["kind"]> = Extract<LaneData, { readonly kind: Kind }>

/** The exact input, output and execution policy of a planned Fetch.
 * @category models
 * @since 1.0.0
 */
export type Fetch = Variant<"fetch", "Fetch", Lane<"fetch">> & {
  readonly mode: "execute"
  readonly declaredInputs: readonly []
  readonly declaredOutputs: { readonly cwd: "."; readonly paths: readonly [string] }
  readonly serviceDeps: readonly []
  readonly argv: undefined
  readonly bunTemplate: undefined
  readonly outDirs: readonly []
  readonly outFiles: readonly [string]
  readonly sandbox: { readonly network: true }
}

declare const bodyRuleName: unique symbol

/** A rule name admitted to the declaration-body fallback, distinct from native catalog names.
 * @category models
 * @since 1.0.0
 */
export type BodyRuleName = string & { readonly [bodyRuleName]: true }

/** The planner's discriminated choice of rule and its exact execution payload.
 * Missing native payloads are represented by Refused, never by a ready rule.
 * @category models
 * @since 1.0.0
 */
export type Selection =
  | Fetch
  | (Variant<"process", "Shell.Build" | "Shell.Test" | "Shell.Run" | "Shell.Diff", undefined> & { readonly argv: Argv })
  | (
    & Variant<
      "language",
      | "Go.Binary"
      | "Go.ModDownload"
      | "Go.Test"
      | "Go.Fuzz"
      | "Go.Lint"
      | "Go.Generate"
      | "Foundry.Build"
      | "Foundry.Test"
      | "Foundry.Fmt",
      undefined
    >
    & { readonly argv: Argv }
  )
  | (Variant<"container", "Docker.Build" | "Docker.Bake" | "Docker.Push", undefined> & { readonly argv: Argv })
  | Variant<"generated", "Generate" | "Owners.Codeowners" | "Owners.Tree", undefined>
  | Variant<
    "value",
    "Filegroup" | "Cargo.AppSet" | "Go.Packages" | "Suite" | "Alias" | "Materialize" | "Clean" | "Install",
    undefined
  >
  | (Variant<"service", "Shell.Serve", Lane<"serve">> & { readonly argv: Argv })
  | Variant<"service", "Docker.Serve" | "Docker.Service", Lane<"docker-service">>
  | Variant<"service", "Anvil.Fork", Lane<"anvil-fork">>
  | Variant<"files", "ImportClosure", Lane<"closure">>
  | Variant<"files", "Test", Lane<"files-test"> | Lane<"files-digest">>
  | Variant<"bundler", "Bundler.Rspack.resolve", Lane<"bundler-resolve">>
  | Variant<"bundler", "Bundler.Rspack.build", Lane<"bundler-build">>
  | Variant<
    "agent",
    "Agent.Lint",
    Lane<"agent"> & { readonly flavor: "lint"; readonly payload: AgentTarget.LintPayload }
  >
  | Variant<
    "agent",
    "Agent.Diff" | "Docs.Page",
    Lane<"agent"> & { readonly flavor: "diff"; readonly payload: AgentTarget.DiffPayload }
  >
  | Variant<"agent", "Agent.Pr", Lane<"agent"> & { readonly flavor: "pr"; readonly payload: AgentTarget.DiffPayload }>
  | Variant<"outward", "Git.Commit", Lane<"git-commit">>
  | Variant<"generated", "Github.CiGen", Lane<"ci-gen">>
  | Variant<"value", "Github.Setup" | "Github.Workflow", Lane<"github-decl">>
  | Variant<"files", "Npm.Pack", Lane<"npm-pack">>
  | Variant<"files", "Copy", Lane<"native-file"> & { readonly flavor: "copy" }>
  | Variant<"files", "Literal", Lane<"native-file"> & { readonly flavor: "literal"; readonly text: string }>
  | Variant<"repository", "Git.Submodules" | "Git.Submodule", Lane<"submodules">>
  | Variant<"files", "Markdown.CodeBlocks", Lane<"markdown-code-blocks">>
  | Variant<"stamp", "Docs.Check", Lane<"docs-check">>
  | Variant<"repository", "Npm.Published", Lane<"published">>
  | Variant<"files", "Api.Compat", Lane<"api-compat">>
  | Variant<"files", "Overlay", Lane<"overlay">>
  | Variant<
    "outward",
    "Npm.Publish" | "Changesets.Publish" | "Github.Pr" | "Github.Release" | "Github.Pages" | "Git.Pr",
    Lane<"outward">
  >
  | Variant<"value", "Changesets.Version" | "Size.Budgets" | "Cron", Lane<"inert">>
  | Variant<"value", "Npm.Downstream", Lane<"unimplemented">>
  | Variant<"outward", "Memory.Retain", Lane<"memory-retain">>
  | Variant<
    "language",
    | "Cargo.Fetch"
    | "Cargo.Build"
    | "Cargo.Test"
    | "Cargo.Nextest"
    | "Cargo.Clippy"
    | "Cargo.Deny"
    | "Cargo.Fmt"
    | "Cargo.Doc",
    Lane<"cargo">
  >
  | Variant<"repository", "Repo.Target", Lane<"repo-target">>
  | Variant<"body", BodyRuleName, undefined>

/** A planning refusal carries no executable lane.
 * @category models
 * @since 1.0.0
 */
export type Refused = Variant<"refused", string, undefined> & { readonly refusal: string }

/** A schedulable package node; every native rule is paired with its own payload.
 * @category models
 * @since 1.0.0
 */
export type PlannedRule = SharedFields & (Selection | Refused)

/** The exact node accepted by a family executor.
 * @category models
 * @since 1.0.0
 */
export type Planned<S extends Selection> = SharedFields & S

/** A family planner either produces its whole contract or explains its refusal.
 * @category models
 * @since 1.0.0
 */
export type PlanResult<S extends Selection> =
  | { readonly ok: true; readonly value: S }
  | { readonly ok: false; readonly refusal: string }

/** Host context supplied after centralized scheduling, admission and service acquisition.
 * @category models
 * @since 1.0.0
 */
export interface ExecutionContext {
  readonly root: string
  readonly signal: AbortSignal | undefined
}

/** A paired family planner and executor. Cache and service ownership stay with the caller.
 * @category models
 * @since 1.0.0
 */
export interface Contract<S extends Selection, Request, Result, Context extends ExecutionContext = ExecutionContext> {
  readonly plan: (request: Request) => PlanResult<S>
  readonly execute: (node: Planned<S>, context: Context) => Promise<Result>
}
