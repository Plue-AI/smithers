import { renderHomeCard, renderSetupCard } from "./cards/CardRenderers"
import { shownInTranscript } from "./state/ApprovalDeciders"
import {
Button,
ChatMessage,
MessageScrollerButton,
MessageScrollerContent,
MessageScrollerItem,
MessageScrollerProvider,
MessageScrollerViewport,
SmithersUiStyles
} from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react"
import { useMemo,useRef,useSyncExternalStore } from "react"
import { controllerCardActions as cardActions } from "./cards/controllerCardActions"
import { LoginScreen } from "./cards/LoginScreen"
import { CardView } from "./ChatCards"
import { Composer } from "./Composer"
import { useController } from "./ControllerContext"
import { DevtoolsPanel } from "./DevtoolsPanel"
import { ChatHint,FirstSightHint } from "./FirstSightHint"
import { dynamicFlowAction, flowProps } from "./flows/FlowAction"
import { InputModeMenu } from "./InputModeMenu"
import type { InitMessage } from "./Onboarding"
import { cloudWebHost, initMessage } from "./Onboarding"
import { GUIDE_KEYS,GuideButton } from "./onboarding/GuideButton"
import { pathRepo } from "./RepoLink"
import type { Card,Message } from "./state/AppState"
import { conversationTabIdOf,inConversation } from "./state/AppState"
import { catalogRepositoryOf } from "./state/RepoContext"
import { useCardRows,useFileCardRows,useFlowDurationRows,useTriggerListRows,useWorkflowCatalogRows } from "./state/useCardRows"
import { ConfirmDialog } from "./SurfaceChrome"
import { TranscriptMessage } from "./TranscriptMessage"
import { HOME_ENTRY_ID, ShellRail } from "./ShellRail"
import { WikiDeleteDialog } from "./WikiDeleteDialog"
import { WorldSurface } from "./WorldSurface"

type TranscriptEntry =
  | { readonly kind: "message"; readonly message: Message }
  | { readonly kind: "init"; readonly message: InitMessage }
  | { readonly kind: "card"; readonly card: Card }

const entryOrdinal = (entry: TranscriptEntry): number =>
  entry.kind === "card" ? entry.card.ordinal : entry.message.ordinal

const entryCreatedAt = (entry: TranscriptEntry): number =>
  entry.kind === "card" ? entry.card.createdAt : entry.message.createdAt

const entryId = (entry: TranscriptEntry): string => entry.kind === "card" ? entry.card.id : entry.message.id

