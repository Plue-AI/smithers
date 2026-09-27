/**
 * The `install` flow: measure, fetch, link.
 *
 * `docs/specs/Concepts/Unified Flow Authoring.md` gives two nouns. The atoms
 * here are Actions, because each carries an implementation that is
 * attached separately as a `Layer` and none of them is made of steps. The
 * composite is a Flow, because it has a pure plan-time body and no opaque
 * code of its own.
 *
 * The shape follows Bazel's fetch/build split and rules_js's `npm_translate_lock`
 * split, restated in this vocabulary:
 *
 * | step    | tier   | boundary | admitted to the cross-run cache |
 * | ------- | ------ | -------- | ------------------------------- |
 * | measure | sealed | expected | no                              |
 * | fetch/* | sealed | expected | no                              |
 * | link    | irreversible | expected | no                        |
 *
 * All effect tiers can be planned. Measure and fetch use `expected` boundaries,
 * which keep them out of the cross-run cache, because
 * `ActionPersistence` admits a result only when the tier is `sealed` AND the
 * boundary mode is `hard`. Link uses a run-local identity and cannot publish
 * a cache entry regardless of boundary mode. It is not compensable: ordinary
 * workspace snapshots omit ignored `node_modules` trees and cannot restore a
 * half-finished link. No automatic retry or blind crash recovery is promised.
 *
 * A `node_modules` tree is a graph of links into a local store, so
 * restoring one from another machine would produce a tree whose entries point
 * at nothing. Link is therefore never admitted, and measure is not admitted
 * either.
 *
 * ## What measure is, and what it is not
 *
 * Measure reports **content**: the lockfile, credential-free `.npmrc`,
 * and pnpm hook and workspace digests. It used to report an `Environment` struct that
 * also carried the manager name, the manager version, and the host platform,
 * and the flow ran in two trampoline rounds so a later round could select a
 * manager-specific fetch from a measured manager name.
 *
 * Those three fields were never content. They are the identity of two host
 * services, and they now come from those services:
 *
 * - Which manager, and which version it must be, is
 *   {@link PackageManager.Service}. The workspace declares the version and
 *   `PackageManager.Service.verify` holds the host to it.
 * - The platform is {@link Runtime.Service}. It describes the machine, so it
 *   belongs to the runtime rather than to a struct passed between steps.
 *
 * Two consequences follow. The flow no longer trampolines: the manager arrives
 * in the payload as a plan-time declaration from legacy declaration, so one round records
 * measure, exactly one fetch, and link. And the cross-round recheck is gone
 * with the second round, replaced by `verify`, which compares the host against
 * what the workspace declared rather than against an earlier measurement of the
 * same host.
 *
 * Measure still exists, and still runs in its own step, because the input digests
 * are step-key material: an install whose lockfile changed must not be answered
 * by the previous install's recorded result.
 *
 * @since 0.1.0
 */

import { Action, Flow } from "@smthrs/flow"
import { FileInput } from "@smthrs/flow/FileInput"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as PackageManager from "./PackageManager.ts"
import * as Runtime from "./Runtime.ts"

/**
 * Schema for the content an install is keyed on.
 *
 * The fields contain file paths and digests. Nothing here names a host, a
 * manager, or a path into a store, because this value exists to make one install distinguishable from
 * another install of different dependencies.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Content = Schema.Struct({
  /** The lockfile path and its measured digest. */
  lockfile: FileInput,
  /** The credential-free `.npmrc` and its digest, or `null` when absent. */
  npmrc: Schema.NullOr(FileInput),
  /** The project pnpm hook, or `null` when absent or not using pnpm. */
  pnpmfile: Schema.NullOr(FileInput),
  /** The pnpm workspace manifest, or `null` when absent or not using pnpm. */
  workspace: Schema.NullOr(FileInput)
})

