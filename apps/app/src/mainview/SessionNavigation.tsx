import { useLiveQuery } from "@tanstack/react-db"
import { useCallback,type CSSProperties } from "react"
import { useController } from "./ControllerContext"
import { KeyboardNavigation } from "./KeyboardNavigation"
import { LocalAuthPanel } from "./LocalAuthPanel"
import { RegistrationStatus } from "./RegistrationStatus"
import { WORDMARK } from "./Wordmark"
import { flowAction, flowSelector } from "./flows/FlowAction"
import { GUIDE_KEYS } from "./onboarding/GuideButton"
import { bindPressActions } from "./runtime/PressActions"

const Mark = () => <pre aria-hidden="true">{WORDMARK.map((line, i) => <span key={i} style={{ "--row": i } as CSSProperties}>{line}{"\n"}</span>)}</pre>
export const SessionNavigationFallback = () => <header className="session-navigation" aria-label="Smithers"><h1 className="guide-wordmark" aria-label="Smithers" style={{ margin: 0 }}><Mark /></h1></header>

/** Mode selection is a preference; it never starts microphone capture. */
export const modeShortcut = (event: KeyboardEvent): boolean => !event.repeat && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === GUIDE_KEYS.mode && !(event.target as Element | null)?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')

/** One global logo and navigation surface. */
export function SessionNavigation() {
  const controller = useController()
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const { data: identities } = useLiveQuery(controller.store.collections.identitySessions)
  const identity = identities[0]
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
        if (key === GUIDE_KEYS.mode) return action(() => root.querySelector<HTMLButtonElement>('[aria-haspopup="menu"][aria-keyshortcuts="m"]')?.click())
      },
    })
    return () => { pressActions() }

  }, [controller])
  return <>
    {sessions[0]?.inputMode === "vim" && <KeyboardNavigation />}
    <header className="session-navigation" aria-label="Smithers" data-keyboard-pane="Navigation" ref={mount}>
      <h1 className="guide-wordmark" aria-label="Smithers" style={{ margin: 0 }}><Mark /></h1>
      {/* Signed in, the header carries no account chrome; Account is /account.show. */}
      {identity?.state !== "signed-in" && controller.commands.find("auth.sign-in") !== undefined && <div className="session-identity">
        <button type="button" className="chrome-action" data-testid="chrome-sign-in" {...flowAction(controller.runCommand, "auth.sign-in")}>
          {controller.localAuth === undefined ? "Sign in with GitHub" : "Sign in"}
        </button>
      </div>}
      {controller.localAuth !== undefined && <LocalAuthPanel auth={controller.localAuth} />}
      <RegistrationStatus />
    </header>
  </>
}
