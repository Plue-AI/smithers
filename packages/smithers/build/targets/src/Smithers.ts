/**
 * The `Smithers` namespace: the complete declaration surface.
 *
 * A PACKAGE.ts file imports this namespace once and reaches everything through
 * it, so the import line never changes as a workspace grows:
 *
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const runtime = Smithers.Runtime.Node({ version: ">=26.4.0" })
 * export const cacheToken = Smithers.Secret("SMITHERS_CACHE_TOKEN")
 * ```
 *
 * Library code that consumes this package imports the module it needs
 * directly, `@smthrs/targets/Target`, rather than going through the
 * namespace.
 *
 * @since 0.1.0
 */

import * as CargoModule from "./Cargo.ts"
import * as ChangesetsTargetModule from "./ChangesetsTarget.ts"
import * as CiToolchainModule from "./CiToolchain.ts"
import * as DependencyDocs from "./DependencyDocs.ts"
import * as DocsCheckModule from "./DocsCheck.ts"
import * as DocsPageModule from "./DocsPage.ts"
import * as FactoryModule from "./Factory.ts"
import * as HomeModule from "./Home.ts"
import * as InputModule from "./Input.ts"
import { Mise as MiseSurface } from "./Mise.ts"
import * as NodeArtifactModule from "./NodeArtifact.ts"
import * as NpmTargetModule from "./NpmTarget.ts"
import * as OwnersModule from "./Owners.ts"
import * as PackageManagerModule from "./PackageManager.ts"
import * as RuntimeModule from "./Runtime.ts"
import * as RustToolchainModule from "./RustToolchain.ts"
import * as VerbModule from "./Verb.ts"
import * as WorkspaceDeclarationModule from "./WorkspaceDeclaration.ts"

/**
 * Workspace remote-cache declarations.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as RemoteCache from "./RemoteCache.ts"

/**
 * Declared input schemas and constructors.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Input from "./Input.ts"

/**
 * Target construction and target metadata.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Target from "./Target.ts"

/**
 * Package manifest declarations, rendering, and target synthesis.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as PackageJsonDeclaration from "./PackageJson.ts"

/**
 * Shared inert manifest templates.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as PackageJsonTemplate from "./PackageJsonTemplate.ts"

/**
 * Declares one file input.
 *
 * @category constructors
 * @since 0.1.0
 */
export const file = (path: string): InputModule.File => InputModule.file(path)
/**
 * Declares a reference to exactly one target by label, `S.label("//:ci")`,
 * for a `.smithers/FACTORY.ts` that never imports a `PACKAGE.ts`.
 *
 * @category constructors
 * @since 1.0.0
 */
export { label } from "./Reference.ts"
/** @category constructors @since 0.1.0 */
export { gitDiff, glob, pnpmWorkspace } from "./Input.ts"
/** @category constructors @since 0.1.0 */
export { Workspace } from "./WorkspaceDeclaration.ts"
/** @category constructors @since 0.1.0 */
export { Cache, Flags, Host, Sandbox, Sandboxes } from "./WorkspaceDeclaration.ts"
/** @category constructors @since 0.1.0 */
export { make as LocalRepository } from "./LocalRepository.ts"
/** @category constructors @since 0.1.0 */
export { Package } from "./Package.ts"