/**
 * The content an install is keyed on.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Content = typeof Content.Type

/**
 * Schema for what a completed link reports.
 *
 * The digest describes the tree; the tree itself is never a value, never an
 * artifact, and never leaves the host.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const LinkManifest = Schema.Struct({
  /** The store manifest digest this tree was linked from. */
  store: PackageManager.Digest,
  /** Digest of the store, root package manifest, and manager tree evidence. */
  manifest: PackageManager.Digest,
  /**
   * Always `true`: link never trusts a freshness marker.
   *
   * Manager metadata describes the intended graph and cannot prove every
   * package file is still present and unmodified, so the manager runs every
   * time and no code path produces `false`. The field is reserved for an
   * implementation that can prove a tree intact. It stays on the schema
   * because `@smthrs/targets` declares this struct as the `Install` target's
   * public success type, so removing it is a coordinated change in both
   * packages rather than a rename here.
   */
  linked: Schema.Boolean
})

/**
 * What a completed link reports.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type LinkManifest = typeof LinkManifest.Type

/**
 * The lockfiles and configuration the measure action may read.
 *
 * One entry per manager {@link PackageManager.Name} admits, plus the project
 * `.npmrc` and pnpm hook and workspace files. `package-lock.json` and `yarn.lock` were declared here too, for
 * managers no declaration can select and no implementation can drive, which
 * inflated a sealed action's read set with paths no code path opens.
 */
const measureInputPatterns: ReadonlyArray<string> = [
  ".npmrc",
  "bun.lock",
  "pnpm-lock.yaml",
  ".pnpmfile.cjs",
  "pnpm-workspace.yaml"
]

/**
 * Measures the content every later step keys on.
 *
 * Declared with an `expected` boundary so that no cross-run cache ever answers
 * it. Re-measuring costs a few file digests, and a restored measurement would
 * describe another machine's checkout.
 *
 * `manager` is in the payload as key material and for nothing else: the
 * implementation reads the manager from its layer, never from here. With an
 * empty payload a pnpm install and a Bun install of one workspace shared a
 * single measure key, which is inert only while the boundary stays `expected`
 * and becomes a hit on another manager's measurement the day it hardens. The
 * declared manager is not checked against the composed layer here, and
 * `d191c9dfcf` says why: that check belongs at the composition root that wires
 * a layer against a declaration, not inside a sealed action that receives only
 * the layer.
 *
 * @category actions
 * @since 0.1.0
 * @slop
 */
export const Measure = Action.make("smithers-build/install/measure", {
  payload: { manager: PackageManager.Name },
  success: Content,
  error: PackageManager.PackageManagerError,
  tier: "sealed"
})
  .annotate(Flow.EffectsDeclaration, {
    reads: measureInputPatterns,
    writes: [],
    boundaryMode: "expected"
  })

/**
 * Populates the package-manager store. For pnpm it also writes the virtual
 * store (`node_modules/.pnpm/**` and `node_modules/.modules.yaml`), which
 * `pnpm fetch` lays down beside the content-addressed store; the declared
 * write set names both, so conflict ordering sees the overlap with Link.
 *
 * Its key material is the measured lockfile and configuration digests,
 * reaching the key as a settled upstream
 * reference. Its value is a store-manifest digest, never the store's bytes and
 * never a `node_modules` archive. The store files are declared outputs, but
 * the shipped implementation pins its child process to an absolute project
 * root. It cannot freeze the inputs between verification and
 * the child's own opens, so this action uses an `expected` boundary and is
 * not admitted to a cross-run cache.
 *
 * Every manager uses a workspace-local directory beneath `.flows/store`.
 * This static path keeps the write declaration exact and makes a future
 * sandbox-root-aware implementation possible without changing the Flow API.
 * It costs a full download and unpack per clone or worktree, because a file
 * set names no host path and so a store the Flow can declare is a store only
 * one workspace owns. `PackageManager.Options.storeDirectory` names a shared
 * host store for a composition that drives the manager directly;
 * {@link verifyManagerContract} refuses such a service here rather than
 * declaring this path and writing another.
 *
 * @category actions
 * @since 0.1.0
 */
