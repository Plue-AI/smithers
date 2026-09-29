/*
 * The search and command palette (Search and Command Palette Spec 2026-09-07
 * §1, §3, §9): ONE overlay anchored above the composer at composer width,
 * never a takeover (THE EMBED LAW). The slash tree is its `/` mode,
 * unchanged; every other prefix lists the seam's rows grouped as the ranking
 * left them; `→` opens the actions panel for the
 * highlighted item, whose rows are registered flows. The composer's draft IS
 * the query, so closing the overlay never touches the draft (§3 Esc).
 *
 * This file is the overlay's projection and its keyboard contract as data:
 * the Composer owns the textarea and calls `paletteKey` on each keydown,
 * then performs the decision it returns through the controller. Nothing here
 * owns application state; the open state and the actions panel live on the
 * session row, and the highlight is presentation state the composer keeps.
 */
import type { SearchAction, SearchItem } from "@smthrs/rpc/Cards"
import type { CatalogItem } from "./flows/Commands"
import { Sparkles } from "lucide-react"
import { Fragment, useCallback, useId } from "react"
import type { SlashRow } from "./flows/registry"
import { actionForKey, prefixRow } from "./flows/SearchQuery"
import type { PrefixRow } from "./flows/SearchQuery"
import type { PaletteAnswer } from "./state/seams/SearchSeam"
import { dynamicFlowProps } from "./flows/FlowAction"

/** One selectable row of the overlay. */
export type PaletteRow =
  | { readonly kind: "slash"; readonly row: SlashLeafRow }
  | { readonly kind: "item"; readonly item: SearchItem; readonly group: string; readonly recommended: boolean }
  | { readonly kind: "action"; readonly action: SearchAction; readonly item: SearchItem }
  | { readonly kind: "help"; readonly row: PrefixRow & { readonly available: boolean } }
  /* "Ask Smithers": the composer itself, the first row of an empty ⌘K (onboarding SCRIPT v4, open decision). */
  | { readonly kind: "ask" }

/** The overlay's rows for one draft, plus where each group starts. */
export interface PaletteRows {
  readonly rows: ReadonlyArray<PaletteRow>
  readonly groups: ReadonlyArray<{ readonly label: string; readonly start: number }>
  /** The item whose actions panel is showing, when it is among the current rows. */
  readonly actionsFor?: SearchItem
}

/** A slash row the overlay lists as a choice: a note is a caption, not a row. */
export type SlashLeafRow = Exclude<SlashRow<CatalogItem>, { readonly kind: "note" }>

export const paletteRows = (answer: PaletteAnswer, slashRows: ReadonlyArray<SlashRow<CatalogItem>>, actionsRef: string | null, ask = false): PaletteRows => {
  const shown = paletteRowsOf(answer, slashRows, actionsRef)
  // Bare prose stays a question even when helper results match it.
  if (!ask || answer.parsed.mode !== "all" || shown.actionsFor !== undefined) return shown
  return { ...shown, rows: [{ kind: "ask" }, ...shown.rows], groups: shown.groups.map((group) => ({ ...group, start: group.start + 1 })) }
}

const paletteRowsOf = (answer: PaletteAnswer, slashRows: ReadonlyArray<SlashRow<CatalogItem>>, actionsRef: string | null): PaletteRows => {
  if (answer.parsed.mode === "flows") {
    // A note row is a caption over the rows that follow it, never a choice: it renders as a group label.
    const rows: Array<PaletteRow> = []
    const groups: Array<{ label: string; start: number }> = []
    for (const row of slashRows) {
      if (row.kind === "note") groups.push({ label: row.text, start: rows.length })
      else rows.push({ kind: "slash", row })
    }
    return { rows, groups }
  }
  if (answer.help !== undefined) {
    return { rows: answer.help.map((row) => ({ kind: "help", row })), groups: [] }
  }
  const items = answer.groups.flatMap((group) => group.items.map((ranked) => ({ ...ranked, group: group.label })))
  const focus = actionsRef === null ? undefined : items.find((ranked) => ranked.item.ref === actionsRef)?.item
  if (focus !== undefined) {
    return {
      rows: focus.actions.map((action) => ({ kind: "action", action, item: focus })),
      groups: [{ label: focus.title, start: 0 }],
      actionsFor: focus
    }
  }
  const rows: Array<PaletteRow> = []
  const groups: Array<{ label: string; start: number }> = []
  for (const group of answer.groups) {
    groups.push({ label: group.label, start: rows.length })
    for (const ranked of group.items) rows.push({ kind: "item", item: ranked.item, group: group.label, recommended: ranked.recommended })
  }
  return { rows, groups }
}

