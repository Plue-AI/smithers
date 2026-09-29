/**
 * PACKAGE.ts environment declarations: `S.Environment.Toolchain`.
 *
 * A toolchain declaration states, as data, the tool releases a prepared
 * environment installs: each tool's exact version, the linux/arm64 artifact it
 * is fetched from, and the SHA-256 that artifact must match, plus the Rust
 * toolchain and the PostgreSQL major. `destinations` lists every host the
 * installation reaches. The declaration runs nothing; it reaches the target
 * index as one row, and an environment builder (the Microsandbox layers in
 * `packages/backend`) reads its pins, digests and destinations from that row
 * rather than from a list of its own.
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Target from "./Target.ts"

/** A lowercase hex SHA-256 digest. */
const hexDigest = /^[0-9a-f]{64}$/

/** An absolute https URL with no whitespace. */
const httpsUrl = /^https:\/\/\S+$/

/**
 * One pinned tool artifact.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Download = Schema.Struct({
  version: Schema.NonEmptyString,
  url: Schema.NonEmptyString.check(Schema.isPattern(httpsUrl)),
  sha256: Schema.NonEmptyString.check(Schema.isPattern(hexDigest))
})

/**
 * One pinned tool artifact.
 *
 * @category models
 * @since 1.0.0
 */
export type Download = typeof Download.Type

/**
 * The Rust toolchain an environment installs through rustup.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Rust = Schema.Struct({
  channel: Schema.NonEmptyString,
  components: Schema.Array(Schema.NonEmptyString),
  targets: Schema.Array(Schema.NonEmptyString)
})

/**
 * The Rust toolchain an environment installs through rustup.
 *
 * @category models
 * @since 1.0.0
 */
export type Rust = typeof Rust.Type

/**
 * The toolchain as the target index carries it: everything but the
 * destinations, which every row carries in its own field.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ToolchainData = Schema.Struct({
  /** Pinned artifacts keyed by tool name (`node`, `pnpm`, `go`, ...). */
  downloads: Schema.Record(Schema.NonEmptyString, Download),
  rust: Schema.optional(Rust),
  /** The PostgreSQL major installed from its signed apt repository. */
  postgres: Schema.optional(Schema.NonEmptyString)
})

/**
 * The toolchain as the target index carries it.
 *
 * @category models
 * @since 1.0.0
 */
export type ToolchainData = typeof ToolchainData.Type

/**
 * Attrs for {@link Toolchain}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ToolchainAttrs = Schema.Struct({
  ...ToolchainData.fields,
  destinations: Attr.Destinations
})

/**
 * Attrs for {@link Toolchain}.
 *
 * @category models
 * @since 1.0.0
 */
export type ToolchainAttrs = typeof ToolchainAttrs.Type

/**
 * The rule id every {@link Toolchain} target reports.
 *
 * @category constants
 * @since 1.0.0
 */
export const toolchainRuleId = "Environment.Toolchain"

/**
 * The tool releases a prepared environment installs, as data.
 *
 * It participates in no verb: selecting it plans the typed not-implemented
 * refusal, and its only reader is the target index.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const environmentToolchain = Smithers.Environment.Toolchain({
 *   downloads: {
 *     jq: {
 *       version: "1.7.1",
 *       url: "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-arm64",
 *       sha256: "4dd2d8a0661df0b22f1bb9a1f9830f06b6f3b8f7d91211a1ef5d7c4f06a8b4a5"
 *     }
 *   },
 *   destinations: ["github.com", "release-assets.githubusercontent.com"]
 * })
 * ```
 *
 * @category targets
 * @since 1.0.0
 */
export const Toolchain = Target.make(toolchainRuleId, {
  attrs: ToolchainAttrs,
  kinds: [],
  implementation: () => Target.notImplemented(toolchainRuleId)
})

/**
 * The index data of a {@link Toolchain} declaration's attrs.
 *
 * @category accessors
 * @since 1.0.0
 */
export const toolchainData = (attrs: ToolchainAttrs): ToolchainData => ({
  downloads: attrs.downloads,
  ...(attrs.rust === undefined ? {} : { rust: attrs.rust }),
  ...(attrs.postgres === undefined ? {} : { postgres: attrs.postgres })
})
