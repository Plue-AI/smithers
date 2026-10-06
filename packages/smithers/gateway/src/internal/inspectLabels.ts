import { ACTION_RENDERINGS } from "./actionRenderings.ts"

/**
 * The recorded action's Appendix C label, with unknown historical tags retained.
 * Dynamic cell-call wrappers name the tool they recorded, never a new action.
 * @category utilities
 * @since 1.0.0
 */
export const inspectLabel = (tag: string): string => {
  const tool = /^<cell-call:(.+)>$/.exec(tag)?.[1] ?? tag
  return ACTION_RENDERINGS[tool] ?? tool
}