const makeFetch = <Tag extends string>(
  name: Tag,
  lockfile: string,
  manager: PackageManager.Name
) =>
  Action.make(name, {
    payload: {
      content: Content
    },
    success: PackageManager.StoreManifest,
    error: PackageManager.PackageManagerError,
    tier: "sealed"
  })
    .annotate(Flow.EffectsDeclaration, {
      reads: manager === "pnpm"
        ? [lockfile, ".npmrc", ".pnpmfile.cjs", "pnpm-workspace.yaml"]
        : [lockfile, ".npmrc"],
      writes: [
        { _tag: "TreeArtifact", path: `${PackageManager.storeRoot}/${manager}` },
        // `pnpm fetch` also writes the virtual store (`node_modules/.pnpm`) and its
        // `.modules.yaml` state file beside it.
        ...(manager === "pnpm"
          ? [{ _tag: "Glob" as const, include: ["**/node_modules/.pnpm/**", "**/node_modules/.modules.yaml"] as const }]
          : [])
      ],
      boundaryMode: "expected"
    })

/**
 * Fetches pnpm packages from `pnpm-lock.yaml`.
 *
 * @category actions
 * @since 0.1.0
 * @slop
 */
export const FetchPnpm = makeFetch("smithers-build/install/fetch/pnpm", "pnpm-lock.yaml", "pnpm")

/**
 * Materializes `node_modules` from the already-populated store.
 *
 * Its `irreversible` tier keeps it out of the cross-run cache. Here the
 * boundary is the restorable workspace, not the physical project directory:
 * ignored dependency trees are outside a normal snapshot. A completed attempt
 * replays within its run; a new run reconciles the tree again. An uncertain
 * interrupted attempt requires operator reconciliation, not a blind retry.
 * Its expected write set names root and nested dependency trees for conflict
 * ordering. A non-sealed write declaration does not publish file artifacts,
 * so the planner can see these mutations without caching the installed tree.
 *
 * @category actions
 * @since 0.1.0
 * @slop
 */
export const Link = Action.make("smithers-build/install/link", {
  payload: {
    content: Content,
    store: PackageManager.StoreManifest
  },
  success: LinkManifest,
  error: PackageManager.PackageManagerError,
  tier: "irreversible"
})
  .annotate(Flow.EffectsDeclaration, {
    reads: [...measureInputPatterns, "package.json", {
      _tag: "Glob",
      include: ["**/package.json"],
      exclude: ["**/node_modules/**", ".flows/**"]
    }],
    writes: [{ _tag: "Glob", include: ["**/node_modules", "**/node_modules/**"] }],
    boundaryMode: "expected"
  })

/**
 * The install payload.
 *
 * `manager` is the manager the workspace declared in legacy declaration. It is a
 * plan-time value, which is what lets one round select exactly one fetch
 * action; the previous design had to measure the manager first and hand off to
 * a second round to do the same job. The project root is the engine's working
 * directory, so it does not enter a content key.
 *
 * Only pnpm is admitted. A Bun payload used to plan a `FetchBun` action whose
 * manager refused every operation, so the install always failed at run time;
 * the payload now refuses it when the flow is called (see
 * {@link PackageManager.bunInstallUnsupportedMessage}).
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const payloadFields = {
  manager: Schema.Literal("pnpm")
}

/**
 * The implementations the body names.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Requires =
  | Action.Requirement<"smithers-build/install/measure">
  | Action.Requirement<"smithers-build/install/fetch/pnpm">
  | Action.Requirement<"smithers-build/install/link">

/**
 * The declaration shape the flow is named under.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type InstallFlow = Flow.Flow<
  "smithers-build/install",
  Schema.Struct<typeof payloadFields>,
  typeof LinkManifest,
  typeof PackageManager.PackageManagerError,
  Requires
>

/**
 * Records measure, one fetch, and link.
 *
 * The fetch is a parameter rather than a value selected inside the body because
 * each fetch declaration carries its own requirement in its type. Selecting one
 * from a union collapses the recorded requirement to whichever branch the
 * compiler read first; passing one in keeps this helper generic over exactly one
 * requirement and lets the four call sites union at the body, which is what
 * {@link Requires} already spells.
 *
 * @private
 */
