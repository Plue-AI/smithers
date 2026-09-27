/**
 * PACKAGE.ts bundler surface: `S.Bundler.Rspack(...)`.
 *
 * The `Rspack` call constructs no target. It returns an object with
 * `.resolve(opts)` and `.build(opts)` methods; each method call constructs
 * one target that carries the bundler config file plus the call's own
 * options. `resolve` targets expose `.files` for the file algebra.
 *
 * Both bodies are implemented over two dedicated actions, {@link Resolve} and
 * {@link Build}, whose live implementations run the workspace's own
 * rsbuild/rspack in a child node process (`build-cli/src/RspackRunner.ts`).
 * The plan-time bodies stay pure: they only record the action calls.
 *
 * ## Key semantics
 *
 * A resolve target keys on the config file digest, the declared universe
 * (targets become dependency keys, declared inputs become content digests),
 * and the implementation fingerprint — the resolver-row contract. A build
 * target's attrs carry the resolve target as `graph`, so today its key
 * includes the graph *target's* key. The spec's caching win — keying builds
 * on the resolved graph digest ({@link ResolveResult.graphDigest}) instead of
 * the declared universe — needs the planner to substitute a dependency's
 * cached result digest for its key, which is cache machinery outside this
 * module; {@link graphDigest} is the canonical digest that substitution must
 * use.
 *
 * @since 0.1.0
 */

import { Action } from "@smthrs/flow"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as Attr from "./Attr.ts"
import { attachFiles, type TargetFiles } from "./Compose.ts"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"
import { BuildError, captureOutputs, Outputs } from "./ToolBuild.ts"

/**
 * The two bundler modes observed in the audited PACKAGE.ts prototypes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Mode = Schema.Literals(["development", "production"])

/**
 * A bundler mode.
 *
 * @category models
 * @since 0.1.0
 */
export type Mode = typeof Mode.Type

/**
 * Attrs for a bundler resolve target.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ResolveAttrs = Schema.Struct({
  config: Input.File,
  entries: Schema.Array(Schema.NonEmptyString),
  universe: Attr.Data
})

/**
 * Attrs for a bundler build target.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BuildAttrs = Schema.Struct({
  config: Input.File,
  environment: Schema.NonEmptyString,
  mode: Mode,
  env: Schema.optional(Attr.Env),
  graph: Target.Target,
  outDirs: Schema.Array(Schema.NonEmptyString)
})

const hexDigest = /^[0-9a-f]{64}$/

/**
 * One resolved module row: a workspace-relative posix path and the sha256 of
 * the file's bytes. This is the same per-file shape `ImportClosure` produces,
 * so resolve results compose with the `S.Files` algebra as data.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ResolvedFile = Schema.Struct({
  path: Schema.NonEmptyString,
  digest: Schema.NonEmptyString.check(Schema.isPattern(hexDigest))
})

/**
 * One resolved module row.
 *
 * @category models
 * @since 0.1.0
 */
export type ResolvedFile = typeof ResolvedFile.Type

/**
 * The settled result of one bundler resolve: every workspace source file the
 * bundler's module graph reached (sorted by path, node_modules excluded),
 * every package name it reached under any node_modules directory (sorted),
 * the total module count seen, and the canonical {@link graphDigest} of the
 * rows.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ResolveResult = Schema.Struct({
  files: Schema.Array(ResolvedFile),
  packages: Schema.Array(Schema.NonEmptyString),
  moduleCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  graphDigest: Schema.NonEmptyString.check(Schema.isPattern(hexDigest))
})

/**
 * The settled result of one bundler resolve.
 *
 * @category models
 * @since 0.1.0
 */
export type ResolveResult = typeof ResolveResult.Type

/**
 * The canonical digest of one resolved graph: the sha256 of the sorted
 * `(path, digest)` rows plus the sorted package names.
 *
 * `moduleCount` is deliberately excluded: it is diagnostic metadata, and two
 * runs that resolve the same files must digest identically even when the
 * bundler reports runtime-module bookkeeping differently.
 *
 * This is the value a planner substitutes for the graph dependency's key to
 * key builds on the resolved graph rather than the declared universe.
 *
 * @category keys
 * @since 0.1.0
 */
export const graphDigest = (
  rows: Pick<ResolveResult, "files" | "packages">
): string =>
  createHash("sha256")
    .update("smithers-build-bundler-graph/1\u0000")
    .update(JSON.stringify([
      rows.files.map((file) => [file.path, file.digest]),
      [...rows.packages]
    ]))
    .digest("hex")

/**
 * Payload for one bundler resolve run.
 *
 * `configPath` is workspace-relative. Resolution always runs a
 * development-mode compile: it is the cheapest complete module graph the
 * bundler can produce (no minification, no module concatenation folding
 * modules out of the stats), and the graph — not the emitted bytes — is the
 * result.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ResolvePayload = Schema.Struct({
  configPath: Schema.NonEmptyString,
  entries: Schema.Array(Schema.NonEmptyString),
  mode: Mode
})

/**
 * Payload for one bundler resolve run.
 *
 * @category models
 * @since 0.1.0
 */
export type ResolvePayload = typeof ResolvePayload.Type

/**
 * Payload for one bundler build run.
 *
 * `outDirs` names the output roots the target declares; the runner refuses a
 * build that exits green without creating every one of them.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BuildPayload = Schema.Struct({
  configPath: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
  mode: Mode,
  env: Schema.Record(Schema.String, Schema.String),
  outDirs: Schema.Array(Schema.NonEmptyString)
})

/**
 * Payload for one bundler build run.
 *
 * @category models
 * @since 0.1.0
 */
