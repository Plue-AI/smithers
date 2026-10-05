/** @jsxImportSource react */
import { useLayoutEffect, useRef } from "react"
import { defaultKeymap } from "@codemirror/commands"
import { Compartment, EditorState, type Extension } from "@codemirror/state"
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, showTooltip, type Tooltip } from "@codemirror/view"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { tags } from "@lezer/highlight"
import { javascript } from "@codemirror/lang-javascript"
import { go } from "@codemirror/lang-go"
import { rust } from "@codemirror/lang-rust"
import { python } from "@codemirror/lang-python"
import { lintGutter, setDiagnostics } from "@codemirror/lint"

/** Positions use 1-based lines and UTF-16 columns (T-UI-11, spec §7.6). */
export interface EditorPosition { readonly line: number; readonly col?: number }
/** Supplied controls, with no command discovery or authorization in the editor. */
export interface EditorGesture<Tag extends string> { readonly tag: Tag; readonly label: string; readonly args?: Record<string, string>; readonly disabled?: { readonly reason: string } }
/** A host-approved document binding; no transport or authority is discovered here. */
export interface EditorBinding {
  readonly extensions: Extension
  readonly text: string
}
/** The same editor serves read-only files and approved live bindings. */
export interface CodeEditorViewProps<Tag extends string = string> {
  readonly binding?: EditorBinding
  readonly path: string
  readonly text: string
  readonly language: string
  readonly diagnostics: readonly (EditorPosition & { readonly severity: "error" | "warning"; readonly message: string })[]
  readonly hover?: EditorPosition & { readonly col: number; readonly markdown: string }
  readonly reveal?: EditorPosition & { readonly to_line?: number }
  readonly gestures?: { readonly hover?: EditorGesture<Tag>; readonly definition?: EditorGesture<Tag> }
  readonly onAction: (tag: Tag, args?: Record<string, string>) => void
  readonly onView: (patch: { line: number }) => void
}

/** Smallest single replacement after trimming the common prefix and suffix. */
export function minimalChange(before: string, after: string) {
  let from = 0
  const limit = Math.min(before.length, after.length)
  while (from < limit && before[from] === after[from]) from++
  let tail = 0
  while (tail < limit - from && before[before.length - tail - 1] === after[after.length - tail - 1]) tail++
  return { from, to: before.length - tail, insert: after.slice(from, after.length - tail) }
}
const position = (state: EditorState, point: EditorPosition) => {
  const line = state.doc.line(Math.max(1, Math.min(state.doc.lines, point.line)))
  return line.from + Math.max(0, Math.min(line.length, point.col ?? 0))
}
const languageExtension = (language: string): Extension => {
  switch (language.toLowerCase()) {
    case "typescript": case "tsx": return javascript({ typescript: true, jsx: language === "tsx" })
    case "javascript": case "jsx": return javascript({ jsx: language === "jsx" })
    case "go": return go()
    case "rust": return rust()
    case "python": return python()
    default: return []
  }
}
const paper = EditorView.theme({
  "&": { backgroundColor: "var(--surface)", color: "var(--code-text)", fontSize: "12.5px", border: "1px solid var(--border)", borderRadius: "var(--r-1)", overflow: "hidden" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "20px", maxHeight: "480px", overflow: "auto" },
  ".cm-content": { padding: "4px 0", caretColor: "var(--text)" },
  ".cm-line": { padding: "0 12px 0 6px" },
  ".cm-gutters": { backgroundColor: "var(--code-bg)", color: "var(--text-faint)", borderRight: "1px solid var(--border)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--hover-subtle)" },
  ".cm-selectionBackground": { backgroundColor: "var(--brand-soft) !important" },
  ".cm-tooltip": { backgroundColor: "var(--surface)", color: "var(--text)", border: "1px solid var(--border-strong)", borderRadius: "var(--r-1)", padding: "6px 10px", maxWidth: "min(460px, 80vw)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--danger)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--attention)" },
})
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.propertyName], color: "var(--lane-1)" },
  { tag: [tags.string, tags.regexp, tags.invalid], color: "var(--danger)" },
  { tag: [tags.number, tags.bool, tags.atom], color: "var(--attention)" },
  { tag: [tags.comment, tags.meta], color: "var(--text-muted)" },
  { tag: [tags.typeName, tags.className], color: "var(--text)" },
])
const tip = (state: EditorState, hover: NonNullable<CodeEditorViewProps["hover"]>): Tooltip => ({
  pos: position(state, hover), above: true,
  create: () => {
    const dom = document.createElement("div")
    dom.setAttribute("role", "tooltip")
    // Hover Markdown is untrusted text. No HTML, links, modules or commands execute.
    dom.textContent = hover.markdown
    return { dom }
  },
})

