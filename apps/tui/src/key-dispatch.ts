/**
 * Key handling by layer. The app's `handleKey` tries the layers in the order
 * `keys.ts` documents for its contexts; each layer here sees only its own
 * state and the acts it may take. Every key a layer compares is registered
 * in `keys.ts` (see `test/keys.test.ts`).
 */
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import * as Form from "@smthrs/ui/flow-form"
import type { Schema } from "effect"
import type * as Activity from "./activity.ts"
import type * as Complete from "./complete.ts"
import type * as Editor from "./editor.ts"
import type * as Extension from "./extension.ts"
import * as Keys from "./keys.ts"
import * as Panels from "./panels.ts"
import * as Scrubber from "./scrubber.ts"
import type * as Subagents from "./subagents.ts"
import * as Tabs from "./tabs.ts"
import type { Tab } from "./workspace.ts"

/** A flow run's inline form for its missing input, or the answer form for a worker's ask. */
export interface FlowForm {
  readonly id: string
  readonly flow: string
  readonly fields: ReadonlyArray<Form.FormField>
  readonly draft: Record<string, Form.FieldValue>
  readonly focus: number
  readonly error?: string
  /** An ask: its whole question, one choice per line, `other…` last; `draft.answer` holds typed words. */
  readonly ask?: AskChoices
}

/** An ask's choices and the one under the cursor; without options the answer is typed. */
export interface AskChoices {
  readonly question: string
  readonly options: ReadonlyArray<string>
  /** Index into `options`; `options.length` is `other…`, where the answer is typed. */
  readonly choice: number
  /** Until then enter and numbers wait unless the cursor moved: keys typed ahead are not an answer. */
  readonly armedAt: number
  /** An arrow or tab selected the answer input or moved the cursor. */
  readonly moved?: true
  /** The chat key that opened the form; until answer selection, typing returns it to the chat. */
  readonly lead?: string
}

/** The answer form's lines under the question: the options, then `other…`; none when the answer is typed. */
export const choices = (ask: AskChoices): ReadonlyArray<string> =>
  ask.options.length === 0 ? [] : [...ask.options, "other…"]

/** Whether the answer is typed here: no options, or `other…` chosen. */
export const typed = (ask: AskChoices): boolean => ask.choice >= ask.options.length

/** The answer the form would send now, or undefined while a typed one is blank. */
export const answerOf = (ask: AskChoices, draft: FlowForm["draft"]): string | undefined => {
  if (!typed(ask)) return ask.options[ask.choice]
  const text = String(draft.answer ?? "").trim()
  return text === "" ? undefined : text
}

/** Which keys act right now, in the order `handleKey` tries them. */
export const context = (state: {
  /** The undo checklist is open. */
  readonly checklist: boolean
  readonly picker: boolean
  /** A run's full-height diff shows. */
  readonly review: boolean
  readonly inspecting: boolean
  readonly form: boolean
  readonly approvals: boolean
  /** The composer is empty. */
  readonly empty: boolean
  /** A panel shows and has the keys. */
  readonly panel: boolean
  /** The Summary overview has the keys: its tree, or a branch's cards. */
  readonly overview: boolean
  readonly completion: boolean
  readonly card: boolean
  /** A `!` command runs, or the draft starts with `!`. */
  readonly shell: boolean
  readonly turn: boolean
}): Keys.KeyContext => {
  if (state.checklist) return "checklist"
  if (state.picker) return "picker"
  if (state.review) return "review"
  if (state.inspecting) return "selection"
  if (state.form) return "form"
  if (state.approvals && state.empty) return "approval"
  if (state.overview) return "overview"
  if (state.panel) return "panel"
  if (state.completion) return "completion"
  if (state.card) return "card"
  if (state.shell) return "shell"
  if (state.turn) return "working"
  return "composer"
}

/** The terminal parser emits one Unicode code point per text key, not one UTF-16 unit. */
export const typing = (key: KeyEvent): string | undefined => {
  const typed = key.sequence
  return !key.ctrl && !key.meta && !key.option && Array.from(typed).length === 1 && typed >= " " && typed !== "\x7f"
    ? typed
    : undefined
}

/**
 * The `?` popup. Page keys scroll it; esc and `?` close it, a listed key then
 * acts, and other typing becomes `?` plus that character, so a message that
 * starts with `?` is never lost. True when the key was consumed.
 */
