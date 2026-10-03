import { parseRepoSelection } from "../AppState"
import type { ControllerContext } from "./context"

export interface TabsController {
  /**
   * Select a repository or one of its boxes.
   */
  readonly selectRepo: (repoKey: string) => Promise<string | void>
}

export const createTabsController = (ctx: ControllerContext): TabsController => {
  const { store } = ctx

  const selectRepo: TabsController["selectRepo"] = async (repoKey) => {
    /*
     * Lane piper: `org/repo` and `org/repo#copyId` tokens select from the
     * inventory; the reducer validates them.
     */
    if (parseRepoSelection(repoKey) === null) return `There is no repository ${repoKey}.`
    store.dispatch({ type: "repo.selected", actor: "user", id: repoKey })
  }

  return {
    selectRepo,
  }
}
