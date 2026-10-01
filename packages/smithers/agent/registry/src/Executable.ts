/**
 * Turning a discovered descriptor into something the durable engine runs.
 *
 * Discovery answers *what flows exist*: a {@link module:Descriptor.FlowDescriptor}
 * is metadata read without evaluating anything, with the body left behind a
 * {@link module:Descriptor.BodyRef}. Nothing in that answer is executable, so
 * `smithers up <flow>` could print a plan card and stop. This module is the
 * missing half: it loads the body a descriptor points at, resolves the
 * `@smthrs/flow` flow the descriptor delegates to, and returns a durable flow
 * plus the `Interpreter` layer that registers it with the runtime.
 *
 * A discovered flow arrives in one of two shapes. A module that
 * default-exports a `@smthrs/flow` flow IS the work: its own body is the plan,
 * and {@link selfDelegate} makes it its own delegate so nothing has to be
 * registered under a name. Everything else — a markdown `flows:` frontmatter
 * list, a `@smthrs/core` `Flow.make({ flows })` — declares WHAT it delegates
 * to, and the host declares HOW that work runs by registering `@smthrs/flow`
 * flows under those names.
 *
 * The bridge deliberately does not compile a `@smthrs/core` graph into a plan.
 * For a delegating descriptor one delegating node is therefore the whole
 * lowering. Either way the runtime decisions the descriptor carries ride the
 * same lowering:
 *
 * - the declared cache policy goes onto the ACTION the bridged flow
 *   dispatches, which is the value `@smthrs/engine-store` `ActionPersistence`
 *   reads a policy off: `ttlMs` bounds the age of the row the engine may
 *   serve and `scope` narrows the address it is stored under. Declaring one is
 *   also what makes the delegation a single dispatched step at all; read
 *   {@link Lowered.cache} and {@link dispatchedAction} for the shape and for
 *   the one gate a policy still has to pass;
 * - `Node.priority` becomes the delegating node's priority, which is what
 *   reaches `NodeDraft.priority` and `@smthrs/engine-store`'s `PlanScheduler`.
 *   The rc.0 `up` path settles a flow through `@smthrs/flow` `Interpreter`,
 *   which admits every ready node at once, so the priority orders scheduled
 *   plans and nothing else;
 * - the placement directive becomes both the flow's placement annotation,
 *   which is the one key `@smthrs/plan` declares, and a field of the
 *   {@link Invocation} the delegate reads, which is what a host selects a
 *   spawn target with.
 *
 * A delegate the host never registered is refused HERE, with an
 * {@link ExecutableError} naming it, rather than at dispatch: an unresolved
 * call inside the engine dies with an empty `AnyOf` issue that names nothing
 * during dispatch, and a missing flow is a wiring mistake
 * an operator can fix only if the message says which flow is missing.
 *
 * @since 1.0.0-rc.0
 */

import * as Annotations from "@smthrs/core/Annotations"
import * as CoreFlow from "@smthrs/core/Flow"
import * as CoreMarkdown from "@smthrs/core/Markdown"
import * as CorePlacement from "@smthrs/core/Placement"
import * as Action from "@smthrs/flow/Action"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import * as RuntimeFlow from "@smthrs/flow/Flow"
import { FlowInstance, FlowRuntime } from "@smthrs/flow/FlowRuntime"
import * as Graph from "@smthrs/flow/Graph"
import * as Interpreter from "@smthrs/flow/Interpreter"
import type * as FileSet from "@smthrs/plan/FileSet"
import * as PlanNode from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Descriptor from "./Descriptor.ts"
import { readVerifiedBody } from "./internal/Body.ts"
import * as ModuleClosure from "./internal/ModuleClosure.ts"
import * as MarkdownFlow from "./MarkdownFlow.ts"
import * as Registry from "./Registry.ts"
import type { DiscoveryError, RegistryError } from "./RegistryError.ts"

/**
 * The delegate a descriptor runs on when it names no single flow of its own.
 *
 * A markdown skill and a bodiless `Flow.make({ model })` both say "a model
 * does this"; neither names the code that drives one. `agent` is the name a
 * host registers that driver under, and {@link Options.agent} renames it for a
 * host that calls it something else.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const defaultAgent = "agent"

/**
 * The payload a bridged flow is executed with.
 *
 * One JSON field, because the caller is `smithers up <flow> --data <json>` or
 * a control-plane launch, and neither knows the descriptor's schema at the
 * call site. A markdown flow receives its `{ args }` here.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Payload = Schema.Struct({
  input: Schema.optionalKey(Schema.Json)
})

/**
 * The payload a bridged flow is executed with.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Payload = typeof Payload.Type

/**
 * Everything a delegate is told about the descriptor it is running.
 *
 * It is a fixed, serializable envelope rather than the descriptor's own input
 * schema, because a host registers ONE delegate for many descriptors: the
 * agent driver runs every markdown skill in the project. The envelope is what
 * lets it, and it carries the two decisions a driver cannot re-derive —
 * `placement`, which selects the host a cell is spawned on, and `model`, which
 * selects the seat.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Invocation = Schema.Struct({
  /** The discovered flow's registry name. */
  flow: Schema.String,
  /** The caller's input, as JSON. `null` when the caller supplied none. */
  input: Schema.Json,
  /** The rendered markdown body, or the empty string for a module flow. */
  prompt: Schema.String,
  /** The seat the descriptor declared, or `null`. */
  model: Schema.NullOr(Descriptor.ModelSelection),
  /**
   * The lowered host kind, or `null`. A loaded body annotation wins over the
   * descriptor directive.
   */
  placement: Schema.NullOr(Descriptor.Placement),
  /**
   * Host-selection detail for the lowered placement, or `null` when it names
   * no image, profile, or target. A loaded body annotation wins here too.
   *
   * An absent key decodes to `null`. This envelope is a durable action payload
   * — hosts pass `Invocation` itself as an `Action.make` payload schema — so a
   * journal row written before this field existed is decoded again on replay.
   * Without the decoding default that replay would fail on a missing key. The
   * default applies to DECODING only: encoding still writes the key, so the
   * step key an envelope carrying a placement hashes to does not move.
   */
  placementOptions: Schema.NullOr(Schema.Struct({
    image: Schema.optional(Schema.String),
    profile: Schema.optional(Schema.String),
    target: Schema.optional(Schema.String)
  })).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The capabilities the descriptor declared. */
  capabilities: Schema.Array(Schema.String),
  /** The collaborator flows the descriptor declared. */
  flows: Schema.Array(Schema.String)
})

/**
 * Everything a delegate is told about the descriptor it is running.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Invocation = typeof Invocation.Type

/**
 * A registered `@smthrs/flow` flow a descriptor may delegate to.
 *
 * Structural on purpose: a `Flow.make(...)` value satisfies it, and so does a
 * test double. The bridge needs the tag to resolve a name, and both ways of
 * reaching the flow, because the descriptor decides which one it uses: a
 * declared cache policy makes the delegation one dispatched step and a child
 * execution beneath it, and no policy leaves it a call in the caller's plan.
 * See {@link fromDescriptor} for the choice and {@link Lowered.cache} for why
 * it is a choice at all.
 *
 * Structural does not mean untyped. Both ways in take the {@link Invocation}
 * envelope, because that is the only value the bridge ever supplies: a
 * delegate is resolved by TAG, so a flow whose payload is its own shape would
 * otherwise resolve, load, and fail at dispatch on an envelope missing every
 * field it asked for. Requiring the envelope here refuses that flow where the
 * host writes it down instead.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Delegate {
  readonly _tag: string
  /**
   * Existing Flow codecs, preserved in inline and dispatched bridges. Custom
   * delegates without codecs keep their historical Unknown/JSON-only behavior.
   */
  readonly successSchema?: Schema.Top | undefined
  readonly errorSchema?: Schema.Top | undefined
  /**
   * Places the delegation in the caller's plan. This is the shape a descriptor
   * that declares no cache policy takes: the delegate's own topology — its
   * fan-out, its priorities, its waits — is part of the plan the engine builds
   * for the bridged flow, and a host reading that plan sees the real work.
   */
  readonly call: (payload: Invocation) => PlanNode.Node<any, any, any>
  /**
   * Runs the delegate as an execution of its own. This is the shape a
   * descriptor that DECLARES a cache policy takes, because a result can only
   * be recorded and served again if the delegation is one dispatched step;
   * see {@link fromDescriptor}.
   */
  readonly execute: (
    payload: Invocation,
    options?: { readonly executionId?: string | undefined }
  ) => Effect.Effect<any, any, any>
}

