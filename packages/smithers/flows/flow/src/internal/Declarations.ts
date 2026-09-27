/**
 * The lowering every declaration in this package shares: literal
 * `capabilities`, `effects` and `modelInvocable` become entries in the
 * annotation bag readers already consult.
 *
 * Both literals exist so a CATALOG can project them from source text without
 * importing the module, so this is the only place either spelling is turned
 * into a value. A flow or an action that declares `capabilities` and one that
 * annotates {@link module:Flow/Annotations.Capabilities} are the same
 * declaration to {@link module:Graph.build}, and the same holds for `effects`
 * and {@link module:Flow/Annotations.EffectEnvelope}.
 *
 * It lives here, below both constructors, because a flow and an action lower
 * the same two literals and a second copy would let one gain a field the other
 * kept ignoring.
 *
 * @since 0.1.0
 * @private
 */

import * as Effects from "@smthrs/plan/Effects"
import * as Context from "effect/Context"
import { Capabilities, EffectEnvelope, ModelInvocable } from "../Flow/Annotations.ts"

/**
 * Lowers the literal declarations a constructor call carries into the
 * annotation bag, leaving every annotation the caller already supplied.
 *
 * @since 0.1.0
 * @private
 */
export const lowerDeclarations = (options: {
  readonly capabilities?: ReadonlyArray<string> | undefined
  readonly effects?: Effects.MakeOptions | undefined
  readonly modelInvocable?: boolean | undefined
  readonly annotations?: Context.Context<never> | undefined
}): Context.Context<never> => {
  let annotations = options.annotations ?? Context.empty()
  if (options.capabilities !== undefined) {
    annotations = Context.add(annotations, Capabilities, options.capabilities)
  }
  if (options.effects !== undefined) {
    annotations = Context.add(annotations, EffectEnvelope, Effects.make(options.effects))
  }
  if (options.modelInvocable !== undefined) {
    annotations = Context.add(annotations, ModelInvocable, options.modelInvocable)
  }
  return annotations
}
