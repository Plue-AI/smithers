/**
 * Reduction of ordered policy rulesets to one decision.
 *
 * @since 0.1.0
 */

import { type Capability, matches, withinMatchBudget } from "./Capability.ts"
import type { Rule } from "./Rule.ts"
import type { RuleEffect } from "./RuleEffect.ts"

/**
 * Evaluates ordered permission rules.
 *
 * Matching rules are last-match-wins across all rulesets and the default is
 * `ask`. `rulesets[0]` is the configured policy ruleset. The function first
 * reduces that ruleset with the same last-match rule, then treats its effective
 * denial as a hard veto. A configured deny superseded by a later configured
 * allow or ask in that ruleset is therefore not a veto.
 *
 * A rule the matcher cannot decide within `Capability.maxMatchWork` vetoes the
 * decision and `evaluate` returns `deny`. Skipping it could let an undecidable
 * deny fall through to a later allow. The kernel turns that `deny` into a
 * `PermissionDenied`.
 *
 * @category policy
 * @since 0.1.0
 * @slop
 */
export const evaluate = (
  rulesets: ReadonlyArray<ReadonlyArray<Rule>>,
  capability: Capability
): RuleEffect => {
  // One indexed pass: an undecidable rule anywhere vetoes, so returning on the
  // first one is equivalent to a separate budget preflight. Each rule is
  // matched once; index 0 additionally tracks the configured last-match.
  let configuredEffect: RuleEffect = "ask"
  let effect: RuleEffect = "ask"
  for (const [index, ruleset] of rulesets.entries()) {
    for (const rule of ruleset) {
      if (!withinMatchBudget(rule.pattern, capability)) {
        return "deny"
      }
      if (matches(rule.pattern, capability)) {
        effect = rule.effect
        if (index === 0) {
          configuredEffect = rule.effect
        }
      }
    }
  }
  return configuredEffect === "deny" ? "deny" : effect
}