const measureFetchLink = <R>(
  manager: PackageManager.Name,
  fetch: (
    content: Planned.Planned<Content>
  ) => Node.Node<PackageManager.StoreManifest, PackageManager.PackageManagerError, R>
): Node.Node<
  LinkManifest,
  PackageManager.PackageManagerError,
  | R
  | Action.Requirement<"smithers-build/install/measure">
  | Action.Requirement<"smithers-build/install/link">
> =>
  Measure.call({ manager }).pipe(
    Node.bindPlanned((content) => fetch(content).pipe(Node.bindPlanned((store) => Link.call({ content, store }))))
  )

/**
 * Installs a project's dependencies.
 *
 * The body is pure: it records nodes and executes nothing. It runs in one
 * round. The manager is a declaration in the payload, so the body selects one
 * manager-specific fetch statically, and measure feeds it as an ordinary
 * settled upstream reference rather than as a second round's payload.
 *
 * The capability ceiling is declared here rather than per action because
 * `Graph.build` reads it from the flow and copies it onto every node it
 * records; an `Action` declaration's own `Flow.Capabilities` annotation is
 * never read. DESIGN.md records that discrepancy against
 * `docs/specs/Concepts/Step Keys.md`, which describes capabilities as
 * per-step key material.
 *
 * @category flows
 * @since 0.1.0
 * @slop
 */
export const Install: InstallFlow = Flow.make("smithers-build/install", {
  payload: payloadFields,
  success: LinkManifest,
  error: PackageManager.PackageManagerError,
  maxRounds: 1,
  body: ({ manager }): Node.Node<
    Flow.BodySuccess<typeof LinkManifest.Type>,
    PackageManager.PackageManagerError,
    Requires
  > => measureFetchLink(manager, (content) => FetchPnpm.call({ content }))
}).annotate(Flow.Capabilities, ["fs:read", "fs:write", "net:get", "net:post", "proc:spawn"])

/** @private */
const environmentMismatch = (message: string): PackageManager.PackageManagerError =>
  new PackageManager.PackageManagerError({ code: "environment_mismatch", message })

const lockfileFor = (manager: PackageManager.Name): string => manager === "pnpm" ? "pnpm-lock.yaml" : "bun.lock"

const verifyManagerContract = (
  manager: PackageManager.Service
): Effect.Effect<void, PackageManager.PackageManagerError> => {
  if (!["pnpm", "bun"].includes(manager.name)) {
    return Effect.fail(environmentMismatch("the package-manager layer declares an unknown manager"))
  }
  const expectedLockfile = lockfileFor(manager.name)
  const expectedStore = `${PackageManager.storeRoot}/${manager.name}`
  return manager.lockfileName === expectedLockfile && manager.storeDirectory === expectedStore
    ? Effect.void
    : Effect.fail(
      environmentMismatch(
        `the ${manager.name} layer declares ${manager.lockfileName} and ${manager.storeDirectory}; ` +
          `the install Flow boundary requires ${expectedLockfile} and ${expectedStore}`
      )
    )
}

/**
 * Checks the layer against itself and the host against both declarations.
 *
 * Two things have to agree before a manager writes anything: the layer has to
 * be internally consistent, its lockfile name and store directory matching what
 * its own manager name implies, and the host has to satisfy the runtime and
 * manager versions the layers declare. The first is a wiring error and the
 * second is a machine that is not set up the way the workspace says it must be;
 * both are reported before any store or tree is touched.
 *
 * The manager the workspace declared is deliberately not compared against the
 * layer here. A sealed action receives only the layer, so it cannot see the
 * declaration; `d191c9dfcf` moved that check to the composition root that wires
 * one against the other.
 *
 * @private
 */
const verifyEnvironment = (
  manager: PackageManager.Service,
  runtime: Runtime.Service
): Effect.Effect<string, PackageManager.PackageManagerError> =>
  Effect.gen(function*() {
    yield* verifyManagerContract(manager)
    yield* runtime.verify.pipe(
      Effect.mapError((cause) => environmentMismatch(cause.message))
    )
    return yield* manager.verify
  })

/**
 * Refuses to link a store with a different manager implementation.
 *
 * @private
 */
