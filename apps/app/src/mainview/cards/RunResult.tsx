import { Markdown } from "@smthrs/ui"

export interface HtmlRunResult { readonly kind: "html"; readonly title: string; readonly html: string }
/** Authored results share one presentation contract, independent of flow names. */
export function htmlRunResult(result: string): HtmlRunResult | null {
  try {
    const value: unknown = JSON.parse(result)
    if (typeof value !== "object" || value === null || !("ui" in value)) return null
    const ui = value.ui
    if (typeof ui !== "object" || ui === null || !("kind" in ui) || ui.kind !== "html"
      || !("title" in ui) || typeof ui.title !== "string" || !("html" in ui) || typeof ui.html !== "string") return null
    return { kind: "html", title: ui.title, html: ui.html }
  } catch { return null }
}
// Runs may contain model-authored HTML. Isolate scripts from the app origin,
// block external resources/fetch/forms, and omit popup/top-navigation authority.
// CSP does not prevent the isolated frame from navigating itself.
export const RUN_RESULT_CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"
export function RunResult({ result, technical = false }: { readonly result: string; readonly technical?: boolean }) {
  const ui = htmlRunResult(result)
  if (ui !== null) return <iframe
    className="run-result"
    title={ui.title || "Run result"}
    sandbox="allow-scripts"
    referrerPolicy="no-referrer"
    srcDoc={`<meta http-equiv="Content-Security-Policy" content="${RUN_RESULT_CSP}">${ui.html}`}
    style={{ width: "100%", height: "min(70vh, 720px)", border: 0 }}
  />
  if (technical) return <details className="run-progress-fold">
    <summary>Technical details</summary>
    <pre className="run-trace-code" tabIndex={0} aria-label="Run output">{result}</pre>
  </details>
  return <Markdown className="smithers-card-markdown run-result" content={result} />
}
