import type { DocsViewProps } from "@smthrs/rpc/DocsCard"
import { MarkdownEditor, MarkdownEditorStyles } from "@smthrs/ui/adapters/markdown-editor"
import { headingLine, resolveMarkdownLink } from "../MarkdownLinks"
import { DiffAction } from "./DiffAction"

export function DocsView({ model, actions, gestures, onAction }: DocsViewProps) {
  const open = gestures.open
  const body = model.page.markdown.replace(new RegExp(`^#\\s+${model.page.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n`), "")
  const links: Record<string, string> = {}
  const markdown = body.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|^\[([^\]]+)\]:\s*(\S+)/gm, (match, label, inlineHref, _reference, target) => {
    const href = inlineHref ?? target
    const link = resolveMarkdownLink(`${model.page.slug}.md`, href)
    if (link.kind === "blocked") return label ?? ""
    if (link.kind === "fragment") links[href] = `${model.page.slug}#${link.fragment}`
    else if (link.kind === "file") links[href] = `${link.path.replace(/\.md$/, "")}${link.fragment ? `#${link.fragment}` : ""}`
    return match
  })
  const go = (page: string) => { if (open && !open.disabled) onAction(open.tag, { ...open.args, page }) }
  const follow = (href: string) => { if (links[href]) go(links[href]); return true }
  return <article className="mvp-docs" aria-label="Docs" data-keyboard-pane="Docs">
    <nav aria-label="Docs pages">{model.toc.map(entry => open ? <a key={entry.slug} href={`#${entry.slug}`}
      data-flow={open?.tag} aria-current={entry.slug === model.page.slug ? "page" : undefined}
      aria-disabled={!!open.disabled}
      onClick={event => { event.preventDefault(); go(entry.slug) }}>{entry.title}</a> : <span key={entry.slug} aria-current={entry.slug === model.page.slug ? "page" : undefined}>{entry.title}</span>)}
      {open?.disabled && <span className="mvp-docs-reason">{open.disabled.reason}</span>}
    </nav>
    <section className="mvp-docs-page" aria-label={model.page.title}>
      {model.not_found && <p className="mvp-docs-missing">Page not found: <code>{model.not_found}</code></p>}
      <header><h2>{model.page.title}</h2><p>{model.page.summary}</p></header>
      <div className="mvp-docs-markdown" data-flow={open?.tag} data-inert={!open || !!open.disabled || undefined}>
        <MarkdownEditorStyles />
        <MarkdownEditor value={markdown} resetKey={`${model.page.slug}#${model.anchor ?? ""}`} readOnly aria-label={model.page.title}
          initialLine={model.anchor ? headingLine(markdown, model.anchor) : undefined} onLinkClick={follow} />
      </div>
      {actions.length > 0 && <footer className="draft-actions">{actions.map((action, index) => <DiffAction key={index} action={action} onAction={onAction} />)}</footer>}
    </section>
  </article>
}