/** What one key does with the overlay open (§3), decided from the rows and the highlight. */
export type PaletteDecision =
  | { readonly kind: "none" }
  | { readonly kind: "move"; readonly index: number; readonly resultSelected: boolean }
  | { readonly kind: "send" }
  | { readonly kind: "open-namespace"; readonly id: string }
  | { readonly kind: "root" }
  | { readonly kind: "run-flow"; readonly name: string }
  | { readonly kind: "run-action"; readonly action: SearchAction; readonly item: SearchItem }
  | { readonly kind: "run-mode-flow"; readonly flow: string; readonly rest: string }
  | { readonly kind: "actions"; readonly ref: string }
  | { readonly kind: "close-actions"; readonly ref: string }
  | { readonly kind: "set-draft"; readonly draft: string }
  | { readonly kind: "close"; readonly overlayOnly: boolean }

export interface PaletteKeyInput {
  readonly key: string
  readonly meta: boolean
  readonly shift: boolean
  readonly draft: string
  readonly answer: PaletteAnswer
  readonly rows: PaletteRows
  readonly highlighted: number
  /** Only an ArrowDown/ArrowUp choice grants an unprefixed result Enter. */
  readonly resultSelected: boolean
  /** The draft is inside a `/ns.` branch (the slash tree's own back key). */
  readonly slashBranch: string | undefined
  /**
   * The flow the draft names OUTRIGHT (`/model`) when no row carries that name:
   * a hidden door whose namespace the menu lists instead. Enter on a whole name
   * is that flow, never the row the menu happened to lead with.
   */
  readonly outright?: string
  /** The person moved the highlight (arrows or pointer) since the draft last changed: the row is their choice. */
  readonly moved?: boolean
}

const wrap = (index: number, length: number): number => (length === 0 ? 0 : (index + length) % length)

export const paletteKey = (input: PaletteKeyInput): PaletteDecision => {
  const { key, meta, shift, rows, highlighted, answer, draft } = input
  const row = rows.rows[highlighted]
  const inActions = rows.actionsFor !== undefined
  if (key === "ArrowDown" || key === "ArrowUp") {
    const index = wrap(highlighted + (key === "ArrowDown" ? 1 : -1), rows.rows.length)
    const kind = rows.rows[index]?.kind
    return { kind: "move", index, resultSelected: kind === "item" || kind === "action" }
  }
  if (key === "Tab") return { kind: "none" }
  if (key === "Escape") {
    if (inActions && rows.actionsFor !== undefined) return { kind: "close-actions", ref: rows.actionsFor.ref }
    return { kind: "close", overlayOnly: true }
  }
  if (key === "ArrowRight") {
    if (row?.kind === "slash" && row.row.kind === "namespace") return { kind: "open-namespace", id: row.row.namespace.id }
    if (row?.kind === "item" && row.item.actions.length > 0) return { kind: "actions", ref: row.item.ref }
    return { kind: "none" }
  }
  if (key === "ArrowLeft") {
    if (inActions && rows.actionsFor !== undefined) return { kind: "close-actions", ref: rows.actionsFor.ref }
    if (input.slashBranch !== undefined) return { kind: "root" }
    return { kind: "none" }
  }
  if (key === "Backspace") {
    const { prefix, query, mode } = answer.parsed
    if (mode === "flows" || draft.trimStart().slice(prefix.length).trim() !== "" || query !== "") return { kind: "none" }
    if (prefix !== "") return { kind: "set-draft", draft: "" }
    return draft === "" ? { kind: "close", overlayOnly: false } : { kind: "none" }
  }
  if (key === "Enter" && !shift) {
    if (input.outright !== undefined && input.moved !== true) return { kind: "run-flow", name: input.outright }
    const chosen = rows.rows.length === 1 ? rows.rows[0] : row
    if (chosen?.kind === "ask" || (answer.parsed.prefix === "" && !input.resultSelected)) return { kind: "send" }
    if (chosen?.kind === "slash") {
      return chosen.row.kind === "namespace" ? { kind: "open-namespace", id: chosen.row.namespace.id } : { kind: "run-flow", name: chosen.row.flow.name }
    }
    if (chosen?.kind === "action") return { kind: "run-action", action: chosen.action, item: chosen.item }
    if (chosen?.kind === "help") return { kind: "set-draft", draft: chosen.row.prefix }
    if (chosen?.kind === "item") {
      const action = actionForKey(chosen.item, meta ? "primary" : "open")
      return action === undefined ? { kind: "none" } : { kind: "run-action", action, item: chosen.item }
    }
    // The `/` mode is the slash tree unchanged (§1, §3): with no slash row to choose, Enter is the composer's own send.
    if (answer.parsed.mode === "flows") return { kind: "none" }
    // No row to choose: the mode's flow runs with the query (signed out, that is where "Sign in to run" lands).
    if (answer.flow !== null) {
      return { kind: "run-mode-flow", flow: answer.flow, rest: draft.trimStart().slice(answer.parsed.prefix.length).trim() }
    }
    return { kind: "none" }
  }
  return { kind: "none" }
}

