import type { CSSProperties } from "react"

/* The single entrance mark, painted before the runtime loads. */
export const WORDMARK = [
  "███████╗███╗   ███╗██╗████████╗██╗  ██╗███████╗██████╗ ███████╗",
  "██╔════╝████╗ ████║██║╚══██╔══╝██║  ██║██╔════╝██╔══██╗██╔════╝",
  "███████╗██╔████╔██║██║   ██║   ███████║█████╗  ██████╔╝███████╗",
  "╚════██║██║╚██╔╝██║██║   ██║   ██╔══██║██╔══╝  ██╔══██╗╚════██║",
  "███████║██║ ╚═╝ ██║██║   ██║   ██║  ██║███████╗██║  ██║███████║",
  "╚══════╝╚═╝     ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝",
]

export function Home() {
  return (
    <>
      <main className="wrap hero home">
        <h1 className="wordmark" aria-label="Smithers">
          <pre aria-hidden="true">{WORDMARK.map((line, row) => (
            <span key={row} className="wordmark-row" style={{ "--row": row } as CSSProperties}>{line}</span>
          ))}</pre>
        </h1>
        <p className="sub">Automate maintaining your codebase</p>
        <div className="actions">
          <button className="start ready" type="button"><span>Get started for free</span></button>
          <button className="btn ghost" type="button">Docs</button>
          <a className="btn ghost" href="https://github.com/smithersai/smithers" target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
      </main>
      <footer className="wrap foot">
        <button type="button">Terms</button>
        <button type="button">Privacy</button>
      </footer>
    </>
  )
}
