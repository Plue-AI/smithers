/**
 * The three text helpers every module in this package needs and nine of them
 * had copy-defined: a host-independent string order, the POSIX rendering of a
 * host path, and a hex SHA-256.
 *
 * They are shared rather than repeated because each one is cache-key material.
 * `byCodeUnit` decides the order a manifest, a closure, or a synthesized
 * target set is written in, `posix` decides how a path is spelled inside a
 * digest, and `sha256Hex` is the digest itself, so two copies drifting apart
 * would key one workspace two ways on two machines.
 *
 * @since 0.1.0
 */

import { createHash } from "node:crypto"
import * as NodePath from "node:path"

/**
 * Orders strings by UTF-16 code unit.
 *
 * `localeCompare` answers differently under different host locales and ICU
 * versions, which would let one workspace pick a different configuration
 * declaration, or synthesize targets in a different order, on two machines
 * looking at the same files; code-unit order is the same everywhere.
 *
 * @category ordering
 * @since 0.1.0
 */
export const byCodeUnit = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/**
 * Renders a host path with POSIX separators, so a label, a manifest entry,
 * and a digest spell one path the same way on every platform.
 *
 * @category paths
 * @since 0.1.0
 */
export const posix = (value: string): string => value.split(NodePath.sep).join("/")

/**
 * Hex SHA-256 of text or bytes. Text is hashed as UTF-8.
 *
 * @category digests
 * @since 0.1.0
 */
export const sha256Hex = (content: string | Buffer): string =>
  typeof content === "string"
    ? createHash("sha256").update(content, "utf8").digest("hex")
    : createHash("sha256").update(content).digest("hex")