export type BuildPayload = typeof BuildPayload.Type

/**
 * Resolves a module graph with the workspace's own bundler.
 *
 * Implemented by `RspackRunner.ResolveLive` in the build CLI.
 *
 * @category actions
 * @since 0.1.0
 */
export const Resolve = Action.make("smithers-build/bundler-resolve", {
  payload: ResolvePayload,
  success: ResolveResult,
  error: Exec.ExecError,
  tier: "sealed"
})

/**
 * Runs one bundler build for one environment and mode.
 *
 * Implemented by `RspackRunner.BuildLive` in the build CLI. The success is
 * the child process result; the target body sequences the shared
 * output-capture step after it, so the target's own success is the standard
 * {@link Outputs} manifest.
 *
 * @category actions
 * @since 0.1.0
 */
export const Build = Action.make("smithers-build/bundler-build", {
  payload: BuildPayload,
  success: Exec.Result,
  error: Exec.ExecError,
  tier: "sealed"
})

const resolveDefinition = Target.make("Bundler.Rspack.resolve", {
  attrs: ResolveAttrs,
  kinds: ["build"],
  success: ResolveResult,
  error: Exec.ExecError,
  // The resolver-row contract: the config digest, the universe (dependency
  // keys and declared-input digests), and the implementation fingerprint are
  // all in the planner's key material, so equal inputs replay the memoized
  // graph.
  cache: true,
  implementation: (attrs) =>
    Resolve.call({
      configPath: Input.rootRelative(".", attrs.config.path),
      entries: [...attrs.entries],
      mode: "development"
    })
})

const buildDefinition = Target.make("Bundler.Rspack.build", {
  attrs: BuildAttrs,
  kinds: ["build"],
  success: Outputs,
  error: BuildError,
  cache: true,
  // The declared output tree: cache admission re-measures these roots, so a
  // hit is only reported while the built tree is still on disk and intact.
  outputs: (attrs) => ({ cwd: ".", paths: [...attrs.outDirs] }),
  implementation: (attrs) =>
    captureOutputs(
      Build.call({
        configPath: Input.rootRelative(".", attrs.config.path),
        environment: attrs.environment,
        mode: attrs.mode,
        env: attrs.env === undefined ? {} : { ...attrs.env },
        outDirs: [...attrs.outDirs]
      }),
      ".",
      attrs.outDirs
    )
})

/**
 * One configured Rspack bundler: a factory for resolve and build targets.
 *
 * @category models
 * @since 0.1.0
 */
export interface RspackBundler {
  readonly resolve: (options: {
    readonly entries: ReadonlyArray<string>
    readonly universe: (typeof ResolveAttrs)["~type.make.in"]["universe"]
  }) => Target.AnyTarget & { readonly files: TargetFiles }
  readonly build: (options: {
    readonly environment: string
    readonly mode: Mode
    readonly env?: Readonly<Record<string, string>> | undefined
    readonly graph: Target.AnyTarget
    readonly outDirs: ReadonlyArray<string>
  }) => Target.AnyTarget
}

const isFile = Schema.is(Input.File)

/**
 * The methods rebuild their attrs from named keys, so a misspelled option
 * would vanish before the schema sees it. Rejecting unknown keys here keeps
 * the no-silent-drop rule that `Target.make` enforces for direct attrs.
 */
const rejectUnknownOptions = (id: string, options: object, known: ReadonlyArray<string>): void => {
  for (const key of Object.keys(options)) {
    if (!known.includes(key)) {
      throw new TypeError(`${id} received unknown option ${JSON.stringify(key)}`)
    }
  }
}

/**
 * Configures Rspack against its own config file. The call itself constructs
 * nothing; the returned methods construct targets keyed on the config plus
 * their own options.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Rspack = (options: { readonly config: Input.File }): RspackBundler => {
  if (typeof options !== "object" || options === null || !isFile(options.config)) {
    throw new TypeError("Bundler.Rspack requires a declared config file")
  }
  rejectUnknownOptions("Bundler.Rspack", options, ["config"])
  const config = options.config
  const bundler: RspackBundler = {
    resolve: (resolveOptions) => {
      if (typeof resolveOptions !== "object" || resolveOptions === null) {
        throw new TypeError("Bundler.Rspack resolve options must be an object")
      }
      rejectUnknownOptions("Bundler.Rspack.resolve", resolveOptions, ["entries", "universe"])
      if (!Array.isArray(resolveOptions.entries) || resolveOptions.entries.length === 0) {
        throw new TypeError("Bundler.Rspack.resolve requires at least one entry")
      }
      return attachFiles(
        resolveDefinition({
          config,
          entries: resolveOptions.entries,
          universe: resolveOptions.universe
        }) as unknown as Target.AnyTarget
      )
    },
    build: (buildOptions) => {
      if (typeof buildOptions !== "object" || buildOptions === null) {
        throw new TypeError("Bundler.Rspack build options must be an object")
      }
      rejectUnknownOptions("Bundler.Rspack.build", buildOptions, [
        "environment",
        "mode",
        "env",
        "graph",
        "outDirs"
      ])
      if (!Array.isArray(buildOptions.outDirs) || buildOptions.outDirs.length === 0) {
        throw new TypeError("Bundler.Rspack.build requires at least one outDir")
      }
      return buildDefinition({
        config,
        environment: buildOptions.environment,
        mode: buildOptions.mode,
        ...(buildOptions.env === undefined ? {} : { env: buildOptions.env }),
        graph: buildOptions.graph,
        outDirs: buildOptions.outDirs
      })
    }
  }
  return Object.freeze(bundler)
}
