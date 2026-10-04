import { useLiveQuery } from "@tanstack/react-db"
import { useCallback,type CSSProperties } from "react"
import { useController } from "./ControllerContext"
import { KeyboardNavigation } from "./KeyboardNavigation"
import { WORDMARK } from "./Wordmark"
import { flowSelector } from "./flows/FlowAction"
import { SHORTCUT_KEYS } from "./ShortcutButton"
import { bindPressActions } from "./runtime/PressActions"
import { BranchCrumbs } from "./BranchTree"
import { catalogRepositoryOf } from "./state/RepoContext"
import { useDesign, useDesignWorldOf } from "./state/seams/DesignWorld/hooks"
import { designBranchTree, shellViewsOf } from "./state/seams/DesignWorld/shell"

const Mark = () => <pre aria-hidden="true">{WORDMARK.map((line, i) => <span key={i} style={{ "--row": i } as CSSProperties}>{line}{"\n"}</span>)}</pre>
export const SessionNavigationFallback = () => <header className="session-navigation" aria-label="Smithers"><h1 className="guide-wordmark" aria-label="Smithers" style={{ margin: 0 }}><Mark /></h1></header>

/** Mode selection is a preference; it never starts microphone capture. */
export const modeShortcut = (event: KeyboardEvent): boolean => !event.repeat && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === SHORTCUT_KEYS.mode && !(event.target as Element | null)?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')

/** `owner/repo / main / <branch> ▾`: parent crumbs go up, the last opens the branch tree. */
function Crumbs() {
  const controller = useController()
  const design = useDesign()
  const world = useDesignWorldOf(design)
  const { data: views } = useLiveQuery(shellViewsOf(design))
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const { data: repositories } = useLiveQuery(controller.store.collections.repositories)
  const repo = catalogRepositoryOf(sessions[0]?.activeRepoKey, repositories) ?? controller.repositoryFlows()?.repo ?? world.repo.repo
  const at = views.find(view => view.id === design.viewer())?.at ?? "main"
  const nodes = designBranchTree(world, at)
  return <div className="mvp-crumbs-host">
    <span className="mvp-crumb-repo">{repo}</span><span aria-hidden="true">/</span>
    <BranchCrumbs nodes={nodes} view={{ selected_branch: at }}
      onAction={(tag, input) => { controller.commands.submit({ name: tag, payload: input ?? {}, actor: "user" }) }} onView={() => {}} />
  </div>
}

/** One global logo and navigation surface. */
export function SessionNavigation() {
  const controller = useController()
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const mount = useCallback((node: HTMLElement | null) => {
    if (!node) return
    const doc = node.ownerDocument
    const root = node.closest<HTMLElement>('.session-shell') ?? node
    const toggleChat = () => {
      controller.dismissHint("chat")
      if (controller.store.session().paletteOpen) {
        controller.closePalette(controller.store.session().draft)
        doc.querySelector<HTMLButtonElement>(`.app-chat-controls ${flowSelector("chat.open")}`)?.focus()
      }
      else {
        controller.runCommand('chat.open')
        doc.querySelector<HTMLTextAreaElement>('.app-shell [data-testid="composer-input"]')?.focus()
      }
    }
    const pressActions = bindPressActions({ root,
      enabled: () => !doc.querySelector('.input-mode-menu'),
      resolveShortcut: event => {
        const key = event.key.toLowerCase()
        const action = (activate: () => void, shortcut = key) => ({
          element: [...root.querySelectorAll<HTMLElement>('[aria-keyshortcuts]')].find(button => button.getAttribute('aria-keyshortcuts')?.toLowerCase().split(' ').includes(shortcut)), activate,
        })
        if ((event.metaKey || event.ctrlKey) && !event.altKey && key === 'k') {
          if (event.shiftKey) return action(() => controller.runCommand('palette.open', controller.store.session().paletteLastQuery ?? ''))
          return action(toggleChat, event.metaKey ? 'meta+k' : 'control+k')
        }
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
        if (key === SHORTCUT_KEYS.mode) return action(() => root.querySelector<HTMLButtonElement>('[aria-haspopup="menu"][aria-keyshortcuts="m"]')?.click())
      },
    })
    return () => { pressActions() }

  }, [controller])
  return <>
    {sessions[0]?.inputMode === "vim" && <KeyboardNavigation />}
    <header className="session-navigation" aria-label="Smithers" data-keyboard-pane="Navigation" ref={mount}>
      <h1 className="guide-wordmark" aria-label="Smithers" style={{ margin: 0 }}><Mark /></h1>
      <Crumbs />
      {/* The header carries no account chrome: signed out, the login screen holds the one door (Will, 2026-10-03); signed in, Account is /account.show. */}
    </header>
  </>
}
