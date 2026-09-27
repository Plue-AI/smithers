/**
 * The key-material contract: what a planner hands the step-key compiler.
 *
 * Revived from the deleted `packages/smithers/flows/keys/src/KeyMaterial.ts`.
 * It does NOT return to `@smthrs/keys`: that package owns generic derivation
 * and stored-key validation, while material is a *plan-shaped* concept. It
 * lives here, above `@smthrs/keys`, so the key package stays a leaf.
 *
 * Governing contract: the step-key rules at
 * https://smithers.sh/docs/concepts/content-addressing. Material is computed with no I/O,
 * and two hardening rules shape it: the nominal, never shape-sniffed
 * `InputRef` and the hashed `version`.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Effects from "./Effects.ts"

/**
 * A reference to one declared input of a node: a value hashed inline, or the
 * key of an upstream node whose result this node consumes.
 *
 * The three variants are tagged, and the tag is hashed, so `Pending{from}` and
 * `Ref{from, path: []}` — which resolve to the same dependency digest — can
 * never collide.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const InputRef = Schema.Union([
  Schema.TaggedStruct("Literal", { value: Schema.Unknown }),
  Schema.TaggedStruct("Ref", { from: Schema.NonEmptyString, path: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Pending", { from: Schema.NonEmptyString })
])

/**
 * A reference to one declared input of a node.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type InputRef = typeof InputRef.Type

/**
 * The material version. Folded into every hashed body so a bump re-keys every
 * node derived from it — the original's second collision fix, kept.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const version = "flows/key-material/v2"

/**
 * Everything that can change a node's result, handed to the digest.
 *
 * `effects` and `placement` are opaque: canonically serialized, never
 * interpreted, which is what keeps the compiler independent of whatever the
 * flow builder decides an effect declaration looks like.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const KeyMaterial = Schema.Struct({
  version: Schema.Literal(version),
  kind: Effects.Tier,
  // Absence claims determinism; only the explicit declaration changes identity.
  nondeterministic: Schema.optional(Schema.Literal(true)),
  body: Schema.Unknown,
  inputs: Schema.Array(InputRef),
  layers: Schema.Array(Schema.String),
  capabilities: Schema.Array(Schema.String),
  effects: Schema.optional(Schema.Unknown),
  placement: Schema.optional(Schema.Unknown)
})

/**
 * Everything that can change a node's result, handed to the digest.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type KeyMaterial = typeof KeyMaterial.Type

/**
 * The graph-local dependencies a material names, in declaration order and
 * without duplicates. The compiler resolves exactly these before hashing, and
 * {@link module:Plan} uses them as the edge set — one derivation, so an edge
 * and a hashed reference can never disagree.
 *
 * @since 0.1.0
 * @category accessors
 * @slop
 */
export const dependencies = (material: KeyMaterial): ReadonlyArray<string> => {
  const seen = new Set<string>()
  for (const input of material.inputs) {
    if (input._tag !== "Literal") seen.add(input.from)
  }
  return [...seen]
}
