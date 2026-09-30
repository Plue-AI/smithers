import { expect, test } from "./browserTest"
import type { Page } from "./browserTest"
import { assistantReplyEvidence } from "../contracts/assistantReplyEvidence"
import type { TranscriptBubble } from "../contracts/assistantReplyEvidence"

/*
 * A real turn on the shared backend (`POST /api/agent/turn` on
 * SMITHERS_CLOUD_API) as the Cloud user SMITHERS_CLOUD_TOKEN names. Runs only
 * when the suite is started with SMITHERS_CHAT_STUB=0 (network, model spend).
 */

test.skip(process.env.SMITHERS_CHAT_STUB !== "0", "set SMITHERS_CHAT_STUB=0 to hit the real endpoint")
test.skip(!process.env.SMITHERS_CLOUD_TOKEN, "set SMITHERS_CLOUD_TOKEN to a Smithers Cloud token for the real turn")

const PROMPT = "Reply with the single word: ok"

/** Every bubble in transcript order: role, rendered markdown, and whether it still carries a status marker. */
const transcript = (page: Page): Promise<Array<TranscriptBubble>> =>
  page.locator(".smithers-chat-message").evaluateAll((nodes) =>
    nodes.map((node) => ({
      role: node.getAttribute("data-role") ?? "",
      text: Array.from(node.querySelectorAll(".message-markdown")).map((part) => part.textContent ?? "").join("\n")
        .trim(),
      pending: node.querySelector(".bubble-system-note") !== null
    }))
  )

test("a signed-in turn gets a non-empty reply from the backend", async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto("/")
  const input = page.getByTestId("composer-input")
  await input.fill(PROMPT)
  const before = await transcript(page)
  // The boot transcript already ends in a completed assistant bubble, so a
  // send that starts no turn must not read as a reply.
  expect(assistantReplyEvidence(before, before, PROMPT)).toBeUndefined()

  await page.getByTestId("composer-send").click()
  // Evidence is a completed assistant bubble rendered after this send's own
  // user turn: no failure marker, so the turn finished rather than errored.
  await expect
    .poll(async () => assistantReplyEvidence(before, await transcript(page), PROMPT) !== undefined, {
      timeout: 90_000
    })
    .toBe(true)
  const reply = assistantReplyEvidence(before, await transcript(page), PROMPT)
  expect((reply?.text ?? "").length).toBeGreaterThan(0)
})
