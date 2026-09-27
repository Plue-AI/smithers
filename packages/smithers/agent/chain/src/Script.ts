/**
 * The authored artifact of one link: flow-script text plus its content
 * digest.
 *
 * The digest is the replay identity of every call the script makes
 * (https://chain.smithers.sh/contract/). Extraction implements gate 1
 * (shape): the author's output must contain exactly one fenced flow block.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import { Schema } from "effect"

/**
 * A link's flow-script text paired with the content digest that keys every
 * call it makes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Script = Schema.Struct({
  text: Schema.String,
  digest: Schema.String
})

/**
 * The decoded form of {@link Script}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Script = typeof Script.Type

/**
 * Builds a script from its text, digesting it.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (text: string): Script => ({ text, digest: Digest.digest(text) })

/**
 * The result of applying the shape gate: an extracted script, or the
 * rejection prose the next authoring reads.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Extraction =
  | { readonly _tag: "Extracted"; readonly script: Script }
  | { readonly _tag: "Rejected"; readonly reason: string }

const fence = /```flow\n([\s\S]*?)\n```/g

/**
 * Applies the shape gate to raw author output: exactly one fenced `flow`
 * block, whose body becomes the script.
 *
 * @category gates
 * @since 0.1.0
 * @slop
 */
export const extract = (raw: string): Extraction => {
  const blocks = [...raw.matchAll(fence)]
  const first = blocks[0]
  if (first === undefined) {
    return { _tag: "Rejected", reason: "the author output contains no ```flow block" }
  }
  if (blocks.length > 1) {
    return {
      _tag: "Rejected",
      reason: `the author output contains ${blocks.length} \`\`\`flow blocks, expected exactly one`
    }
  }
  // The capture group always participates when the fence matches.
  return { _tag: "Extracted", script: make(first[1] as string) }
}