export const whichKeyKey = (key: KeyEvent, binding: Keys.Binding | undefined, act: {
  readonly close: () => void
  readonly type: (text: string) => void
  readonly scroll: (direction: -1 | 1) => void
}): boolean => {
  if (!key.ctrl && !key.meta && !key.option && !key.shift && (key.name === "pageup" || key.name === "pagedown")) {
    key.preventDefault()
    act.scroll(key.name === "pageup" ? -1 : 1)
    return true
  }
  act.close()
  if (key.name === "escape" || binding?.id === "keys") {
    key.preventDefault()
    return true
  }
  const typed = typing(key)
  if (binding === undefined && typed !== undefined) {
    key.preventDefault()
    act.type(`?${typed}`)
    return true
  }
  return false
}

/** The activity scrubber while a step is selected; true when the key was consumed. */
export const scrubberKey = (key: KeyEvent, activity: Activity.Activity, seq: number, act: {
  readonly follow: () => void
  readonly inspect: (seq: number) => void
}): boolean => {
  if (
    key.ctrl || key.meta || key.option ||
    !["left", "right", "up", "down", "home", "end", "escape", "return", "[", "]"].includes(key.name)
  ) return false
  key.preventDefault()
  if (key.name === "escape" || key.name === "return") {
    act.follow()
    return true
  }
  // Shift steps milestone to milestone, the way brackets do.
  const name = key.shift && key.name === "left" ? "[" : key.shift && key.name === "right" ? "]" : key.name
  const next = Scrubber.key(activity, seq, name)
  if (next !== undefined) act.inspect(next)
  return true
}

/** Arrows, and hjkl where `vim` allows them, as a direction. */
const direction = (key: KeyEvent, vim: boolean): Subagents.Direction | undefined =>
  key.name === "up" || (vim && key.name === "k")
    ? "up"
    : key.name === "down" || (vim && key.name === "j")
    ? "down"
    : key.name === "left" || (vim && key.name === "h")
    ? "left"
    : key.name === "right" || (vim && key.name === "l")
    ? "right"
    : undefined

/** A worker action's binding, whether or not the worker's status allows it now. */
const workerBinding = (key: KeyEvent): string | undefined => {
  const binding = Keys.bindingFor(key, "panel")
  return binding !== undefined && Tabs.bindings.some((each) => each.binding === binding.id) ? binding.id : undefined
}

/**
 * A focused chat card: enter opens it, esc leaves it, arrows and tab move
 * between cards. On a subagent card, `a` answers the ask it shows `a Answer`
 * for, `f` opens its files, `d` its run's diff, `u` undoes the run, and the
 * worker keys act on its worker. Anything else unfocuses it and goes on to
 * the composer; false then.
 */
export const cardKey = (key: KeyEvent, act: {
  readonly move: (direction: Subagents.Direction) => void
  readonly leave: () => void
  readonly open: () => void
  /** The focused subagent card's worker; undefined on a panel card. */
  readonly worker: Tab | undefined
  readonly workerAction: (tab: Tab, action: Tabs.ActionId) => void
  readonly files: () => void
  /** Present only when the worker settled with captured changes. */
  readonly diff?: (() => void) | undefined
  /** Present only when those changes can be undone now. */
  readonly undo?: (() => void) | undefined
  /** Present only when the card shows `a Answer`: opens its ask's answer form. */
  readonly answer?: (() => void) | undefined
}): boolean => {
  if (key.name === "return" || key.name === "kpenter") {
    key.preventDefault()
    act.leave()
    act.open()
    return true
  }
  if (key.name === "escape") {
    key.preventDefault()
    act.leave()
    return true
  }
  const moved = key.name === "tab" ? key.shift ? "previous" : "next" : direction(key, false)
  if (moved !== undefined) {
    key.preventDefault()
    act.move(moved)
    return true
  }
  const worker = act.worker
  if (worker === undefined) {
    // Anything else goes back to the composer.
    act.leave()
    return false
  }
  if (key.name === "f") {
    key.preventDefault()
    act.files()
    return true
  }
  const run = key.name === "d" ? act.diff : key.name === "u" ? act.undo : key.name === "a" ? act.answer : undefined
  if (run !== undefined) {
    key.preventDefault()
    act.leave()
    run()
    return true
  }
  const binding = workerBinding(key)
  if (binding === undefined) {
    act.leave()
    return false
  }
  key.preventDefault()
  const action = Tabs.actionFor(binding, worker)
  if (action !== undefined) act.workerAction(worker, action.id)
  return true
}

