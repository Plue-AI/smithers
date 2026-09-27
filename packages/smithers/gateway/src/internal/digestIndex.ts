/** Persistent scalar indexes for carried diagnosis corrections.
 * @since 1.0.0
 */

import { encodedBytes } from "./digestMemory.ts"

/** An ordinal and its optional timestamps, with cached subtree extrema.
 * @category models
 * @since 1.0.0
 */
export interface Index {
  readonly ordinal: number
  readonly start: number | undefined
  readonly end: number | undefined
  readonly left: Index | undefined
  readonly right: Index | undefined
  readonly height: number
  readonly size: number
  readonly first: number
  readonly min: number | undefined
  readonly max: number | undefined
  readonly bytes: number
}

const height = (tree: Index | undefined): number => tree?.height ?? 0
const min = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b)
const max = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b)
const node = (
  ordinal: number,
  start: number | undefined,
  end: number | undefined,
  left: Index | undefined,
  right: Index | undefined
): Index => {
  const subtreeHeight = 1 + Math.max(height(left), height(right))
  const size = 1 + (left?.size ?? 0) + (right?.size ?? 0)
  const first = left?.first ?? ordinal
  const earliest = min(start, min(left?.min, right?.min))
  const latest = max(end, max(left?.max, right?.max))
  return {
    ordinal,
    start,
    end,
    left,
    right,
    height: subtreeHeight,
    size,
    first,
    min: earliest,
    max: latest,
    bytes: (left?.bytes ?? 0) + (right?.bytes ?? 0) +
      encodedBytes([ordinal, start, end, left?.ordinal, right?.ordinal, subtreeHeight, size, first, earliest, latest])
  }
}

const rotateLeft = (tree: Index): Index => {
  const right = tree.right!
  return node(
    right.ordinal,
    right.start,
    right.end,
    node(tree.ordinal, tree.start, tree.end, tree.left, right.left),
    right.right
  )
}
const rotateRight = (tree: Index): Index => {
  const left = tree.left!
  return node(
    left.ordinal,
    left.start,
    left.end,
    left.left,
    node(tree.ordinal, tree.start, tree.end, left.right, tree.right)
  )
}
const balanced = (tree: Index): Index => {
  if (height(tree.left) > height(tree.right) + 1) {
    const left = tree.left!
    return rotateRight(
      height(left.left) < height(left.right)
        ? node(tree.ordinal, tree.start, tree.end, rotateLeft(left), tree.right)
        : tree
    )
  }
  if (height(tree.right) > height(tree.left) + 1) {
    const right = tree.right!
    return rotateLeft(
      height(right.right) < height(right.left)
        ? node(tree.ordinal, tree.start, tree.end, tree.left, rotateRight(right))
        : tree
    )
  }
  return tree
}

/** Inserts or replaces scalar evidence without changing an earlier index.
 * @category constructors
 * @since 1.0.0
 */
export const set = (
  tree: Index | undefined,
  ordinal: number,
  start?: number,
  end?: number
): Index => {
  if (tree === undefined) return node(ordinal, start, end, undefined, undefined)
  if (ordinal === tree.ordinal) return node(ordinal, start, end, tree.left, tree.right)
  return balanced(
    ordinal < tree.ordinal
      ? node(tree.ordinal, tree.start, tree.end, set(tree.left, ordinal, start, end), tree.right)
      : node(tree.ordinal, tree.start, tree.end, tree.left, set(tree.right, ordinal, start, end))
  )
}

/** Removes one ordinal, keeping earlier index versions valid.
 * @category constructors
 * @since 1.0.0
 */
export const remove = (tree: Index | undefined, ordinal: number): Index | undefined => {
  if (tree === undefined) return undefined
  if (ordinal < tree.ordinal) {
    return balanced(node(tree.ordinal, tree.start, tree.end, remove(tree.left, ordinal), tree.right))
  }
  if (ordinal > tree.ordinal) {
    return balanced(node(tree.ordinal, tree.start, tree.end, tree.left, remove(tree.right, ordinal)))
  }
  if (tree.left === undefined) return tree.right
  if (tree.right === undefined) return tree.left
  let next = tree.right
  while (next.left !== undefined) next = next.left
  return balanced(node(next.ordinal, next.start, next.end, tree.left, remove(tree.right, next.ordinal)))
}