function AppContent() {
  const controller = useController()
  const install = useSyncExternalStore(controller.installSnapshots.subscribe, controller.installSnapshots.get, controller.installSnapshots.get)
  const { collections } = controller.store
  /*
   * The transcript's order is the QUERY's order (§hot path): sorting a copy of
   * every row on every render made each keystroke O(messages log messages) on
   * top of the render it should not have caused at all. The collection sorts
   * incrementally and hands back rows already in order.
   */
  const { data: messageRows } = useLiveQuery((q) =>
    q.from({ message: collections.messages }).orderBy(({ message }) => message.ordinal)
  )
  const { data: savedSignInPrompts } = useLiveQuery(q => q.from({ receipt: collections.savedSignInPrompts }))
  /*
   * The shell reads the session WITHOUT the draft.
   *
   * The draft changes on every keystroke, and this subscription carried it —
   * so typing one character re-rendered App, and App renders the whole
   * transcript. The projection is consolidated by the query, so a draft-only
   * write produces no change here at all and the transcript stays still;
   * `Composer` below subscribes to the draft, one component deep, and is the
   * only thing a keystroke re-renders.
   */
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: collections.sessions }).select(({ session }) => ({
      id: session.id,
      phase: session.phase,
      theme: session.theme,
      surface: session.surface,
      maximizedCardId: session.maximizedCardId,
      activeBranchId: session.activeBranchId,
      devtoolsOpen: session.devtoolsOpen,
      paletteOpen: session.paletteOpen,
      dictating: session.dictating,
      inputMode: session.inputMode,
      paletteLastQuery: session.paletteLastQuery,
      resetConfirmOpen: session.resetConfirmOpen,
      verbose: session.verbose,
      activeRepoKey: session.activeRepoKey,
      repositoryEntry: session.repositoryEntry
    }))
  )
  const { data: worldDocumentRows } = useLiveQuery(collections.worldDocuments)
  const cardRows = useCardRows(collections.cards)
  const workflowCatalogs = useWorkflowCatalogRows(collections.cards)
  const triggerCatalogs = useTriggerListRows(collections.cards)
  const flowDurations = useFlowDurationRows(collections.flowDurations)
  const fileCards = useFileCardRows(collections.cards)
  const { data: identityRows } = useLiveQuery(collections.identitySessions)
  const { data: connectorRows } = useLiveQuery(collections.connectors)
  const { data: repositoryRows } = useLiveQuery(collections.repositories)
  /* The composer wrap: Cmd+K focuses the textarea inside it (the palette opens on the composer). */
  const composerWrapRef = useRef<HTMLDivElement>(null)
  const chatTriggerRef = useRef<HTMLButtonElement>(null)
  const readRequestRef = useRef(0)
  const session = sessionRows[0] ?? controller.store.session()
  /*
   * The conversation on screen (docs/LOCAL-APP.md "Tabs"): there is ONE
   * Smithers, the first tab, aware of every other one — so the conversation is
   * always main's. Rows keep their conversation stamp (a turn in flight writes
   * where it started), and this filter reads it.
   */
  const conversationTabId = conversationTabIdOf(session)
  // A recovery door is an acknowledgment only once its journal receipt exists.
  const messages = messageRows.filter((message) => inConversation(message, conversationTabId) &&
    (message.action?.flow !== "sign-in" || savedSignInPrompts.some(receipt => receipt.id === message.id)))
  const conversationRows = cardRows.filter((card) => inConversation(card, conversationTabId))
  // Admin chrome follows the same capability-filtered registry as every act.
  const isAdmin = controller.commands.find("admin.devtools") !== undefined
  const conversationCards = conversationRows.filter((card) => shownInTranscript(card, isAdmin))
  /*
   * A stable array: CardView is memoized, and re-sorting the same rows into a
   * fresh array on every render would re-render every card body regardless.
   * The Wiki pane lists the same array (WorldSurface.tsx).
   */
  const worldDocuments = useMemo(
    () => [...worldDocumentRows].sort((left, right) => left.path.localeCompare(right.path)),
    [worldDocumentRows]
  )
  /*
   * The flow registry, read once per render: the opening read counts it and
   * the shell's `data-flows` manifest names it. The registry object never
   * changes while its catalog does (admin sign-in, a repository's flow
   * leaves), so there is no identity to memoize the read on.
   */
  useLiveQuery(collections.repositoryFlows)
  const flows = controller.commands.all()
  const typing = session.phase === "responding"
  const streamingMessageId = typing ? messages[messages.length - 1]?.id : undefined
  const identity = identityRows[0]

  // The door is already mounted. Restore focus in this gesture, before the
  // user's next focus choice can be overwritten by a delayed frame.
  const focusChatDoor = (): void => { chatTriggerRef.current?.focus() }
  const dismissComposer = (): void => {
    controller.closePalette(controller.store.session().draft)
    focusChatDoor()
  }

  /** Dismiss open chrome without swallowing the original press. */
  const onShellPointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (session.paletteOpen === true && target.matches(".composer-overlay")) {
      // The backdrop's native pointer focus would otherwise blur the door
      // immediately after we restore it.
      event.preventDefault()
      dismissComposer()
    }
  }
  /*
   * One page: the chat. Auth is a conversation state, never a view — a
   * definitive signed-out answer opens the transcript
   * with the Smithers message whose action IS the one available step.
   * "Unknown" is not a definitive answer and changes nothing. "Unavailable"
   * IS one about the BUILD: a deployment with no identity seam can never
   * sign in, and pretending otherwise walked live users into empty choosers
   * and dead sign-in flows — so the state names itself up front, once,
   * derived like the rest (never stored, gone the moment a seam answers).
   *
   * Signed out on the web (docs/web-mode/PLAN.md §3) is the third definitive
   * state: the visitor reads what this is and the one act that is theirs,
   * in the shape auth.prompt renders (message + CTA bound to sign-in).
   * Only the cloud host: local keeps its opening read (sign-in is an option
   * there), and a build with no identity seam is "unavailable", not this.
   *
   * With a public catalog repository selected (the /owner/name path,
   * apps/server/PUBLIC-REPOSITORIES.md) the signed-out visitor is not gated:
   * reads and chat work, and writes render the sign-in step when needed.
   */
  /*
   * The sign-in door, named once: the hosted GitHub session is the provider
   * `github` (state/IdentityProvider.ts), and the GitHub copy, the public
   * catalog exploring and the signup are its. The owner's credentials
   * (self-host, the owned native backend) get the one `sign-in` door
   * below. Neither reads the host name: a self-hosted origin is the web app.
   * A build with no bootstrap at all (a harness) has no sign-in to offer and
   * no opening read to give; the empty transcript is the pinned behaviour.
   */
  const hasBootstrap = controller.bootstrap !== undefined
  const githubIdentity = hasBootstrap && controller.identityProvider === "github"
  const bootRepository = useMemo(() => typeof window === "undefined" ? null : pathRepo(window.location.pathname), [])
  // The catalog receipt owns admission. A build-time roster cannot classify a
  // pending/failed request, or reject a repository added since this build.
  const bootEntry = session.repositoryEntry?.repo.toLowerCase() === bootRepository?.toLowerCase()
    ? session.repositoryEntry : undefined
  const bootPending = bootRepository !== null && (bootEntry === undefined || bootEntry.phase === "pending")
  const bootUnavailable = bootEntry?.phase === "failed" && bootEntry.failureKind !== "not-public"
  const missingBootRepository = bootEntry?.phase === "failed" && bootEntry.failureKind === "not-public"
    ? bootRepository : null
  const exploringRepo = identity?.state === "signed-out" && githubIdentity
    ? catalogRepositoryOf(session.activeRepoKey, repositoryRows)
    : null
  const repositoryNotice = missingBootRepository !== null && identity?.state === "signed-out" && githubIdentity
  const publicRepositoryLinks = (bootEntry?.publicRepositories ?? [])
    .filter(repo => repo.toLowerCase() !== missingBootRepository?.toLowerCase())
    .map(repo => `- [${repo}](/${repo.toLowerCase()}/)`)
  const authMessage: Message | undefined = identity?.state === "signed-out" && hasBootstrap && !githubIdentity
    ? {
      id: "auth-state",
      role: "smithers",
      text: "Sign in to continue.",
      status: "complete",
      action: { flow: "sign-in", label: "Sign in" },
      createdAt: 0,
      ordinal: 0
    }
    : identity?.state === "signed-out" && githubIdentity
    ? bootPending ? undefined : bootUnavailable
      ? {
        id: "repository-state",
        role: "smithers",
        text: bootEntry.error ?? "The public repository catalog could not be read.",
        status: "complete",
        createdAt: 0,
        ordinal: 0
      }
      : repositoryNotice || (bootEntry?.phase !== "ready" && exploringRepo === null && !messages.some(message => message.action?.flow === "sign-in"))
      ? {
        id: "auth-state",
        role: "smithers",
        text: missingBootRepository === null
          ? "This is the Smithers web app. Sign in with GitHub to open one of your repositories and read its files here."
          : `${missingBootRepository} isn't on Smithers yet. Sign in with GitHub to open your own repositories${
            publicRepositoryLinks.length === 0 ? "." : `, or pick one below.\n\n${publicRepositoryLinks.join("\n")}`
          }`,
        status: "complete",
        action: { flow: "sign-in", label: "Sign in with GitHub" },
        createdAt: 0,
        ordinal: 0
      }
      : undefined
    // MOCK SEAM (state/seams/DesignWorld): the mounted seed stands in for the sign-in this host lacks, so the bubble stays out while it is mounted.
    : identity?.state === "unavailable" && controller.design === undefined
    ? {
      id: "auth-state",
      role: "smithers",
      text:
        "Sign-in is unavailable on this host.",
      status: "complete",
      createdAt: 0,
      ordinal: 0
    }
    : undefined

  /*
   * The one step the auth state offers, named once because it renders twice:
   * inside the message that explains it, and again as the keyboard shortcut
   * below.
   */
  const authAction = authMessage?.action

  /*
   * The hosted web app's signed-out opening is the login screen (Will,
   * 2026-10-03), in the middle of the page: the GitHub door and the email
   * door, in place of the opening message. A repository notice keeps its
   * message (it carries the catalog links) and the owner-credentials host
   * keeps its one Sign in door.
   */
  const loginScreen = authMessage?.id === "auth-state" && githubIdentity && !repositoryNotice && authMessage.action?.flow === "sign-in"

  /*
   * The opening entry: what the host registered, derived from the live
   * collections (never stored), with the repo step riding it as its action.
   * A gated auth state (signed out) still shows only itself.
   */
  const gatedByAuth = identity?.state === "signed-out"
  /*
   * HOME MOUNT (T-APP-01): the Home card (HomeView through its card file) is
   * pinned first in main's conversation. The home lane fills this slot.
   */
  const homeCard: ReactNode = renderHomeCard()
  // The login screen owns the page: no home beside its two doors.
  const home = homeCard !== null && conversationTabId === undefined && !loginScreen
  // A cloud repository opens on its Welcome actions. Selection is durable and
  // precedes that card's load, so the technical success read never flashes first.
  const repositoryOpening = session.activeRepoKey != null
  // A new conversation opens empty; the host's opening read belongs to main alone.
  // The host read is a diagnostic: local hosts show it; a cloud visitor never needs it.
  const cloudWeb = cloudWebHost(controller.bootstrap)
  const openingMessage: InitMessage | undefined = gatedByAuth || cloudWeb || repositoryOpening || conversationTabId !== undefined || home ? undefined : initMessage({
    bootstrap: controller.bootstrap,
    flowCount: flows.length,
    connectors: connectorRows,
    repositories: repositoryRows
  })
  /*
   * §2a″ (wave 12 §4): auth is a conversation STATE, and a state shows only
   * itself. Signed out, the auth message is the whole transcript. Wave 14 §1
   * removed the seeded welcome that used to sit under it, so there is no
   * longer a filler message to filter out here — the transcript is exactly
   * what the session actually said.
   */
  const mainEntries: ReadonlyArray<TranscriptEntry> = [
    ...(openingMessage === undefined ? [] : [{ kind: "init", message: openingMessage } as const]),
    ...(authMessage === undefined || loginScreen ? [] : [{ kind: "message", message: authMessage } as const]),
    ...messages.map((message): TranscriptEntry => ({ kind: "message", message })),
    // A missing URL owns this arrival; retained cards from the last repository
    // stay stored, but cannot become the requested repository's projection.
    ...(repositoryNotice ? conversationCards.filter(card => !("repo" in card.payload) || card.payload.repo === missingBootRepository) : conversationCards)
      .map((card): TranscriptEntry => ({ kind: "card", card }))
  ].sort((left, right) => {
    if (entryOrdinal(left) !== entryOrdinal(right)) return entryOrdinal(left) - entryOrdinal(right)
    return entryCreatedAt(left) - entryCreatedAt(right)
  })
  // Batches before the newest ten fold into one row; opening it is transient chrome for this conversation only.
  const transcriptKey = `${conversationTabId ?? "main"}:${session.activeRepoKey ?? ""}`

  const entries = mainEntries
  const latestEntry = entries.at(-1)
  const latestReadId = latestEntry === undefined ? undefined : entryId(latestEntry)
  const initialReadId = loginScreen ? "login" : repositoryNotice ? authMessage?.id : home ? HOME_ENTRY_ID : undefined

  // Chat stays mounted when closed.
  const composerWrap = (
    <div className="composer-wrap" data-keyboard-pane="Chat input" ref={composerWrapRef} hidden={session.paletteOpen !== true}>
      <Composer
        typing={typing}
        autoFocus={authMessage === undefined}
        placeholder="Ask Smithers to work on something…"
      />
    </div>
  )

  return (
    // data-flows is the live registry manifest (visible AND hidden names):
    // under commands-are-the-app the registry is not secret — the agent tool
    // lists it to the model — and the launch checklist verifies every
    // data-flow binding against exactly this surface.
    <div
      className="app-shell"
      data-frame-maximized={session.maximizedCardId !== null}
      data-flows={flows.map((command) => command.name).join(" ")}
      onPointerDownCapture={onShellPointerDownCapture}
      onClickCapture={event => {
        if (event.target instanceof Element && event.target.closest("button[data-flow], [data-testid=composer-send]")) readRequestRef.current += 1
      }}
      onKeyDownCapture={event => {
        // The summon chord toggles the whole composer from every pane. Item
        // actions keep their ArrowRight path inside the palette.
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
          event.preventDefault()
          event.stopPropagation()
          const current = controller.store.session()
          if (current.paletteOpen === true && !event.shiftKey) dismissComposer()
          else {
            const last = current.paletteLastQuery ?? ""
            if (event.shiftKey && last !== "") controller.runCommand("palette.open", last)
            else controller.runCommand("palette.open")
            composerWrapRef.current?.querySelector("textarea")?.focus()
          }
          return
        }
        if (event.key === "Enter" && !event.shiftKey && event.target instanceof HTMLTextAreaElement && event.target.dataset.testid === "composer-input" && event.target.value.trim()) readRequestRef.current += 1
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented) {
          if (event.key === "Escape" && session.paletteOpen === true && controller.store.session().paletteOpen !== true) focusChatDoor()
          return
        }
        if (event.key === "Escape" && event.target instanceof Element && event.target.closest(".input-mode-menu")) return
        if (event.key === "Escape" && session.paletteOpen === true) {
          event.preventDefault()
          dismissComposer()
          return
        }
        if (event.key === "Escape" && session.maximizedCardId !== null) {
          controller.runCommand("card.minimize")
          return
        }
        // The dev-tools keyboard path (§2b): unregistered for non-admins, so a no-op there.
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "d") {
          event.preventDefault()
          controller.runCommand("admin.devtools")
          return
        }
      }}
    >
      <SmithersUiStyles />

      {/* The controller mounts the control-focus dim on the document body. */}
      {/* The chrome bar: the tab strip upper-left, the repo chip and chrome actions right. */}


      <div className="app-main">

      {
        /*
         * The main tab's body IS the chat. Every tab body stays mounted; an
         * inactive one is hidden, never unmounted (docs/LOCAL-APP.md "Tabs").
         */
      }
      <div
        className="tab-body"
        data-kind="main"
        data-conversation={conversationTabId}
        data-testid="tab-body-main"
      >
      <MessageScrollerProvider key={transcriptKey} scrollAnchor="bottom"
            initialMessageId={initialReadId}
            readAnchor={{ messageId: latestReadId ?? "",
              actor: latestEntry?.kind === "message" && latestEntry.message.role === "user" ? "user" : "output",
              requestId: readRequestRef.current,
              userMessageId: messages.filter(message => message.role === "user").at(-1)?.id,
              version: latestEntry?.kind === "card" ? `${latestEntry.card.ordinal}:${latestEntry.card.kind}` : undefined }}>
      <div className="chat-frame" data-pane={session.surface === "chat" ? undefined : session.surface}>
        <div className="chat-column">
          {
            /*
             * The one available step, first in the focus ring.
             *
             * While auth is the conversation state this is the only thing a
             * visitor can do, but the message's own CTA cannot be the document's
             * first tab stop: it renders inside the transcript, and @smthrs/ui
             * wraps the transcript in a scroller viewport that carries
             * tabindex="0". That tabindex is the dependency's keyboard access to
             * a scrollable region and is not ours to delete, and moving the CTA
             * out of the message would take the action away from the state that
             * explains it. So the step renders a second time here, ahead of the
             * scroller, as the control one Tab reaches from the document. It is
             * out of flow and clipped until focused, so the page looks the same
             * and the shortcut appears exactly when it is the thing you are on.
             */
          }
          {authAction !== undefined ?
            (
              <Button
                className="auth-shortcut"
                {...dynamicFlowAction(controller.runCommand, authAction.flow)}
              >
                {authAction.label}
              </Button>
            ) :
            null}

          <div className="sui-chat-transcript smithers-transcript" data-slot="chat-transcript"
            data-repository-missing={repositoryNotice || undefined}
            data-login={loginScreen || undefined}
            data-testid="transcript" data-keyboard-pane="Conversation" role="log" aria-label="Conversation" aria-busy={typing}>
            <div data-slot="message-scroller" className="sui-msg-scroller" data-streaming={typing ? "true" : "false"}>
            <MessageScrollerViewport fade>
            <MessageScrollerContent className="sui-chat-messages">
            {install.model && install.model.steps.some(step => step.state !== "done") && renderSetupCard({
              install: controller.installSnapshots, allowed: true, view: { maximized: false }, onView: () => {},
              dispatch: (name, payload, gesture) => controller.commands.submit({ name, payload: payload ?? {}, actor: "user", gesture })
            })}
            {loginScreen && <MessageScrollerItem messageId="login" style={{ contentVisibility: "visible" }}>
              <LoginScreen onRunCommand={controller.runCommand} />
            </MessageScrollerItem>}
            {!repositoryNotice && home && <MessageScrollerItem messageId={HOME_ENTRY_ID}>{homeCard}</MessageScrollerItem>}
            {entries.map((entry) => <MessageScrollerItem key={entryId(entry)} messageId={entryId(entry)} style={{ contentVisibility: "visible" }}>
              {entry.kind === "card" ?
                (
                  <CardView
                    key={entry.card.id}
                    card={entry.card}
                    maximized={session.maximizedCardId === entry.card.id}
                    debugVerbose={session.verbose === true}
                    signedOut={identity?.state === "signed-out"}
                    admin={isAdmin}
                    worldDocuments={worldDocuments}
                    workflowCatalogs={workflowCatalogs}
                    triggerCatalogs={triggerCatalogs}
                    flowDurations={flowDurations}
                    fileCards={fileCards}
                    {...cardActions(controller, entry.card)}
                  />
                ) :
                <TranscriptMessage key={entry.message.id} entry={entry} streamingMessageId={streamingMessageId} />}
            </MessageScrollerItem>)}
            {typing && <ChatMessage role="assistant" pending pendingLabel="Smithers is responding" />}
            </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
            </div>
          </div>


        </div>

        {!repositoryNotice && session.surface === "chat" && <ShellRail entries={entries} home={home} />}

        {session.surface === "world" ?
          <WorldSurface documents={worldDocuments} /> :
          null}

        {/* Admin-only: the panel is absent — not hidden — for everyone else. */}
        {isAdmin && session.devtoolsOpen ? <DevtoolsPanel /> : null}
      </div>
      </MessageScrollerProvider>
      </div>

      {/* Card tabs; hidden while inactive, never unmounted. */}
      {/* Keep Chat reachable while a terminal or another tab owns the view. */}
      <div className="composer-overlay" data-testid="composer-overlay" hidden={session.paletteOpen !== true}>
        {composerWrap}
      </div>
      {/* The login screen owns the page: Chat's controls arrive once there is something to ask it (⌘K still opens the composer). */}
      {loginScreen ? null : <footer data-keyboard-pane="Chat controls" className="app-chat-controls" aria-label="Chat controls">
        <FirstSightHint id="chat" placement="above" content={<ChatHint />}><GuideButton ref={chatTriggerRef} shortcut={GUIDE_KEYS.chat} {...flowProps("chat.open")} onClick={() => {
          controller.runCommand("chat.open")
          // Focus an already-open input now; Composer owns focus on opening.
          composerWrapRef.current?.querySelector("textarea")?.focus()
        }}>Chat</GuideButton></FirstSightHint>
        <InputModeMenu mode={session.inputMode ?? "normal"} onChange={mode => controller.runCommand("input.mode", mode)} />
      </footer>}
      </div>

      {
        /*
         * §28.4: reset destroys the transcript with no undo, so it names what
         * goes before it goes. The count is the transcript's own, so the
         * confirm cannot claim more or less than is actually there.
         */
      }
      <ConfirmDialog
        open={session.resetConfirmOpen === true}
        title="Start a fresh conversation?"
        body={`${
          messages.length === 1 ? "1 message" : `${messages.length} messages`
        } and everything on screen will be discarded. Nothing is kept.`}
        confirmLabel="Discard and start fresh"
        destructive
        onConfirm={() => {
          controller.runCommand("admin.reset")
        }}
        onCancel={() => controller.runCommand("admin.reset.cancel")}
      />
      <WikiDeleteDialog />
    </div>
  )
}

function App() {
  return <AppContent />
}
export default App
