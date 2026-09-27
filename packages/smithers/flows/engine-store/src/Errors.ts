/**
 * The public, stable error contract of `@smthrs/engine-store`.
 *
 * Every error here carries a `code` literal that is part of the public API:
 * consumers may switch on `code` (or `_tag`) and the strings will not change
 * without a major version. The classes themselves are declared next to the
 * logic that raises them (`internal/ActionPersistence.ts`,
 * `@smthrs/flow/Action`, and `@smthrs/flow/FlowRuntime`); this module is the
 * barrel-exported surface so that `internal/` never has to be imported by
 * consumers.
 *
 * Related documentation: `docs/troubleshooting.md` names every code and
 * what to change; `docs/api.md` carries the schemas.
 *
 * @since 0.1.0
 */

export { IrreversibleRetryRequiresIdempotencyKey } from "@smthrs/flow/Action"
export { FlowCycleDetected } from "@smthrs/flow/FlowRuntime"
export {
  AttemptAdmissionRejected,
  AttemptEvidenceQuarantined,
  AttemptSuspended,
  CacheConflictDetected,
  CacheCorruptionDetected
} from "./internal/ActionPersistence.ts"
export { RetentionError, RetentionErrorCode } from "./internal/RetentionOps.ts"
export { RunCatalogError, RunCatalogErrorCode } from "./internal/RunCatalogOps.ts"
