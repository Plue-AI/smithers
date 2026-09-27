/**
 * The exact capability parser for the `action:resource` text form.
 *
 * @since 0.1.0
 */

import { Option } from "effect"
import type { Capability } from "./ExactCapability.ts"
import { isAction } from "./internal/isAction.ts"
import { make } from "./make.ts"
import { maxResourceLength } from "./maxResourceLength.ts"

/**
 * Parses an exact capability. The action is the first two colon-separated
 * components; all remaining text belongs to the resource.
 *
 * @since 0.1.0
 * @category parsing
 * @slop
 */
export const parse = (input: string): Option.Option<Capability> => {
  const components = input.split(":")
  const namespace = components[0]
  const operation = components[1]
  if (namespace === undefined || operation === undefined || components.length < 3) {
    return Option.none()
  }
  const action = `${namespace}:${operation}`
  const resource = components.slice(2).join(":")
  return isAction(action) && resource.length <= maxResourceLength
    ? Option.some(make(action, resource))
    : Option.none()
}
