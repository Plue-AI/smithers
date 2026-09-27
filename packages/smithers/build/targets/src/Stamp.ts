/**
 * Inert, late-bound build stamp references.
 *
 * @since 0.1.0
 */

/* eslint-disable jsdoc/require-description, jsdoc/no-restricted-syntax */
import * as Schema from "effect/Schema"

/** */
export const Value = Schema.TaggedStruct("Stamp", {
  name: Schema.Literals(["version", "commit", "commitDate", "buildTime", "versionMeta"])
})
/** */
export type Value = typeof Value.Type

const value = (name: Value["name"]): Value => Object.freeze(Value.make({ name }))

/**
 * The inert placeholder a declaration carries in place of a stamp value.
 *
 * A stamp resolves after keying, so a declaration that must render a stamp
 * into a plain string (a linker flag, a Dockerfile build arg) carries this
 * token instead of a value. The token spells only the stamp's name — or, for
 * a secret-valued stamp, the environment variable's name — so it is safe in
 * key material, and the executor replaces it immediately before spawn.
 *
 * @category constructors
 * @since 0.1.0
 */
export const token = (name: string, value: unknown): string =>
  `{smthrs:stamp:${Buffer.from(JSON.stringify({ name, value })).toString("base64url")}}`

/** */
export const version = value("version")
/** */
export const commit = value("commit")
/** */
export const commitDate = value("commitDate")
/** */
export const buildTime = value("buildTime")
/** */
export const versionMeta = value("versionMeta")
