/**
 * The composer: its draft and cursor, prompt history, the completion menu,
 * and where a submitted line goes. `route` is the one rule for that: a
 * steered worker, a `!` shell line, a `/` command, or a prompt.
 */
import type { CliRenderer, KeyBinding, TextareaRenderable } from "@opentui/core"
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as Approvals from "./approvals.ts"
import * as Complete from "./complete.ts"
import * as Cursor from "./cursor.ts"
import * as Editor from "./editor.ts"
import * as Extension from "./extension.ts"
import * as External from "./external.ts"
import type { FlowRuns } from "./flows.ts"
import * as Log from "./log.ts"
import type * as Models from "./models.ts"
import * as Shell from "./shell.ts"

export const keys: Array<KeyBinding> = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "linefeed", action: "newline" }
]

export type Route =
  | { readonly _tag: "steer" }
  | { readonly _tag: "shell"; readonly command: string; readonly excluded: boolean }
  | { readonly _tag: "command" }
  | { readonly _tag: "prompt" }

/**
 * Where a submitted line goes. While a worker is steered, everything but a
 * shell line or a command goes to it. A `/` line that names no command is a
 * prompt; the caller learns that when the command refuses it.
 */
export const route = (text: string, steering: boolean): Route => {
  const shellLine = Shell.parse(text)
  if (steering && shellLine === undefined && !text.startsWith("/")) return { _tag: "steer" }
  if (shellLine !== undefined) return { _tag: "shell", command: shellLine.command, excluded: shellLine.excluded }
  if (text.startsWith("/")) return { _tag: "command" }
  return { _tag: "prompt" }
}