/**
 * The Summary overview: arrows or hjkl move in the pane (right leaves the
 * tree), enter opens, esc closes; `app.tsx` switches panes with tab. The
 * worker keys act on the selected worker, `x` stops a selected monitor;
 * `f` opens a card's files, `d` and `u` show and undo its run.
 */
export const overviewKey = (key: KeyEvent, state: {
  readonly pane: "tree" | "cards"
  /** The worker the keys act on: the tree's selection, or the focused card's. */
  readonly worker: Tab | undefined
  /** The selected monitor's id. */
  readonly monitor?: string | undefined
}, act: {
  readonly close: () => void
  readonly stopMonitor: (id: string) => void
  readonly release: () => void
  readonly pane: () => void
  readonly tree: (step: -1 | 1) => void
  readonly peek: () => void
  /** `a`: the selected row's form, when it waits on the person. */
  readonly answer: () => void
  /** `g`: the graph of the selected row's run forest, or back to the tree. */
  readonly graph: () => void
  readonly card: (direction: Subagents.Direction) => void
  readonly open: () => void
  readonly files: () => void
  readonly scroll: (direction: number) => void
  readonly workerAction: (tab: Tab, action: Tabs.ActionId) => void
  /** `d`: the selected worker's run diff, when it settled with captured changes. */
  readonly diff?: (() => void) | undefined
  /** `u`: undo the selected worker's run, when it can be undone now. */
  readonly undo?: (() => void) | undefined
  /** `y` and `n`: approve or deny the selected build target. */
  readonly decideTarget?: ((decision: "approve" | "deny") => void) | undefined
}) => {
  key.preventDefault()
  if (key.name === "escape") return act.close()
  if ((key.name === "y" || key.name === "n") && act.decideTarget !== undefined) {
    return act.decideTarget(key.name === "y" ? "approve" : "deny")
  }
  if (key.name === "d" && act.diff !== undefined) return act.diff()
  if (key.name === "u" && act.undo !== undefined) return act.undo()
  if (key.name === "i") return act.release()
  if (key.name === "return" || key.name === "kpenter") return act.open()
  if (key.name === "pageup" || key.name === "pagedown") return act.scroll(key.name === "pageup" ? -1 : 1)
  if (key.name === "space" && state.pane === "tree") return act.peek()
  if (key.name === "a" && state.pane === "tree") return act.answer()
  if (key.name === "g" && state.pane === "tree") return act.graph()
  const moved = direction(key, true)
  if (moved !== undefined && state.pane === "tree") {
    if (moved === "right") return act.pane()
    if (moved === "up" || moved === "down") return act.tree(moved === "up" ? -1 : 1)
    return
  }
  if (moved !== undefined) return act.card(moved)
  if (key.name === "f" && state.pane === "cards") return act.files()
  if (state.monitor !== undefined) {
    if (Keys.bindingFor(key, "panel")?.id === "stop") act.stopMonitor(state.monitor)
    return
  }
  const worker = state.worker
  const binding = worker === undefined ? undefined : workerBinding(key)
  const action = binding === undefined || worker === undefined ? undefined : Tabs.actionFor(binding, worker)
  if (action !== undefined && worker !== undefined) act.workerAction(worker, action.id)
}

/** Keys while a flow form is open; its focused input takes the typing. */
export const formKey = (key: KeyEvent, open: FlowForm, act: {
  readonly change: (next: FlowForm | undefined) => void
  readonly schema: (id: string) => Schema.Top | undefined
  readonly input: (id: string) => Record<string, unknown> | undefined
  readonly fill: (id: string, payload: Record<string, unknown>) => void
  /** Puts `text` in the chat composer. */
  readonly chat: (text: string) => void
}) => {
  if (open.ask !== undefined) return askKey(key, open, open.ask, act)
  const field = open.fields[open.focus]
  const move = (step: number) => {
    key.preventDefault()
    if (open.fields.length > 0) {
      act.change({ ...open, focus: (open.focus + step + open.fields.length) % open.fields.length })
    }
  }
  if (key.name === "escape") {
    // Closes only; the run stays parked (`a` in its tab reopens, `x` stops it).
    key.preventDefault()
    return act.change(undefined)
  }
  if ((key.name === "tab" && !key.shift) || key.name === "down") return move(1)
  if ((key.name === "tab" && key.shift) || key.name === "up") return move(-1)
  if (key.name === "space" && field?.kind === "boolean") {
    key.preventDefault()
    return act.change({
      ...open,
      draft: { ...open.draft, [field.name]: open.draft[field.name] !== true },
      error: undefined
    })
  }
  if ((key.name === "left" || key.name === "right") && field?.kind === "select" && field.options !== undefined) {
    key.preventDefault()
    const options = field.options.filter((option) => !option.disabled).map((option) => option.value)
    if (options.length === 0) return
    const at = options.indexOf(String(open.draft[field.name] ?? ""))
    const next = options[(at + (key.name === "left" ? -1 : 1) + options.length) % options.length]!
    return act.change({ ...open, draft: { ...open.draft, [field.name]: next }, error: undefined })
  }
  if (key.name === "return" || key.name === "kpenter") {
    key.preventDefault()
    const schema = act.schema(open.id)
    const input = act.input(open.id)
    if (schema === undefined || input === undefined) return act.change(undefined)
    const result = Form.fileSubmission(schema, open.fields, input, open.draft)
    if ("error" in result) return act.change({ ...open, error: result.error })
    act.change(undefined)
    act.fill(open.id, result.payload)
  }
}

