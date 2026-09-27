import { PtyCreateResponseSchema, PtyOutputResponseSchema } from "@smthrs/rpc/LocalApp"
import { agentRoleTitle, findAgentRole } from "@smthrs/rpc/AgentRoles"
import type { AgentRoleId } from "@smthrs/rpc/AgentRoles"
import { currentAgentRoles, loadAgents } from "./agents"
import { activeRepoOf, MAIN_TAB_ID, parseRepoSelection, repoKeyOf } from "../AppState"
import type { PinnedRepo, Repo, TabRow } from "../AppState"
import type { CommandResult } from "../../flows/Flows"
import type { ControllerContext } from "./context"
import { knowledgeCardAvailable } from "../KnowledgeFeatures"

/*
 * The local-app tabs (docs/LOCAL-APP.md "Tabs"): opening a terminal, a
 * harness, or a card in a tab; selecting and closing tabs; the `+` menu; and
 * the repository chip's data. Every state change goes through the store's
 * dispatcher with the actor recorded; the server is reached only for what
 * it owns (PTY sessions). The local repository and harness lists retired with
 * the local backend (docs/LOCAL-BACKEND-RETIREMENT.md): `repos.loaded` and
 * `harnesses.loaded` are persisted event kinds no host dispatches any more.
 */

export interface TabsController {
  /**
   * Cmd+T / the `+` menu's Terminal row / the agent's `tab.terminal [cwd]`:
   * `POST /api/pty` then a terminal tab. `cwd` names an OPEN working copy
   * (path, id, name, or pin key); absent, the active one. The server takes a
   * repository id and never a bare path, so a cwd that is not an open
   * repository is refused with the open ones listed.
   */
  readonly openTerminalTab: (cwd?: string) => Promise<string | void>
  /**
   * A `+` menu harness row: `POST /api/pty { kind: "harness", harnessId }`
   * then a harness tab. With a role (AgentRoles.ts) the role's harness and
   * model launch instead, with the task as the CLI's first prompt; the
   * result is the same tab plus the conversation's subagent card.
   */
  readonly openHarnessTab: (
    harnessId: string,
    launch?: { readonly roleId?: AgentRoleId; readonly task?: string }
  ) => Promise<string | void>
  /** `tab.read <tabId>`: another tab's recent output as text, for the agent. */
  readonly readTab: (tabId: string) => Promise<CommandResult>
  /** A maximized card's "Open in tab": one tab per card, rendering the same store record. */
  readonly openCardTab: (cardId: string) => string | void
  /** A tab id, or a 1-based position (Cmd+1..9; 1 is always main). */
  readonly selectTab: (target: string) => string | void
  /**
   * Close a tab (the active one when unnamed). A tab whose process is still
   * alive asks first; the answer is tab.close.confirm / tab.close.cancel.
   * Main never closes and never complains.
   */
  readonly closeTab: (tabId?: string) => Promise<string | void>
  readonly confirmTabClose: () => Promise<string | void>
  readonly cancelTabClose: () => void
  /** The `+` menu; with a pin key, that repository becomes the active one first (a repo row's own `+`). */
  readonly toggleTabMenu: (repoKey?: string) => Promise<string | void>
  /**
   * A sidebar repo row: the active repository, reopened first when its pin
   * is closed (a typed path where the host allows one, else the picker).
   */
  readonly selectRepo: (repoKey: string) => Promise<string | void>
  /** Forget a pinned repository; its open session and tabs stay until closed. */
  readonly unpinRepo: (repoKey: string) => string | void
  /** A `pty.exit` frame reached a tab: record the code so closing no longer asks. */
  readonly notePtyExit: (sessionId: string, code: number | null) => void
  /** The repository new terminals start in; undefined means the server's home directory. */
  readonly activeRepo: () => Repo | undefined
  /** The Cmd+T / Cmd+W / Cmd+1..9 bindings on one document; returns the uninstaller. */
  readonly installKeyboard: (target: Pick<Document, "addEventListener" | "removeEventListener">) => () => void
}

