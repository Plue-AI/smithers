/**
 * Flow discovery and the catalog a model is shown: portable descriptors
 * scanned off a filesystem, disclosed to an agent in a compact form, and
 * resolved back to a runnable body on demand.
 *
 * Discovery is metadata-only. Scanning a source reads and hashes each entry
 * file whole, up to `Discovery.entrySizeLimit`, then parses at most its first
 * 64 KiB for markdown frontmatter or module metadata, so a catalog of a
 * thousand flows costs a thousand reads and frontmatter parses and no imports.
 * No module is evaluated and no prompt body reaches the result. A body is
 * loaded when a flow is actually invoked, and its bytes are checked against the
 * content address discovery recorded.
 *
 * Governing contract: `packages/smithers/agent/registry/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/registry.
 *
 * @since 0.1.0
 */

/**
 * @category errors
 * @since 0.1.0
 */
export * as RegistryError from "./RegistryError.ts"

/**
 * @category models
 * @since 0.1.0
 */
export * as Descriptor from "./Descriptor.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as Discovery from "./Discovery.ts"

/**
 * @category markdown
 * @since 0.1.0
 */
export * as MarkdownFlow from "./MarkdownFlow.ts"

/**
 * @category markdown
 * @since 1.0.0-rc.1
 */
export * as Prompt from "./Prompt.ts"

/**
 * @category conversions
 * @since 0.1.0
 */
export * as Disclosure from "./Disclosure.ts"

/**
 * @category constructors
 * @since 0.1.0
 */
export * as Executable from "./Executable.ts"

/**
 * @category models
 * @since 0.1.0
 */
export * as Pack from "./Pack.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as Registry from "./Registry.ts"

/** @category services @since 1.0.0-rc.1 */
export * as ExecutionSnapshot from "./ExecutionSnapshot.ts"