/**
 * Stable reasons a descriptor cannot be made runnable.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const ExecutableErrorCode = Schema.Literals([
  "missing_delegate",
  "ambiguous_delegate",
  "load_timeout",
  "body_unavailable",
  "invalid_module",
  "invalid_layer",
  "missing_service",
  "layer_failed"
])

/**
 * Stable reasons a descriptor cannot be made runnable.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ExecutableErrorCode = typeof ExecutableErrorCode.Type

/**
 * A descriptor the bridge will not turn into a runnable flow.
 *
 * `delegate` is present whenever the refusal is about one named flow, which is
 * the whole point of the type: the engine's own unresolved-call defect names
 * nothing, so an operator reading it cannot tell which registration is
 * missing.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class ExecutableError extends Schema.TaggedError<ExecutableError>()(
  "flows/registry/ExecutableError",
  {
    code: ExecutableErrorCode,
    flow: Schema.String,
    path: Schema.optional(Schema.String),
    delegate: Schema.optional(Schema.String),
    service: Schema.optional(Schema.String),
    available: Schema.Array(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {}

/**
 * The runtime decisions lowered off a descriptor and its loaded body.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Lowered {
  /**
   * The declared cache policy, or `undefined` when none was declared.
   *
   * A declared policy is what makes a discovered flow's result reusable, and
   * declaring one changes the shape of the plan: the delegation becomes one
   * dispatched action ({@link dispatchedAction}) instead of the delegate's own
   * call, because a result can only be recorded and served again if it is one
   * step. The policy rides that action under the annotation
   * `@smthrs/engine-store` `ActionPersistence` reads a policy off, so `ttlMs`
   * bounds the age of the row the engine may serve and `scope` narrows the
   * address it is stored under. It also enters the delegating node's captured
   * key material, so a changed policy is a changed step key.
   *
   * One gate remains, and it is the engine's: `ActionPersistence` reuses a
   * `sealed` dispatch and nothing else. A descriptor that names a delegate flow
   * inherits authority discovery cannot read, so it projects the conservative
   * wildcard and its effective tier is `irreversible`; its policy reaches
   * admission and is refused there. A descriptor whose own capabilities project
   * a `sealed` tier — an agent-backed skill declaring what it may touch — is
   * the one whose recorded result travels.
   */
  readonly cache: CacheEnvironment.CachePolicy | undefined
  /**
   * The declared scheduling priority, or `undefined`.
   *
   * Honored by `@smthrs/engine-store`'s `PlanScheduler`, which admits ready
   * nodes highest-priority-first under a concurrency limit. The rc.0 `up` path
   * runs a flow through `@smthrs/flow` `Interpreter`, which settles every ready
   * node at once, so on that path the priority orders nothing.
   */
  readonly priority: number | undefined
  /** The declared placement directive, or `undefined`. */
  readonly placement: CorePlacement.Placement | undefined
}

/**
 * What a registration layer still needs from its host: the flow runtime it
 * registers with, the action implementation table a driver resolves the
 * bridged dispatch through, and the `Crypto` the bridge derives its delegate's
 * child execution id with.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Registration = FlowRuntime | Action.Implementations | Crypto.Crypto

/**
 * One discovered flow, made runnable.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Executable {
  /** The descriptor this was built from. */
  readonly descriptor: Descriptor.FlowDescriptor
  /** The module's own Flow.make tag, before the private admission adapter. */
  readonly declaredTag?: string | undefined
  /**
   * The registered flow this descriptor delegates to, or `undefined` when the
   * module IS the flow and delegates to nothing.
   *
   * The distinction is an authority one, which is why it is `undefined` rather
   * than the flow's own tag. A delegate is a flow REGISTERED BY THE HOST under
   * a name; nothing in the descriptor measures its code, so the approved
   * envelope has to name it. A module that is its own flow is measured instead:
   * {@link module:Descriptor.executionDigest} covers its entry bytes and the
   * digest of every module that entry loads from beside itself
   * ({@link module:Descriptor.BodyRefModule.imports}), and
   * {@link module:Executable.fromDescriptor} re-measures that closure before
   * importing anything. Installed packages it imports are not measured and are
   * not meant to be; a bare specifier a loader maps onto project files (a
   * package.json `imports` entry, a tsconfig `paths` alias) is measured.
   */
  readonly delegate: string | undefined
  /**
   * The payload schema a module that IS its flow declared; `undefined` for
   * delegating and markdown descriptors.
   *
   * Discovery reads a module without importing it, so no listing carries this
   * schema. A host that asks a person for missing input reads it here.
   */
  readonly input: Schema.Top | undefined
  /** The runtime decisions lowered off the descriptor. */
  readonly lowered: Lowered
  /** The envelope the delegate receives for a given caller input. */
  readonly invocation: (input: Schema.Json) => Invocation
  /**
   * The durable input adapter. Its tag is source-qualified when the user's
   * declaration already owns the descriptor's registry name. Delegate
   * already erases its call/execute services at this dynamic boundary; the
   * same host owns its codec services when registering and executing.
   */
  readonly flow: RuntimeFlow.Flow<
    string,
    typeof Payload,
    Schema.Codec<unknown, unknown>,
    Schema.Codec<unknown, unknown>,
    any
  >
  /**
   * Registers {@link Executable.flow} with the runtime. May be provided more
   * than once while the scoped host that loaded this executable remains alive;
   * that loading host owns resources acquired by an exported implementation layer.
   * Refresh releases replaced entries after registering the new one; active
   * consumers of a retired entry must finish before the host requests refresh.
   */
  readonly layer: Layer.Layer<never, never, Registration>
}

// Refresh retires resources owned by an executable's original loading scope.
const moduleScopes = new WeakMap<Executable, Scope.Closeable>()

/**
 * One module of a flow's verified closure: the bytes discovery's identity
 * measured, their text, and each static specifier in that text that names
 * another module of the closure, as the specifier token's source range and
 * the absolute path of the module it names.
 *
 * @category models
 * @since 1.0.0
 */
export type ClosureModule = ModuleClosure.Module

/**
 * How a descriptor is loaded and what it may delegate to.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  /**
   * A host-owned retained checkout for the same project locator identity.
   * Only locators beneath identity are accepted; measured bytes and closure
   * checks remain mandatory. The descriptor and approved digest never change.
   */
  readonly sourceRoot?: { readonly identity: string; readonly workspace: string } | undefined
  /** The registered runtime flows a descriptor may delegate to. */
  readonly delegates: ReadonlyArray<Delegate>
  /** The delegate a model-backed descriptor runs on. Defaults to `agent`. */
  readonly agent?: string | undefined
  /**
   * Per-entry catalog deadline in milliseconds. Defaults to
   * SMITHERS_FLOW_LOAD_TIMEOUT_MS, or 30,000 when unset or invalid.
   * Must be positive and finite. Direct descriptor loads have no deadline.
   */
  readonly loadTimeoutMs?: number | undefined
  /**
   * Evaluates the verified entry bytes. Any cache must include both path and
   * contentDigest; reopening path does not honor the verified identity.
   * `modules` holds the verified bytes of every module the entry statically
   * reaches, entry included, keyed by absolute path; reopening those paths
   * does not honor the verified closure either. Defaults to importing
   * private sibling copies of that whole closure.
   */
  readonly load?:
    | ((path: string, source: {
      readonly bytes: Uint8Array
      readonly contentDigest: string
      readonly modules: ReadonlyMap<string, ClosureModule>
    }) => Effect.Effect<unknown, unknown>)
    | undefined
}

const refuse = (options: {
  readonly code: ExecutableErrorCode
  readonly flow: string
  readonly path?: string | undefined
  readonly delegate?: string | undefined
  readonly service?: string | undefined
  readonly available?: ReadonlyArray<string> | undefined
  readonly message: string
  readonly cause?: unknown
}): ExecutableError =>
  new ExecutableError({
    code: options.code,
    flow: options.flow,
    path: options.path,
    delegate: options.delegate,
    service: options.service,
    available: options.available ?? [],
    message: options.message,
    cause: options.cause
  })

/**
 * A `file:` specifier for an absolute filesystem path.
 *
 * Written by hand rather than with `node:url` so a package importing this
 * conversion does not also require a Node builtin or a bundler shim for one.
 * It follows `pathToFileURL`'s escaping for filesystem paths. A `#` or a `?`
 * in a directory name is both a legal filename character and URL syntax, and
 * concatenating one unescaped truncates the specifier at it, so `file:///a#b.ts`
 * addresses `/a`. The loader then imports the wrong module, or none, with
 * nothing in the failure to say why.
 *
 * Exported because {@link Options.load} receives a resolved filesystem path
 * or an existing file URL. A host that supplies its own loader can convert
 * filesystem paths without depending on `node:url` here.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const fileSpecifier = (path: string): string => {
  if (path.startsWith("file:")) return path
  const normalized = /^[A-Za-z]:[\\/]/.test(path) ? path.replaceAll("\\", "/") : path
  const escaped = encodeURI(normalized).replaceAll("#", "%23").replaceAll("?", "%3F")
  return normalized.startsWith("/") ? `file://${escaped}` : `file:///${escaped}`
}

/**
 * Distinguishes one load's private sibling from another's within a process.
 *
 * Nothing rests on it. The exclusive create below is what makes the file this
 * load's own, and a name already taken is answered by trying the next one.
 * This only keeps two concurrent loads of the same bytes from spending their
 * attempts colliding with each other.
 */
let loadSequence = 0

/**
 * Reserves a private sibling of the source file, created exclusively.
 *
 * `makeTempDirectory` is not available here. The capability kernel's guarded
 * filesystem — the one every agent-reachable host composes — implements the
 * `makeTemp*` family only over a wholly isolated host filesystem, and a
 * descriptor-relative POSIX adapter is not one, so on a real native host every
 * `makeTempDirectoryScoped` is refused with "host does not provide
 * descriptor-relative, no-follow filesystem isolation". A loader that reserved
 * its name that way could therefore never load a project's own module flow on
 * the hosts this loader exists for.
 *
 * The exclusive create is the whole reservation. `wx` fails when anything
 * already occupies the name, INCLUDING a symlink, and the kernel performs it
 * relative to a pinned parent descriptor without following one, so a name an
 * attacker pre-creates costs this load an attempt and reaches nothing.
 */
