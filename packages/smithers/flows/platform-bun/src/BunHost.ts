/**
 * Aggregate Bun Host bundle.
 *
 * Runtime-specific dependencies stay inside this package; callers get the same
 * closed five-service Host surface every other bundle provides.
 *
 * There is no Bun shell module: running a command is Effect's
 * `ChildProcessSpawner`, and `@effect/platform-bun`'s implementation is
 * `@effect/platform-node-shared`'s re-exported: the same code on both
 * runtimes, so no runtime detection is needed here.
 *
 * There is no Bun HTTP module either: outgoing requests are Effect's
 * `HttpClient`, and `@effect/platform-bun/BunHttpClient` is Effect's own
 * fetch-backed implementation. Bun reaches for it directly rather than
 * borrowing a browser package to get at `fetch`. The one thing configured here
 * is `redirect: "manual"`, so the runtime never walks to a second origin
 * behind the capability kernel's back; following a redirect is
 * `@smthrs/kernel`'s guarded `HttpClient.layer`, which rechecks every hop.
 *
 * The filesystem slot is `@smthrs/platform-node`'s `AtomicFileSystem`, byte for
 * byte the layer `NodeHost` uses, so a guarded path operation is
 * descriptor-relative and no-follow on both runtimes.
 *
 * @since 1.0.0-rc.0
 */

import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient"
import * as BunPath from "@effect/platform-bun/BunPath"
import type { Jj, JjError } from "@smthrs/jj"
import * as BunJj from "@smthrs/jj/bun/BunJj"
import type { HostServiceIds } from "@smthrs/kernel/HostServices"
import type * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as HostLiveness from "@smthrs/platform-node/HostLiveness"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import type * as Crypto from "effect/Crypto"
import type { FileSystem } from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type * as Path from "effect/Path"
import type { HttpClient } from "effect/unstable/http/HttpClient"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { isAbsolute } from "node:path"
import * as BunFileSystem from "./BunFileSystem.ts"

/**
 * Bun platform modules for selectively providing individual services.
 *
 * `AtomicFileSystem` is here for the same reason `NodeHost` re-exports it: it
 * owns the only configuration escape hatch the filesystem slot has, and a Bun
 * program with a different packaged helper path needs to reach
 * `AtomicFileSystem.layerWith` without hand-composing the other four tags.
 *
 * `BunJj` is deliberately absent: it belongs to `@smthrs/jj` and is imported
 * from there, never re-exported here. So is `@effect/platform-bun/BunHttpClient`:
 * its `layer` follows redirects to origins the capability kernel never
 * authorized. The network slot on its own is {@link layerHttpClient}.
 *
 * @category re-exports
 * @since 1.0.0-rc.0
 * @slop
 */
export { AtomicFileSystem, BunChildProcessSpawner, BunCrypto, BunFileSystem, HostLiveness, ProcessReaper }

/**
 * The complete closed Host service union provided by Bun.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export type BunHost = FileSystem | Path.Path | ChildProcessSpawner | Jj | HttpClient

/**
 * The stable codes a `BunHost` factory refuses with.
 *
 * A code is the contract a caller branches on; the message beside it is for a
 * person. `invalid_repository_root` is the root handed to {@link layerAt} or
 * {@link layerContainedAt} not being absolute, the empty string included.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type BunHostErrorCode = "invalid_repository_root"

/**
 * The refusal a `BunHost` factory throws before it builds a layer.
 *
 * It is thrown rather than failed because a factory is called while a program
 * composes its layers, where there is no fiber to fail yet and a wrong root is
 * a composition mistake, not a runtime outcome. It is this package's class,
 * not the `Jj` adapter's, because a Bun caller composes `BunHost` and should
 * learn nothing about the adapter behind the `Jj` slot from an error message.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class BunHostError extends Error {
  override readonly name = "BunHostError"
  readonly code: BunHostErrorCode
  constructor(options: { readonly code: BunHostErrorCode; readonly message: string }) {
    super(options.message)
    this.code = options.code
  }
}

/** The longest message a factory refuses with, in UTF-16 code units. */
const messageLimit = 255

/** How many code points of a refused root the message repeats at most. */
const previewLimit = 64

