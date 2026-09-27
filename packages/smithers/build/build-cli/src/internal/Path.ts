/**
 * One containment rule for the whole package.
 *
 * Four modules each asked "is this path inside that root?" with their own
 * `NodePath.relative(...).startsWith("..")`, which tests the rendered text
 * rather than the first path segment: a sibling directory literally named
 * `..foo` renders as `..foo/pkg` and was reported as outside the root it is
 * plainly inside. The check belongs in one place, stated once, so the four
 * call sites cannot drift.
 *
 * @since 0.1.0
 */

import * as NodePath from "node:path"

/**
 * Whether `candidate` is `root` itself or lies beneath it.
 *
 * Judged by path segment, so a directory whose name merely begins with two
 * dots is inside, and an absolute `NodePath.relative` result (a different
 * Windows volume) is outside. Neither path is resolved through symlinks: a
 * caller that needs real containment resolves both with `realpath` first.
 *
 * @category paths
 * @since 0.1.0
 */
export const contains = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate)
  if (relative === "" || relative === ".") return true
  if (NodePath.isAbsolute(relative)) return false
  const [first] = relative.split(NodePath.sep)
  return first !== ".."
}

/**
 * The path of `candidate` relative to `root`, or undefined when it lies
 * outside. The containment rule is {@link contains}.
 *
 * @category paths
 * @since 0.1.0
 */
export const containedRelative = (root: string, candidate: string): string | undefined =>
  contains(root, candidate) ? NodePath.relative(root, candidate) : undefined