const reserveSibling = (
  fs: FileSystem.FileSystem,
  prefix: string,
  extension: string,
  attempts = 8
): Effect.Effect<string, unknown> =>
  Effect.suspend(() => {
    loadSequence += 1
    const candidate = `${prefix}${loadSequence.toString(36)}-${Date.now().toString(36)}${extension}`
    return fs.writeFile(candidate, new Uint8Array(0), { flag: "wx", mode: 0o600 }).pipe(
      Effect.as(candidate),
      Effect.catch((cause) => attempts > 1 ? reserveSibling(fs, prefix, extension, attempts - 1) : Effect.fail(cause))
    )
  })

/**
 * How old a load sibling must be before a later load may remove it.
 *
 * A live load removes its own sibling as soon as the import settles, so a
 * sibling this old was left by a crash or a failed unlink. The age keeps a
 * concurrent load in another process from losing the file mid-import.
 */
const staleSiblingAgeMs = 10 * 60 * 1000

/** `.smithers-<digest>-<sequence>-<base-36 epoch ms><extension>`, as {@link reserveSibling} names it. */
const loadSibling = /^\.smithers-.+-[0-9a-z]+-([0-9a-z]+)\.[A-Za-z0-9]+$/

/**
 * Removes the load siblings a crash left in `directory`. Best effort: a
 * listing or an unlink that fails leaves the file for the next load.
 */
const removeStaleSiblings = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string
): Effect.Effect<void> =>
  fs.readDirectory(directory).pipe(
    Effect.flatMap((names) =>
      Effect.forEach(names, (name) => {
        const stamp = loadSibling.exec(name)?.[1]
        const createdAt = stamp === undefined ? Number.NaN : Number.parseInt(stamp, 36)
        return Number.isFinite(createdAt) && Date.now() - createdAt > staleSiblingAgeMs
          ? Effect.ignore(fs.remove(path.join(directory, name)))
          : Effect.void
      }, { discard: true })
    ),
    Effect.ignore
  )

/**
 * Evaluates a verified closure as one coherent version.
 *
 * Every module is written as a private sibling of its original, so each keeps
 * its directory — the base of its relative imports, its nearest package.json,
 * the node_modules it resolves packages from — and every linked static
 * specifier is rewritten to name the sibling of its target. Each load
 * therefore evaluates exactly the measured bytes of the whole closure under
 * fresh module specifiers: a refreshed helper is never answered from the
 * host's module cache with the exports of an earlier version, and cycles
 * stay cycles among the siblings. The siblings are removed once the import
 * settles.
 */
const importModule = (
  path: string,
  source: {
    readonly bytes: Uint8Array
    readonly contentDigest: string
    readonly modules: ReadonlyMap<string, ClosureModule>
  }
): Effect.Effect<unknown, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const platformPath = yield* Path.Path
    const sourcePath = path.startsWith("file:") ? yield* platformPath.fromFileUrl(new URL(path)) : path
    // The closure is keyed by absolute path and always holds the entry.
    const entryPath = platformPath.resolve(sourcePath)
    const modules = source.modules
    const swept = new Set<string>()
    const siblings = new Map<string, string>()
    for (const original of modules.keys()) {
      const directory = platformPath.dirname(original)
      if (!swept.has(directory)) {
        swept.add(directory)
        yield* removeStaleSiblings(fs, platformPath, directory)
      }
      const reserved = yield* Effect.acquireRelease(
        reserveSibling(
          fs,
          platformPath.join(directory, `.smithers-${source.contentDigest}-`),
          original.endsWith(".mdx") ? ".mjs" : platformPath.extname(original) || ".mjs"
        ),
        // The module is already evaluated; a sibling that will not unlink
        // (EBUSY on Windows, a guard refusal) must not undo a successful
        // load. The next load in this directory sweeps it once it is stale.
        (sibling) =>
          fs.remove(sibling).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("could not remove a module load sibling").pipe(
                Effect.annotateLogs({ path: sibling, reason: String(cause) })
              )
            )
          )
      )
      siblings.set(original, reserved)
    }
    for (const [original, module] of modules) {
      const sibling = siblings.get(original)!
      yield* fs.writeFile(sibling, rewriteLinks(platformPath, original, module, siblings))
      // Said before the import, because a declaration captures its site while
      // the module is evaluated: without it every node of this flow would name
      // a scratch file removed when the load settles (D-068).
      Graph.evaluatedFrom(sibling, original)
    }
    return yield* Effect.tryPromise({
      try: () => import(/* @vite-ignore */ fileSpecifier(siblings.get(entryPath)!)) as Promise<unknown>,
      catch: (cause) => cause
    })
  }).pipe(Effect.scoped)

/**
 * A module's bytes with each linked specifier naming its target's sibling.
 *
 * The replacement is the sibling's path relative to the importer's directory,
 * spelled literally as the closure walk resolved the original. A module with
 * no links is written byte for byte, except MDX, which uses its compiled source.
 */
const rewriteLinks = (
  platformPath: Path.Path,
  original: string,
  module: ClosureModule,
  siblings: ReadonlyMap<string, string>
): Uint8Array => {
  if (module.links.length === 0) {
    return original.endsWith(".mdx")
      ? new TextEncoder().encode(module.source)
      : module.bytes
  }
  const directory = platformPath.dirname(original)
  let text = ""
  let copied = 0
  // Links arrive in source order, as the scanner met them.
  for (const link of module.links) {
    const relative = platformPath.relative(directory, siblings.get(link.target)!).replaceAll("\\", "/")
    text += module.source.slice(copied, link.start) +
      JSON.stringify(relative.startsWith("../") ? relative : `./${relative}`)
    copied = link.end
  }
  return new TextEncoder().encode(text + module.source.slice(copied))
}

/**
 * The registry name of the flow a descriptor delegates to.
 *
 * A descriptor that names exactly one flow delegates to it. One that names
 * none delegates to the agent, and so does one that names several while
 * declaring a model — a skill listing its tools is naming what the model may
 * call, not what runs it. Several named flows and no model leaves nothing to
 * choose between them, and the bridge refuses rather than guesses.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const delegateOf = (
  descriptor: Descriptor.FlowDescriptor,
  options: { readonly agent?: string | undefined } = {}
): Effect.Effect<string, ExecutableError> => {
  const agent = options.agent ?? defaultAgent
  if (descriptor.flows.length === 1) return Effect.succeed(descriptor.flows[0]!)
  if (descriptor.flows.length === 0 || Option.isSome(descriptor.model)) return Effect.succeed(agent)
  return Effect.fail(
    refuse({
      code: "ambiguous_delegate",
      flow: descriptor.name,
      message:
        `flow "${descriptor.name}" names ${descriptor.flows.length} flows and no model, so the flow it delegates to is undecidable; declare a model or name one flow`
    })
  )
}

/**
 * The placement directive a descriptor's literal stands for.
 *
 * Discovery records placement as one of four literals because a descriptor is
 * serializable; `@smthrs/core` models it as a tagged value with host-selection
 * options. This is the one-way projection between them.
 */
const placementOf = (literal: Descriptor.Placement): CorePlacement.Placement => {
  switch (literal) {
    case "client":
      return CorePlacement.client()
    case "local":
      return CorePlacement.local()
    case "sandbox":
      return CorePlacement.sandbox()
    case "remote":
      return CorePlacement.remote()
  }
}

/**
 * Reads the runtime decisions a loaded body and its descriptor declare.
 *
 * The body's annotation bag wins over the descriptor's frontmatter, because a
 * body is the later and more specific statement: `Flow.within(...)` and
 * `@smthrs/patterns`' `withCache` both write there, and frontmatter cannot
 * express either.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const lower = (
  descriptor: Descriptor.FlowDescriptor,
  annotations: Context.Context<never>
): Lowered => ({
  cache: CacheEnvironment.cachePolicyOf(annotations),
  priority: Option.getOrUndefined(Annotations.getOption(annotations, Annotations.Priority)),
  placement: Option.getOrUndefined(Annotations.getOption(annotations, Annotations.Placement)) ??
    Option.getOrUndefined(Option.map(descriptor.placement, placementOf))
})

const ownedJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(ownedJson))
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, ownedJson(child)])))
  }
  return value
}

const ownedStrings = (values: ReadonlyArray<string>): Array<string> => {
  const copy = [...values]
  Object.freeze(copy)
  return copy
}

const invocationPlacement = (
  placement: CorePlacement.Placement | undefined
): Pick<Invocation, "placement" | "placementOptions"> => {
  if (placement === undefined) return { placement: null, placementOptions: null }
  switch (placement._tag) {
    case "flows/core/Placement/Client":
      return { placement: "client", placementOptions: null }
    case "flows/core/Placement/Local":
      return { placement: "local", placementOptions: null }
    case "flows/core/Placement/Sandbox":
    case "flows/core/Placement/Remote": {
      const options = {
        ...(placement.image === undefined ? {} : { image: placement.image }),
        ...(placement.profile === undefined ? {} : { profile: placement.profile }),
        ...(placement.target === undefined ? {} : { target: placement.target })
      }
      return {
        placement: placement._tag === "flows/core/Placement/Sandbox" ? "sandbox" : "remote",
        placementOptions: Object.keys(options).length === 0 ? null : Object.freeze(options)
      }
    }
  }
}

/** The captured declaration identity a policy contributes to the node's key. */
const captured = (lowered: Lowered): Readonly<Record<string, unknown>> => ({
  ...(lowered.cache?.ttlMs === undefined ? {} : { ttlMs: lowered.cache.ttlMs }),
  ...(lowered.cache?.scope === undefined ? {} : { scope: lowered.cache.scope })
})

