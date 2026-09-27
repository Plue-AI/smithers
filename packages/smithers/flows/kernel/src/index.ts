/**
 * Capability enforcement at the Host boundary.
 *
 * Every slot of the closed Host surface is decorated in place: a middleware
 * `Layer` over the very tag a platform adapter provides, checking a capability
 * against a `GrantStore` before it delegates. There is no second, protected
 * tag, so code that never heard of the kernel is guarded the moment the layer
 * is composed over its host.
 *
 * @since 1.0.0-rc.0
 */

/**
 * Capability values, patterns, matching, and effect tiers.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as Capability from "@smthrs/capability/Capability"

/**
 * Monotone ambient authority and intersection.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as CapabilitySet from "./CapabilitySet.ts"

/**
 * The `proc:spawn` middleware over Effect's own `ChildProcessSpawner` tag.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as ChildProcessSpawner from "./ChildProcessSpawner.ts"

/**
 * Least-authority child-process environment construction.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as ChildProcessEnvironment from "./ChildProcessEnvironment.ts"

/**
 * Process containment middleware over Effect's own `ChildProcessSpawner` tag.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as ContainedSpawner from "./ContainedSpawner.ts"

/**
 * Rendering `ChildProcess` commands back to command lines.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as CommandLine from "./CommandLine.ts"

/**
 * The `fs:read`/`fs:write` middleware over Effect's own `FileSystem` tag.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as FileSystem from "./FileSystem.ts"

/**
 * Durable grant decision schemas.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as GrantEvent from "./GrantEvent.ts"

/**
 * Attended and unattended grant-store services.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as GrantStore from "./GrantStore.ts"

/**
 * The union of failures the closed Host surface is allowed to produce.
 *
 * A type, not a namespace: process execution now fails with Effect's own
 * `PlatformError`, so nothing is left here to construct.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type { HostError } from "./HostError.ts"

/**
 * The closed protected Host service layer.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as HostServices from "./HostServices.ts"

/**
 * The `net:get`/`net:post`/`model:call` middleware over Effect's own
 * `HttpClient` tag.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as HttpClient from "./HttpClient.ts"

/**
 * The jj capability middleware over `@smthrs/jj`'s own `Jj` tag.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as Jj from "./Jj.ts"

/**
 * Journal-backed grant persistence.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as JournalGrantStore from "./JournalGrantStore.ts"

/**
 * The explicit pure path-service decision.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as Path from "./Path.ts"

/**
 * Typed permission errors and policy rules.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as Permission from "@smthrs/capability/Permission"

/**
 * The host's durable record of the processes it started.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as ProcessLedger from "./ProcessLedger.ts"

/**
 * Filesystem, path and process services bound to one root directory.
 *
 * @category namespace exports
 * @since 1.0.0
 */
export * as Rooted from "./Rooted.ts"

/**
 * The shared workspace-root service.
 *
 * @category namespace exports
 * @since 1.0.0-rc.0
 */
export * as Workspace from "./Workspace.ts"
