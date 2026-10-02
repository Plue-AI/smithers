/*
 * The branch tree (mvp.md B.1): every conversation in the repository, by
 * where it forked from. main is the root; each stack item's branch hangs off
 * main in stack order, and scratch forks hang off the branch they forked.
 * One person's own popover over the crumbs: ↑ ↓ move, ⏎ opens, ← goes up.
 * A closed branch leaves the tree; its merged item's card still opens it.
 */
import { GitBranch } from "lucide-react"
import type { CSSProperties, ReactNode } from "react"
import { AvatarStack, Ref, StateGlyph } from "./parts"
import type { Branch, World } from "./world"

const childrenOf = (world: World, parent: string, at: string): ReadonlyArray<Branch> => {
  const order = (branch: Branch) => branch.item === undefined ? Number.MAX_SAFE_INTEGER : world.stack.indexOf(branch.item)
  return world.branches.filter(each => each.from === parent && (each.machine !== "closed" || each.id === at)).sort((a, b) => order(a) - order(b))
}

const Row = ({ world, branch, at, depth }: { readonly world: World; readonly branch: Branch; readonly at: string; readonly depth: number }): ReactNode => {
  const item = branch.item === undefined ? undefined : world.todos.find(each => each.id === branch.item)
  return (
    <>
      <li style={{ "--depth": depth } as CSSProperties}>
        <button type="button" className="mvp-tree-row" aria-current={branch.id === at ? "page" : undefined} data-mock={`tree-${branch.id}`}>
          {item === undefined ? <GitBranch size={14} className="mvp-glyph" aria-hidden="true" /> : <StateGlyph state={item.state} />}
          {item === undefined ? null : <Ref world={world} todo={item} />}
          <span className="mvp-tree-name">{branch.name}</span>
          <AvatarStack world={world} who={branch.presence.map(each => each.who)} max={3} />
        </button>
      </li>
      {childrenOf(world, branch.id, at).map(child => <Row key={child.id} world={world} branch={child} at={at} depth={depth + 1} />)}
    </>
  )
}

export const BranchTree = ({ world, at }: { readonly world: World; readonly at: string }) => (
  <nav className="mvp-tree" aria-label="Branches">
    <ol>
      <li style={{ "--depth": 0 } as CSSProperties}>
        <button type="button" className="mvp-tree-row" aria-current={at === "main" ? "page" : undefined} data-mock="tree-main">
          <GitBranch size={14} className="mvp-glyph" aria-hidden="true" /><span className="mvp-tree-name">main</span>
        </button>
      </li>
      {childrenOf(world, "main", at).map(branch => <Row key={branch.id} world={world} branch={branch} at={at} depth={1} />)}
    </ol>
  </nav>
)