/**
 * The annotation bag the bridged flow carries.
 *
 * Placement is stored under the one placement key, `@smthrs/plan`'s
 * `Placement.Annotation`, which `@smthrs/core` publishes as
 * `Annotations.Placement` and `@smthrs/flow` as `Flow.Placement`, and which
 * `@smthrs/flow` `Graph` reads while building the plan. The two used to be
 * separate keys over separate value types and this line was a cast. The cache policy is
 * stored under `CacheEnvironment.CachePolicyAnnotation`, the identifier
 * `@smthrs/patterns`' `withCache` writes on a flow, so a host reading the
 * bridged flow back sees the same declaration the descriptor made.
 *
 * A flow's bag is not an action's bag, and nothing carries one onto the other:
 * `@smthrs/engine-store` `ActionPersistence` reads a policy off the DISPATCHED
 * ACTION. That copy is written by {@link dispatchedAction}, which is the half
 * that reaches admission. This bag is the declaration surface.
 */
const annotationsOf = (lowered: Lowered): Context.Context<never> => {
  let bag = Context.empty()
  if (lowered.cache !== undefined) bag = Context.add(bag, CacheEnvironment.CachePolicyAnnotation, lowered.cache)
  if (lowered.placement !== undefined) {
    bag = Context.add(bag, RuntimeFlow.Placement, lowered.placement)
  }
  return bag
}

/**
 * The filesystem boundary a descriptor's own effect declaration lowers to.
 *
 * A descriptor declares reads and writes as strings plus a `mode`, because it
 * is serializable metadata read without evaluating anything. An action's
 * `Action.FileBoundary` wants measured inputs or globs on the read side and
 * patterns on the write side. A declared read carries no digest at discovery
 * time, so the whole read set lowers to one glob the host expands and
 * measures; `@smthrs/engine-store` keeps a globbed read set out of the
 * cross-run cache, so a descriptor that declares reads is boundary-checked but
 * not reused. `hermetic` says the two sets are complete, which is exactly what
 * a `hard` boundary enforces, and `expected` records a deviation rather than
 * refusing the result.
 *
 * The patterns are the author's, not the bridge's: an unusable one is refused
 * by the host that prepares the boundary, naming the path.
 */
const boundaryOf = (descriptor: Descriptor.FlowDescriptor): Action.FileBoundary => ({
  readSet: descriptor.effects.reads.length === 0
    ? []
    : [{ _tag: "Glob", include: descriptor.effects.reads as FileSet.Glob["include"] }],
  writeSet: descriptor.effects.writes,
  boundaryMode: descriptor.effects.mode === "hermetic" ? "hard" : "expected"
})

/**
 * The loaded body of one descriptor: the prompt it renders, the annotation bag
 * its declaration carries, and the flow it IS when it is one.
 *
 * A markdown body and a `@smthrs/core` declaration both say WHAT to run and
 * leave HOW to a host-registered flow, so `flow` is absent for them. A module
 * that default-exports a `@smthrs/flow` flow carries its own graph, so there is
 * nothing to look up: {@link selfDelegate} turns that flow into the delegate.
 */
interface LoadedBody {
  readonly prompt: string
  readonly annotations: Context.Context<never>
  readonly flow: LoadedFlow | undefined
  readonly layer?: Layer.Layer<unknown, unknown, unknown> | undefined
}

/**
 * A loaded `@smthrs/flow` flow, at the dynamic boundary a module load is: any
 * tag, any schemas, and whatever action implementations its body names.
 */
type LoadedFlow = RuntimeFlow.Flow<string, RuntimeFlow.AnyStructSchema, Schema.Top, Schema.Top, any>

const sourceBytes = (
  descriptor: Descriptor.FlowDescriptor,
  sourcePath: string
): Effect.Effect<Uint8Array, ExecutableError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* readVerifiedBody(fs, path, descriptor).pipe(
      Effect.mapError((failure) =>
        refuse({
          code: "body_unavailable",
          flow: descriptor.name,
          path: sourcePath,
          message: failure._tag === "changed"
            ? `the body of flow "${descriptor.name}" changed at "${sourcePath}" after discovery; refresh the registry before running it`
            : failure._tag === "unmeasured"
            ? `the body of flow "${descriptor.name}" is unmeasured at "${sourcePath}"; refresh the registry before running it`
            : `the body of flow "${descriptor.name}" is unavailable at "${sourcePath}"`,
          cause: failure._tag === "unreadable" ? failure.cause : undefined
        })
      )
    )
  })

const loadMarkdown = (
  descriptor: Descriptor.FlowDescriptor,
  path: string,
  baseDirectory: string
): Effect.Effect<LoadedBody, ExecutableError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const text = new TextDecoder().decode(yield* sourceBytes(descriptor, path))
    const body = MarkdownFlow.loadBody(text, baseDirectory)
    const prompt = MarkdownFlow.renderPrompt(body, { args: "" })
    const lowered = CoreMarkdown.lowerMarkdown(MarkdownFlow.toCoreFrontmatter(descriptor), prompt)
    return { prompt, annotations: lowered.annotations, flow: undefined }
  })

/**
 * Re-measures what the entry loads from beside itself, refuses when it is not
 * what discovery recorded, and returns the measured closure.
 *
 * `sourceBytes` verifies the ENTRY and nothing else. Everything the entry
 * reaches is code this flow runs, so it is measured here, against the list on
 * the descriptor's {@link module:Descriptor.BodyRefModule.imports} — the same
 * list `Descriptor.executionDigest` folds into the identity a plan was
 * approved under. The bytes measured are the bytes {@link importModule}
 * evaluates, so no module of the static closure is read a second time between
 * this check and the import.
 *
 * Measured project helpers reached through `import()` or `require()`, or a
 * mapping without one linked static target, are refused before importing the
 * entry. Reopening those paths could reuse stale host cache entries, while
 * rewriting deferred calls to short-lived siblings would outlive cleanup.
 *
 * BARE SPECIFIERS ARE NOT MEASURED. `@smthrs/flow`, `effect`, and every other
 * package resolve into installed code, which is the host's own code under the
 * host's own trust.
 */
const verifyImports = (
  descriptor: Descriptor.FlowDescriptor,
  path: string,
  bytes: Uint8Array,
  recorded: ReadonlyArray<Descriptor.ModuleImport>
): Effect.Effect<ReadonlyMap<string, ClosureModule>, ExecutableError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const platformPath = yield* Path.Path
    const entryPath = path.startsWith("file:")
      ? yield* Effect.orDie(
        Effect.flatMap(Effect.try(() => new URL(path)), (url) => platformPath.fromFileUrl(url))
      )
      : platformPath.normalize(path)
    const { imports: measured, modules, unsupported } = yield* ModuleClosure.snapshot(
      fs,
      platformPath,
      entryPath,
      bytes
    )
    const unpinnable = measured.find((entry) => entry.contentDigest === undefined)
    if (unpinnable !== undefined) {
      return yield* Effect.fail(
        refuse({
          code: "body_unavailable",
          flow: descriptor.name,
          path,
          message:
            `flow "${descriptor.name}" runs code this host cannot pin: ${unpinnable.path}. Every module a flow's entry loads from beside itself has to be measurable before it runs`
        })
      )
    }
    const pinned = new Map(recorded.map((entry) => [entry.path, entry.contentDigest] as const))
    const changed = measured.find((entry) => pinned.get(entry.path) !== entry.contentDigest)?.path ??
      [...pinned.keys()].find((recordedPath) => measured.every((entry) => entry.path !== recordedPath))
    if (changed !== undefined) {
      return yield* Effect.fail(
        refuse({
          code: "body_unavailable",
          flow: descriptor.name,
          path,
          message:
            `the body of flow "${descriptor.name}" changed at "${changed}", a module "${path}" imports, after discovery; refresh the registry before running it`
        })
      )
    }
    if (unsupported.length > 0) {
      return yield* Effect.fail(refuse({
        code: "body_unavailable",
        flow: descriptor.name,
        path,
        message:
          `flow "${descriptor.name}" runs code this host cannot pin coherently through its runtime module cache: ${
            unsupported.join("; ")
          }. Use relative static imports or a single package imports target for measured project helpers`
      }))
    }
    return modules
  })