/**
 * Ownership: `S.Owners.declare` validates the `owners` option a Package or
 * Workspace carries, `S.Owners.Codeowners` and `S.Owners.Tree` are the two
 * generated-file rules that project every declaration into
 * `.github/CODEOWNERS` and the per-directory `OWNERS` tree, and `S.Teams`
 * declares the workspace roster team references resolve against.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export const Owners = Object.freeze({
  declare: OwnersModule.declare,
  Codeowners: OwnersModule.Codeowners,
  Tree: OwnersModule.Tree
})

export { Teams } from "./Owners.ts"
/** @category constructors @since 0.1.0 */
export { gitCommit, Mcp, NodeModule, symlink } from "./Reference.ts"
/** @category targets @since 0.1.0 */
export { Alias, Files, Generate, ImportClosure, Materialize, Suite, Test } from "./Compose.ts"
/** @category targets @since 0.1.0 */
export { Copy, Literal, Overlay } from "./NodeArtifact.ts"
/** @category targets @since 0.1.0 */
export { Cron } from "./CronTarget.ts"
/** @category constructors @since 0.1.0 */
export { Agents } from "./AgentTarget.ts"
/** @category constructors @since 0.1.0 */
export { PackageDefaults } from "./PackageDefaults.ts"
/** @category actions @since 0.1.0 */
export { Exec, ExecError } from "./Exec.ts"
/** @category macros @since 0.1.0 */
export { BunSuite } from "./BunSuite.ts"
/** @category macros @since 0.1.0 */
export { FaultSuite } from "./FaultSuite.ts"
/** @category targets @since 0.1.0 */
export { Filegroup } from "./Filegroup.ts"
/** @category targets @since 0.1.0 */
export { Fetch } from "./Fetch.ts"
/** @category actions @since 0.1.0 */
export { ExpandFilegroup, FilegroupError } from "./Filegroup.ts"
/** @category guards @since 0.1.0 */
export { isFilegroup } from "./Filegroup.ts"
/** @category targets @since 0.1.0 */
export { Install } from "./Install.ts"
/** @category targets @since 0.1.0 */
export { Lockfile } from "./Lockfile.ts"
/** @category targets @since 0.1.0 */
export { PnpmWorkspace } from "./PnpmWorkspaceFile.ts"
/** @category targets @since 0.1.0 */
export { Tsconfig } from "./Tsconfig.ts"
/** @category constructors @since 0.1.0 */
export { Secret } from "./Secret.ts"
/** @category constructors @since 0.1.0 */
export { HttpSecret } from "./Secret.ts"
/** @category constructors @since 0.1.0 */
export { SecretOrigin } from "./Secret.ts"
/** @category targets @since 0.1.0 */
export { TsBuild } from "./TsBuild.ts"
/** @category targets @since 0.1.0 */
export { DtsBuild } from "./DtsBuild.ts"
/** @category targets @since 0.1.0 */
export { Typecheck } from "./Typecheck.ts"
/** @category targets @since 0.1.0 */
export { Vitest } from "./Vitest.ts"
/** @category targets @since 0.1.0 */
export { VitestCoverage } from "./VitestCoverage.ts"
/** @category targets @since 0.1.0 */
export { VitestWatch } from "./VitestWatch.ts"
/** @category targets @since 0.1.0 */
export { BiomeCheck } from "./BiomeCheck.ts"
/** @category targets @since 0.1.0 */
export { Dprint } from "./Dprint.ts"
/** @category targets @since 0.1.0 */
export { EsLint } from "./EsLint.ts"
/** @category targets @since 0.1.0 */
export { DepsLint } from "./DepsLint.ts"
/** @category targets @since 0.1.0 */
export { PackageLint } from "./PackageLint.ts"
/** @category targets @since 0.1.0 */
export { DocsParity } from "./DocsParity.ts"
/** @category actions @since 0.1.0 */
export { CheckDocs, DocsParityError } from "./DocsParity.ts"
/** @category targets @since 0.1.0 */
export { SortPackageJson } from "./SortPackageJson.ts"
/** @category constructors @since 0.1.0 */
export { generated, PackageJson } from "./PackageJson.ts"
/** @category targets @since 0.1.0 */
export { PackageJsonCheck, PackageJsonWrite } from "./PackageJson.ts"
/** @category actions @since 0.1.0 */
export { SyncPackageJson } from "./PackageJson.ts"
/** @category targets @since 0.1.0 */
export { NewPackage } from "./NewPackage.ts"
/** @category actions @since 0.1.0 */
export { ScaffoldPackage } from "./NewPackage.ts"
/** @category actions @since 0.1.0 */
export {
  CheckFile,
  checkGeneratedFile,
  DriftError,
  WriteFile,
  WriteFileError,
  writeGeneratedFile
} from "./GeneratedFile.ts"
/** @category targets @since 0.1.0 */
export { GithubCiGen } from "./GithubCiGen.ts"
/** @category constructors @since 1.0.0 */
export { Flow } from "./Flow.ts"
/** @category guards @since 1.0.0 */
export { isFlowDeclaration } from "./Flow.ts"
/** @category errors @since 1.0.0 */
export { FlowCatalogError } from "./FlowCatalog.ts"
/** @category targets @since 1.0.0 */
export { FactoryProjection } from "./Factory.ts"
/** @category targets @since 1.0.0 */
export { TargetIndex } from "./TargetIndex.ts"
/** @category actions @since 1.0.0 */
export { FactoryProjectionAction, FactoryProjectionError } from "./Factory.ts"
/** @category guards @since 1.0.0 */
export { isFactoryDeclaration } from "./Factory.ts"
/** @category guards @since 1.0.0 */
export { isHomeDeclaration } from "./Home.ts"
/** @category actions @since 0.1.0 */
/** @category parsing @since 0.1.0 */
export * as GithubWorkflow from "./GithubWorkflow.ts"
/** @category targets @since 0.1.0 */
/** @category targets @since 0.1.0 */
export { NpmPublish } from "./NpmPublish.ts"
/** @category targets @since 0.1.0 */
export { JsrPublish } from "./JsrPublish.ts"
/** @category targets @since 0.1.0 */
export { TypedocDocs } from "./TypedocDocumentation.ts"
/** @category targets @since 0.1.0 */
export { LlmLint } from "./LlmLint.ts"
/** @category actions @since 0.1.0 */
export { FindingsError, LlmReview, LlmReviewError, ModelCliMissing } from "./LlmLint.ts"
/** @category macros @since 1.0.0 */
export { SecurityReview } from "./SecurityReview.ts"
/** @category targets @since 0.1.0 */
export { Clean } from "./Compose.ts"
/** @category targets @since 0.1.0 */
export { Dev } from "./Dev.ts"
/** @category targets @since 0.1.0 */
export { ToolBuild } from "./ToolBuild.ts"
/** @category targets @since 0.1.0 */
export { ToolRun } from "./ToolRun.ts"
/** @category targets @since 0.1.0 */
/** @category targets @since 0.1.0 */
export { NodeTest } from "./NodeTest.ts"
/** @category constructors @since 0.1.0 */
export { entrypoint, testRunner, testSuite } from "./NodeTest.ts"
/** @category targets @since 0.1.0 */
export { NodeBinary } from "./NodeBinary.ts"
/** @category actions @since 0.1.0 */
export { CaptureOutputs, measureOutput, OutputError, readOutputManifest, verifyOutputs } from "./ToolBuild.ts"

