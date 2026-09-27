/**
 * The engine-store workspace transaction contract.
 *
 * The proof-of-concept contract that originally lived here diverged after the
 * production engine gained `FileBoundary`, expected-mode deviations, an
 * Effect `FileSystem` surface, and artifact-backed copy-back. Re-exporting the
 * canonical module keeps the harness and the engine on one transaction seam.
 *
 * @since 0.1.0
 */

export * from "@smthrs/engine-store/WorkspaceSandbox"