const loadModule = (
  descriptor: Descriptor.FlowDescriptor,
  path: string,
  recorded: ReadonlyArray<Descriptor.ModuleImport>,
  options: Options
): Effect.Effect<LoadedBody, ExecutableError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const platformPath = yield* Path.Path
    const bytes = yield* sourceBytes(descriptor, path)
    // Before anything is imported: what runs is the entry AND every module it
    // loads from beside itself, and only the entry has been verified so far.
    const modules = yield* verifyImports(descriptor, path, bytes, recorded)
    const loadPath = path.startsWith("file:") ? path : platformPath.resolve(path)
    const loaded = yield* (options.load ?? importModule)(loadPath, {
      bytes,
      contentDigest: descriptor.body.contentDigest!,
      modules
    }).pipe(
      Effect.mapError((cause) =>
        refuse({
          code: "body_unavailable",
          flow: descriptor.name,
          path,
          message: `the body of flow "${descriptor.name}" could not be loaded from "${path}"`,
          cause
        })
      )
    )
    const exported = (loaded as { readonly default?: unknown } | null | undefined)?.default
    // A `@smthrs/flow` flow is the whole body, so it is taken as one. The test
    // is that package's own type id rather than the shape: a `@smthrs/core`
    // declaration carries `annotations` and a `body` too, and guessing
    // structurally would run the wrong model's graph.
    if (RuntimeFlow.isFlow(exported)) {
      const implementation = (loaded as { readonly layer?: unknown }).layer
      if (implementation !== undefined && !Layer.isLayer(implementation)) {
        return yield* Effect.fail(refuse({
          code: "invalid_layer",
          flow: descriptor.name,
          path,
          message: `flow "${descriptor.name}" exports "layer", which must be an Effect Layer`
        }))
      }
      return {
        prompt: "",
        annotations: exported.annotations,
        flow: exported as unknown as LoadedFlow,
        layer: implementation
      }
    }
    if (!CoreFlow.isFlow(exported)) {
      return yield* Effect.fail(
        refuse({
          code: "invalid_module",
          flow: descriptor.name,
          path,
          message: `"${path}" must default-export a Flow.make value; flow "${descriptor.name}" cannot be run`
        })
      )
    }
    if ((loaded as { readonly layer?: unknown }).layer !== undefined) {
      return yield* Effect.fail(refuse({
        code: "invalid_layer",
        flow: descriptor.name,
        path,
        message: `flow "${descriptor.name}" exports "layer" but must default-export Flow.make from "@smthrs/flow"`
      }))
    }
    // Every flow carries an annotation bag; `Flow.Any` simply does not say so.
    return {
      prompt: "",
      annotations: (exported as unknown as CoreFlow.Flow<never, never, never>).annotations,
      flow: undefined
    }
  })

/** The service key a failed Effect lookup names, when that is the cause's defect. */
const missingService = (cause: Cause.Cause<unknown>): string | undefined => {
  const missing = cause.reasons.find((reason) =>
    reason._tag === "Die" && reason.defect instanceof Error &&
    reason.defect.message.startsWith("Service not found: ")
  )
  return missing?._tag === "Die"
    ? (missing.defect as Error).message.slice("Service not found: ".length)
    : undefined
}

/**
 * A module action whose handler asks for a service this host does not supply
 * dies with the same named `missing_service` refusal a construction-time lookup
 * gets. Loading cannot see such a request: the module's types are erased and no
 * handler runs at load, so its first call is where it is named.
 */
const namingMissing = (
  descriptor: Descriptor.FlowDescriptor,
  implementation: Action.Implementation
): Action.Implementation => ({
  ...implementation,
  action: (payload) =>
    implementation.action(payload).pipe(Effect.catchCause((cause) => {
      const service = missingService(cause)
      return service === undefined ? Effect.failCause(cause) : Effect.die(refuse({
        code: "missing_service",
        flow: descriptor.name,
        path: descriptor.body.path,
        service,
        message: `flow "${descriptor.name}" requires host service "${service}" to run action "${implementation.name}"`,
        cause
      }))
    }))
})

/**
 * Builds a module's implementation layer once in its host's scoped context.
 *
 * Dynamic module types erase Layer requirements. Construction is the runtime
 * check: missing Effect service lookups become a named refusal here. A lookup
 * only a handler makes cannot be reflected without executing user actions, so
 * the module's table names it on the call instead; see `namingMissing`.
 * Each module owns one ordinary Action implementation table, so another module
 * or a refresh may use the same tags without replacing its handlers. Resources
 * remain acquired until its loading host closes or refresh retires the entry.
 */
const moduleServices = (
  descriptor: Descriptor.FlowDescriptor,
  implementation: Layer.Layer<unknown, unknown, unknown>,
  own: (scope: Scope.Closeable) => void
): Effect.Effect<{ readonly layer: Layer.Layer<unknown>; readonly scope: Scope.Closeable }, ExecutableError> =>
  Effect.gen(function*() {
    const parent = yield* Effect.serviceOption(Scope.Scope)
    if (Option.isNone(parent)) {
      return yield* Effect.fail(refuse({
        code: "missing_service",
        flow: descriptor.name,
        path: descriptor.body.path,
        service: Scope.Scope.key,
        message: `flow "${descriptor.name}" requires host service "${Scope.Scope.key}" to load its layer`
      }))
    }
    const hostTable = yield* Effect.serviceOption(Action.Implementations)
    const runtime = yield* Effect.serviceOption(FlowRuntime)
    const hostServices = yield* Effect.context<never>()
    // Hand ownership to the whole constructor atomically with the fork, so
    // cancellation after the exported build also retires private registrations.
    const scope = yield* Scope.fork(parent.value).pipe(
      Effect.tap((scope) => Effect.sync(() => own(scope))),
      Effect.uninterruptible
    )
    const local = yield* Layer.buildWithScope(Layer.fresh(Action.layerImplementations), scope)
    const table = Context.get(local, Action.Implementations)
    const moduleTable = Action.Implementations.of({
      add: table.add,
      get: (name) => Effect.map(table.get(name), Option.map((found) => namingMissing(descriptor, found)))
    })
    const fallback = (name: string) => Option.isSome(hostTable) ? hostTable.value.get(name) : Effect.succeedNone
    // Bind registration before constructing the exported layer: its private
    // interpreters belong to this module just as its default flow does.
    const registrationRuntime = Option.map(runtime, (hostRuntime) =>
      FlowRuntime.of({
        ...hostRuntime,
        register: (flow, execute) =>
          hostRuntime.register(flow, (payload, executionId) => {
            const implementations = Action.Implementations.of({
              add: table.add,
              get: (name) =>
                Effect.flatMap(Effect.serviceOption(FlowInstance), (instance) =>
                  Option.isSome(instance) && instance.value.executionId !== executionId
                    ? fallback(name)
                    : Effect.flatMap(
                      moduleTable.get(name),
                      (found) => Option.isSome(found) ? Effect.succeed(found) : fallback(name)
                    ))
            })
            return execute(payload, executionId).pipe(Effect.provideService(Action.Implementations, implementations))
          })
      }))
    const input = Context.merge(hostServices, local)
    const built = yield* Layer.buildWithScope(Layer.fresh(implementation), scope).pipe(
      // Dynamic module types erase requirements; this host closes them here.
      Effect.provideContext(
        Option.isSome(registrationRuntime) ? Context.add(input, FlowRuntime, registrationRuntime.value) : input
      ),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        const service = missingService(cause)
        return Effect.fail(refuse({
          code: service === undefined ? "layer_failed" : "missing_service",
          flow: descriptor.name,
          path: descriptor.body.path,
          service,
          message: service === undefined
            ? `the implementation layer of flow "${descriptor.name}" could not be built`
            : `flow "${descriptor.name}" requires host service "${service}" to load its layer`,
          cause
        }))
      })
    ) as Effect.Effect<Context.Context<unknown>, ExecutableError>
    const exportedTable = Context.getOption(built, Action.Implementations)
    if (Option.isSome(exportedTable) && exportedTable.value !== table) {
      yield* Scope.close(scope, Exit.void)
      return yield* Effect.fail(refuse({
        code: "invalid_layer",
        flow: descriptor.name,
        path: descriptor.body.path,
        service: Action.Implementations.key,
        message:
          `flow "${descriptor.name}" must use its host-owned Action.Implementations table instead of providing a replacement`
      }))
    }
    if (Option.isNone(registrationRuntime)) {
      yield* Scope.close(scope, Exit.void)
      return yield* Effect.fail(refuse({
        code: "missing_service",
        flow: descriptor.name,
        path: descriptor.body.path,
        service: FlowRuntime.key,
        message: `flow "${descriptor.name}" requires host service "${FlowRuntime.key}" to register its layer`
      }))
    }
    const services = Context.add(
      Context.add(Context.merge(local, built), Action.Implementations, moduleTable),
      FlowRuntime,
      registrationRuntime.value
    )
    // Consumers register independently; only the loading host or a catalog
    // refresh that retires this entry releases the acquired module resources.
    return { layer: Layer.succeedContext(services), scope }
  })

/**
 * The delegate a module that IS a flow hands its work to: itself.
 *
 * Both ways in take the {@link Invocation} envelope, because the bridge only
 * ever supplies one. The flow beneath it declared its own payload, so the
 * envelope's `input` — the caller's `--data` — is what reaches it, checked
 * against that payload schema first. A host-registered delegate does that check
 * itself, in the body that decodes `invocation.input`; a flow that IS the body
 * declared the schema instead, and running its graph on input the schema
 * refuses would hand the body absent fields rather than say what was wrong.
 *
 * Everything downstream is the delegating path unchanged: a declared cache
 * policy still makes the run one dispatched step, and an undeclared one still
 * leaves the flow's own graph in the caller's plan.
 */
const selfDelegate = (flow: LoadedFlow): Delegate => ({
  _tag: flow._tag,
  successSchema: flow.successSchema,
  errorSchema: flow.errorSchema,
  call: (invocation) => flow.call(flow.payloadSchema.make(invocation.input)),
  execute: (invocation, options) => flow.execute(invocation.input, options)
})

