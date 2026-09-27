/**
 * Deterministic in-memory implementation of the canonical engine-store
 * workspace sandbox.
 *
 * @since 0.1.0
 */

import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"

/**
 * The files an in-memory workspace starts from.
 *
 * @category models
 * @since 0.1.0
 */
export type InitialFiles = WorkspaceSandbox.InitialFiles

/**
 * One file in the in-memory host.
 *
 * @category models
 * @since 0.1.0
 */
export type HostFile = WorkspaceSandbox.HostFile

/**
 * The in-memory sandbox this module constructs.
 *
 * @category models
 * @since 0.1.0
 */
export type InMemoryWorkspaceSandbox = WorkspaceSandbox.MemorySandbox

/**
 * Creates the engine-store conformance sandbox over an in-memory host.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = WorkspaceSandbox.makeMemory