/**
 * A bounded, quoted excerpt of a refused root that fits in `budget` code
 * units of the message.
 *
 * Counted in code points rather than UTF-16 units so a cut never splits a
 * surrogate pair, and passed through `JSON.stringify` so a newline in the root
 * cannot break the log line the message lands on. Each code point is encoded
 * on its own and admitted only while the quoted excerpt plus the length
 * suffix still fit, so a control character that widens to a `\u0001` escape
 * shortens the excerpt instead of lengthening the message, and a cut never
 * lands inside an escape.
 */
const preview = (root: string, budget: number): string => {
  const points = Array.from(root)
  const whole = JSON.stringify(root)
  if (points.length <= previewLimit && whole.length <= budget) return whole
  const suffix = `... (${points.length} characters)`
  const room = budget - suffix.length - 2
  let excerpt = ""
  for (const point of points.slice(0, previewLimit)) {
    const encoded = JSON.stringify(point).slice(1, -1)
    if (excerpt.length + encoded.length > room) break
    excerpt += encoded
  }
  return `"${excerpt}"${suffix}`
}

/**
 * Refuses a root the `Jj` adapter underneath would refuse, here and in this
 * package's name.
 *
 * `BunJj.layerAt` and `BunJj.layerSpawnerAt` are `NodeJj`'s, and those throw a
 * bare `TypeError` that names `NodeJj`, carries no code, and echoes the whole
 * string. The predicate here is the same `isAbsolute` the adapter applies, so
 * a root that passes this check cannot reach that throw.
 */
const absoluteRoot = (factory: "layerAt" | "layerContainedAt", root: string): string => {
  if (isAbsolute(root)) return root
  const prefix = `BunHost.${factory} requires an absolute repository root, got `
  throw new BunHostError({
    code: "invalid_repository_root",
    message: `${prefix}${preview(root, messageLimit - prefix.length)}`
  })
}

/**
 * Stable implementation identities keyed by the closed Host service slots.
 *
 * Each value names the module behind that slot in the raw host bundle.
 * Contained POSIX factories replace the spawner with {@link ProcessReaper.layerSpawner}.
 * These are identity
 * tokens rather than import specifiers: the filesystem entry is
 * `@smthrs/platform-node/AtomicFileSystem` because that is the implementation,
 * even though a consumer reaches it through `@smthrs/platform-bun`.
 *
 * Nothing digests them yet. `@smthrs/plan`'s step key carries a `layers`
 * component these values are meant to feed, but no planner derives it from a
 * host bundle today, so changing one invalidates no cached step.
 *
 * The keys are written as literals rather than `HostServiceIds` positions so
 * that reordering the closed list cannot silently pair a slot with another
 * slot's implementation.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export const implementationIds: Readonly<Record<(typeof HostServiceIds)[number], string>> = {
  "effect/FileSystem": "@smthrs/platform-node/AtomicFileSystem",
  "effect/Path": "@effect/platform-bun/BunPath",
  "effect/process/ChildProcessSpawner": "@effect/platform-bun/BunChildProcessSpawner",
  "@smthrs/jj/Jj": "@smthrs/jj/bun/BunJj",
  "effect/HttpClient": "@effect/platform-bun/BunHttpClient"
}

/**
 * What a caller may configure about containment.
 *
 * `ContainedSpawner.Options.platform` is deliberately not part of it. It
 * decides one thing, whether a command that names no `detached` option gets a
 * process group of its own, and this native host detaches by `process.platform`
 * whatever a record claims. A
 * caller-supplied `"win32"` on a POSIX host would therefore record
 * `pgid: null` for a child that really does lead a group, and
 * {@link ProcessReaper.reap} would retire that record as `no-group` and leave
 * the orphan running forever: a durable lie rather than a compile error.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ContainedOptions = ProcessReaper.SpawnerOptions & ProcessReaper.Options

/** The reaper half of {@link ContainedOptions}. */
const reaping = (options?: ContainedOptions): ProcessReaper.Options => ({
  ownerPid: options?.ownerPid,
  system: options?.system
})

/** The two services `BunChildProcessSpawner` resolves paths and files with. */
const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layer)

