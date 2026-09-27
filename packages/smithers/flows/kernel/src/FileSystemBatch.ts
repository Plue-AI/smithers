/**
 * Optional, bounded read batches on the existing filesystem host slot.
 *
 * @since 1.0.0
 */

import type { Effect, FileSystem, PlatformError, Result } from "effect"

/** Maximum operations admitted by one batch.
 * @since 1.0.0
 * @category constants
 */
export const maxBatchSize = 128

/** Bounded concurrency for hosts without batching.
 * @since 1.0.0
 * @category constants
 */
export const fallbackConcurrency = 4

/** Read operations supported by a confined batch.
 * @since 1.0.0
 * @category models
 */
export type BatchRequest =
  | { readonly operation: "stat"; readonly path: string }
  | { readonly operation: "readDirectory"; readonly path: string; readonly options?: { readonly recursive?: boolean } }
  | { readonly operation: "digest"; readonly path: string; readonly content?: boolean }
  | {
    readonly operation: "glob"
    readonly path: string
    readonly root: string
    readonly options?: { readonly exclude?: ReadonlyArray<string> }
  }

/** A successful per-path observation. SHA-256 hashes raw bytes.
 * @since 1.0.0
 * @category models
 */
export type BatchValue =
  | { readonly operation: "stat"; readonly info: FileSystem.File.Info }
  | { readonly operation: "readDirectory" | "glob"; readonly paths: ReadonlyArray<string> }
  | {
    readonly operation: "digest"
    readonly digest: string
    readonly sizeBytes: number
    readonly bytes?: Uint8Array
  }

/** A result names its original request index, including failures.
 * @since 1.0.0
 * @category models
 */
export interface BatchEntry {
  readonly index: number
  readonly path: string
  readonly result: Result.Result<BatchValue, PlatformError.PlatformError>
}

/** Results sorted by path, then request index, bound to one root inode.
 * @since 1.0.0
 * @category models
 */
export interface BatchResponse {
  readonly rootIdentity: string
  readonly entries: ReadonlyArray<BatchEntry>
}

/** The guarded extension, never a second service tag.
 * @since 1.0.0
 * @category models
 */
export interface FileSystemBatch {
  readonly maxSize: number
  readonly maxResponseBytes: number
  readonly execute: (requests: ReadonlyArray<BatchRequest>) => Effect.Effect<BatchResponse, PlatformError.PlatformError>
}

/** Host extension identity on the guarded filesystem.
 * @since 1.0.0
 * @category constants
 */
export const FileSystemBatchTypeId = Symbol.for("@smthrs/kernel/FileSystemBatch")

/** Discover the guarded batch extension when the host supports it.
 * @since 1.0.0
 * @category accessors
 */
export const batch = (fs: FileSystem.FileSystem): FileSystemBatch | undefined =>
  (fs as FileSystem.FileSystem & { readonly [FileSystemBatchTypeId]?: FileSystemBatch })[FileSystemBatchTypeId]