export const useComposer = (options: {
  readonly models: ReadonlyArray<Models.Model>
  readonly runs: FlowRuns
  /** Bumped by every store change; the menu re-lists flows and files on it. */
  readonly revision: number
  readonly files: MutableRefObject<() => ReadonlyArray<string>>
  /** Typing delays the approval row's keys; see `Approvals.Arming`. */
  readonly arming: MutableRefObject<Approvals.Arming>
  readonly prompts: ReadonlyArray<string>
}) => {
  const { models, runs, revision, files, arming } = options
  const composer = useRef<TextareaRenderable>(null)
  const [draft, setDraft] = useState("")
  const [cursor, setCursor] = useState(0)
  /** The selected row, for the menu it was picked in; a different menu starts at its first row. */
  const [selection, setSelection] = useState({ identity: "", index: 0 })
  // Keys in one burst read and move the selection here, before the next render.
  const selected = useRef(selection)
  const [menuDismissed, setMenuDismissed] = useState(false)
  const history = useRef(new Editor.History(options.prompts))
  /** The draft a palette command with an argument displaced; restored by the next submit. */
  const parkedDraft = useRef<string | undefined>(undefined)
  const editing = useRef<{ controller: AbortController; done: Promise<string | undefined> } | undefined>(undefined)
  const stopEditor = useCallback((): Promise<void> | undefined => {
    const current = editing.current
    current?.controller.abort()
    return current?.done.then(() => {}, () => {})
  }, [])
  useEffect(() => () => {
    void stopEditor()
  }, [stopEditor])

  const completeAt = (text: string, at: number): Complete.Completion | undefined => {
    const completion = Complete.complete(text, at, {
      models,
      files: () => files.current(),
      flows: runs.listed,
      agents: () => runs.listed().filter(Extension.isAgent)
    })
    return completion !== undefined && (completion.items.length > 0 || completion.kind !== "file")
      ? completion
      : undefined
  }
  const menu = useMemo(
    () => (menuDismissed ? undefined : completeAt(draft, cursor)),
    [draft, cursor, menuDismissed, models, runs, revision]
  )
  const identity = (open: Complete.Completion | undefined) => open === undefined ? "" : `${open.kind}:${open.query}`
  const indexFor = (open: Complete.Completion | undefined) =>
    selected.current.identity === identity(open) ? selected.current.index : 0
  // A menu that differs from the rendered one starts at its first row, as a new menu does.
  if (selected.current.identity !== identity(menu)) selected.current = { identity: identity(menu), index: 0 }
  const menuIndex = selected.current.index
  /**
   * The menu for the text the composer holds now, and its selection. Keys in
   * one input burst are handled before the next render, so the rendered menu
   * can belong to an older draft: Enter then accepted `/summ`'s span and ran
   * `/summaryary`. An edit since the render also undoes a dismissal, as
   * `onContentChange` does.
   */
  const liveMenu = (): { readonly menu: Complete.Completion | undefined; readonly index: number } => {
    const input = composer.current
    const now = input === null || (input.plainText === draft && Cursor.index(input) === cursor)
      ? menu
      : input.plainText === draft && menuDismissed
      ? undefined
      : completeAt(input.plainText, Cursor.index(input))
    return { menu: now, index: indexFor(now) }
  }
  /** Moves the live menu's selection. */
  const setMenuIndex = (update: (index: number) => number) => {
    const { menu: now, index } = liveMenu()
    selected.current = { identity: identity(now), index: update(index) }
    setSelection(selected.current)
  }

  const setText = useCallback((text: string, at?: number) => {
    const input = composer.current
    if (input === null) return
    input.setText(text)
    if (at === undefined) input.gotoBufferEnd()
    else Cursor.move(input, at)
    arming.current = Approvals.edited(arming.current, Date.now())
    setDraft(text)
    setCursor(Cursor.index(input))
  }, [])

  /** Tab inserts the selected completion; Enter also runs it through `submit` when it is a whole command. */
  const accept = (open: Complete.Completion, index: number, run: boolean, submit: (text: string) => void) => {
    const input = composer.current
    if (input === null) return
    const suggestion = open.items[index]
    if (suggestion === undefined) return
    const next = Complete.apply(input.plainText, open, suggestion)
    if (run && suggestion.submit) return submit(next.text)
    setText(next.text, next.cursor)
  }

  /** Ctrl+G: the draft in $VISUAL or $EDITOR, with the terminal handed over until it exits. */
  const externalEditor = async (renderer: CliRenderer, setStatus: (text: string, tone: "warning") => void) => {
    if (editing.current !== undefined) return
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "nano"
    const controller = new AbortController()
    let edited: string | undefined
    const done = External.exclusive(async () => {
      renderer.suspend()
      try {
        edited = await External.edit(composer.current?.plainText ?? "", editor, undefined, controller.signal)
      } catch (error) {
        Log.write("editor", error)
        if (!controller.signal.aborted) setStatus("Editor unavailable", "warning")
      } finally {
        if (!controller.signal.aborted) {
          renderer.resume()
          // Window changes went to the foreground editor while we were suspended.
          // Refresh the runtime's TTY dimensions and the renderer through its
          // normal signal path, on both Node and Bun.
          process.kill(process.pid, "SIGWINCH")
        }
      }
      return edited
    })
    editing.current = { controller, done }
    try {
      await done
    } finally {
      editing.current = undefined
    }
    if (edited !== undefined) setText(edited)
  }

  /** The textarea's change handlers. */
  const onContentChange = () => {
    arming.current = Approvals.edited(arming.current, Date.now())
    setDraft(composer.current?.plainText ?? "")
    setCursor(composer.current === null ? 0 : Cursor.index(composer.current))
    setMenuDismissed(false)
  }
  const onCursorChange = () => setCursor(composer.current === null ? 0 : Cursor.index(composer.current))

  return {
    composer,
    draft,
    setText,
    history,
    parkedDraft,
    menu,
    menuIndex,
    liveMenu,
    setMenuIndex,
    dismissMenu: () => setMenuDismissed(true),
    accept,
    externalEditor,
    stopEditor,
    onContentChange,
    onCursorChange
  }
}