const isProcessTab = (tab: TabRow | undefined): tab is Extract<TabRow, { kind: "terminal" | "harness" }> =>
  tab?.kind === "terminal" || tab?.kind === "harness"

/** The home directory is the server's to expand; the SPA never knows it. */
const HOME_CWD = "~"

/** The emulator's geometry before the first fit; the resize seam corrects it. */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** How much of a tab's output `tab.read` hands the model: the last 16 KiB. */
export const TAB_READ_TAIL_BYTES = 16 * 1024

export const createTabsController = (ctx: ControllerContext): TabsController => {
  const { store, baseUrl } = ctx
  const { collections } = store

  const orderedTabs = (): Array<TabRow> =>
    [...collections.tabs.values()].filter(tab => tab.kind !== "card" ||
      knowledgeCardAvailable(collections.cards.get(tab.cardId)?.kind ?? "", ctx.services.features))
      .sort((left, right) => left.ordinal - right.ordinal)

  const activeTab = (): TabRow | undefined => collections.tabs.get(store.session().activeTabId ?? MAIN_TAB_ID)

  const activeRepo = (): Repo | undefined => activeRepoOf(store.session(), collections.repos.values())
  /** The pin a repository nests new tabs under (docs/LOCAL-APP.md "Tabs"). */
  const repoKeyFor = (repo: Repo | undefined): { readonly repoKey: string } | Record<never, never> =>
    repo === undefined ? {} : { repoKey: repoKeyOf(repo.path) }
  const activeRepoKey = (): { readonly repoKey: string } | Record<never, never> => repoKeyFor(activeRepo())

  const cwdOf = (repo: Repo | undefined): string => repo?.path ?? HOME_CWD
  /*
   * The tab names where its process runs. A process started with no
   * repository open lands in the home directory, and a tab that hid that
   * read as "Claude Code in the repo" while the agent sat in `~`. The
   * title says which: the repository's name, or `~`.
   */
  const tabTitleFor = (base: string, repo: Repo | undefined): string => `${base} · ${repo?.name ?? HOME_CWD}`
  const sessionRepositoryOf = (repo: Repo | undefined): { readonly repoId: string } | Record<never, never> =>
    repo === undefined ? {} : { repoId: repo.id }

  /**
   * `tab.terminal [cwd]`: the open working copy the text names — its path,
   * server id, display name, or pin key — or the refusal that lists what IS
   * open. The server resolves the authorized directory from the repository
   * id (src/bun/server.ts), so a path that is not an open repository has no
   * door here; `repo.open <path>` is the act that opens one.
   */
  const resolveCwd = (cwd: string): Repo | string => {
    const wanted = cwd.trim()
    const open = [...collections.repos.values()]
    const found = open.find((repo) =>
      repo.path === wanted || repo.id === wanted || repo.name === wanted || repoKeyOf(repo.path) === wanted
    )
    if (found !== undefined) return found
    return open.length === 0
      ? `No repository is open, so ${wanted} cannot be a terminal's directory — open it first with repo.open <path>.`
      : `${wanted} is not an open repository. Open repositories: ${
        open.map((repo) => `${repo.name} (${repo.path})`).join(", ")
      } — name one of those, or open ${wanted} first with repo.open <path>.`
  }

  const createSession = async (body: Record<string, unknown>): Promise<string> => {
    const response = await ctx.boundedFetch(`${baseUrl}/api/pty`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
    if (!response.ok) throw new Error(await ctx.errorMessageOf(response, `The server answered ${response.status}`))
    const parsed = PtyCreateResponseSchema.safeParse(await response.json())
    if (!parsed.success) throw new Error("The server's answer carried no session id")
    return parsed.data.sessionId
  }

  const openTerminalTab: TabsController["openTerminalTab"] = async (cwd) => {
    let repo: Repo | undefined
    if (cwd === undefined || cwd.trim() === "") repo = activeRepo()
    else {
      const resolved = resolveCwd(cwd)
      if (typeof resolved === "string") return resolved
      repo = resolved
    }
    let sessionId: string
    const directory = cwdOf(repo)
    try {
      sessionId = await createSession({ kind: "terminal", ...sessionRepositoryOf(repo), cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
    } catch (error) {
      return `Could not start a terminal: ${error instanceof Error ? error.message : String(error)}`
    }
    store.dispatch({
      type: "tab.opened",
      actor: ctx.commandActor,
      // The session id is the tab id: unique per process, and `tab-<id>` stays a readable test id.
      tab: { id: sessionId, kind: "terminal", title: tabTitleFor("Terminal", repo), sessionId, cwd: directory, ...repoKeyFor(repo) }
    })
  }

  const openHarnessTab: TabsController["openHarnessTab"] = async (harnessId, launch) => {
    /*
     * A role (AgentRoles.ts), built-in, names its harness and its
     * model; the server resolves the role against the same agents store to
     * the launch argv, so the renderer sends the role id and the task, never
     * argv. Its availability is the harness's.
     */
    if (launch?.roleId !== undefined && collections.agents.size === 0) await loadAgents(ctx)
    const role = launch?.roleId === undefined ? undefined : findAgentRole(launch.roleId, currentAgentRoles(store))
    if (launch?.roleId !== undefined && role === undefined) {
      return `There is no agent named ${launch.roleId}. Agents: ${currentAgentRoles(store).map((agent) => agent.id).join(", ")}.`
    }
    const wanted = role?.harness ?? harnessId
    const harness = [...collections.harnesses.values()].find((candidate) => candidate.id === wanted)
    if (harness === undefined) return `There is no harness with id ${wanted}.`
    const displayName = role === undefined ? harness.displayName : agentRoleTitle(role)
    if (harness.status === "unavailable") return `${displayName} is not available: ${harness.displayName} is not installed here.`
    if (role !== undefined && harness.status === "binary-only") {
      return `${displayName} is not available: ${harness.displayName} has no credential for ${role.model.label}.`
    }
    let sessionId: string
    const repo = activeRepo()
    const directory = cwdOf(repo)
    const task = launch?.task?.trim() ?? ""
    try {
      sessionId = await createSession({
        kind: "harness",
        ...sessionRepositoryOf(repo),
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        harnessId: harness.id,
        ...(role === undefined ? {} : { roleId: role.id }),
        ...(task === "" ? {} : { task })
      })
    } catch (error) {
      return `Could not start ${displayName}: ${error instanceof Error ? error.message : String(error)}`
    }
    store.dispatch({
      type: "tab.opened",
      actor: ctx.commandActor,
      tab: {
        id: sessionId,
        kind: "harness",
        title: tabTitleFor(displayName, repo),
        sessionId,
        harnessId: harness.id,
        ...(role === undefined ? {} : { roleId: role.id }),
        cwd: directory,
        ...repoKeyFor(repo)
      }
    })
    /*
     * The agent is a subagent of the conversation it was launched from
     * (docs/LOCAL-APP.md "Tabs"): the tab is where it runs, and this card is
     * the conversation's record of it — embedded, never a takeover — with the
     * way back to the tab. The store scopes the card to the conversation
     * that was active at the launch.
     */
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: {
        id: `agent-${sessionId}`,
        kind: "agent",
        title: displayName,
        status: "active",
        createdAt: Date.now(),
        ordinal: 0,
        payload: {
          harnessId: harness.id,
          displayName,
          ...(role === undefined ? {} : { roleId: role.id, purpose: role.purpose }),
          ...(task === "" ? {} : { task }),
          tabId: sessionId,
          sessionId,
          cwd: directory,
          phase: "running",
          exitCode: null
        }
      }
    })
  }

  /*
   * `tab.read` (docs/LOCAL-APP.md "Tabs"): Smithers is the first tab and can
   * read every other one. A process tab answers with the tail of its
   * scrollback from the server (`GET /api/pty/:id/output`), plain text,
   * bounded; a card tab answers with its payload; main is the conversation
   * the model is already in.
   */
  const readTab: TabsController["readTab"] = async (tabId) => {
    const tab = collections.tabs.get(tabId)
    if (tab === undefined) {
      const known = orderedTabs().map((candidate) => `${candidate.id} (${candidate.kind} "${candidate.title}")`)
      return `There is no tab with id ${tabId}. Open tabs: ${known.join(", ")}.`
    }
    if (tab.kind === "main") return { value: "That is this conversation — its transcript is already in your context." }
    if (tab.kind === "card") {
      const card = collections.cards.get(tab.cardId)
      if (card === undefined) return `The card behind tab ${tabId} is no longer in the conversation.`
      if (!knowledgeCardAvailable(card.kind, ctx.services.features)) return "This feature is not enabled."
      return { value: JSON.stringify({ kind: card.kind, title: card.title, status: card.status, payload: card.payload }) }
    }
    if (tab.kind === "terminal" && tab.workspaceId !== undefined) {
      return `"${tab.title}" runs inside workspace ${tab.workspaceId} in the cloud — the local PTY server holds no scrollback for it.`
    }
    let response: Response
    try {
      response = await ctx.boundedFetch(
        `${baseUrl}/api/pty/${encodeURIComponent(tab.sessionId)}/output?tail=${TAB_READ_TAIL_BYTES}`
      )
    } catch (error) {
      return `Could not read ${tab.title}: ${error instanceof Error ? error.message : String(error)}`
    }
    if (!response.ok) {
      return `Could not read ${tab.title}: ${await ctx.errorMessageOf(response, `the server answered ${response.status}`)}`
    }
    const parsed = PtyOutputResponseSchema.safeParse(await response.json())
    if (!parsed.success) return `Could not read ${tab.title}: the server's answer had no output.`
    const header = `${tab.kind} "${tab.title}" (${parsed.data.alive ? "running" : "exited"}${
      tab.exitCode === undefined || tab.exitCode === null ? "" : `, code ${tab.exitCode}`
    }) in ${tab.cwd ?? "~"}${parsed.data.truncated ? " — older output not shown" : ""}`
    return { value: parsed.data.output.trim() === "" ? `${header}\n(no output yet)` : `${header}\n${parsed.data.output}` }
  }

  const openCardTab: TabsController["openCardTab"] = (cardId) => {
    const card = collections.cards.get(cardId)
    if (card === undefined) return `There is no card with id ${cardId}.`
    if (!knowledgeCardAvailable(card.kind, ctx.services.features)) return "This feature is not enabled."
    const existing = orderedTabs().find((tab) => tab.kind === "card" && tab.cardId === cardId)
    if (existing !== undefined) {
      store.dispatch({ type: "tab.selected", actor: ctx.commandActor, id: existing.id })
    } else {
      store.dispatch({
        type: "tab.opened",
        actor: ctx.commandActor,
        tab: { id: `card-${cardId}`, kind: "card", title: card.title, cardId, ...activeRepoKey() }
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
    if (tab.kind === "card" && !knowledgeCardAvailable(collections.cards.get(tab.cardId)?.kind ?? "", ctx.services.features)) return "This feature is not enabled."
    store.dispatch({ type: "tab.selected", actor: "user", id: tab.id })
  }

  const endSession = async (tab: TabRow): Promise<string | void> => {
    if (!isProcessTab(tab)) return
    /*
     * A workspace terminal's process is a cloud workspace session: closing
     * the tab detaches, never kills. The explicit act is
     * `box.session.destroy` (lane citc).
     */
    if (tab.kind === "terminal" && tab.workspaceId !== undefined) return
    // An exited session is still listed on the server until deleted, so the
    // DELETE goes out either way; a 404 for one the server already dropped is fine.
    try {
      const response = await ctx.boundedFetch(`${baseUrl}/api/pty/${encodeURIComponent(tab.sessionId)}`, { method: "DELETE" })
      if (!response.ok && response.status !== 404) {
        throw new Error(await ctx.errorMessageOf(response, `The server answered ${response.status}`))
      }
    } catch (error) {
      return `Could not terminate ${tab.title}: ${error instanceof Error ? error.message : String(error)}. The tab is still open; close again to retry.`
    }
  }

  const finishClose = async (tab: TabRow): Promise<string | void> => {
    const error = await endSession(tab)
    if (error !== undefined) return error
    store.dispatch({ type: "tab.closed", actor: "user", id: tab.id })
  }

  const closeTab: TabsController["closeTab"] = async (tabId) => {
    const tab = tabId === undefined ? activeTab() : collections.tabs.get(tabId)
    if (tab === undefined) return tabId === undefined ? undefined : `There is no tab with id ${tabId}.`
    if (tab.kind === "main") return
    if (isProcessTab(tab) && tab.exitCode === undefined) {
      store.dispatch({ type: "tab.close.asked", actor: "user", id: tab.id })
      return
    }
    return finishClose(tab)
  }

  const confirmTabClose: TabsController["confirmTabClose"] = async () => {
    const pending = store.session().pendingTabCloseId
    if (pending === undefined || pending === null) return
    const tab = collections.tabs.get(pending)
    if (tab === undefined) {
      store.dispatch({ type: "tab.close.asked", actor: "user", id: null })
      return
    }
    return finishClose(tab)
  }

  const cancelTabClose: TabsController["cancelTabClose"] = () => {
    store.dispatch({ type: "tab.close.asked", actor: "user", id: null })
  }

  const toggleTabMenu: TabsController["toggleTabMenu"] = async (repoKey) => {
    if (repoKey !== undefined) {
      const refusal = await selectRepo(repoKey)
      if (refusal !== undefined) return refusal
      if (store.session().tabMenuOpen === true) return
    }
    const open = store.session().tabMenuOpen !== true
    store.dispatch({ type: "tab.menu.toggled", actor: ctx.commandActor, open })
  }

  const selectRepo: TabsController["selectRepo"] = async (repoKey) => {
    /*
     * Lane piper: `org/repo` and `org/repo#copyId` tokens select from the
     * inventory — the reducer validates them. A local checkout key can reopen
     * a checkout that is not currently open.
     */
    const selection = parseRepoSelection(repoKey)
    if (selection !== null && "repoId" in selection) {
      store.dispatch({ type: "repo.selected", actor: "user", id: repoKey })
      return
    }
    const pin: PinnedRepo | undefined = collections.pinnedRepos.get(repoKey)
    if (pin === undefined) return `There is no pinned repository with key ${repoKey}.`
    const open = [...collections.repos.values()].some((repo) => repoKeyOf(repo.path) === repoKey)
    if (!open) return "This host no longer opens local repositories."
    store.dispatch({ type: "repo.selected", actor: "user", id: repoKey })
  }

  const unpinRepo: TabsController["unpinRepo"] = (repoKey) => {
    if (collections.pinnedRepos.get(repoKey) === undefined) return `There is no pinned repository with key ${repoKey}.`
    store.dispatch({ type: "repo.unpinned", actor: "user", id: repoKey })
  }

  const notePtyExit: TabsController["notePtyExit"] = (sessionId, code) => {
    store.dispatch({ type: "pty.exited", actor: "system", sessionId, code })
  }

  /*
   * Cmd+T, Cmd+W, Cmd+1..9 (docs/LOCAL-APP.md "Keyboard"). The capture phase
   * so a focused terminal (whose emulator handles keydown itself) still
   * yields the chrome's shortcuts; Meta alone, because Ctrl+T/Ctrl+W are
   * keystrokes a shell owns.
   */
  const installKeyboard: TabsController["installKeyboard"] = (target) => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      const name = key === "t" ? "tab.terminal" : key === "w" ? "tab.close" : /^[1-9]$/.test(key) ? "tab.select" : undefined
      if (name === undefined) return
      event.preventDefault()
      event.stopPropagation()
      void ctx.commands.run(name, name === "tab.select" ? key : undefined)
    }
    target.addEventListener("keydown", onKeyDown, true)
    return () => target.removeEventListener("keydown", onKeyDown, true)
  }

  return {
    openTerminalTab,
    openHarnessTab,
    readTab,
    openCardTab,
    selectTab,
    closeTab,
    confirmTabClose,
    cancelTabClose,
    toggleTabMenu,
    selectRepo,
    unpinRepo,
    notePtyExit,
    activeRepo,
    installKeyboard
  }
}
