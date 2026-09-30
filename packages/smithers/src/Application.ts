/**
 * Transport-neutral application composition.
 *
 * @since 0.1.0
 */

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import type { ApprovalAuthority, Control, ControlExecutor, ControlSchema, Health } from "@smthrs/control"
import { ControlClient, ControlRuntime } from "@smthrs/control"
import type * as ReplayOnly from "@smthrs/engine-store/ReplayOnly"
import type { Journal } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import type * as McpClient from "@smthrs/mcp/McpClient"
import type * as Evaluator from "@smthrs/model/Evaluator"
import type { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Layer } from "effect"
import type { HttpClient } from "effect/unstable/http/HttpClient"
import type { RpcSerialization } from "effect/unstable/rpc/RpcSerialization"
import type { Socket } from "effect/unstable/socket/Socket"
import * as ExecutorOwnership from "./ExecutorOwnership.ts"
import * as LocalControl from "./internal/LocalControl.ts"

/**
 * Everything the durable layers need to know before any flag is parsed.
 *
 * The composition roots are built from this, and they are built before the
 * command tree runs, so these four values are read straight off the argument
 * vector and the environment by `NodeControl.makeConfig` rather than by a
 * handler. An invalid value is reported there as a usage error; by the time a
 * handler sees a `Config` it is already valid.
 *
 * @category models
 * @since 0.1.0
 */
export interface Config {
  /** An explicitly supplied judge; otherwise the native host requires its gateway key. */
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  /**
   * Whether this composition may start or resume a run.
   *
   * `true`, the default, composes the run executor, and a local one needs a
   * completion judge before it opens a store or a socket: a host that can
   * reach a completion must not boot into a state where every completion is
   * doomed.
   *
   * `false` composes a host that observes runs and drives none. It opens with
   * no gateway key at all, which is what lets a listing, a diagnosis or a log
   * read work in a project that has never had one, and its executor refuses a
   * launch or a resume as a composition defect rather than admitting work it
   * cannot judge. `Verb.startsRuns` is what the CLI answers this from; the
   * default is `true` so a composition that says nothing keeps the refusal.
   */
  readonly startsRuns?: boolean | undefined
  /** Compile and validate authored flow plans while keeping execution disabled. */
  readonly plansFlows?: boolean | undefined
  /** A human can answer parked agent steps on this host. Unattended compositions default to false. */
  readonly approvalChannel?: boolean | undefined
  /** Trusted local observational checkers, keyed by flow id. Remote clients never execute these callbacks. */
  readonly health?: Health.HealthConfig | undefined
  /** Trusted local host configuration, never decoded from command arguments. */
  readonly approvalAuthority?: ApprovalAuthority.Service | undefined
  /** Transport-owned local identity; remote RPC authentication owns its own actor. */
  readonly principal?: Omit<ControlSchema.Principal, "stampedAt"> | undefined
  /** Execution worktree for a durable fork; database and registry stay under root. */
  readonly executionRoot?: string | undefined
  /**
   * Where the durable databases live, when that is not {@link Config.root}.
   *
   * The registry, the grant store and every run still work under `root`. Only
   * `.flows/control.db`, `.flows/engine.db` and their WAL companions move. A
   * host served over a live JJ or Git working copy sets this outside that
   * checkout: the engine writes on every step, and inside the checkout those
   * writes are untracked files that change the working-copy tree digest under
   * the very code a run is reading.
   */
  readonly stateRoot?: string | undefined
  /**
   * Composes the local engine replay-only: a recorded step replays, and a step
   * the current code would execute stops the run instead. `smthrs runs verify`
   * sets it over a copy of the stores.
   */
  readonly replayOnly?: Layer.Layer<ReplayOnly.ReplayOnly> | undefined
  readonly remote?: string | undefined
  readonly credential?: string | undefined
  /**
   * Reads the stored login for `remote` when `credential` is unset. The Node
   * remote transport calls it once while it is built, because the login may
   * live in the system keyring and reading that starts a process.
   */
  readonly login?: (() => Promise<string | undefined>) | undefined
  /**
   * Whether this host imports a flow file its own runs write, while it serves.
   *
   * OFF by default, and that default is a trust statement. The host's module
   * loader is a plain `import()` in the serving process: top-level code in an
   * agent-written `flows/<id>/flow.ts` runs with the host's own credentials,
   * its filesystem and its network, and nothing approves that import. With
   * this off, a flow a run authored is discovered the next time the host
   * starts — which is an operator's decision — and until then the plan door
   * answers `FlowNotFound`, the refusal it has always answered with for a
   * flow this host does not hold.
   *
   * Turn it on for a host whose runs you would let run arbitrary code anyway:
   * a fixture, a disposable box, a sandbox. Do not turn it on for a host that
   * holds credentials a run must not reach.
   */
  readonly rebuildAuthoredFlows?: boolean | undefined
  /**
   * MCP servers the local executor connects at startup, each projected into
   * the run's flow catalog by `@smthrs/mcp/McpFlows`. Empty by default, and
   * meaningless when `remote` is set — a remote composition's executor is not
   * this process's to configure.
   */
  readonly mcpServers?: ReadonlyArray<McpClient.ConnectOptions> | undefined
  /**
   * The project root every durable layer is built over: the `.flows/`
   * directory, the `flows/` registry sources, and the detached run logs all
   * hang off it. Resolved from `--root` or the nearest ancestor holding
   * `.flows/` or `flows/`, before any command handler runs.
   */
  readonly root?: string | undefined
  /**
   * The 0.x project `smthrs migrate` converts when the operator names no
   * path: `--root`, or the nearest ancestor holding 0.x state.
   *
   * Not {@link Config.root}. That one anchors on `.flows/`, which a 0.x
   * project does not have, so migrating from a directory nested under an rc.0
   * project targeted the ancestor.
   */
  readonly migrationRoot?: string | undefined
}