/**
 * Declared JavaScript runtimes and the argv they run programs with.
 *
 * The name is both the namespace the constructors live under and the type they
 * return, so a declaration writes `Runtime.Node({ … })` and annotates the
 * result `Runtime`. The module's remaining types are reachable at
 * `@smthrs/targets/Runtime`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export const Runtime = RuntimeModule

/**
 * One declared JavaScript runtime.
 *
 * @category models
 * @since 0.1.0
 */
export type Runtime = RuntimeModule.Runtime

/**
 * Declared package managers, their argv spellings, and the lockfile each one
 * writes.
 *
 * The name is both the namespace the constructors live under and the type they
 * return, so a declaration writes `PackageManager.Pnpm({ … })` and annotates
 * the result `PackageManager`. The module's remaining types are reachable at
 * `@smthrs/targets/PackageManager`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export const PackageManager = PackageManagerModule

/**
 * One declared package manager.
 *
 * @category models
 * @since 0.1.0
 */
export type PackageManager = PackageManagerModule.PackageManager

/**
 * The CLI verbs a generated pipeline may run across a target graph.
 *
 * The name is both the namespace the verb values live under and the type they
 * have, so a declaration writes `{ verb: Verb.Ci, pattern: "//packages/..." }`
 * and annotates the result `Verb`. The module's remaining types are reachable
 * at `@smthrs/targets/Verb`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export const Verb = VerbModule

/**
 * One CLI verb a generated pipeline may run.
 *
 * @category models
 * @since 0.1.0
 */
export type Verb = VerbModule.Verb

/**
 * The Rust surface: `Rust.Toolchain({ workspace, channel })` or
 * `Rust.Toolchain({ toolchain, lockfile })`, the layer a Cargo workspace
 * declares in place of the JavaScript runtime and package manager, and
 * `Rust.Pinned({})`, the checked-in `rustup` pin a generated CI job installs.
 *
 * The name is both the namespace the constructors live under and the type
 * `Rust.Toolchain` returns. The module's remaining types are reachable at
 * `@smthrs/targets/RustToolchain`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export const Rust = RustToolchainModule

/**
 * One declared workspace Rust toolchain layer.
 *
 * @category models
 * @since 0.1.0
 */
export type Rust = RustToolchainModule.ToolchainDeclaration

/**
 * The cargo surface.
 *
 * PACKAGE.ts exposes `Cargo.Fetch`, `Cargo.Build`, `Cargo.Test`, `Cargo.Clippy`,
 * `Cargo.Fmt`, `Cargo.Doc`, and the `Cargo.AppSet` crate set. Each is a target
 * whose crate selector — `workspace: true`, `package: "<name>"`, or
 * `crates: <set>` — says which crates it runs over.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export const Cargo = CargoModule

/**
 * What one generated CI job requires before its targets run.
 *
 * The name is both the namespace the constructors live under and the type
 * `Needs` returns, so a declaration writes `CiToolchain.Needs({ … })` and
 * annotates the result `CiToolchain`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export const CiToolchain = CiToolchainModule

/**
 * Everything one generated CI job requires before its targets run.
 *
 * @category models
 * @since 0.1.0
 */
export type CiToolchain = CiToolchainModule.Toolchain

