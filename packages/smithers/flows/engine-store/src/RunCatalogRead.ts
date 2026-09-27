/**
 * The workspace run catalog read.
 *
 * `@smthrs/sync` serves a workspace subscription over a `RunCatalog`, and its
 * own implementations are static or in-process. This is the durable source a
 * `RunCatalog.makePolling` catalog reads, so a follower learns of a run
 * another engine created.
 *
 * The operation lives in `internal/RunCatalogOps.ts`, beside the other
 * modules that read this package's own tables; this module is the public
 * surface, so `internal/` is never imported by a consumer.
 *
 * @since 0.1.0
 */

export {
  defaultLimit,
  layer,
  type ListOptions,
  make,
  RunCatalogError,
  RunCatalogErrorCode,
  RunCatalogRead,
  type Service
} from "./internal/RunCatalogOps.ts"

export { Filters, type ListRunsOptions, maximumPageSize, type RunPage } from "./internal/RunListing.ts"
