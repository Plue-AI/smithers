import { CodeEditorView as Editor, type EditorBinding } from "@smthrs/ui/adapters/code-editor"
import type { CodeEditorViewProps } from "@smthrs/rpc/FileCard"
import { CodeEditorView } from "./views/CodeEditorView"

/** Supply the approved editor implementation to the props-only File presentation. */
export function CodeEditorSurface(props: CodeEditorViewProps & { readonly binding?: EditorBinding }) {
  const { model, view, binding, gestures, onAction, onView } = props
  const editor = model.content.kind === "text" ? <Editor
    binding={model.mode === "live" && !model.gone ? binding : undefined}
    path={model.path} text={model.content.text} language={model.language}
    diagnostics={model.diagnostics} hover={model.hover}
    reveal={model.reveal ?? (view.line ? { line: view.line } : undefined)}
    gestures={gestures} onAction={onAction} onView={onView} /> : null
  return <CodeEditorView {...props} editor={editor} />
}