/**
 * Placeholder minting and outbound secret substitution.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as SecretProxy from "./SecretProxy.ts"

/**
 * PACKAGE.ts shell target flavors: `Shell.Build`, `Shell.Test`,
 * `Shell.Run`, `Shell.Serve`, and `Shell.Diff`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Shell from "./Shell.ts"

/**
 * mise version authority and pinned binary references.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export const Mise = MiseSurface

/**
 * Foundry toolchain plus forge build/test/fmt targets.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Foundry from "./Foundry.ts"

/**
 * Anvil fork services.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Anvil from "./Anvil.ts"

/**
 * Docker services, OCI builds, bake targets, and pushes.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Docker from "./Docker.ts"

/**
 * Cross-repository target edges into opaque local workspaces.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Repo from "./RepoTarget.ts"

/**
 * PACKAGE.ts agent target flavors and the workspace agent declarations:
 * `Agent.Lint`, `Agent.Diff`, `Agent.Pr`, `Agent.ClaudeCode`,
 * `Agent.Codex`, and `Agent.Pool`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Agent from "./AgentTarget.ts"

/**
 * PACKAGE.ts git target flavors: `Git.Commit`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Git from "./GitTarget.ts"

/**
 * PACKAGE.ts GitHub target flavors: `Github.Setup`, `Github.Workflow`,
 * `Github.CiGen`, and `Github.Pr`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Github from "./GithubTarget.ts"

/**
 * PACKAGE.ts memory surfaces: the `Memory.Retain` target and the
 * `Memory.SmithersCloud` workspace declaration.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Memory from "./MemoryTarget.ts"

/**
 * PACKAGE.ts bundler surface: `Bundler.Rspack(...)`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Bundler from "./BundlerTarget.ts"

/** Go toolchain and package rules. */
export * as Go from "./Go.ts"

/** Late-bound build stamps. */
export * as Stamp from "./Stamp.ts"

/** Nix dev-shell version authority and tools. */
export * as Nix from "./Nix.ts"

/** Prepared-environment toolchain pins, digests and destinations. */
export * as Environment from "./Environment.ts"

/**
 * npm-facing workspace declarations: `Npm.NodeModules({ packageJson })`.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export const Npm = {
  NodeModules: WorkspaceDeclarationModule.NodeModules,
  Pack: NpmTargetModule.Pack,
  Publish: NpmTargetModule.Publish,
  Published: NpmTargetModule.Published,
  Downstream: NpmTargetModule.Downstream
} as const

/** Changesets versioning and publishing targets.
 *
 * @category targets
 * @since 0.1.0
 */
export const Changesets = ChangesetsTargetModule

/** Markdown-derived target constructors.
 *
 * @category targets
 * @since 0.1.0
 */
export const Markdown = Object.freeze({ CodeBlocks: NodeArtifactModule.CodeBlocks })

/** API-surface checks.
 *
 * @category targets
 * @since 0.1.0
 */
export const Api = Object.freeze({ Compat: NodeArtifactModule.Compat })

/** Artifact-size checks.
 *
 * @category targets
 * @since 0.1.0
 */
export const Size = Object.freeze({ Budgets: NodeArtifactModule.Budgets })

/**
 * Documentation: `Docs.Page` writes one page with an agent under the `docs`
 * verb, and `Docs.Check` fails, deterministically and with no agent, when a
 * committed page is older than the inputs it was stamped against.
 * `Docs.Package` and `Docs.Url` declare pinned dependency documentation under
 * a workspace's `docs`, which a wiki refresh imports for agent memory.
 *
 * @category targets
 * @since 0.1.0
 */
export const Docs = Object.freeze({
  Page: DocsPageModule.Page,
  Check: DocsCheckModule.Check,
  Package: DependencyDocs.Package,
  Url: DependencyDocs.Url
})

/**
 * The declared homepage blocks: `Prompt`, `Flows`, `Markdown`, `Text`, `Links`, `Stack`, and `App`.
 *
 * @category namespace exports
 * @since 1.0.0
 */
export const Home = Object.freeze({
  Text: HomeModule.Text,
  Links: HomeModule.Links,
  Flows: HomeModule.Flows,
  Prompt: HomeModule.Prompt,
  Markdown: HomeModule.Markdown,
  Stack: HomeModule.Stack,
  App: HomeModule.App
})

/**
 * The factory `.smithers/FACTORY.ts` exports: `S.Factory({...})` is the
 * declaration itself, and `S.Factory.Home({ blocks })` the homepage exported
 * beside it. `FactoryProjection` projects both to `.smithers/factory.json`
 * and `.smithers/home.json`.
 *
 * @category namespace exports
 * @since 1.0.0
 */
export const Factory = Object.freeze(Object.assign(
  (options: FactoryModule.FactoryOptions): FactoryModule.Declaration => FactoryModule.Factory(options),
  { Home: HomeModule.Home }
))
