import { expect } from "@playwright/test"
import { showcase } from "../showcase"

const CONNECTIONS = "/api/user/provider-connections"
const DEVICE = "0f5b8f0e-3c1a-4d2b-9e7f-5a6b7c8d9e01"

type Row = { id: string; provider: "claude" | "codex"; state: string; label: string; account_email: string | null; limited_until: string | null; sort_order: number }

export default showcase({
  id: "accounts",
  order: 80,
  title: "Accounts",
  summary: "Your GitHub login and the Claude and Codex accounts sessions draw from.",
  flows: ["account.show", "secrets.connections", "secrets.move", "secrets.connect.codex"],
  run: async ({ page, app, backend }) => {
    const limited = new Date(Date.now() + 2 * 3600_000).toISOString()
    let rows: Row[] = [
      { id: "claude-work", provider: "claude", state: "active", label: "Claude Max", account_email: "ada@acme.dev", limited_until: limited, sort_order: 0 },
      { id: "claude-team", provider: "claude", state: "active", label: "Claude Team", account_email: "platform@acme.dev", limited_until: null, sort_order: 1 }
    ]
    let polls = 0
    const orders: string[][] = []
    await backend.cloud({ capabilities: ["agent", "identity", "cloud"] })
    await backend.route(url => url.pathname === CONNECTIONS, route => route.fulfill({ json: rows }))
    await backend.route(url => url.pathname === `${CONNECTIONS}/order`, async route => {
      const { provider, ids } = route.request().postDataJSON() as { provider: string; ids: string[] }
      orders.push(ids)
      rows = rows.map(row => row.provider === provider ? { ...row, sort_order: ids.indexOf(row.id) } : row)
      await route.fulfill({ status: 204, body: "" })
    })
    const device = (state: string) => ({
      id: DEVICE, state, user_code: "WDJB-MJHT", verification_uri: "https://auth.openai.com/codex/device",
      expires_at: new Date(Date.now() + 900_000).toISOString(), interval_seconds: 1
    })
    await backend.route(url => url.pathname === `${CONNECTIONS}/codex/device`, route => route.fulfill({ json: device("pending") }))
    await backend.route(url => url.pathname === `${CONNECTIONS}/codex/device/${DEVICE}`, route => {
      polls++
      if (polls < 3) return route.fulfill({ json: device("pending") })
      if (!rows.some(row => row.provider === "codex")) {
        rows = [...rows, { id: "codex-pro", provider: "codex", state: "active", label: "ChatGPT Pro", account_email: "ada@acme.dev", limited_until: null, sort_order: 0 }]
      }
      return route.fulfill({ json: device("connected") })
    })

    await app.open("/")
    await app.slash("/account.show")
    await app.closeComposer()
    const account = page.locator('.smithers-card[data-kind="account"]').last()
    await expect(account).toContainText("@codeplanesmithers")
    await app.show(account)
    await app.beat(1500)

    await app.slash("/secrets.connections")
    await app.closeComposer()
    const pool = page.locator('.smithers-card[data-kind="provider-accounts"]').last()
    await expect(pool.getByTestId("account-claude-work")).toContainText("limited until")
    await app.show(pool)
    await app.beat(1500)

    // The limited account goes to the back of the Claude pool.
    await app.click(pool.getByRole("button", { name: "Move ada@acme.dev down" }))
    await expect(pool.locator('[data-testid^="account-claude-"]').first()).toHaveAttribute("data-testid", "account-claude-team")
    await expect.poll(() => orders).toEqual([["claude-team", "claude-work"]])
    await app.beat(1200)

    // Codex connects by device code; the row appears once the sign-in completes.
    await app.click(pool.getByRole("button", { name: "Add Codex" }))
    await expect(pool.getByTestId("codex-pending")).toContainText("WDJB-MJHT")
    await app.beat(1200)
    await expect(pool.getByTestId("account-codex-pro")).toBeVisible({ timeout: 15_000 })
    await app.show(pool)
    await app.beat(1500)
  }
})
