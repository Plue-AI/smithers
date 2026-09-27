/**
 * Public contracts for package planning and execution.
 *
 * @since 1.0.0
 */
import type * as Compose from "@smthrs/targets/Compose"
import type * as Target from "@smthrs/targets/Target"
import type * as PackageIndexModule from "../PackageIndex.ts"
import type * as Reporter from "../Reporter.ts"
import type * as Workspace from "../Workspace.ts"
import type * as RuleContract from "./RuleContract.ts"

/**
 * The mode one node executes under: `execute` for plain tool runs and
 * builds, `check` for the non-mutating drift verdict of Diff and Generate,
 * `write` for their applying form. Modes are distinct key material.
 *
 * @category models
 * @since 0.1.0
 */
export type Mode = RuleContract.Mode

/**
 * The invocation surface: a CLI verb, or `auto` for the bare-label form
 * whose verb is implied by the target flavor.
 *
 * @category models
 * @since 0.1.0
 */
export type PackageVerb = Target.Kind | "auto"

/**
 * One planned PACKAGE.ts node, with a rule-specific execution contract.
 * @category models
 * @since 0.1.0
 */
export type PackageNode = RuleContract.PlannedRule

/**
 * Reduced file-algebra operand shared with the rule contracts.
 * @category models
 * @since 0.1.0
 */
export type TestOperandPlan = RuleContract.TestOperandPlan

/**
 * Native execution payloads owned by the internal rule contract.
 * @category models
 * @since 0.1.0
 */
export type LaneData = RuleContract.LaneData

/**
 * The inert plan report `--plan` prints for PACKAGE.ts workspaces.
 *
 * @category models
 * @since 0.1.0
 */
export interface PlanReport {
  readonly verb: string
  readonly pattern: string
  readonly roots: ReadonlyArray<string>
  readonly targets: ReadonlyArray<{
    readonly label: string
    readonly rule: string
    readonly mode: Mode
    readonly key: string
    readonly cacheable: boolean
    readonly dependencies: ReadonlyArray<string>
    readonly argv?: ReadonlyArray<string> | undefined
    readonly shards?: number | undefined
    /** A cargo target's per-crate commands, when it renders more than one. */
    readonly commands?: ReadonlyArray<ReadonlyArray<string>> | undefined
    readonly sandbox?: PackageNode["sandbox"]
    /**
     * Whether this host can enforce the declared sandbox.
     *
     * Confinement is bubblewrap on Linux, seatbelt (`sandbox-exec`) on macOS,
     * and Docker wherever the workspace declares it. A host missing its
     * mechanism refuses the target with `sandbox_unenforceable` rather than
     * running it unconfined, and the plan reports that answer here, because a
     * declaration alone never said whether the posture was actually kept.
     */
    readonly sandboxEnforced?: boolean | undefined
    readonly refusal?: string | undefined
  }>
}

/**
 * Options accepted by {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RunOptions {
  readonly index: PackageIndexModule.PackageIndex
  readonly cacheDirectory: string
  /**
   * The remote cache this invocation reads and publishes through.
   *
   * `WORKSPACE.ts` may declare `S.Cache({ remote })` and the host may set
   * `SMITHERS_CACHE_URL`; both were schema-validated and then dropped, so a
   * workspace that declared a shared cache ran local-only with no warning and
   * no line in the plan. The CLI resolves it once and hands it here, exactly
   * as it does for every target execution.
   */
  readonly remoteCache?: Workspace.RemoteCacheAccess | undefined
  readonly verb: PackageVerb
  /** The target patterns whose union this invocation selects; at least one. */
  readonly patterns: ReadonlyArray<string>
  /** Opts wildcard test and CI selections into the exclusive tier. */
  readonly includeExclusive?: boolean | undefined
  /**
   * The host platform a target's declared `hosts` is checked against.
   * Defaults to `process.platform`; tests inject one.
   */
  readonly platform?: NodeJS.Platform | undefined
  /**
   * The plan runs with nobody attending it: the aggregate `ci` verb. Roots
   * whose rule spawns an agent under a verb `ci` aggregates (`Docs.Page`
   * under `docs`) are not selected. The same pattern under the verb itself
   * selects them.
   */
  readonly unattended?: boolean | undefined
  readonly write?: boolean | undefined
  readonly fix?: boolean | undefined
  readonly plan?: boolean | undefined
  readonly jobs?: number | undefined
  readonly readCache?: boolean | undefined
  readonly signal?: AbortSignal | undefined
  readonly log?: ((line: string) => void) | undefined
  /** Receives every execution event; without one, `log` receives the plain status lines. */
  readonly reporter?: Reporter.Reporter | undefined
  /** `-m` override for `Git.Commit`; wins over the declared message. */
  readonly message?: string | undefined
  /**
   * `--sweep`: lets a `Git.Commit` target with no declared path scope commit
   * the whole working tree.
   *
   * A `Git.Commit` without a `changes` scope owns nothing. The rule used to stage
   * everything the tree carried — a concurrent agent's edits included — with a
   * reporter warning as the only notice. A notice is not a guard. Without this
   * flag the commit refuses, naming the changes it would have absorbed; the
   * operator who wants them commits with the flag and says so.
   */
  readonly sweep?: boolean | undefined
  /** `--input name=value` payload values for agent targets. */
  readonly inputs?: Readonly<Record<string, string>> | undefined
  /**
   * The environment agent-fake selection (`SMTHRS_AGENT_FAKE`), the memory
   * backend's PATH lookup, and outward preconditions (the `Github.Pr` token)
   * read. Defaults to `process.env`; tests inject a hermetic record.
   */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  /** Package name supplied to scaffold targets. */
  readonly packageName?: string | undefined
}

/**
 * Options accepted by an already-merged execution, including the aggregate CI verb.
 *
 * @category models
 * @since 0.1.0
 */
export interface ExecuteOptions extends Omit<RunOptions, "verb"> {
  readonly verb: PackageVerb | "ci"
}

/**
 * One resolved crate and its manifest digest, owned by the rule contract.
 * @category models
 * @since 0.1.0
 */
export type CrateRow = RuleContract.CrateRow

/**
 * One planned PACKAGE.ts execution: the keyed nodes plus the scheduled
 * work list.
 *
 * @category models
 * @since 0.1.0
 */
export interface PackagePlan {
  readonly roots: ReadonlyArray<string>
  readonly workList: ReadonlyArray<PackageNode>
  readonly nodes: ReadonlyMap<string, PackageNode>
  /**
   * ImportClosure label → the closure computed at plan time to key its
   * consumers. Execution reports the same result rather than resolving twice.
   */
  readonly closures: ReadonlyMap<string, Compose.ClosureResult>
}
