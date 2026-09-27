/**
 * Browser implementation of Effect's `FileSystem` service.
 *
 * A browser tab has no `node:fs`. What it has is a virtual filesystem mounted
 * over IndexedDB, OPFS, or memory — in practice **ZenFS** — which exposes a
 * `node:fs/promises`-shaped object. This module adapts that object into a
 * `FileSystem` layer, the way `NodeFileSystem` adapts `node:fs`.
 *
 * Unlike `NodeFileSystem`, the layer is a **function**: the page owns which
 * backend is mounted and when, so the promises object is an argument rather
 * than a static import. That also keeps `@zenfs/core` out of this package's
 * dependency list — {@link ZenFsPromisesLike} is a structural slice, and Node's
 * own `node:fs/promises` satisfies it, which is what the tests use.
 *
 * @since 1.0.0-rc.0
 */

export * from "./layer.ts"
export * from "./make.ts"
export * from "./ZenFsFileHandleLike.ts"
export * from "./ZenFsPromisesLike.ts"
export * from "./ZenFsStatsLike.ts"
