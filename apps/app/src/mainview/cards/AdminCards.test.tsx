import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "../state/AppState"
import type { CardActions } from "./CardFamily"
import { adminCardFamily } from "./AdminCards"

/*
 * The admin health card never shows a probe's raw words as a sentence: a
 * failing probe says ours, with the raw text behind a collapsed Details.
 */

const base = { title: "Admin", status: "acted" as const, createdAt: 0, ordinal: 0 }
const actions = { onRunCommand: () => {} } as unknown as CardActions

const health = (services: Extract<Card, { kind: "admin-health" }>["payload"]["services"]): Extract<Card, { kind: "admin-health" }> => ({
  ...base, id: "admin-health", kind: "admin-health",
  payload: { services, charges: null, checkedAt: "2026-09-29T00:00:00Z" }
})

describe("the health readout", () => {
  test("a passing or unconfigured probe shows its diagnostic; a failing one says our sentence with the error behind Details", () => {
    const html = renderToStaticMarkup(adminCardFamily["admin-health"].render(health([
      { name: "billing", status: "ok", detail: "healthz ok." },
      { name: "email", status: "unconfigured", detail: "No SMTP host." },
      { name: "identity", status: "failed", detail: "fetch failed: ECONNREFUSED 10.0.0.4:8080" }
    ]), actions))
    expect(html).toContain("<strong>billing</strong> — healthz ok.")
    expect(html).toContain("<strong>email</strong> — No SMTP host.")
    const start = html.indexOf('data-testid="admin-health-identity-failure"')
    const failing = html.slice(html.lastIndexOf("<div", start), html.indexOf("</div>", start))
    expect(failing).toMatch(/role="status"[^>]*data-fault="infra"[^>]*data-failure="AdminHealth.failed"/)
    expect(failing).toContain("<p>This service failed its health check. Not your fault.</p>")
    expect(failing).toContain('<pre tabindex="0" role="region" aria-label="Failure details">fetch failed: ECONNREFUSED 10.0.0.4:8080</pre>')
    expect(html).not.toContain("— fetch failed")
    expect(html).toContain('data-status="failed"')
  })
})