/**
 * The one action a policy-declaring descriptor's bridged flow dispatches, and
 * the layer carrying its implementation.
 *
 * The declaration is a thin named seam: `Declared.toLayer` builds the action it
 * dispatches from the declaration's own tier and idempotency key and carries no
 * `metadata`, and an action with no file boundary is never cacheable. The
 * dispatched unit that carries the descriptor's declarations is therefore the
 * inline action the implementation returns — its tier, its identity, its file
 * boundary, and the `CacheEnvironment.CachePolicyAnnotation`
 * `@smthrs/engine-store` `ActionPersistence` reads off a DISPATCHED action to
 * bound a row's age by `ttlMs` and narrow its address by `scope`.
 *
 * The delegate runs underneath as a CHILD EXECUTION derived from the parent's —
 * the same derivation `@smthrs/flow` `Interpreter` uses for a `.child()`
 * boundary — so it keeps its own execution, journal lineage, and retry policy
 * beneath the step rather than being hidden inside it. Deriving the id from the
 * parent's is what keeps two runs' children apart: the ambient default derives
 * an id from the flow tag and the payload, so two runs invoking the same
 * descriptor the same way would otherwise be one child execution, and a
 * descriptor that declared nothing would reuse a result anyway.
 */
const dispatchedAction = (options: {
  readonly tag: string
  readonly descriptor: Descriptor.FlowDescriptor
  readonly delegate: Delegate
  readonly cache: CacheEnvironment.CachePolicy
}) => {
  const { cache, delegate, descriptor, tag } = options
  const declaration = Action.make(tag, {
    payload: Invocation,
    success: delegate.successSchema ?? Schema.Unknown,
    error: delegate.errorSchema ?? Schema.Unknown
  })
  const layer = declaration.toLayer((envelope: Invocation) => {
    const identityEnvelope = Schema.encodeUnknownSync(Invocation)(envelope) as unknown as Schema.Json
    return CacheEnvironment.withCache(
      Action.make({
        name: `${tag}/run`,
        success: delegate.successSchema ?? Schema.Unknown,
        error: delegate.errorSchema ?? Schema.Unknown,
        // The descriptor's own reversibility tier, declared or inferred from its
        // projected authority, and never widened here. It is also the gate on
        // reuse: `ActionPersistence` caches a `sealed` dispatch and nothing
        // else, so a policy on a descriptor whose authority projects to
        // `irreversible` — which is every descriptor naming a delegate flow,
        // because the delegate's authority is not statically visible — reaches
        // admission and is refused there rather than being dropped here.
        tier: descriptor.effects.tier,
        // The cross-run address: the delegate, the whole envelope — the
        // descriptor's declaration AND the caller's input, so one caller's
        // recorded answer is never served to the next caller's question — and
        // the policy itself, because `ActionPersistence` assumes a changed
        // `ttlMs` is a changed step key when it fences its own expiry verdict.
        idempotencyKey: { delegate: delegate._tag, invocation: identityEnvelope, cache },
        metadata: boundaryOf(descriptor),
        execute: Effect.gen(function*() {
          const instance = yield* FlowInstance
          const executionId = yield* Interpreter.childExecutionId(
            instance.executionId,
            tag,
            delegate._tag,
            identityEnvelope
          )
          return yield* delegate.execute(envelope, { executionId })
        })
      }),
      cache
    )
  })
  return { declaration, layer }
}

/**
 * Makes one discovered descriptor runnable.
 *
 * The body is loaded — a module through the loader, markdown through
 * {@link module:MarkdownFlow} — the delegate is resolved against the host's
 * registered flows, and the result is a durable flow whose body is one
 * delegating node plus the layer that registers it.
 *
 * Everything that can be refused is refused here, before the flow exists: a
 * missing delegate, an undecidable one, an unreadable body, a module that
 * exports something else. A flow this function returns is one the engine can
 * drive.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const fromDescriptor = (
  descriptor: Descriptor.FlowDescriptor,
  options: Options
): Effect.Effect<Executable, ExecutableError, FileSystem.FileSystem | Path.Path> =>
  Effect.suspend(() => {
    let moduleScope: Scope.Closeable | undefined
    const loadEffect = Effect.gen(function*() {
      // The delegate is resolved BEFORE the body is loaded, and the refusal for a
      // missing one is raised after. Both refusals are real, but only one of them
      // is about this host: a flow whose delegate nobody registered is not
      // runnable here whatever its body says, and an operator reading "could not
      // load" would go looking in the wrong place. The body is read first anyway
      // because a module that default-exports a `@smthrs/flow` flow delegates to
      // nothing, so its missing registration is not a refusal at all; a body that
      // cannot be read keeps the missing registration as the refusal to report.
      const name = yield* delegateOf(descriptor, options)
      const registered = options.delegates.find((candidate) => candidate._tag === name)
      const missing = refuse({
        code: "missing_delegate",
        flow: descriptor.name,
        delegate: name,
        available: options.delegates.map((candidate) => candidate._tag).sort(),
        message: `flow "${descriptor.name}" delegates to "${name}", which no registered flow provides`
      })
      const sourceRoot = options.sourceRoot
      const loading = sourceRoot === undefined ? descriptor : yield* Effect.gen(function*() {
        const path = yield* Path.Path
        const locate = (value: string) =>
          Effect.gen(function*() {
            const physical = value.startsWith("file:")
              ? yield* Effect.flatMap(Effect.try(() => new URL(value)), (url) => path.fromFileUrl(url))
              : path.resolve(value)
            const suffix = path.relative(path.resolve(sourceRoot.identity), physical)
            if (suffix === ".." || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) {
              return yield* Effect.fail(new Error("Source locator is outside the approved project identity root"))
            }
            return path.resolve(sourceRoot.workspace, suffix)
          })
        return new Descriptor.FlowDescriptor({
          ...descriptor,
          body: descriptor.body._tag === "Markdown"
            ? new Descriptor.BodyRefMarkdown({
              ...descriptor.body,
              path: yield* locate(descriptor.body.path),
              baseDirectory: yield* locate(descriptor.body.baseDirectory)
            })
            : new Descriptor.BodyRefModule({ ...descriptor.body, path: yield* locate(descriptor.body.path) })
        })
      }).pipe(Effect.mapError((cause) =>
        refuse({
          code: "body_unavailable",
          flow: descriptor.name,
          path: descriptor.body.path,
          message: "The retained source locator could not be resolved",
          cause
        })
      ))
      const load = loading.body._tag === "Markdown"
        ? loadMarkdown(loading, loading.body.path, loading.body.baseDirectory)
        : loadModule(loading, loading.body.path, loading.body.imports ?? [], options)
      // Which refusal a failed load reports when no delegate is registered.
      //
      // A descriptor that NAMES a delegate is asking this host for a flow it does
      // not have, and that is the refusal to report however the body fared: an
      // operator reading "could not load" would go looking in the file when the
      // registration is what is missing.
      //
      // A module that names none is the opposite case. `delegateOf` answers
      // `agent` for it, and a self-contained flow never wanted an agent, so
      // reporting `missing_delegate` would send the operator after a registration
      // their flow does not need and hide the typo that actually stopped it. Its
      // load failure is its own.
      const masksLoadFailure = registered === undefined &&
        !(descriptor.body._tag === "Module" && descriptor.flows.length === 0)
      const body = yield* (masksLoadFailure
        ? Effect.catch(load, () => Effect.fail(missing))
        : load)
      if (body.flow === undefined && registered === undefined) return yield* Effect.fail(missing)
      const delegate = body.flow === undefined ? registered! : selfDelegate(body.flow)
      const lowered = lower(descriptor, body.annotations)
      const invocation = (input: Schema.Json): Invocation => {
        const placement = invocationPlacement(lowered.placement)
        return Object.freeze({
          flow: descriptor.name,
          input: ownedJson(input),
          prompt: body.prompt,
          model: Option.getOrNull(descriptor.model),
          placement: placement.placement,
          placementOptions: placement.placementOptions,
          capabilities: ownedStrings(descriptor.capabilities),
          flows: ownedStrings(descriptor.flows)
        })
      }
      // WHAT THE BRIDGED FLOW DISPATCHES, AND WHY IT DEPENDS ON THE POLICY.
      //
      // Without a cache policy the delegation is a CALL: the delegate's node goes
      // into the plan the engine builds for this flow, so its fan-out, its
      // priorities, and its waits are the caller's plan and a host reading that
      // plan sees the real work. That shape is not a step the engine can record —
      // it is many steps — so there is nothing there for a policy to govern.
      //
      // A declared policy asks for exactly that: one recorded unit, served again
      // when a later run asks the same question. A descriptor that declares one
      // therefore dispatches `dispatchedAction` instead of calling the delegate,
      // and the delegate runs underneath it as a child execution.
      const bridge = lowered.cache === undefined ? undefined : dispatchedAction({
        tag: `registry/${descriptor.name}`,
        descriptor,
        delegate,
        cache: lowered.cache
      })
      // The policy travels three ways: as an annotation on the flow (the
      // declaration surface a host reads back), as captured identity on the
      // delegating node, so two descriptors declaring different policies are two
      // declarations with two step keys, and — the half that reaches admission —
      // onto the action the bridged flow dispatches, above.
      const identity = PlanNode.capture(captured(lowered), (value: unknown) => value)
      // The BODY's identity is captured too, and it has to be. A plan-time
      // function JavaScript cannot inspect gets process-local identity, so a
      // bridged flow built from one unchanged descriptor would key differently in
      // every process — no replayed step would ever match, and no recorded result
      // would ever be reused. Everything the body reads is inert descriptor data,
      // so declaring it makes the flow's identity a function of the descriptor
      // rather than of the process that loaded it.
      const placement = invocationPlacement(lowered.placement)
      const build = PlanNode.capture(
        {
          flow: descriptor.name,
          delegate: delegate._tag,
          prompt: body.prompt,
          model: Option.getOrNull(descriptor.model),
          placement: placement.placement,
          placementOptions: placement.placementOptions,
          capabilities: [...descriptor.capabilities],
          flows: [...descriptor.flows],
          priority: lowered.priority ?? null,
          ...captured(lowered)
        },
        (payload: Payload) => {
          const envelope = invocation(payload.input ?? null)
          const carried = bridge === undefined
            ? delegate.call(envelope)
            : PlanNode.map(bridge.declaration.call(envelope), identity)
          return lowered.priority === undefined ? carried : PlanNode.priority(carried, lowered.priority)
        }
      )
      // A canonical declaration normally has the same tag as its registry name.
      // Its payload codec is the user's schema; this admission adapter takes
      // { input }. Registering both under that tag made whichever layer won
      // decode the other's payload. Keep the declaration's tag and give only
      // the private adapter a stable, source-qualified registration identity.
      const adapterTag = body.flow?._tag === descriptor.name
        ? `registry/entry/${Descriptor.executionDigest(descriptor)}/${descriptor.name}`
        : descriptor.name
      const flow = RuntimeFlow.make(adapterTag, {
        payload: Payload,
        // Preserve the delegate's codecs through the named bridge. Unknown loses
        // transformations and cannot encode tagged Error instances as JSON.
        success: delegate.successSchema ?? Schema.Unknown,
        error: delegate.errorSchema ?? Schema.Unknown,
        // A module that is its own flow keeps its own bag underneath the lowered
        // one, so a `@smthrs/flow` placement or capability ceiling it declared
        // reaches `Graph` instead of being dropped at the bridge. The lowered
        // values win, because they are the descriptor's statement about this
        // entry and the bag is the body's about itself.
        annotations: body.flow === undefined
          ? annotationsOf(lowered)
          : Context.merge(body.annotations, annotationsOf(lowered)),
        body: build
      })
      const registrations = Layer.mergeAll(
        Interpreter.layer(flow),
        ...(bridge === undefined ? [] : [bridge.layer]),
        ...(body.flow === undefined ? [] : [Interpreter.layer(body.flow)])
      )
      const implementations = body.layer === undefined
        ? undefined
        : yield* moduleServices(descriptor, body.layer, (scope) => {
          moduleScope = scope
        })
      const executable: Executable = {
        descriptor,
        declaredTag: body.flow?._tag,
        delegate: body.flow === undefined ? name : undefined,
        input: body.flow?.payloadSchema,
        lowered,
        invocation,
        // The catalog cannot name services of a dynamically selected delegate.
        // Keep its exact schema objects. Delegate.call/execute already erase
        // services; the delegate's registrant also owns these codec services.
        flow: flow as Executable["flow"],
        // The cast erases the requirement `bridge` minted for itself. Its key is
        // built from a tag this function computes, so no caller can spell the
        // type, and nothing outside the bridged flow's own body asks for it.
        //
        // A module that is its own flow registers that flow too: the bridged flow
        // CALLS it, and a declared cache policy EXECUTES it as a child, which the
        // runtime resolves by tag.
        layer: (implementations === undefined ? registrations : Layer.effectDiscard(Effect.gen(function*() {
          // Consumers own their registration scope, but it is also a child of
          // the module lifetime so refresh retires every original registration.
          const scope = yield* Effect.acquireRelease(
            Scope.fork(implementations.scope),
            (scope, exit) => Scope.close(scope, exit)
          )
          yield* Layer.buildWithScope(registrations.pipe(Layer.provide(implementations.layer)), scope)
        }))) as Layer.Layer<never, never, Registration>
      }
      if (implementations !== undefined) moduleScopes.set(executable, implementations.scope)
      return executable
    }).pipe(Effect.onExit((exit) =>
      Exit.isFailure(exit) && moduleScope !== undefined ? Scope.close(moduleScope, exit) : Effect.void
    ))
    return Effect.acquireUseRelease(
      Effect.forkChild(
        Effect.gen(function*() {
          const startedAt = yield* Clock.currentTimeMillis
          for (;;) {
            yield* Effect.sleep("30 seconds")
            yield* Effect.logInfo("loading flow", {
              flow: descriptor.name,
              path: descriptor.body.path,
              elapsedMs: (yield* Clock.currentTimeMillis) - startedAt
            })
          }
        }).pipe(Effect.interruptible)
      ),
      () =>
        loadEffect,
      Fiber.interrupt
    )
  })

/**
 * Makes one discovered flow runnable by registry name.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const fromRegistry = (
  name: string,
  options: Options
): Effect.Effect<
  Executable,
  ExecutableError | RegistryError,
  Registry.Registry | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const registry = yield* Registry.Registry
    return yield* fromDescriptor(yield* registry.get(name), options)
  })

/**
 * Every discovered flow this host can run, and the ones it declined.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Catalog {
  readonly executables: ReadonlyArray<Executable>
  readonly refused: ReadonlyArray<ExecutableError>
  /**
   * First-use lookup supplied by a live host. Retries catalog load_timeout
   * refusals through the direct path and registers the recovered executable.
   */
  readonly load?:
    | ((name: string) => Effect.Effect<Executable, ExecutableError | RegistryError | DiscoveryError>)
    | undefined
}