/** A run's full-height diff: `u` undoes the run, esc goes back, arrows and page keys scroll. Takes every key. */
export const reviewKey = (key: KeyEvent, act: {
  /** Present only when the run can be undone now. */
  readonly undo: (() => void) | undefined
  readonly close: () => void
  /** Lines, or a half page with `page`. */
  readonly scroll: (by: number, page: boolean) => void
}) => {
  key.preventDefault()
  if (key.name === "escape") return act.close()
  if (key.name === "u") return act.undo?.()
  if (key.name === "up" || key.name === "k") return act.scroll(-1, false)
  if (key.name === "down" || key.name === "j") return act.scroll(1, false)
  if (key.name === "pageup" || key.name === "pagedown") return act.scroll(key.name === "pageup" ? -1 : 1, true)
}

/** The undo checklist: arrows move, space checks a file, enter undoes the checked ones, esc goes back. */
export const checklistKey = (key: KeyEvent, state: { readonly rows: number }, act: {
  readonly close: () => void
  readonly select: (update: (selected: number) => number) => void
  readonly toggle: () => void
  readonly undo: () => void
}) => {
  key.preventDefault()
  if (key.name === "escape") return act.close()
  const move = (step: number) => {
    if (state.rows > 0) act.select((selected) => (selected + step + state.rows) % state.rows)
  }
  if (key.name === "up") return move(-1)
  if (key.name === "down") return move(1)
  if (key.name === "space") return act.toggle()
  if (key.name === "return" || key.name === "kpenter") return act.undo()
}

/**
 * Keys in an ask's answer form: arrows or tab move the cursor, a number picks
 * its option, enter answers, esc goes back and leaves the ask open. Other
 * typing goes to `other…`. Until `armedAt`, unless the cursor moved, enter and
 * numbers wait. After the chat's `a`, typing and editing keys return to the
 * chat with that `a` until an arrow or tab selects the answer, regardless of
 * elapsed time; an editing key then edits it there.
 */
const askKey = (key: KeyEvent, open: FlowForm, ask: AskChoices, act: {
  readonly change: (next: FlowForm | undefined) => void
  readonly fill: (id: string, payload: Record<string, unknown>) => void
  readonly chat: (text: string) => void
}) => {
  const lines = choices(ask).length
  const armed = ask.moved === true || Date.now() >= ask.armedAt
  const choose = (choice: number) => {
    key.preventDefault()
    act.change({ ...open, ask: { ...ask, choice, moved: true }, error: undefined })
  }
  if (key.name === "escape") {
    key.preventDefault()
    return act.change(undefined)
  }
  if (key.name === "return" || key.name === "kpenter") {
    key.preventDefault()
    const answer = answerOf(ask, open.draft)
    if (answer === undefined || !armed) return
    act.change(undefined)
    return act.fill(open.id, { answer })
  }
  const char = typing(key)
  if (char !== undefined) {
    const picked = /^[1-9]$/.test(char) && armed && !typed(ask)
      ? ask.options[Number(char) - 1]
      : undefined
    if (picked !== undefined) {
      key.preventDefault()
      act.change(undefined)
      return act.fill(open.id, { answer: picked })
    }
    if (ask.lead !== undefined && ask.moved !== true) {
      key.preventDefault()
      act.change(undefined)
      return act.chat(`${ask.lead}${char}`)
    }
    // The focused input takes the rest.
    if (typed(ask)) return
    key.preventDefault()
    return act.change({
      ...open,
      draft: { ...open.draft, answer: `${String(open.draft.answer ?? "")}${char}` },
      ask: { ...ask, choice: ask.options.length },
      error: undefined
    })
  }
  // The form keeps the keys that select an answer or scroll its question.
  const kept = ["tab", "down", "up", "pageup", "pagedown"].includes(key.name)
  if (ask.lead !== undefined && ask.moved !== true && !kept) {
    // The chat's input is focused again before this key reaches it, so the key edits the `a`.
    act.change(undefined)
    return act.chat(ask.lead)
  }
  if (lines === 0) {
    if (key.name === "tab" || key.name === "down" || key.name === "up") return choose(0)
    return
  }
  if ((key.name === "tab" && !key.shift) || key.name === "down") return choose(Math.min(lines - 1, ask.choice + 1))
  if ((key.name === "tab" && key.shift) || key.name === "up") return choose(Math.max(0, ask.choice - 1))
}

