/**
 * Rebuildable candidate index for the compiler's existing overlap predicate.
 * Exact paths and tree prefixes share a trie keyed by case-folded segments, the
 * form FileSet.overlaps compares. Globs and wildcard strings stay conservative: their
 * exclusions and pair semantics are decided by FileSet.overlaps, never here.
 * Nothing in this index becomes persisted plan or key material.
 * @since 0.1.0
 * @private
 */

import * as FileSet from "../FileSet.ts"

interface Branch {
  readonly children: Map<string, Branch>
  readonly exact: Set<number>
  readonly trees: Set<number>
}

const branch = (): Branch => ({ children: new Map(), exact: new Set(), trees: new Set() })
const add = (target: Set<number>, values: ReadonlySet<number>): void => {
  for (const value of values) target.add(value)
}
/**
 * A Glob, or a plain string holding `*`, which `FileSet.overlaps` reads as a
 * pattern. Neither has a single trie position, so both stay conservative.
 */
const patternLike = (entry: FileSet.Entry): boolean =>
  typeof entry === "string" ? entry.includes("*") : entry._tag === "Glob"
const ordered = (values: ReadonlySet<number>): Array<number> => Array.from(values).sort((left, right) => left - right)

/**
 * Selects possible producers in declaration order; callers retain the final
 * FileSet.overlaps check for every selected pair.
 * @since 0.1.0
 * @private
 */
export const make = (produced: ReadonlyArray<ReadonlyArray<FileSet.Entry>>) => {
  const root = branch()
  const all = new Set<number>()
  const globs = new Set<number>()
  for (let owner = 0; owner < produced.length; owner++) {
    for (const entry of produced[owner]!) {
      all.add(owner)
      if (patternLike(entry)) {
        globs.add(owner)
        continue
      }
      const path = typeof entry === "string" ? entry : (entry as FileSet.TreeArtifact).path
      let current = root
      for (const segment of FileSet.folded(path).split("/")) {
        let child = current.children.get(segment)
        if (child === undefined) {
          child = branch()
          current.children.set(segment, child)
        }
        current = child
      }
      const owners = typeof entry === "string" ? current.exact : current.trees
      owners.add(owner)
    }
  }

  return (entries: ReadonlyArray<FileSet.Entry>): ReadonlyArray<number> => {
    const found = new Set<number>()
    for (const entry of entries) {
      // A glob can overlap every other glob/tree; literal matches and
      // exclusions remain the final predicate's responsibility as well.
      if (patternLike(entry)) return ordered(all)
      add(found, globs)
      const path = typeof entry === "string" ? entry : (entry as FileSet.TreeArtifact).path
      let current: Branch | undefined = root
      for (const segment of FileSet.folded(path).split("/")) {
        current = current.children.get(segment)
        if (current === undefined) break
        add(found, current.trees)
      }
      if (current === undefined) continue
      add(found, current.exact)
      if (typeof entry === "string") continue
      const stack = Array.from(current.children.values())
      while (stack.length > 0) {
        const descendant = stack.pop()!
        add(found, descendant.exact)
        add(found, descendant.trees)
        for (const child of descendant.children.values()) stack.push(child)
      }
    }
    // Original declaration order controls annotations, conflict precedence,
    // and cycle diagnostics, irrespective of trie or Set traversal order.
    return ordered(found)
  }
}