/**
 * Service tag for the catalog a host was built from.
 *
 * {@link layer} provides it, so a command that lists or diagnoses flows reads
 * the same refusals the registration phase acted on instead of rebuilding the
 * catalog and hoping the two agree.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export const Catalog: Context.Service<Catalog, Catalog> = Context.Service("flows/registry/Catalog")

/** Whether a refusal only says the host registered no `agent` delegate for a prompt body. */
const isUnregisteredAgent = (failure: ExecutableError, options: Options): boolean =>
  failure.code === "missing_delegate" && failure.delegate === (options.agent ?? defaultAgent)

/**
 * Makes every discovered flow runnable, reporting the ones it could not.
 *
 * A project's `flows/` directory is a mixed set: some entries delegate to a
 * flow this host registered, others name a delegate only another host has, and
 * one may simply be broken. None of those is a reason to withhold the rest.
 * `flows/` is a directory a person edits, so at any moment one file in it is
 * mid-edit or wrong, and a catalog that failed on it would take down `ls`,
 * `ps`, and every unrelated `up` with it.
 *
 * So every refusal is reported in {@link Catalog.refused} carrying its
 * {@link ExecutableError} code, and the entries that resolve stay runnable. The
 * codes are what distinguish the two kinds: `missing_delegate` and
 * `ambiguous_delegate` are statements about this host, while
 * `body_unavailable` and `invalid_module` are defects in the entry.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const catalog = (
  options: Options
): Effect.Effect<
  Catalog,
  RegistryError | DiscoveryError,
  Registry.Registry | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const registry = yield* Registry.Registry
    const descriptors = yield* registry.list()
    const executables: Array<Executable> = []
    const refused: Array<ExecutableError> = []
    const configured = options.loadTimeoutMs ?? (yield* Config.String("SMITHERS_FLOW_LOAD_TIMEOUT_MS").pipe(
      Effect.map(Number),
      Effect.catch(() => Effect.succeed(30_000))
    ))
    const loadTimeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 30_000
    for (const descriptor of descriptors) {
      const result = yield* Effect.result(
        fromDescriptor(descriptor, options).pipe(
          Effect.timeoutOrElse({
            duration: loadTimeoutMs,
            orElse: () =>
              Effect.fail(refuse({
                code: "load_timeout",
                flow: descriptor.name,
                path: descriptor.body.path,
                message:
                  `the body of flow "${descriptor.name}" timed out after ${loadTimeoutMs}ms while loading "${descriptor.body.path}" (load_timeout; SMITHERS_FLOW_LOAD_TIMEOUT_MS catalog limit)`
              }))
          })
        )
      )
      if (result._tag === "Success") {
        executables.push(result.success)
        continue
      }
      const failure = result.failure
      refused.push(failure)
      // A prompt body names no flow, so it delegates to the host's `agent`, which
      // hosts that run prompts through their own agent path never register here.
      // That is the ordinary case, not a fault an operator can act on.
      if (isUnregisteredAgent(failure, options)) continue
      yield* Effect.logWarning("discovered flow is not runnable on this host", {
        flow: failure.flow,
        path: failure.path,
        code: failure.code,
        delegate: failure.delegate,
        available: failure.available,
        reason: failure.message
      })
    }
    return { executables, refused }
  })

/**
 * What rebuilding one catalog entry did.
 *
 * Four answers, because a caller that cannot tell them apart cannot say
 * anything honest about the flow afterwards: it is runnable now, this host
 * refuses it and why, discovery no longer finds it at all, or this host holds
 * that entry fixed and left the catalog alone
 * ({@link RefreshOptions.refreshable}).
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Refreshed =
  | { readonly _tag: "Registered"; readonly executable: Executable }
  | { readonly _tag: "Refused"; readonly error: ExecutableError }
  | { readonly _tag: "Removed" }
  | { readonly _tag: "Fixed" }

/**
 * Rebuilding one entry of a catalog a host is already serving from.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Refresh {
  /**
   * Rescans discovery, rebuilds this one flow's executable from the bytes now
   * on disk, registers its body with the runtime, and swaps it into the
   * catalog. Serialized: two refreshes of the same host never interleave.
   *
   * `Removed` and `Refused` take the entry out of the catalog and close the
   * scope of a body THIS seam registered. An exported implementation layer's
   * lifetime also owns its original registrations, so retiring that entry
   * unregisters them and closes its resources. Other startup registrations
   * remain owned by their original provider scope until the host closes.
   */
  readonly flow: (name: string) => Effect.Effect<Refreshed, RegistryError | DiscoveryError>
}

