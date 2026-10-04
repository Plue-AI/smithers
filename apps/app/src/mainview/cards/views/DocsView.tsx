import type { DocsViewProps } from "@smthrs/rpc/DocsCard"
import { Markdown } from "@smthrs/ui"
import { useCallback } from "react"
import { headingLine, resolveMarkdownLink } from "../MarkdownLinks"
import { DiffAction } from "./DiffAction"

export function DocsView({ model, actions, gestures, onAction }: DocsViewProps) {
  const open = gestures.open
  const body = model.page.markdown.replace(new RegExp(`^#\\s+${model.page.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n`), "")
  const go = (page: string) => { if (open && !open.disabled) onAction(open.tag, { ...open.args, page }) }
  const follow = (href: string) => {
    const link = resolveMarkdownLink(`${model.page.slug}.md`, href)
    if (link.kind === "fragment") go(`${model.page.slug}#${link.fragment}`)
    else if (link.kind === "file" && link.path.endsWith(".md")) go(`${link.path.slice(0, -3)}${link.fragment ? `#${link.fragment}` : ""}`)
  }
  // The shared renderer owns parsing. A commit ref decorates its headings and
  // reveals the supplied anchor when the page or anchor changes, without effects.
  const reveal = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    for (const link of node.querySelectorAll("a")) {
      if (open) link.setAttribute("data-flow", open.tag)
      else link.removeAttribute("data-flow")
    }
    const seen = new Map<string, number>()
    const headings = [...node.querySelectorAll<HTMLElement>(".sui-md-heading")]
    for (const heading of headings) {
      const base = (heading.textContent ?? "").trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-")
      const count = seen.get(base) ?? 0
      seen.set(base, count + 1)
      heading.id = count ? `${base}-${count}` : base
      heading.setAttribute("role", "heading")
      heading.setAttribute("aria-level", /sui-md-h([1-6])/.exec(heading.className)![1]!)
    }
    if (model.anchor && headingLine(body, model.anchor) !== undefined) {
      let anchor: string
      try { anchor = decodeURIComponent(model.anchor).toLowerCase() } catch { return }
      headings.find(heading => heading.id === anchor)?.scrollIntoView?.({ block: "nearest" })
    }
  }, [body, model.page.slug, model.anchor, open?.tag])
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
        <div ref={reveal}><Markdown content={body} onLinkClick={follow} /></div>
      </div>
      {actions.length > 0 && <footer className="draft-actions">{actions.map((action, index) => <DiffAction key={index} action={action} onAction={onAction} />)}</footer>}
    </section>
  </article>
}
