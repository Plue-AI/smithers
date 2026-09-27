import { ChatComposer } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { KeyboardEvent } from "react"
import { useId,useRef,useState } from "react"
import { useController } from "./ControllerContext"
import * as PromptQueue from "@smthrs/rpc/PromptQueue"
import { promptQueueScope } from "./state/PromptQueue"
import { flowAction, flowProps } from "./flows/FlowAction"
import { actionForKey } from "./flows/SearchQuery"
import type { PaletteDecision,PaletteRow } from "./SearchPalette"
import { paletteKey,PaletteOverlay,paletteRows } from "./SearchPalette"

/** Stable Playwright handle; spread past ChatComposer's excess-property check. */
const COMPOSER_INPUT_TEST_ID: Record<string, string> = { "data-testid": "composer-input" }

/* Send and Stop are `chat.send` and `chat.stop`'s doors, named through
 * ChatComposer's own pass-through props. The names come from `flowProps`, so
 * the registry — not this file — decides that they exist. */

/** The Send button's flow binding, and Playwright's handle on it. */
const COMPOSER_SEND_PROPS = { ...flowProps("chat.send"), "data-testid": "composer-send" }

/** The Stop button is `chat.stop`'s door. */
const COMPOSER_STOP_PROPS = flowProps("chat.stop")

/*
 * The composer, and everything a keystroke touches.
 *
 * §hot path: the draft is the ONE piece of session state that changes per
 * character, and it used to be read by the shell — so every keystroke
 * re-rendered App, and App renders the entire transcript. The draft
 * subscription lives HERE instead, behind the shell's draft-less projection,
 * so typing re-renders this subtree and nothing above it. The slash menu is
 * part of the same hot path (it is a function of the draft) and moved with it.
 *
 */