/** Keys while a dialog is open: its filter input takes the typing, these move and pick. */
export const dialogKey = (key: KeyEvent, open: { readonly kind: string; readonly selected: number }, state: {
  readonly rows: number
  /** The composer still has focus: the dialog's input has not mounted yet. */
  readonly composerFocused: boolean
}, act: {
  readonly close: () => void
  readonly select: (update: (selected: number) => number) => void
  readonly type: (text: string) => void
  /** Picks the row at `index`, if there is one. */
  readonly pick: (index: number) => void
}) => {
  const { rows } = state
  const move = (step: number) => {
    key.preventDefault()
    if (rows > 0) act.select((selected) => (selected + step + rows) % rows)
  }
  if (key.name === "escape") return act.close()
  // Typing that arrives before the dialog's input mounts would reach the still-focused composer.
  const typed = typing(key)
  if (state.composerFocused && open.kind !== "stop" && typed !== undefined) {
    key.preventDefault()
    return act.type(typed)
  }
  if (key.name === "up" || (key.ctrl && key.name === "p")) return move(-1)
  if (key.name === "down" || (key.ctrl && key.name === "n")) return move(1)
  if (key.name === "pageup") return move(-Math.min(10, open.selected))
  if (key.name === "pagedown") return move(Math.min(10, rows - 1 - open.selected))
  if (key.name === "return" || key.name === "kpenter") {
    key.preventDefault()
    act.pick(open.selected)
  }
}

/** Keys while the completion menu is open; true when the menu took the key. */
export const menuKey = (key: KeyEvent, open: Complete.Completion, act: {
  readonly select: (update: (index: number) => number) => void
  readonly dismiss: () => void
  /** Inserts the selected item; `run` also submits a whole command. */
  readonly accept: (run: boolean) => void
}): boolean => {
  const count = open.items.length
  const move = (step: number) => {
    key.preventDefault()
    if (count > 0) act.select((index) => (index + step + count) % count)
    return true
  }
  if (key.name === "up" || (key.ctrl && key.name === "p")) return move(-1)
  if (key.name === "down" || (key.ctrl && key.name === "n")) return move(1)
  if (key.name === "escape") {
    key.preventDefault()
    act.dismiss()
    return true
  }
  if (count === 0) return false
  if (key.name === "tab" && !key.shift) {
    key.preventDefault()
    act.accept(false)
    return true
  }
  if ((key.name === "return" || key.name === "kpenter") && !key.shift && !key.meta && !key.option) {
    key.preventDefault()
    act.accept(true)
    return true
  }
  return false
}

