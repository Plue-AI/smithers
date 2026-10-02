/*
 * J7's fixtures (mvp.md J7): retry.ts as it moves through the reel, and T9's
 * history before it starts. T9's coding agent changed lines 9 and 16 against
 * main. Ben's fork rewrites line 9 by hand. #88, the Stripe v17 upgrade,
 * renames the event type on main, which conflicts with T9's line 16 once the
 * new TODO rebases onto it.
 */
import { STACK, type Activity, type CodeLine } from "../world"
import { ALICE } from "./seed"

export const T9_AGENT = "agent:b-retry"

/** The revision Ben forks: T9's work, including the jitter its agent just added. */
export const FORK_REV = "9c4e1b7"

/** retry.ts on main before #88 merges. */
const MAIN = `import { backoff } from "../lib/backoff"
import { post, sleep } from "../lib/http"
import type { WebhookEvent } from "./types"

export async function deliver(event: WebhookEvent) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await post(event.url, event.body)
    if (response.ok) return
    await sleep(30_000)
  }
  throw new DeliveryFailed(event.id)
}

// Resend from the dashboard. It waits first,
// so an endpoint that is down can recover.
export async function redeliver(event: WebhookEvent, delay = 30_000) {
  await sleep(delay)
  return deliver(event)
}`

/** T9's two edits, each against main. */
const T9: Readonly<Record<number, string>> = {
  9: "    await sleep(backoff(attempt))",
  16: "export async function redeliver(event: WebhookEvent, delay = backoff(1)) {"
}

/** What #88 changed on main: the v17 SDK's event type. */
const MAIN_88: Readonly<Record<number, string>> = {
  3: `import type Stripe from "stripe"`,
  5: "export async function deliver(event: Stripe.Event) {",
  16: "export async function redeliver(event: Stripe.Event, delay = 30_000) {"
}

/** Ben's approach, typed by hand: wait as long as the endpoint asks, and back off only without a Retry-After. */
export const HAND = { line: 9, after: "    await sleep(", text: "response.retryAfter ?? backoff(attempt))" } as const

/** The coding agent's resolution of the one conflict: #88's type with T9's delay. */
export const RESOLVED = { line: 16, after: "export async function redeliver(event: ", text: "Stripe.Event, delay = backoff(1)) {" } as const

export const t9Source = (): Array<CodeLine> => MAIN.split("\n").map((text, index) => {
  const edited = T9[index + 1]
  return edited === undefined ? { n: index + 1, text } : { n: index + 1, text: edited, was: text, by: T9_AGENT }
})

/** Rebasing onto main brings #88 in: a line nobody on the branch changed takes main's text, and a changed one now diffs against it. */
export const rebaseOnMain = (lines: ReadonlyArray<CodeLine>): void => {
  for (const line of lines) {
    const main = MAIN_88[line.n]
    if (main === undefined) continue
    if (line.was === undefined) line.text = main
    else line.was = main
  }
}

/** T9 proposed #214, then Alice's review on GitHub sent it back to work. */
export const t9Activity = (): Array<Activity> => [
  { id: "j7-a1", who: T9_AGENT, kind: "step", text: "Planned: backoff for each retry, give up after 5", tone: "ok", seq: 0 },
  { id: "j7-a2", who: STACK, kind: "step", text: "Proposed #214", tone: "ok", seq: 0 },
  { id: "j7-a3", who: ALICE, kind: "steer", text: "Cap each wait at 5 minutes.", github: true, seq: 0 },
  { id: "j7-a4", who: T9_AGENT, kind: "edit", text: "Capped backoff() at 5 minutes", tone: "ok", seq: 0 }
]
