/*
 * Browser entry for `scripts/codex-session.ts`: the page embeds the read
 * session as JSON, or names a URL that serves it fresh while the session runs.
 */
import { createRoot } from "react-dom/client"
import type { CodexSession } from "./CodexRollout"
import { defaultParticipants } from "./CodexRollout"
import { CodexSessionPage } from "./CodexSessionPage"

const data = document.getElementById("codex-session")
const embedded = JSON.parse(data?.textContent ?? "null") as { session: CodexSession; person?: { name: string; login: string } } | null
const live = data?.dataset.live
document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
const root = createRoot(document.getElementById("root")!)
const render = (payload: NonNullable<typeof embedded>) => {
  const who = defaultParticipants(payload.session, payload.person?.name, payload.person?.login)
  root.render(<CodexSessionPage session={payload.session} who={who} />)
}
if (embedded) render(embedded)
if (live) {
  const poll = async () => { const response = await fetch(live, { cache: "no-store" }); if (response.ok) render(await response.json()) }
  void poll()
  setInterval(() => void poll(), 5000)
}