/**
 * The network slot on its own: Effect's fetch client, told never to follow a
 * redirect. A `3xx` comes back to the caller with its `location` intact and the
 * second origin uncontacted; following a redirect is `@smthrs/kernel`'s guarded
 * `HttpClient.layer`, which rechecks every hop.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerHttpClient: Layer.Layer<HttpClient> = Layer.provide(
  BunHttpClient.layer,
  Layer.succeed(BunHttpClient.RequestInit)({ redirect: "manual" })
)

/**
 * Provides all five Bun Host services, including the runtime-independent Path
 * service.
 *
 * Fails at construction with {@link JjError} carrying `not_installed` or
 * `unsupported_version`: the `Jj` slot is merged eagerly and probes
 * `jj --version` while the layer is built, before the program body runs and
 * whether or not the program asks for `Jj`. Requires jj 0.39.0 or later.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layer: Layer.Layer<BunHost | Crypto.Crypto, JjError> = Layer.mergeAll(
  platform,
  Layer.provide(BunChildProcessSpawner.layer, platform),
  BunJj.layer,
  layerHttpClient
)

/**
 * Provides all five Bun Host services bound to one absolute repository root.
 *
 * Throws {@link BunHostError} with code `invalid_repository_root` when `root`
 * is not absolute; the empty string counts. The check runs when the factory is
 * called, before any layer exists.
 *
 * Fails at construction with {@link JjError} exactly as {@link layer} does:
 * the `Jj` slot probes `jj --version` while the layer is built.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerAt = (root: string): Layer.Layer<BunHost | Crypto.Crypto, JjError> => {
  const repositoryRoot = absoluteRoot("layerAt", root)
  return Layer.mergeAll(
    platform,
    Layer.provide(BunChildProcessSpawner.layer, platform),
    BunJj.layerAt(repositoryRoot),
    layerHttpClient
  )
}

/**
 * Provides the Bun host with process containment turned on.
 *
 * Bun uses the same prepared native process lifecycle as Node on POSIX, while
 * preserving its underlying runtime spawner on Windows. `ContainedSpawner` gives
 * every child an escalation deadline and a ledger entry, and
 * `ProcessReaper` sweeps the entries a crashed incarnation of this host left
 * behind. The reaper module lives in `@smthrs/platform-node` because the calls
 * it makes, `process.kill` and `taskkill`, are Node's, and Bun implements
 * them unchanged.
 *
 * Fails at construction with {@link JjError} exactly as {@link layer} does;
 * here the `jj --version` probe runs through the contained spawner, so its
 * record enters and leaves the ledger like any other child.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerContained = (
  options?: ContainedOptions
): Layer.Layer<BunHost | Crypto.Crypto, JjError, ProcessLedger.ProcessLedger> => {
  const spawner = Layer.provide(
    ProcessReaper.layerSpawner({ graceMs: options?.graceMs }),
    Layer.provide(BunChildProcessSpawner.layer, platform)
  )
  return Layer.mergeAll(
    platform,
    layerHttpClient,
    // jj goes through the CONTAINED spawner here, not around it, exactly as in
    // `NodeHost.layerContained`: a jj child that starts its own process leads
    // no recorded group, is in no ledger, and outlives the host that ran it.
    Layer.provideMerge(BunJj.layerSpawner, spawner)
  ).pipe(Layer.provideMerge(ProcessReaper.layer(reaping(options))))
}

/**
 * Provides the contained Bun host bound to one absolute repository root.
 *
 * Refuses a root exactly as {@link layerAt} does: {@link BunHostError} with
 * code `invalid_repository_root`, thrown when the factory is called.
 * Fails at construction with {@link JjError} exactly as {@link layerContained}
 * does.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerContainedAt = (
  root: string,
  options?: ContainedOptions
): Layer.Layer<BunHost | Crypto.Crypto, JjError, ProcessLedger.ProcessLedger> => {
  const repositoryRoot = absoluteRoot("layerContainedAt", root)
  const spawner = Layer.provide(
    ProcessReaper.layerSpawner({ graceMs: options?.graceMs }),
    Layer.provide(BunChildProcessSpawner.layer, platform)
  )
  return Layer.mergeAll(
    platform,
    layerHttpClient,
    Layer.provideMerge(BunJj.layerSpawnerAt(repositoryRoot), spawner)
  ).pipe(Layer.provideMerge(ProcessReaper.layer(reaping(options))))
}