/**
 * Service tag for rebuilding one catalog entry after startup.
 *
 * Provided by {@link layer} beside the {@link Catalog} it builds, so every
 * host that registers discovered flows can also rebuild one of them.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export const Refresh: Context.Service<Refresh, Refresh> = Context.Service("flows/registry/CatalogRefresh")

/**
 * Registers every runnable discovered flow with the runtime, and keeps one
 * entry rebuildable while the host serves.
 *
 * This is the layer a host passes as the durable runtime's registration phase:
 * once it has been built, `Control.run` on a discovered flow reaches a
 * registered durable flow instead of an empty catalog.
 *
 * A refusal is never silent. Each one is logged as a warning naming the flow,
 * the code, the delegate it wanted, and what is registered instead, and the
 * whole {@link Catalog} is provided as a service, so a host can print the
 * refusals rather than let an operator discover them from `up <flow>` failing
 * inside the runtime.
 *
 * The catalog it provides is not frozen. It used to be, and that was wrong for
 * a host whose own runs write into its `flows/` directory: an agent that
 * authors `flows/<id>/flow.ts` produced a file nothing on the host could plan
 * or execute, because the descriptor existed and the executable behind it did
 * not, and only a restart closed the gap. {@link Refresh} is the one operation
 * that closes it instead. Two properties make it safe to call on a serving
 * host:
 *
 * - the `Catalog` service object never changes identity. `AgentSession`,
 *   admission and the plan hook each read the catalog they were handed while
 *   the host was composed, so a refresh swaps the SNAPSHOT those readers see
 *   rather than the service they hold. The swap is one assignment: a reader
 *   observes the entry list before it or after it, never a half-built one;
 * - the new body is registered with the runtime BEFORE the previous body's
 *   scope is closed. `@smthrs/flow` keys registrations by flow tag and a
 *   scope release removes only the registration it still owns, so an
 *   execution dispatched across the swap reaches one body or the other and
 *   never an unregistered tag.
 *
 * Re-importing is not a problem the caller has to solve: the default loader
 * writes the verified bytes to a private sibling named by their content
 * digest and imports THAT, so new bytes are a new module specifier and the
 * ESM cache cannot answer with the previous body. The cost is retention: each
 * load has its own specifier and ESM offers no unload, so the process keeps
 * every module it has loaded for its lifetime, one per load of each flow. A
 * long-lived host that refreshes often should expect that growth.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (
  options: RefreshOptions
): Layer.Layer<
  Catalog | Refresh,
  RegistryError | DiscoveryError,
  Registry.Registry | FileSystem.FileSystem | Path.Path | Registration
> =>
  Layer.unwrap(
    Effect.map(catalog(options), (built) =>
      Layer.mergeAll(
        layerRefreshable(built, options),
        ...built.executables.map((executable) => executable.layer)
      ))
  )

/**
 * How much of a catalog a host is willing to rebuild.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface RefreshOptions extends Options {
  /**
   * Which discovered flows this host rebuilds. Every one, by default.
   *
   * A host that serves some of its catalog out of its own measured bundle
   * answers `false` for those: their bytes are the image the host was shipped
   * as, they cannot change under it, and rebuilding one from the working tree
   * would replace an admitted declaration with whatever is on disk.
   */
  readonly refreshable?: ((descriptor: Descriptor.FlowDescriptor) => boolean) | undefined
}

/**
 * Serves a catalog a host already built, and keeps one entry rebuildable.
 *
 * {@link layer} is this plus the initial registrations, and is what a host
 * that has no catalog of its own wants. Reach for this one when the host
 * assembles the catalog itself (several sources, or a loader per source)
 * and registers the result its own way: this adds the live `Catalog` service
 * and the {@link Refresh} beside it without registering anything twice.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerRefreshable = (
  built: Catalog,
  options: RefreshOptions
): Layer.Layer<
  Catalog | Refresh,
  never,
  Registry.Registry | FileSystem.FileSystem | Path.Path | Registration
> =>
  Layer.unwrap(Effect.gen(function*() {
    let snapshot: Catalog = built
    const refresh = yield* makeRefresh(options, () => snapshot, (next) => {
      snapshot = next
    })
    const live: Catalog = {
      get executables() {
        return snapshot.executables
      },
      get refused() {
        return snapshot.refused
      },
      load: refresh.load
    }
    return Layer.merge(
      Layer.succeed(Catalog)(live),
      Layer.succeed(Refresh)(refresh)
    )
  }))

/** The refresh operation, closed over the host's registration context and scope. */
const makeRefresh = (
  options: RefreshOptions,
  read: () => Catalog,
  swap: (next: Catalog) => void
): Effect.Effect<
  Refresh & { readonly load: NonNullable<Catalog["load"]> },
  never,
  Scope.Scope | Registry.Registry | FileSystem.FileSystem | Path.Path | Registration
> =>
  Effect.gen(function*() {
    const host = yield* Effect.scope
    // The refresh runs later, from whatever called it. Everything it needs to
    // load a body and register one is captured here, where the host composed
    // it, rather than demanded of a caller that has no reason to hold it.
    const services = yield* Effect.context<
      Registry.Registry | FileSystem.FileSystem | Path.Path | Registration
    >()
    const gate = yield* Semaphore.make(1)
    const held = new Map<string, Scope.Closeable>()
    for (const executable of read().executables) {
      const scope = moduleScopes.get(executable)
      if (scope !== undefined) held.set(executable.descriptor.name, scope)
    }
    const release = (name: string) => {
      const previous = held.get(name)
      held.delete(name)
      return previous === undefined ? Effect.void : Scope.close(previous, Exit.void)
    }
    const put = (name: string, executable: Executable | undefined, failure: ExecutableError | undefined): void => {
      const current = read()
      const executables = executable === undefined
        ? current.executables.filter((entry) => entry.descriptor.name !== name)
        : current.executables.some((entry) => entry.descriptor.name === name)
        ? current.executables.map((entry) => entry.descriptor.name === name ? executable : entry)
        : [...current.executables, executable]
      const without = current.refused.filter((entry) => entry.flow !== name)
      swap({ executables, refused: failure === undefined ? without : [...without, failure] })
    }
    const register = (descriptor: Descriptor.FlowDescriptor) => {
      const name = descriptor.name
      // Own the generation from its fork through publication. Slow user
      // construction remains interruptible; every uncommitted exit closes
      // resources and registrations even at a scheduler boundary after build.
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          const scope = yield* Scope.fork(host)
          let committed = false
          return yield* Effect.gen(function*() {
            const result = yield* Effect.result(restore(
              fromDescriptor(descriptor, options).pipe(Effect.provideService(Scope.Scope, scope))
            ))
            if (result._tag === "Failure") {
              put(name, undefined, result.failure)
              yield* release(name)
              if (!isUnregisteredAgent(result.failure, options)) {
                yield* Effect.logWarning("refreshed flow is not runnable on this host", {
                  flow: result.failure.flow,
                  path: result.failure.path,
                  code: result.failure.code,
                  delegate: result.failure.delegate,
                  available: result.failure.available,
                  reason: result.failure.message
                })
              }
              return { _tag: "Refused", error: result.failure } as const
            }
            yield* restore(Layer.build(result.success.layer).pipe(Effect.provideService(Scope.Scope, scope)))
            put(name, result.success, undefined)
            yield* release(name)
            held.set(name, scope)
            committed = true
            return { _tag: "Registered", executable: result.success } as const
          }).pipe(Effect.onExit((exit) => committed ? Effect.void : Scope.close(scope, exit)))
        })
      )
    }
    const flow = (name: string): Effect.Effect<Refreshed, RegistryError | DiscoveryError> =>
      gate.withPermits(1)(Effect.gen(function*() {
        const registry = yield* Registry.Registry
        yield* registry.refresh()
        const found = yield* registry.getOption(name)
        if (Option.isNone(found)) {
          return yield* Effect.uninterruptible(Effect.gen(function*() {
            // Catalog publication and retirement share one ownership transfer.
            put(name, undefined, undefined)
            yield* release(name)
            return { _tag: "Removed" } as const
          }))
        }
        if (options.refreshable !== undefined && !options.refreshable(found.value)) {
          return { _tag: "Fixed" } as const
        }
        return yield* register(found.value)
      })).pipe(Effect.provideContext(services))
    const load: NonNullable<Catalog["load"]> = (name) =>
      gate.withPermits(1)(Effect.gen(function*() {
        const snapshot = read()
        const executable = snapshot.executables.find((entry) => entry.descriptor.name === name)
        if (executable !== undefined) return executable
        const refusal = snapshot.refused.find((entry) => entry.flow === name)
        if (refusal !== undefined && refusal.code !== "load_timeout") return yield* Effect.fail(refusal)
        const registry = yield* Registry.Registry
        // No refresh: first use retries the already measured descriptor, never
        // adopts edited bytes or imports a newly authored entry implicitly.
        const descriptor = yield* registry.get(name)
        if (refusal === undefined) {
          return yield* Effect.fail(refuse({
            code: "body_unavailable",
            flow: name,
            path: descriptor.body.path,
            message: `flow "${name}" was not loaded by this catalog`
          }))
        }
        const result = yield* register(descriptor)
        return result._tag === "Registered" ? result.executable : yield* Effect.fail(result.error)
      })).pipe(Effect.provideContext(services))
    return { flow, load }
  })