const verifyStoreManager = (
  manager: PackageManager.Service,
  managerVersion: string,
  platform: PackageManager.Platform | null,
  store: PackageManager.StoreManifest
): Effect.Effect<void, PackageManager.PackageManagerError> => {
  const samePlatform = store.platform === null
    ? platform === null
    : platform !== null &&
      store.platform.os === platform.os &&
      store.platform.arch === platform.arch &&
      store.platform.libc === platform.libc
  return store.manager === manager.name &&
      store.managerVersion === managerVersion &&
      samePlatform
    ? Effect.void
    : Effect.fail(environmentMismatch("the fetched store does not match this host"))
}

const inputDrift = (path: string): PackageManager.PackageManagerError =>
  new PackageManager.PackageManagerError({
    code: "input_drift",
    message: `install input ${path} changed since measurement or could not be reverified`
  })

const optionalInput = (root: string, path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const present = yield* fs.exists(`${root}/${path}`).pipe(
      Effect.mapError(() =>
        new PackageManager.PackageManagerError({
          code: "manifest_unreadable",
          message: `cannot inspect ${path}`
        })
      )
    )
    return present ? { path, digest: yield* PackageManager.lockfileDigest(root, path) } : null
  })

/** Re-read fixed manager paths, never paths supplied by a recorded payload. */
const verifyContent = (manager: PackageManager.Service, content: Content) =>
  Effect.gen(function*() {
    const current = yield* executeMeasure().pipe(
      Effect.provideService(PackageManager.PackageManager, manager),
      Effect.mapError((error) => inputDrift(error.message))
    )
    for (const field of ["lockfile", "npmrc", "pnpmfile", "workspace"] as const) {
      const expected = content[field]
      const actual = current[field]
      if (expected === null && actual === null) continue
      if (expected?.path !== actual?.path || expected?.digest !== actual?.digest || expected === undefined) {
        const path = actual?.path ?? expected?.path ?? field
        return yield* Effect.fail(inputDrift(path))
      }
    }
    return current
  })

/**
 * The implementation of {@link Measure}.
 *
 * It reads the manager inputs and digests them. It measures no manager version and no
 * platform, because neither is content and both now have a service that
 * answers for them.
 *
 * Exported for the same reason {@link executeFetch} and {@link executeLink}
 * are: a test that drives the layer's body has to be able to name it, and a
 * body reachable only through `MeasureLive` is a body a test re-implements
 * inline and then asserts against its own copy.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const executeMeasure = (): Effect.Effect<
  Content,
  PackageManager.PackageManagerError,
  PackageManager.PackageManager | FileSystem.FileSystem | Crypto.Crypto
> =>
  Effect.gen(function*() {
    const manager = yield* PackageManager.PackageManager
    yield* verifyManagerContract(manager)
    const lockfile = yield* PackageManager.lockfileDigest(manager.projectRoot, manager.lockfileName)
    const npmrc = yield* PackageManager.npmrcDigest(manager.projectRoot)
    return {
      lockfile: { path: manager.lockfileName, digest: lockfile },
      npmrc: npmrc === null ? null : { path: ".npmrc", digest: npmrc },
      pnpmfile: manager.name === "pnpm" ? yield* optionalInput(manager.projectRoot, ".pnpmfile.cjs") : null,
      workspace: manager.name === "pnpm" ? yield* optionalInput(manager.projectRoot, "pnpm-workspace.yaml") : null
    }
  })

/**
 * Implements {@link Measure}.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const MeasureLive = Measure.toLayer(executeMeasure)

/**
 * The implementation shared by the manager-specific fetch declarations.
 *
 * It holds the layer, the host manager, and the host runtime to the
 * declaration before the manager writes anything, then reports the store
 * manifest the measured content produces.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const executeFetch = ({ content }: { readonly content: Content }) =>
  Effect.gen(function*() {
    const manager = yield* PackageManager.PackageManager
    const runtime = yield* Runtime.Runtime
    const managerVersion = yield* verifyEnvironment(manager, runtime)
    yield* verifyContent(manager, content)
    yield* manager.fetch
    const verified = yield* verifyContent(manager, content)
    return yield* PackageManager.storeManifest({
      manager: manager.name,
      managerVersion,
      platform: manager.platformSensitive ? runtime.platform : null,
      lockfileDigest: verified.lockfile.digest,
      npmrcDigest: verified.npmrc === null ? null : verified.npmrc.digest,
      pnpmfileDigest: verified.pnpmfile?.digest ?? null,
      workspaceDigest: verified.workspace?.digest ?? null
    })
  })

/**
 * Implements {@link FetchPnpm}.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const FetchPnpmLive = FetchPnpm.toLayer(executeFetch)

/**
 * Refuses to link a store that was fetched for different content.
 *
 * `content` is in {@link Link}'s payload because it is key material the
 * implementation is supposed to honour, and the implementation ignored it: a
 * `StoreManifest` fetched from another lockfile, or under another project
 * `.npmrc`, on this same host passed every check and produced a
 * {@link LinkManifest} attesting to content the tree was not built from.
 *
 * The check is one recompute, because a store manifest's digest is already
 * taken over a canonical text carrying both digests.
 *
 * @private
 */
