import { MAIN_TAB_ID, parseRepoSelection } from "../AppState"
import type { TabRow } from "../AppState"
import type { ControllerContext } from "./context"
import { cardAvailable } from "../CardAvailability"

/*
 * The card tabs (docs/LOCAL-APP.md "Cards", "Open in tab"): pinning a card in
 * its own tab, selecting and closing tabs, and the repository chip's data.
 * Every state change goes through the store's dispatcher with the actor
 * recorded; nothing here reaches a server. The terminal and harness tabs, the
 * `+` menu and the PTY seams retired with the local backend
 * (docs/LOCAL-BACKEND-RETIREMENT.md, smithersai/smithers#2229).
 */

/** A box a pick may select: one that runs, or one a flow call resumes (RepoContext.repositoryBoxOf). */
const SELECTABLE_BOX: ReadonlySet<string> = new Set(["running", "suspended", "stopped"])

export interface TabsController {
  /** A maximized card's "Open in tab": one tab per card, rendering the same store record. */
  readonly openCardTab: (cardId: string) => string | void
  /** A tab id, or a 1-based position (Cmd+1..9; 1 is always main). */
  readonly selectTab: (target: string) => string | void
  /** Close a tab (the active one when unnamed); the card stays in the transcript. Main never closes and never complains. */
  readonly closeTab: (tabId?: string) => string | void
  /**
   * Select a repository or one of its boxes.
   */
  readonly selectRepo: (repoKey: string) => Promise<string | void>
  /** `box.select`: select one of a repository's boxes, then run the act that asked for the pick, once. */
  readonly selectBox: (workspaceId: string, repo?: string, flow?: string, args?: string) => Promise<string | void | { readonly value: string }>
  /** The Cmd+W / Cmd+1..9 bindings on one document; returns the uninstaller. */
  readonly installKeyboard: (target: Pick<Document, "addEventListener" | "removeEventListener">) => () => void
}

export const createTabsController = (ctx: ControllerContext): TabsController => {
  const { store } = ctx
  const { collections } = store

  const orderedTabs = (): Array<TabRow> =>
    [...collections.tabs.values()].filter(tab => tab.kind !== "card" ||
      cardAvailable(collections.cards.get(tab.cardId)?.kind ?? ""))
      .sort((left, right) => left.ordinal - right.ordinal)

  const activeTab = (): TabRow | undefined => collections.tabs.get(store.session().activeTabId ?? MAIN_TAB_ID)

  const openCardTab: TabsController["openCardTab"] = (cardId) => {
    const card = collections.cards.get(cardId)
    if (card === undefined) return `There is no card with id ${cardId}.`
    if (!cardAvailable(card.kind)) return "This feature is not enabled."
    const existing = orderedTabs().find((tab) => tab.kind === "card" && tab.cardId === cardId)
    if (existing !== undefined) {
      store.dispatch({ type: "tab.selected", actor: ctx.commandActor, id: existing.id })
    } else {
      store.dispatch({
        type: "tab.opened",
        actor: ctx.commandActor,
        tab: { id: `card-${cardId}`, kind: "card", title: card.title, cardId, ...(store.session().activeRepoKey == null ? {} : { repoKey: store.session().activeRepoKey! }) }
      })
    }
    /*
     * The transcript's copy returns to its embedded form, but that is the
     * frames controller's act (AppController composes the two): minimizing
     * here by dispatch alone left the address bar at the maximized frame,
     * so a reload restored the card maximized in the transcript AND the tab.
     */
  }

  const selectTab: TabsController["selectTab"] = (target) => {
    const position = /^[1-9]$/.test(target) ? Number(target) : undefined
    const tab = position === undefined
      ? collections.tabs.get(target)
      : orderedTabs()[position - 1]
    if (tab === undefined) {
      // A position past the strip is a no-op keystroke, not an error.
      return position === undefined ? `There is no tab with id ${target}.` : undefined
    }
    if (tab.kind === "card" && !cardAvailable(collections.cards.get(tab.cardId)?.kind ?? "")) return "This feature is not enabled."
    store.dispatch({ type: "tab.selected", actor: "user", id: tab.id })
  }

  const closeTab: TabsController["closeTab"] = (tabId) => {
    const tab = tabId === undefined ? activeTab() : collections.tabs.get(tabId)
    if (tab === undefined) return tabId === undefined ? undefined : `There is no tab with id ${tabId}.`
    if (tab.kind === "main") return
    store.dispatch({ type: "tab.closed", actor: "user", id: tab.id })
  }

  const selectRepo: TabsController["selectRepo"] = async (repoKey) => {
    /*
     * Lane piper: `org/repo` and `org/repo#copyId` tokens select from the
     * inventory; the reducer validates them.
     */
    if (parseRepoSelection(repoKey) === null) return `There is no repository ${repoKey}.`
    store.dispatch({ type: "repo.selected", actor: "user", id: repoKey })
  }

  const selectBox: TabsController["selectBox"] = async (workspaceId, repo, flow, args) => {
    const box = store.collections.cloudWorkspaces.get(workspaceId)
    if (box === undefined || (repo !== undefined && box.repoId !== repo) || !SELECTABLE_BOX.has(box.status)) return "That box is no longer available."
    if (flow === "box.select") return "box.select cannot continue into itself."
    await store.dispatch({ type: "repo.selected", actor: "user", id: `${box.repoId}#workspace:${box.id}` }).isPersisted.promise
    if (flow === undefined) return
    const outcome = await ctx.commands.run(flow, args)
    switch (outcome.status) {
      case "failed": return outcome.error
      case "unavailable": return outcome.reason
      case "unknown-command": return `/${flow} is not available here.`
      case "executed": return outcome.value === undefined ? undefined : { value: outcome.value }
      case "form": return
    }
  }

  /*
   * Cmd+W, Cmd+1..9 (docs/LOCAL-APP.md "Keyboard"). The capture phase so a
   * focused card body that handles keydown itself still yields the chrome's
   * shortcuts; Meta alone, because Ctrl+W is a keystroke an editor owns.
   */
  const installKeyboard: TabsController["installKeyboard"] = (target) => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      const name = key === "w" ? "tab.close" : /^[1-9]$/.test(key) ? "tab.select" : undefined
      if (name === undefined) return
      event.preventDefault()
      event.stopPropagation()
      void ctx.commands.run(name, name === "tab.select" ? key : undefined)
    }
    target.addEventListener("keydown", onKeyDown, true)
    return () => target.removeEventListener("keydown", onKeyDown, true)
  }

  return {
    openCardTab,
    selectTab,
    closeTab,
    selectRepo,
    selectBox,
    installKeyboard
  }
}
