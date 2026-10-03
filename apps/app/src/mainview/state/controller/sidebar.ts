import {  repoTreeRowId } from "../AppState"
import { normalizeTreePath } from "../seams/RepoTreeSeam"
import type { RepoTreeSeam } from "../seams/RepoTreeSeam"
import type { ControllerContext } from "./context"

/*
 * The repository tree's and workspace name's acts: the file tree's carets
 * (a cloud workspace or shared copy alike) and the workspace
 * rename. Every state change goes through the store's dispatcher with the
 * actor recorded; the server is reached only for a directory listing,
 * through the tree seam.
 */
export interface SidebarController {
  /**
   * `repo.tree <copyId>[#path]`: toggle a directory row of a working copy
   * (no path = the copy's root). The first expand loads the directory; a
   * failed row loads again; a loaded row only turns its caret.
   */
  readonly toggleRepoTree: (copyId: string, path?: string) => Promise<string | void>
}

export const createSidebarController = (ctx: ControllerContext, seam: RepoTreeSeam): SidebarController => {
  const { store } = ctx
  const { collections } = store

  const toggleRepoTree: SidebarController["toggleRepoTree"] = async (copyId, pathArg) => {
    const path = normalizeTreePath(pathArg ?? "")
    const copy = collections.workingCopies.get(copyId)
    if (copy === undefined) return `There is no working copy with id ${copyId}.`
    const row = collections.repoTree.get(repoTreeRowId(copyId, path))
    if (row !== undefined && row.expanded) {
      store.dispatch({ type: "repo-tree.toggled", actor: ctx.commandActor, copyId, path, expanded: false })
      return
    }
    if (row !== undefined && row.state !== "failed") {
      // Loaded, or a load already in flight: the caret turns and the listing shows as it is.
      store.dispatch({ type: "repo-tree.toggled", actor: ctx.commandActor, copyId, path, expanded: true })
      return
    }
    store.dispatch({ type: "repo-tree.loading", actor: ctx.commandActor, copyId, path })
    await seam.loadDirectory(copyId, path)
  }

  return { toggleRepoTree,}
}