const verifyStoreContent = (
  manager: PackageManager.Service,
  managerVersion: string,
  platform: PackageManager.Platform | null,
  content: Content,
  store: PackageManager.StoreManifest
): Effect.Effect<void, PackageManager.PackageManagerError, Crypto.Crypto> =>
  Effect.flatMap(
    PackageManager.storeManifest({
      manager: manager.name,
      managerVersion,
      platform,
      lockfileDigest: content.lockfile.digest,
      npmrcDigest: content.npmrc === null ? null : content.npmrc.digest,
      pnpmfileDigest: content.pnpmfile?.digest ?? null,
      workspaceDigest: content.workspace?.digest ?? null
    }),
    (expected) =>
      expected.digest === store.digest ? Effect.void : Effect.fail(
        environmentMismatch(
          `the fetched store attests ${store.digest}; this project's measured content is ${expected.digest}`
        )
      )
  )

/**
 * The implementation of {@link Link}.
 *
 * Link always asks the selected package manager to reconcile `node_modules`.
 * Manager metadata such as npm's hidden lockfile or pnpm's modules manifest
 * describes the intended graph, but cannot prove that every package file is
 * still present and unmodified. Treating that metadata as a freshness proof
 * would silently accept a deleted or corrupted package. The expected boundary
 * keeps this work local and out of the shared action cache.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const executeLink = ({ content, store }: {
  readonly content: Content
  readonly store: PackageManager.StoreManifest
}) =>
  Effect.gen(function*() {
    const manager = yield* PackageManager.PackageManager
    const runtime = yield* Runtime.Runtime
    const managerVersion = yield* verifyEnvironment(manager, runtime)
    const platform = manager.platformSensitive ? runtime.platform : null
    yield* verifyStoreManager(manager, managerVersion, platform, store)
    const verified = yield* verifyContent(manager, content)
    yield* verifyStoreContent(manager, managerVersion, platform, verified, store)
    const packageJsonDigest = yield* PackageManager.packageJsonDigest(manager.projectRoot)
    yield* manager.link
    const managerEvidence = yield* manager.linkManifest
    yield* verifyContent(manager, content)
    const currentPackageJsonDigest = yield* PackageManager.packageJsonDigest(manager.projectRoot).pipe(
      Effect.mapError(() => inputDrift("package.json"))
    )
    if (currentPackageJsonDigest !== packageJsonDigest) return yield* Effect.fail(inputDrift("package.json"))
    const manifest = yield* PackageManager.linkedTreeManifest({
      storeDigest: store.digest,
      packageJsonDigest,
      managerEvidence
    })
    return { store: store.digest, manifest, linked: true }
  })

/**
 * Live implementation of the package-manager link action.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const LinkLive = Link.toLayer(executeLink)

/**
 * Every implementation the {@link Install} flow needs.
 *
 * Compose it over a `PackageManager` layer, a `Runtime` layer, a
 * `FlowRuntime`, and the host services those need. Selecting the manager and
 * the runtime is the only choice a consumer makes.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = Layer.mergeAll(
  MeasureLive,
  FetchPnpmLive,
  LinkLive
)