/** Keys while a panel has focus. Worker letters are handled by the composer first. */
export const panelKey = (key: KeyEvent, panel: Panels.Panel, state: {
  readonly surface: string
  readonly navigation: Panels.Navigation
  /** The shown worker tab, whose actions are its own keys. */
  readonly worker: Tab | undefined
  readonly flow: { readonly retry: boolean; readonly continue: boolean; readonly stop: boolean }
}, act: {
  /** Back to the chat. */
  readonly close: () => void
  /** Keys back to the composer, the panel still shown. */
  readonly release: () => void
  readonly retryRun: (id: string) => void
  /** Approves a parked run's open request and resumes it. */
  readonly continueRun: (id: string) => void
  readonly cancelRun: (id: string) => void
  readonly fillRun: (id: string) => void
  /** Undo the chat turn of the selected Summary row. */
  readonly undo: (row: Panels.Row | undefined) => void
  readonly scroll: (direction: number) => void
  readonly navigate: (update: (current: Panels.Navigation) => Panels.Navigation) => void
  /** An agent-written prompt, sent as text. */
  readonly send: (prompt: string) => void
  readonly perform: (action: Extension.Action) => void
}) => {
  const { surface, navigation } = state
  if (state.worker !== undefined && typing(key) !== undefined) return act.release()
  key.preventDefault()
  if (key.name === "escape") return act.close()
  if (key.name === "i") return act.release()
  if (key.name === "r" && surface.startsWith("flow:") && state.flow.retry) return act.retryRun(surface.slice(5))
  if (key.name === "c" && surface.startsWith("flow:") && state.flow.continue) return act.continueRun(surface.slice(5))
  if (key.name === "x" && surface.startsWith("flow:") && state.flow.stop) return act.cancelRun(surface.slice(5))
  if (key.name === "a" && surface.startsWith("flow:")) return act.fillRun(surface.slice(5))
  if (key.name === "u" && surface === "summary") {
    return act.undo(panel.rows[Math.min(navigation.selected, panel.rows.length - 1)])
  }
  if (state.worker !== undefined) {
    if (key.name === "pageup" || key.name === "pagedown") return act.scroll(key.name === "pageup" ? -1 : 1)
    return
  }
  if (key.name === "a") {
    const action = panel.rows[Math.min(navigation.selected, panel.rows.length - 1)]?.action
    if (action === undefined) return
    // An agent wrote this prompt: it goes to the agent as text, never through `!` or `/` parsing.
    if ("prompt" in action) {
      if (action.prompt.trim() === "") return
      act.release()
      return act.send(action.prompt.trim())
    }
    return act.perform(action.action)
  }
  if (key.name === "pageup" || key.name === "pagedown") return act.scroll(key.name === "pageup" ? -1 : 1)
  act.navigate((current) => Panels.navigate(current, key.name, panel.rows))
}

/** The composer's own keys, once no dialog, menu or panel took the key. */
export const composerKey = (key: KeyEvent, state: {
  readonly text: string
  readonly steering: boolean
  readonly turn: { readonly stop: () => void } | undefined
  readonly shell: { readonly cancel: () => void } | undefined
  readonly history: Editor.History
  readonly scroll: ScrollBoxRenderable | null
}, act: {
  /** Back to the steered worker's tab. */
  readonly stopSteering: () => void
  readonly setText: (text: string) => void
  readonly quit: () => void
  readonly submit: (followUp: boolean) => void
  readonly restoreQueued: () => void
  readonly pickModel: () => void
  readonly cycleModel: (step: number) => void
  readonly toggleExpanded: () => void
  readonly externalEditor: () => void
}) => {
  const { text, history, scroll } = state
  if (key.name === "escape") {
    if (state.steering) return act.stopSteering()
    if (state.turn !== undefined) return state.turn.stop()
    if (state.shell !== undefined) return state.shell.cancel()
    if (text.startsWith("!")) return act.setText("")
    return
  }
  if (key.ctrl && key.name === "d") {
    if (text === "") {
      key.preventDefault()
      act.quit()
    }
    return
  }
  if ((key.meta || key.option) && (key.name === "return" || key.name === "enter")) {
    key.preventDefault()
    return act.submit(true)
  }
  if ((key.meta || key.option) && key.name === "up") {
    key.preventDefault()
    return act.restoreQueued()
  }
  if (key.ctrl && key.name === "l") return act.pickModel()
  if (key.ctrl && key.name === "p") return act.cycleModel(key.shift ? -1 : 1)
  if (key.ctrl && key.name === "o") return act.toggleExpanded()
  if (key.ctrl && key.name === "g") return act.externalEditor()
  if (key.shift && (key.name === "up" || key.name === "down")) {
    key.preventDefault()
    return scroll?.scrollBy(key.name === "up" ? -1 : 1)
  }
  if (key.name === "pageup") return scroll?.scrollBy(-0.5, "viewport")
  if (key.name === "pagedown") return scroll?.scrollBy(0.5, "viewport")
  // History only from an empty editor or while already browsing (pi's rule).
  if (key.name === "up" && !key.ctrl && (text === "" || history.browsing)) {
    const older = history.up(text)
    if (older !== undefined) {
      key.preventDefault()
      act.setText(older)
    }
    return
  }
  if (key.name === "down" && !key.ctrl && history.browsing) {
    const newer = history.down()
    if (newer !== undefined) {
      key.preventDefault()
      act.setText(newer)
    }
  }
}