export function Composer({
  typing,
  autoFocus,
  placeholder
}: {
  readonly typing: boolean
  readonly autoFocus: boolean
  readonly placeholder: string
}) {
  const controller = useController()
  const paletteId = useId()
  const { collections } = controller.store
  const { data: draftRows } = useLiveQuery((q) =>
    q
      .from({ session: collections.sessions })
      .select(({ session }) => ({
        id: session.id,
        draft: session.draft,
        queuedPrompts: session.queuedPrompts,
        promptQueuePaused: session.promptQueuePaused,
        activeWorkspaceId: session.activeWorkspaceId,
        activeBranchId: session.activeBranchId,
        activeTabId: session.activeTabId,
        activeRepoKey: session.activeRepoKey,
        paletteOpen: session.paletteOpen,
        paletteActionsRef: session.paletteActionsRef
      }))
  )
  /*
   * The overlay's highlight: presentation state keyed by the draft and the
   * actions panel, so a new query or a new level starts at the first row.
   * `dismissed` is the slash tree's own Escape (the draft stays, the menu
   * hides until the draft changes), which the palette's Escape reuses.
   */
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [slashMenu, setSlashMenu] = useState<{ draft: string; index: number; dismissed: boolean; resultSelected?: boolean; moved?: boolean }>({
    draft: "",
    index: 0,
    dismissed: false
  })
  const queued = PromptQueue.inScope(draftRows[0]?.queuedPrompts ?? [], promptQueueScope(controller.store.session()))
  const queuePaused = draftRows[0]?.promptQueuePaused === true
  const draft = draftRows[0]?.draft ?? controller.store.session().draft
  const paletteOpen = draftRows[0]?.paletteOpen ?? controller.store.session().paletteOpen ?? false
  // Focus as part of the opening commit; waiting for an animation frame lets
  // the next character reach a shell shortcut. Do not refocus on draft edits.
  const focusedOpen = useRef(false)
  const bindInput = (node: HTMLTextAreaElement | null) => {
    inputRef.current = node
    if (!paletteOpen) focusedOpen.current = false
    else if (node && !focusedOpen.current) {
      focusedOpen.current = true
      node.focus()
    }
  }
  const actionsRef = draftRows[0]?.paletteActionsRef ?? controller.store.session().paletteActionsRef ?? null
  const [wasOpen, setWasOpen] = useState(paletteOpen)
  if (wasOpen !== paletteOpen) {
    setWasOpen(paletteOpen)
    setSlashMenu({ draft: "", index: 0, dismissed: false })
  }

  const slashQuery = draft.startsWith("/") && !draft.slice(1).includes(" ")
    ? draft.slice(1).toLowerCase()
    : undefined
  /*
   * §5.2: the listing used to be suppressed for the whole duration of a turn,
   * which made `typing -> chat.stop` — the first clause of the recommendation
   * order — unreachable in the shipped UI, and left the composer with no way
   * to invoke any flow mid-turn. Submission and the menu now both stay usable.
   */
  /*
   * ONE palette (Search and Command Palette Spec 2026-09-07 §1): the slash
   * tree (registry.slashTree) is its `/` mode, unchanged — a bare "/" lists
   * the surface switches, the recommendations, and one row per namespace;
   * opening a namespace rewrites the draft to `/ns.` so the branch is the
   * listing and Backspace / ArrowLeft walk back up. Every other prefix, and
   * Cmd+K on any draft, reads the search seam's rows (SearchPalette.tsx).
   */
  const slashRows = slashQuery === undefined ? [] : controller.slashTree(slashQuery)
  const overlayKey = `${draft}\u0000${actionsRef ?? ""}`
  const slashMenuLive = slashMenu.draft === overlayKey ? slashMenu : { draft: overlayKey, index: 0, dismissed: false }
  const overlayWanted = paletteOpen || slashQuery !== undefined
  const answer = overlayWanted ? controller.searchPalette(draft) : undefined
  const rows = answer === undefined ? undefined : paletteRows(answer, slashRows, actionsRef, true)
  const slashOpen = rows !== undefined && !slashMenuLive.dismissed
  const slashHighlighted = rows === undefined ? 0 : Math.max(0, Math.min(slashMenuLive.index, rows.rows.length - 1))
  /* The branch the draft is inside (`/tab.` → "tab"), when it is exactly one. */
  const slashBranch = slashQuery !== undefined && /^[a-z0-9_-]+\.$/.test(slashQuery)
    ? slashQuery.slice(0, -1)
    : undefined

  const runSlashCommand = (name: string, sourceDraft = draft): void => {
    setSlashMenu({ draft: "", index: 0, dismissed: false })
    controller.changeDraft("")
    controller.closePalette(sourceDraft)
    controller.runCommand(name)
  }

  /* Opening a namespace is a draft edit, never a command: the branch is the listing. */
  const openNamespace = (id: string): void => {
    setSlashMenu({ draft: `/${id}.\u0000`, index: 0, dismissed: false })
    controller.changeDraft(`/${id}.`)
  }

  /** A palette decision (SearchPalette.paletteKey) performed through the controller. */
  const perform = (decision: PaletteDecision, sourceDraft = draft): boolean => {
    const sourceKey = sourceDraft === draft ? overlayKey : `${sourceDraft}\u0000${controller.store.session().paletteActionsRef ?? ""}`
    switch (decision.kind) {
      case "none":
        return false
      case "send":
        // Use the button's form submission, including its empty/busy guard.
        inputRef.current?.form?.requestSubmit()
        inputRef.current?.focus()
        return true
      case "move":
        setSlashMenu({ draft: sourceKey, index: decision.index, dismissed: false, resultSelected: decision.resultSelected, moved: true })
        return true
      case "open-namespace":
        openNamespace(decision.id)
        return true
      case "root":
        setSlashMenu({ draft: "/\u0000", index: 0, dismissed: false })
        controller.changeDraft("/")
        return true
      case "run-flow":
        runSlashCommand(decision.name, sourceDraft)
        return true
      case "run-action": {
        // Enter opens the item; the draft was its query, so it clears as the slash menu's does, and the overlay closes remembering it.
        setSlashMenu({ draft: "", index: 0, dismissed: false })
        controller.notePaletteItemOpened(decision.item)
        controller.changeDraft("")
        controller.closePalette(sourceDraft)
        controller.runCommand(decision.action.flow, decision.action.args)
        return true
      }
      case "run-mode-flow":
        setSlashMenu({ draft: "", index: 0, dismissed: false })
        controller.changeDraft("")
        controller.closePalette(sourceDraft)
        if (decision.rest === "") controller.runCommand(decision.flow)
        else controller.runCommand(decision.flow, decision.rest)
        return true
      case "actions":
      case "close-actions":
        controller.runCommand("palette.actions", decision.ref)
        return true
      case "set-draft":
        setSlashMenu({ draft: `${decision.draft}\u0000`, index: 0, dismissed: false })
        controller.changeDraft(decision.draft)
        return true
      case "close":
        // Dismiss only the overlay; paletteOpen also holds the composer open.
        setSlashMenu({ draft: sourceKey, index: sourceDraft === draft ? slashHighlighted : 0, dismissed: true })
        if (!decision.overlayOnly) controller.closePalette(sourceDraft)
        return true
    }
  }

  const chooseRow = (row: PaletteRow): void => {
    if (row.kind === "ask") {
      perform({ kind: "send" })
      return
    }
    if (row.kind === "slash") {
      if (row.row.kind === "namespace") openNamespace(row.row.namespace.id)
      else runSlashCommand(row.row.flow.name)
      return
    }
    if (row.kind === "help") {
      perform({ kind: "set-draft", draft: row.row.prefix })
      return
    }
    if (row.kind === "action") {
      perform({ kind: "run-action", action: row.action, item: row.item })
      return
    }
    const action = actionForKey(row.item, "open")
    if (action !== undefined) perform({ kind: "run-action", action, item: row.item })
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.altKey && !event.ctrlKey && !event.metaKey && event.key === "Enter") {
      event.preventDefault()
      if (event.repeat) return
      const text = controller.store.session().draft.trim()
      if (text !== "") controller.runCommand("chat.queue", text)
      return
    }
    if (event.altKey && event.key === "ArrowUp") {
      event.preventDefault()
      controller.runCommand("chat.queue.restore")
      return
    }
    if (event.key === "Enter" && event.shiftKey) return
    // Capture owns this Escape; leave the palette and Chat available below it.
    if (event.key === "Escape" && controller.store.session().dictating) {
      event.preventDefault()
      controller.cancelDictation()
      return
    }
    // Input can arrive before the live-query render catches up. Keyboard
    // decisions must use the text under the caret, never the previous menu.
    const inputDraft = event.currentTarget.value
    const changed = inputDraft !== draft
    const inputQuery = inputDraft.startsWith("/") && !inputDraft.slice(1).includes(" ") ? inputDraft.slice(1).toLowerCase() : undefined
    const inputSlashRows = changed ? (inputQuery === undefined ? [] : controller.slashTree(inputQuery)) : slashRows
    const inputSession = controller.store.session()
    const inputWanted = changed ? inputSession.paletteOpen || inputQuery !== undefined : slashOpen
    const inputAnswer = changed ? (inputWanted ? controller.searchPalette(inputDraft) : undefined) : answer
    const inputRows = changed ? (inputAnswer === undefined ? undefined : paletteRows(inputAnswer, inputSlashRows, inputSession.paletteActionsRef ?? null, true)) : rows
    if (!inputWanted || inputAnswer === undefined || inputRows === undefined) {
      if (event.key === "Escape") {
        if (typing) {
          event.preventDefault()
          controller.runCommand("chat.stop")
        } else controller.closePalette(inputDraft)
      }
      return
    }
    /*
     * `/model` names a hidden door outright while the menu lists its namespace,
     * so the first row is another flow; Enter used
     * to run that row and open a form nobody asked for. The whole name wins
     * unless the person moved the highlight to a row of their own.
     */
    const outright = inputAnswer.parsed.mode === "flows" && inputQuery !== undefined && inputQuery !== "" &&
        !inputSlashRows.some((row) => row.kind === "flow" && row.flow.name.toLowerCase() === inputQuery) &&
        controller.commands.find(inputQuery) !== undefined
      ? inputQuery
      : undefined
    const decision = paletteKey({
      key: event.key,
      meta: event.metaKey || event.ctrlKey,
      shift: event.shiftKey,
      draft: inputDraft,
      answer: inputAnswer,
      rows: inputRows,
      highlighted: changed ? 0 : slashHighlighted,
      resultSelected: !changed && slashMenuLive.resultSelected === true,
      outright,
      moved: !changed && slashMenuLive.moved === true,
      slashBranch: changed ? (inputQuery !== undefined && /^[a-z0-9_-]+\.$/.test(inputQuery) ? inputQuery.slice(0, -1) : undefined) : slashBranch
    })
    const performed = perform(decision, inputDraft)
    if (performed) {
      // Chat and its root palette are one dialog. The guide closes both on
      // release; slash and action menus own their dismissal before Chat.
      if (event.key === "Escape" && decision.kind === "close" && inputAnswer.parsed.mode !== "flows") {
        controller.closePalette(inputDraft)
      }
      event.preventDefault()
      return
    }
    if (event.key !== "Enter") return
    /*
     * A declined Enter in the `/` mode is a slash command with its arguments
     * (`/implement fix it`): the slash tree never owned it, so it reaches
     * onSubmit (chat.send) as it did before the overlay existed, and the
     * overlay closes behind it. Explicit search modes with no available act
     * consume Enter; bare prose has already taken the button's submit path.
     */
    if (inputAnswer.parsed.mode === "flows") {
      // Hidden flows stay out of the menu, but a human may still invoke their
      // exact registered name. Frame gestures and menu toggles use this path:
      // hidden means unlisted, never nonexistent or unreachable by keyboard.
      if (inputQuery !== undefined && inputSlashRows.length === 0) {
        if (controller.commands.find(inputQuery) !== undefined) {
          runSlashCommand(inputQuery, inputDraft)
        }
        event.preventDefault()
        return
      }
      controller.closePalette(inputDraft)
      return
    }
    event.preventDefault()
  }

  return (
    <>
      {slashOpen && answer !== undefined && rows !== undefined ?
        (
          <PaletteOverlay
            id={paletteId}
            answer={answer}
            rows={rows}
            highlighted={slashHighlighted}
            slashBranch={slashBranch}
            onHighlight={(index) => setSlashMenu({ draft: overlayKey, index, dismissed: false, moved: true })}
            onChoose={chooseRow}
          />
        ) :
        null}
      {/* §6.1: Send and Stop run registered flows, so they carry the law's marker. */}
      <ChatComposer
        className="smithers-composer"
        value={draft}
        onValueChange={controller.changeDraft}
        onSubmit={() => {
          // The input transition is synchronous; its React projection can lag.
          controller.runCommand("chat.send", controller.store.session().draft.trim())
        }}
        onStop={() => controller.runCommand("chat.stop")}
        submitWhileBusy
        actions={<button type="button" className="composer-queue-action" disabled={draft.trim() === ""}
          aria-keyshortcuts="Alt+Enter" {...flowProps("chat.queue")}
          onClick={() => {
            const text = controller.store.session().draft.trim()
            if (text !== "") controller.runCommand("chat.queue", text)
          }}>Queue</button>}
        placeholder={placeholder}
        lifecycleStatus={typing ? "submitted" : "ready"}
        submitProps={COMPOSER_SEND_PROPS}
        stopProps={COMPOSER_STOP_PROPS}
        textareaProps={{ ref: bindInput, autoFocus, onKeyDown: onComposerKeyDown, ...COMPOSER_INPUT_TEST_ID,
          role: "combobox", "aria-autocomplete": "list", "aria-haspopup": "listbox",
          "aria-expanded": slashOpen,
          "aria-controls": slashOpen ? paletteId : undefined,
          "aria-activedescendant": slashOpen && rows?.rows[slashHighlighted] ? `${paletteId}-option-${slashHighlighted}` : undefined,
        }}
      />
      {queued.length > 0 && <section className="prompt-queue" aria-label="Queued prompts">
        <div className="prompt-queue-heading"><span>{queuePaused ? "Paused" : "Queued"} · {queued.length}</span>
          {queuePaused && <button type="button" {...flowAction(controller.runCommand, "chat.queue.resume")}>Resume</button>}
        </div>
        <ol>{queued.map(prompt => <li key={prompt.id}>
          <span className="prompt-queue-text">{prompt.text}</span>
          <button type="button" aria-label={`Edit queued prompt: ${prompt.text}`} {...flowAction(controller.runCommand, "chat.queue.edit", prompt.id)}>Edit</button>
          <button type="button" aria-label={`Remove queued prompt: ${prompt.text}`} {...flowAction(controller.runCommand, "chat.queue.remove", prompt.id)}>Remove</button>
        </li>)}</ol>
      </section>}
    </>
  )
}