/** Production CodeMirror 6 surface, retained across prop updates and read-only unless a binding is supplied. */
export function CodeEditorView<Tag extends string>(props: CodeEditorViewProps<Tag>) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const bound = useRef(props.binding)
  const latest = useRef(props)
  latest.current = props
  const compartments = useRef({ language: new Compartment(), hover: new Compartment(), attributes: new Compartment(), binding: new Compartment(), access: new Compartment() })
  useLayoutEffect(() => {
    const send = (kind: "hover" | "definition", view: EditorView, pos = view.state.selection.main.head) => {
      const action = latest.current.gestures?.[kind]
      if (!action || action.disabled) return false
      const line = view.state.doc.lineAt(pos)
      latest.current.onAction(action.tag, { ...action.args, path: latest.current.path, line: String(line.number), col: String(pos - line.from) })
      return true
    }
    let hoverPosition: number | null = null
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: latest.current.binding?.text ?? latest.current.text, extensions: [
        compartments.current.access.of([EditorState.readOnly.of(!latest.current.binding), EditorView.editable.of(!!latest.current.binding), ...(latest.current.binding ? [EditorState.lineSeparator.of("\n")] : [])]),
        compartments.current.binding.of(latest.current.binding?.extensions ?? []),
        compartments.current.attributes.of(EditorView.contentAttributes.of({ tabindex: "0", role: "textbox", "aria-readonly": String(!latest.current.binding), "aria-label": latest.current.path })),
        lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), lintGutter(), paper,
        syntaxHighlighting(highlight), compartments.current.language.of(languageExtension(latest.current.language)), compartments.current.hover.of([]),
        keymap.of([{ key: "Ctrl-Space", run: view => send("hover", view) }, { key: "F12", run: view => send("definition", view) }, ...defaultKeymap]),
        EditorView.domEventHandlers({ mousemove: (event, view) => {
          if (!event.ctrlKey) { hoverPosition = null; return false }
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos !== null && pos !== hoverPosition) { hoverPosition = pos; send("hover", view, pos) }
          return false
        }, mouseleave: () => { hoverPosition = null; return false }, keyup: event => {
          if (event.key === "Control") hoverPosition = null
          return false
        } }),
        EditorView.updateListener.of(update => {
          if (update.selectionSet) latest.current.onView({ line: update.state.doc.lineAt(update.state.selection.main.head).number })
        }),
      ] }),
    })
    editor.current = view
    return () => { editor.current = null; view.destroy() }
  }, [])
  useLayoutEffect(() => {
    const view = editor.current!
    const replaced = bound.current !== props.binding
    if (replaced) view.dispatch({ effects: [compartments.current.binding.reconfigure([]), compartments.current.access.reconfigure([EditorState.readOnly.of(!props.binding), EditorView.editable.of(!!props.binding), ...(props.binding ? [EditorState.lineSeparator.of("\n")] : [])])] })
    const before = view.state.doc.toString()
    const after = view.state.toText(props.binding?.text ?? props.text).toString()
    if ((!props.binding || replaced) && before !== after) {
      const top = view.scrollDOM.scrollTop, left = view.scrollDOM.scrollLeft
      view.dispatch({ changes: minimalChange(before, after) })
      view.scrollDOM.scrollTop = top; view.scrollDOM.scrollLeft = left
    }
    bound.current = props.binding
    view.dispatch({ effects: [compartments.current.access.reconfigure([EditorState.readOnly.of(!props.binding), EditorView.editable.of(!!props.binding), ...(props.binding ? [EditorState.lineSeparator.of("\n")] : [])]), compartments.current.binding.reconfigure(props.binding?.extensions ?? []), compartments.current.attributes.reconfigure(EditorView.contentAttributes.of({ tabindex: "0", role: "textbox", "aria-readonly": String(!props.binding), "aria-label": props.path })), compartments.current.language.reconfigure(languageExtension(props.language)), compartments.current.hover.reconfigure(props.hover ? showTooltip.of(tip(view.state, props.hover)) : [])] })
    view.dispatch(setDiagnostics(view.state, props.diagnostics.map(diagnostic => {
      const from = position(view.state, diagnostic)
      return { from, to: Math.min(view.state.doc.length, from + 1), severity: diagnostic.severity, message: diagnostic.message }
    })))
  }, [props.binding, props.text, props.language, props.diagnostics, props.hover, props.path])
  useLayoutEffect(() => {
    if (!props.reveal) return
    const view = editor.current!, from = position(view.state, props.reveal)
    const to = props.reveal.to_line ? position(view.state, { line: props.reveal.to_line, col: view.state.doc.line(Math.min(view.state.doc.lines, props.reveal.to_line)).length }) : from
    view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from) })
  }, [props.reveal?.line, props.reveal?.col, props.reveal?.to_line])
  return <div className="code-editor" ref={host} data-flow={props.gestures?.hover?.tag} data-definition-flow={props.gestures?.definition?.tag} />
}
