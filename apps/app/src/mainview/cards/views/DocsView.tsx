import type { DocsViewProps } from "@smthrs/rpc/DocsCard"
import { MarkdownEditor, MarkdownEditorStyles } from "@smthrs/ui/adapters/markdown-editor"
import { headingLine, resolveMarkdownLink } from "../MarkdownLinks"
import { DiffAction } from "./DiffAction"

export function DocsView({ model, actions, gestures, onAction }: DocsViewProps) {
  const open = gestures.open
  const markdown = model.page.markdown.replace(/</g, "&lt;")
  const follow = (href: string) => {
    const link = resolveMarkdownLink(`${model.page.slug}.md`, href)
    const page = link.kind === "fragment" ? `${model.page.slug}#${link.fragment}`
      : link.kind === "file" ? `${link.path.replace(/\.md$/, "")}${link.fragment ? `#${link.fragment}` : ""}` : undefined
    if (page && open && !open.disabled) onAction(open.tag, { ...open.args, page })
    return true
  }
  return <article className="mvp-docs" aria-label="Docs" data-keyboard-pane="Docs">
    <nav aria-label="Docs pages">{model.toc.map(entry => <button key={entry.slug} type="button"
      data-flow={open?.tag} aria-current={entry.slug === model.page.slug ? "page" : undefined}
      disabled={!open || !!open.disabled}
      onClick={() => { if (open) onAction(open.tag, { ...open.args, page: entry.slug }) }}>{entry.title}</button>)}
      {open?.disabled && <span>{open.disabled.reason}</span>}
    </nav>
    <section className="mvp-docs-page" aria-label={model.page.title}>
      {model.not_found && <p className="mvp-docs-missing">Page not found: <code>{model.not_found}</code></p>}
      <header><h2>{model.page.title}</h2><p>{model.page.summary}</p></header>
      <div className="mvp-docs-markdown" data-flow={open?.tag} ref={node => {
        if (!node) return
        // The wiki adapter creates its document asynchronously. Observe only
        // DOM readiness; props remain the authority for the requested anchor.
        const reveal = () => {
          const headings = [...node.querySelectorAll<HTMLElement>(".ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6")]
          const seen = new Map<string, number>()
          for (const heading of headings) {
            const base = (heading.textContent ?? "").trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-")
            const count = seen.get(base) ?? 0
            seen.set(base, count + 1)
            const anchor = count ? `${base}-${count}` : base
            heading.id = `${model.page.slug}#${anchor}`
            if (model.anchor && headingLine(model.page.markdown, model.anchor) === headingLine(model.page.markdown, anchor)) heading.scrollIntoView?.({ block: "start" })
          }
        }
        reveal()
        const observer = new MutationObserver(reveal)
        observer.observe(node, { childList: true, subtree: true })
        return () => observer.disconnect()
      }}>
        <MarkdownEditorStyles />
        <MarkdownEditor value={markdown} resetKey={model.page.slug} readOnly aria-label={model.page.title}
          onLinkClick={follow} ref={editor => {
            const line = model.anchor ? headingLine(model.page.markdown, model.anchor) : undefined
            if (line) editor?.scrollToLine(line)
          }} />
      </div>
      {actions.length > 0 && <footer>{actions.map((action, index) => <DiffAction key={index} action={action} onAction={onAction} />)}</footer>}
    </section>
  </article>
}