/**
 * The runtime and journal a local composition executes on.
 *
 * Pass one to {@link layer} to choose where a local command's runs and events
 * are recorded: {@link engineMemory} for a composition that must not touch the
 * disk, `NodeControl.engineDurable` for the real project database.
 *
 * A journal is required, not optional: `Journal.layerNoop()` is a closed stub,
 * so every mutation event (decide/resume/launch) failed with
 * `journal_closed` after the runtime had already transitioned.
 *
 * @category models
 * @since 0.1.0
 */
export interface Engine {
  readonly runtime: Layer.Layer<ControlRuntime.ControlRuntime>
  readonly journal: Layer.Layer<Journal.Journal>
}

/**
 * The in-memory engine: a deterministic runtime over an in-memory SQLite
 * journal.
 *
 * It is the default because this module is transport-neutral and cannot open a
 * file. Nothing it records survives the process, so a platform composition
 * that can reach durable storage should supply its own —
 * `NodeControl.engineDurable` is the Node one.
 *
 * A local journal that fails to migrate cannot serve anything; startup failure
 * is a defect, not a typed control-plane error.
 *
 * @category layers
 * @since 0.1.0
 */
export const engineMemory: Engine = {
  // The runtime mints identifiers through `Crypto`, which is a host service
  // now rather than an ambient global.
  runtime: ControlRuntime.layerMemory().pipe(Layer.provide(NodeCrypto.layer)),
  journal: TestJournal.layer().pipe(Layer.orDie)
}

const rpcUrl = (remote: string): string => {
  const url = new URL(remote)
  if (!url.pathname.endsWith("/rpc")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/rpc`
  }
  return url.toString()
}

/**
 * Selects the sole Control implementation used by the command tree.
 *
 * Local commands call the in-process implementation directly. Remote commands
 * use the RPC-backed implementation and leave its abstract HTTP and socket
 * requirements for a platform composition module to provide.
 *
 * `registry` is the local flow registry and `engine` is what local commands
 * execute on. This module is transport-neutral, so it can construct neither a
 * filesystem-backed registry nor a file-backed engine and defaults to the empty
 * registry and the in-memory engine; a platform composition supplies the real
 * things — `NodeControl.layerRegistry` and `NodeControl.engineDurable` are the
 * Node ones.
 *
 * `executor` is the run executor `ControlLive.run` starts accepted launches
 * on. It must be provided here — `ControlLive` resolves it with
 * `Effect.serviceOption` while its own layer is built, so an executor
 * provided from outside an already-satisfied layer is invisible. Omitting it
 * leaves every run `pending`, which is only correct for compositions that
 * observe runs without executing them. `NodeControl.layerExecutor` is the
 * production one.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  config: Config,
  // Discovery, not safety: the empty registry is the transport-neutral default
  // this module can build, and `NodeControl.layerRegistry` is the production
  // one every Node composition passes. A command that finds no flows says so;
  // it does not run anything with a guard removed.
  // eslint-disable-next-line no-restricted-syntax -- registry is discovery, see above
  registry: Layer.Layer<Registry.Registry> = Registry.layerNoop(),
  engine: Engine = engineMemory,
  executor?:
    | Layer.Layer<
      ControlExecutor.ControlExecutor,
      never,
      ControlRuntime.ControlRuntime | Journal.Journal | NotificationQueue.NotificationQueue | Registry.Registry
    >
    | undefined
): Layer.Layer<Control.Control, never, HttpClient | RpcSerialization | Socket> =>
  config.remote === undefined
    // An executor built for a host that drives no run holds the port so a
    // listing still reads the engine, but refuses a launch, so this process
    // will never settle an accepted run and no verb may wait for one.
    ? LocalControl.layer(registry, engine, executor, undefined, config.startsRuns !== false)
    : Layer.merge(
      ControlClient.layer({ url: rpcUrl(config.remote), credential: config.credential }),
      ExecutorOwnership.layer(false)
    )
