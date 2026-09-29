import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "../state/AppState"
import type { CardActions } from "./CardFamily"
import { adminCardFamily } from "./AdminCards"

/*
 * The admin cards never show the admin route's or a probe's raw words as a
 * sentence: a failed approval and a failing probe say ours, with the raw text
 * behind a collapsed Details.
 */

const base = { title: "Admin", status: "acted" as const, createdAt: 0, ordinal: 0 }
const actions = { onRunCommand: () => {}, onQueueApprove: () => {} } as unknown as CardActions

const queue = (error: string | undefined): Extract<Card, { kind: "request-queue" }> => ({
  ...base, id: "admin-requests", kind: "request-queue",
  payload: { requests: [{ login: "octo", note: null, createdAt: "2026-09-29T00:00:00Z" }], approving: null, ...(error === undefined ? {} : { error }) }
})

const health = (services: Extract<Card, { kind: "admin-health" }>["payload"]["services"]): Extract<Card, { kind: "admin-health" }> => ({
  ...base, id: "admin-health", kind: "admin-health",
  payload: { services, queueDepth: null, charges: null, checkedAt: "2026-09-29T00:00:00Z" }
})

describe("the request queue", () => {
  test("a failed approval says our sentence; the route's body stays behind Details", () => {
    const html = renderToStaticMarkup(adminCardFamily["request-queue"].render(queue("Approving octo didn't go through. (403 {\"error\":\"forbidden\"})"), actions))
    expect(html).toMatch(/role="alert"[^>]*data-fault="infra"[^>]*data-failure="AdminApproveFailed"[^>]*data-testid="queue-approve-failure"/)
    expect(html).toContain("<p>Smithers could not approve that request. Not your fault.</p>")
    expect(html).toContain("<details><summary>Details</summary>")
    expect(html.slice(html.indexOf("<details>"))).toContain("403")
    expect(html.slice(0, html.indexOf("<details>"))).not.toContain("403")
    // Approve on the row is the way to try again; the notice adds no second door.
    expect(html.match(/<button/g)?.length).toBe(1)
  })

  test("no error, no notice", () => {
    expect(renderToStaticMarkup(adminCardFamily["request-queue"].render(queue(undefined), actions))).not.toContain("queue-approve-failure")
  })
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
    expect(failing).toContain('<pre tabindex="0">fetch failed: ECONNREFUSED 10.0.0.4:8080</pre>')
    expect(html).not.toContain("— fetch failed")
    expect(html).toContain('data-status="failed"')
  })
})
