import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "./ControllerContext"
import { MarkdownEditor, MarkdownEditorStyles } from "@smthrs/ui/adapters/markdown-editor"
import type { MarkdownEditorHandle } from "@smthrs/ui/adapters/markdown-editor"

/**
 * Heavy editor adapter boundary: loaded only when a markdown document is
 * visible — a World note (editable) or a repository's markdown file (read
 * only: no route writes a repository file, so the surface says nothing it
 * cannot do).
 */
export function MarkdownEditorSurface({
  value,
  resetKey,
  label,
  readOnly = false,
  onChange,
  onEditor,
  onLinkClick
}: {
  readonly value: string
  readonly resetKey: string
  readonly label: string
  readonly readOnly?: boolean
  readonly onChange?: (value: string) => void
  /** The editor's imperative handle on mount, null on unmount (the Wiki pane registers it for `wiki.heading`). */
  readonly onEditor?: (editor: MarkdownEditorHandle | null) => void
  /** A rendered link was clicked; true when the caller opened it (see MarkdownEditorProps.onLinkClick). */
  readonly onLinkClick?: (href: string) => boolean
}) {
  const controller = useController()
  const { data: sessions } = useLiveQuery(q => q.from({ session: controller.store.collections.sessions }).select(({ session }) => ({ id: session.id, inputMode: session.inputMode })))
  if (!readOnly && sessions[0]?.inputMode === "vim") return <textarea key={resetKey} className="vim-markdown-buffer" aria-label={label}
    value={value} onChange={event => onChange?.(event.currentTarget.value)} spellCheck={false} ref={node => {
      if (!node) return
      onEditor?.({
        getMarkdown: () => node.value,
        setMarkdown: markdown => { node.value = markdown },
        scrollToLine: line => {
          const lines = node.value.split('\n')
          if (!Number.isInteger(line) || line < 1 || line > lines.length) return false
          const cursor = lines.slice(0, line - 1).reduce((length, text) => length + text.length + 1, 0)
          node.focus(); node.setSelectionRange(cursor, cursor)
          node.scrollTop = (line - 1) * (Number.parseFloat(getComputedStyle(node).lineHeight) || 20)
          return true
        },
      })
      return () => onEditor?.(null)
    }} />
  return (
    <>
      <MarkdownEditorStyles />
      <MarkdownEditor
        value={value}
        resetKey={resetKey}
        aria-label={label}
        readOnly={readOnly}
        onChange={onChange ?? (() => {})}
        ref={onEditor}
        onLinkClick={onLinkClick}
      />
    </>
  )
}