export interface PaletteOverlayProps {
  readonly id?: string
  readonly answer: PaletteAnswer
  readonly rows: PaletteRows
  readonly highlighted: number
  readonly slashBranch: string | undefined
  readonly onHighlight: (index: number) => void
  readonly onChoose: (row: PaletteRow) => void
}

const roleWord = (role: SearchAction["role"]): string => (role === "open" ? "Enter" : role === "primary" ? "Cmd+Enter" : "")


export function PaletteOverlay({ id, answer, rows, highlighted, slashBranch, onHighlight, onChoose }: PaletteOverlayProps) {
  const revealHighlighted = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const row = node.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!row) return
    const view = node.getBoundingClientRect()
    const option = row.getBoundingClientRect()
    // Move only this list, preserving composer focus and transcript position.
    if (option.top < view.top) node.scrollTop += option.top - view.top
    else if (option.bottom > view.bottom) node.scrollTop += option.bottom - view.bottom
  }, [highlighted, rows])
  const generatedId = useId()
  const listboxId = id ?? generatedId
  const { parsed } = answer
  const chip = parsed.mode === "flows" ? "/" : prefixRow(parsed.mode).label
  const groupAt = new Map(rows.groups.map((group) => [group.start, group.label]))
  const showHead = rows.actionsFor !== undefined || (parsed.mode !== "all" && parsed.mode !== "flows")
  /* Authored copy only: the registry's absent-door reason, the seam's fixed mode notes, or this line. */
  const absentNote = answer.refusal ?? (parsed.mode === "flows" && rows.rows.length === 0 && /^\S+$/.test(parsed.query)
    ? `There is no /${parsed.query} flow. Type / to see everything Smithers can do.` : undefined)
  return (
    <div id={listboxId} className="slash-menu" data-keyboard-pane="Search results" role="listbox" aria-label="Search palette" data-branch={slashBranch} data-mode={parsed.mode} data-testid="palette" onKeyDown={event => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isDefaultPrevented()) return
      const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      const current = options.indexOf(event.target as HTMLButtonElement)
      const delta = event.key === 'ArrowDown' || event.key === 'j' ? 1 : event.key === 'ArrowUp' || event.key === 'k' ? -1 : 0
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : delta ? Math.max(0, Math.min(options.length - 1, current + delta)) : undefined
      if (next !== undefined) { event.preventDefault(); options[next]?.focus(); onHighlight(next) }
    }}>
      {showHead ? (
        <div className="palette-head">
          <span className="palette-chip" data-testid="palette-chip">{rows.actionsFor === undefined ? chip : "actions"}</span>
          <span className="palette-query">{rows.actionsFor?.title ?? parsed.query}</span>
        </div>
      ) : null}
      <div className="slash-menu-body" ref={revealHighlighted}>
        {absentNote === undefined ? null : <p className="palette-refusal" role="status" data-testid="palette-refusal">{absentNote}</p>}
        {rows.rows.map((row, index) => {
          const label = groupAt.get(index)
          const highlightedRow = index === highlighted
          const common = {
            type: "button" as const,
            role: "option",
            id: `${listboxId}-option-${index}`,
            tabIndex: -1,
            "aria-selected": highlightedRow,
            "data-highlighted": highlightedRow ? "true" : "false",
            // Opening or reflowing the menu beneath a stationary pointer must not
            // replace the keyboard selection. Only actual pointer motion does.
            onMouseMove: () => onHighlight(index)
          }
          const heading = label === undefined ? null : <div className="palette-group" key={`group:${label}:${index}`}>{label}</div>
          if (row.kind === "slash" && row.row.kind === "namespace") {
            const { namespace, count } = row.row
            return (
              <Fragment key={`ns:${namespace.id}`}>
                {heading}
                <button {...common} data-namespace={namespace.id} className="slash-menu-item slash-menu-namespace" onClick={() => onChoose(row)}>
                  <span className="slash-menu-name">/{namespace.id} ›</span>
                  <span className="slash-menu-description">
                    {namespace.label}
                    {namespace.summary === "" ? "" : ` — ${namespace.summary}`}
                  </span>
                  <span className="slash-menu-count">{count}</span>
                </button>
              </Fragment>
            )
          }
          if (row.kind === "slash" && row.row.kind === "flow") {
            const { flow, recommended } = row.row
            return (
              <Fragment key={flow.name}>
                {heading}
                <button {...common} data-gold={recommended} {...dynamicFlowProps(flow.name)} className="slash-menu-item" onClick={() => onChoose(row)}>
                  <span className="slash-menu-name">/{flow.name}</span>
                  <span className="slash-menu-description">{flow.summary}</span>
                </button>
              </Fragment>
            )
          }
          // Unreachable (a leaf row is a namespace or a flow); it narrows `row` for the branches below.
          if (row.kind === "slash") return null
          if (row.kind === "ask") {
            return (
              <button {...common} key="ask" data-ask="" className="slash-menu-item palette-ask-row" onClick={() => onChoose(row)}>
                <span className="palette-ask-icon" aria-hidden="true"><Sparkles size={13} /></span>
                <span className="palette-ask-title">Ask Smithers</span>
              </button>
            )
          }
          if (row.kind === "help") {
            const { prefix, label: shown, searches, available } = row.row
            return (
              <button {...common} key={`help:${shown}`} data-prefix={prefix} data-available={available} className="slash-menu-item palette-help-row" onClick={() => onChoose(row)}>
                <span className="slash-menu-name">{shown}</span>
                <span className="slash-menu-description">{available ? searches : "sign in"}</span>
              </button>
            )
          }
          if (row.kind === "action") {
            const { action } = row
            return (
              <button {...common} key={`action:${action.flow}:${action.args ?? ""}`} {...dynamicFlowProps(action.flow)} data-role={action.role} className="slash-menu-item" onClick={() => onChoose(row)}>
                <span className="slash-menu-name">/{action.flow}</span>
                <span className="slash-menu-description">{action.label}</span>
                <span className="slash-menu-count">{roleWord(action.role)}</span>
              </button>
            )
          }
          const { item, recommended } = row
          const primary = actionForKey(item, "primary")
          return (
            <div key={`item:${item.kind}:${item.ref}`} className="palette-item-wrap">
              {heading}
              <button {...common} data-kind={item.kind} data-ref={item.ref} data-gold={recommended} className="slash-menu-item" onClick={() => onChoose(row)}>
                <span className="slash-menu-name">{item.kind === "flow" ? `/${item.title}` : item.title}</span>
                {item.subtitle === undefined ? null : <span className="slash-menu-description">{item.subtitle}</span>}
                {primary === undefined ? null : <span className="slash-menu-count">Cmd+Enter</span>}
              </button>
            </div>
          )
        })}
      </div>
      <div className="palette-foot" aria-hidden="true">
        <span className="palette-hint"><kbd>↑↓</kbd>Navigate</span>
        <span className="palette-hint"><kbd>↵</kbd>Select</span>
        <span className="palette-hint"><kbd>→</kbd>Actions</span>
        <span className="palette-hint palette-hint-end"><kbd>?</kbd>Prefixes</span>
        <span className="palette-hint"><kbd>esc</kbd>Close</span>
      </div>
    </div>
  )
}
