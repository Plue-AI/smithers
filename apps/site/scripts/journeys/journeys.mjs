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
  }
]

/** Recording ids from apps/tui/docs; each is a tui-script fence there. */
export const tuiRecordings = [
  { id: "composer", detail: "Production TUI in a PTY; deterministic model replies (apps/tui-docs fixture basic)." },
  { id: "queue", detail: "Production TUI in a PTY; deterministic model replies (apps/tui-docs fixture slow)." },
  { id: "timeline", detail: "Production TUI in a PTY; deterministic model replies (apps/tui-docs fixture fix-add)." },
  { id: "flow-approval", detail: "Production TUI in a PTY; fixture flow asking for each capability (apps/tui-docs fixture flow-approval)." },
  { id: "run-flow", detail: "Production TUI in a PTY; fixture flows (apps/tui-docs fixture flows)." },
  { id: "custom-agent", detail: "Production TUI in a PTY; fixture review agent (apps/tui-docs fixture agents)." }
]

/** Design previews: real app components over fixture data, from an unlanded branch. */
export const previews = [
  { id: "issues", file: "issue-list-1280-light.png", detail: "Design preview: ui-surfaces probe, branch ui-threads-org, fixture data (#2111, #2112)." },
  { id: "chat", file: "issue-1280-light.png", detail: "Design preview: ui-surfaces probe, branch ui-threads-org, fixture data (#2111, #2105)." },
  { id: "agents", file: "agents-1280-light.png", detail: "Design preview: ui-surfaces probe, branch ui-threads-org, fixture data (#2113)." },
  { id: "run-steps", file: "run-trace-1280-light.png", detail: "Design preview: ui-surfaces probe, branch ui-threads-org, fixture data (#2114, #2115)." },
  { id: "inbox", file: "approvals-inbox-1280-light.png", detail: "Design preview: ui-surfaces probe, branch ui-threads-org, fixture data (#2114)." },
  { id: "integrations", file: "connect-1280-light.png", detail: "Design preview: ui-surfaces probe, branch ui-threads-org, fixture data (#2116)." }
]
