/** What capture.mjs records. Each entry's detail is copied into captures.json. */

const pause = (page, ms) => page.waitForTimeout(ms)

const typeInComposer = async (page, text) => {
  const input = page.getByTestId("composer-input")
  if (!(await input.isVisible())) await page.getByRole("button", { name: "Chat", exact: true }).click()
  await input.waitFor({ state: "visible" })
  await pause(page, 400)
  await input.pressSequentially(text, { delay: 35 })
  await pause(page, 500)
}

const CHAT_PROMPT = "Explain this repository. Which files should I read first?"
const CHAT_REPLY = "Start with README.md for the overview, then CONTRIBUTING.md for setup and the checks to run. I have not changed any files."

export const appJourneys = [
  {
    id: "app-chat",
    detail: "The app on a local offline host. The reply comes from a scripted test model, not a live model.",
    replies: [{ when: "Explain this repository", reply: CHAT_REPLY }],
    steps: async (page) => {
      await page.getByRole("button", { name: "Chat", exact: true }).waitFor({ state: "visible", timeout: 60_000 })
      await pause(page, 1200)
      await typeInComposer(page, CHAT_PROMPT)
      await page.keyboard.press("Enter")
      await page.getByText("I have not changed any files.").last().waitFor({ state: "visible", timeout: 30_000 })
      await pause(page, 1500)
      await page.keyboard.press("Escape")
      await pause(page, 2000)
    }
  },
  {
    id: "app-agents",
    detail: "The app on a local offline host: the Agents door and its card of built-in agents.",
    steps: async (page) => {
      // Opening and closing Chat once retires the first-run keyboard hint.
      await page.getByRole("button", { name: "Chat", exact: true }).click()
      await page.getByTestId("composer-input").press("Escape")
      await page.getByRole("button", { name: "Agents", exact: true }).click()
      const card = page.locator('.smithers-card[data-kind="agents"]').last()
      await card.waitFor({ state: "visible", timeout: 30_000 })
      await pause(page, 800)
      return card
    }
  }
]

/** Recording ids from apps/tui/docs; each is a tui-script fence there. */
export const tuiRecordings = [
  { id: "composer", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording composer)." },
  { id: "queue", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording queue)." },
  { id: "resume-session", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording resume-session)." },
  { id: "fork-session", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording fork-session)." },
  { id: "shell-context", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording shell-context)." },
  { id: "text-search", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording text-search)." },
  { id: "review-diff", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording review-diff)." },
  { id: "undo-edit", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording undo-edit)." },
  { id: "flow-approval", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording flow-approval)." },
  { id: "deny-edit", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording deny-edit)." },
  { id: "run-flow", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording run-flow)." },
  { id: "flow-form", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording flow-form)." },
  { id: "background-worker", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording background-worker)." },
  { id: "worker-controls", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording worker-controls)." },
  { id: "worker-tree", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording worker-tree)." },
  { id: "model-picker", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording model-picker)." },
  { id: "custom-agent", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording custom-agent)." },
  { id: "timeline", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording timeline)." },
  { id: "fix-add", detail: "Production TUI in a PTY replaying the recorded fix-add model run (apps/tui/test/fixtures/fix-add.jsonl)." },
  { id: "print-mode", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording print-mode)." },
  { id: "instruction-context", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording instruction-context)." },
  { id: "transcript-filter", detail: "Production TUI in a PTY replaying the recorded fix-add model run (apps/tui/test/fixtures/fix-add.jsonl)." },
  { id: "estimates", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording estimates)." },
  { id: "custom-view", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording custom-view)." },
  { id: "repository-extension", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording repository-extension)." },
  { id: "monitor", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording monitor)." },
  { id: "provider-failure", detail: "Production TUI in a PTY with deterministic fixture replies (apps/tui/docs recording provider-failure)." }
]

/**
 * The surfaces apps/app/e2e/playwright/finish-surfaces.spec.ts drives in the
 * real app against the backend's DTO shapes and captures as stills.
 */
export const surfaces = [
  { id: "app-issues", detail: "The app's issue list with a conversation and a fixed issue, driven by apps/app/e2e/playwright/finish-surfaces.spec.ts against the contract's fixture routes." },
  { id: "app-conversation", detail: "A conversation read through the chat = issues contract (personas, reactions, the Slack thread), driven by apps/app/e2e/playwright/finish-surfaces.spec.ts against the contract's fixture routes." },
  { id: "app-connect", detail: "The Connect card's Slack channels and Linear team from the registered routes, driven by apps/app/e2e/playwright/finish-surfaces.spec.ts against fixture routes." },
  { id: "app-run-steps", detail: "A run's Steps view leading with its recorded triggers (a schedule, an approval decision), driven by apps/app/e2e/playwright/finish-surfaces.spec.ts against fixture routes." }
]

/** Design previews: real app components over fixture data, for a screen not connected yet. */
export const previews = [
  { id: "inbox", file: "approvals-inbox-1280-light.png", detail: "Design preview: apps/app ui-surfaces probe on main, fixture data (#2114)." }
]
