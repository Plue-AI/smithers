import { CodeEditorView as Editor } from "@smthrs/ui/adapters/code-editor"
import { CodeEditorView, type CodeEditorViewProps } from "./views/CodeEditorView"

/** The mounted card and stories share the props-only File View; this draws its CodeMirror editors (C-UI-08). */
export const CodeEditorSurface = (props: Omit<CodeEditorViewProps, "editor">) => {
  const { model, view, gestures, onAction, onView } = props
  return <CodeEditorView {...props} editor={slot => slot.kind === "snapshot"
    // A comparison snapshot has no binding or gestures and discards cursor updates.
    ? <Editor path={`${model.path} · Snapshot`} text={slot.text} language={model.language} diagnostics={[]} onAction={() => {}} onView={() => {}} />
    : <Editor binding={slot.binding} path={model.path} text={slot.text} language={model.language}
      diagnostics={model.diagnostics} hover={model.hover} reveal={model.reveal ?? (view.line ? { line: view.line } : undefined)}
      gestures={gestures} onAction={onAction} onView={onView} />} />
}
