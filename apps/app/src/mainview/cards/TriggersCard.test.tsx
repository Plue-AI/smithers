import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { describeEvent, describeSchedule } from "./TriggerEvents"
import { TriggerListCardBody } from "./TriggersCard"

/*
 * The dispatcher card (factory mock 2): declared rows say their event in
 * words and the flow they start under the "declared in .smithers/FACTORY.ts"
 * pill; live columns exist only when a box answered; a signed-out card has
 * no live column and no placeholder for one; with nothing declared and no
 * box the card is exactly one sentence; and Register is the button door of
 * triggers.register carrying the repository.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const REPO = "smithersai/smithers"

type TriggerListCard = Extract<Card, { kind: "trigger-list" }>
type Payload = TriggerListCard["payload"]

const triggerCard = (payload: Partial<Payload>): TriggerListCard => ({
  id: `trigger-list-${REPO}`,
  kind: "trigger-list",
  title: `Dispatcher · ${REPO}`,
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { repo: REPO, triggers: [], ...payload }
})

/** The day-one table of design §7, as the projection carries it. */
const DECLARED: NonNullable<Payload["declared"]> = [
  { event: "issue.opened", flow: "issue", description: "Triage every new issue" },
  { event: "issue.labeled:smithers", flow: "implement" },
  { event: "change.landed", flow: ["wiki", "history.fold"] },
  { event: "github.push:main", flow: "history.fold" },
  { event: "schedule:0 9 * * 1-5", flow: "review", description: "Weekday morning review of main" }
]

const render = (
  card: TriggerListCard,
  onRunCommand: (name: string, args?: string) => void = () => {}
): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<TriggerListCardBody card={card} onRunCommand={onRunCommand} />)
  })
  return host
}

/** The two rows every button test draws: one Smithers Cloud named, one only the trigger store holds. */
const TWO_ROWS: Partial<Payload> = {
  declared: [],
  live: true,
  triggers: [
    { id: "registration-nightly", slug: "nightly", flowId: "nightly-lint", cron: "0 9 * * 1-5", timezone: "UTC", enabled: true },
    { id: "sweep", flowId: "issue", cron: "*/15 * * * *", enabled: false }
  ]
}

describe("the event a trigger waits for, in words", () => {
  test("names the common schedules and prints the zone only when the trigger declared one", () => {
    expect(describeSchedule("0 9 * * 1-5", "UTC")).toBe("Every weekday at 09:00 UTC")
    expect(describeSchedule("30 17 * * *")).toBe("Every day at 17:30")
    expect(describeSchedule("0 8 * * 1,3,5", "Europe/London")).toBe("Every Monday, Wednesday, Friday at 08:00 Europe/London")
    expect(describeSchedule("0 0 * * 0")).toBe("Every Sunday at 00:00")
    expect(describeSchedule("*/15 * * * *")).toBe("Every 15 minutes")
    expect(describeSchedule("0 * * * *")).toBe("Every hour")
    expect(describeSchedule("0 */6 * * *")).toBe("Every 6 hours")
    expect(describeSchedule("30 */6 * * *")).toBe("Every 6 hours at 30 minutes past")
    expect(describeSchedule("15 */2 * * *")).toBe("Every 2 hours at 15 minutes past")
    expect(describeSchedule("* * * * *")).toBe("Every minute")
    expect(describeSchedule("0 6 1 * *", "UTC")).toBe("Monthly on day 1 at 06:00 UTC")
  })

  test("a schedule the shorthand cannot say is shown as its expression", () => {
    expect(describeSchedule("0 9 * 1-6 1-5")).toBe("On the schedule 0 9 * 1-6 1-5")
    expect(describeSchedule("5 4 * * sun", "UTC")).toBe("On the schedule 5 4 * * sun UTC")
    expect(describeSchedule("not a cron")).toBe("On the schedule not a cron")
  })
})

describe("the event a declared rule waits for, in words", () => {
  test("says every key of the vocabulary and its parameterized families", () => {
    expect(describeEvent("issue.opened")).toBe("On a new issue")
    expect(describeEvent("issue.labeled:smithers")).toBe("On an issue labeled smithers")
    expect(describeEvent("issue.closed")).toBe("On an issue closed")
    expect(describeEvent("change.opened")).toBe("On a Change opened")
    expect(describeEvent("change.updated")).toBe("On a Change updated")
    expect(describeEvent("change.landed")).toBe("On a Change landed")
    expect(describeEvent("box.session.ended")).toBe("On a box session ended")
    expect(describeEvent("github.push:main")).toBe("GitHub push on main")
    expect(describeEvent("schedule:0 9 * * 1-5")).toBe("Every weekday at 09:00")
    expect(describeEvent("schedule:*/15 * * * *")).toBe("Every 15 minutes")
    expect(describeEvent("schedule:0 10 * * 1")).toBe("Every Monday at 10:00")
    expect(describeEvent("nomination")).toBe("On a nomination")
    expect(describeEvent("manual")).toBe("Started by hand")
  })

  test("a key the vocabulary does not know is printed as itself, never guessed at", () => {
    expect(describeEvent("release.tagged")).toBe("release.tagged")
    expect(describeEvent("schedule:")).toBe("schedule:")
    expect(describeEvent("  issue.opened ")).toBe("On a new issue")
  })
})

describe("the dispatcher card", () => {
  test("declared rows render in words with the flow they start, under the declared-in pill", () => {
    const host = render(triggerCard({ declared: DECLARED, live: false }))
    expect(host.querySelector("[data-testid='trigger-declared-pill']")?.textContent).toBe("declared in .smithers/FACTORY.ts")
    const rows = [...host.querySelectorAll("[data-source='declared']")]
    expect(rows.map((row) => row.getAttribute("data-rule"))).toEqual([
      "issue.opened",
      "issue.labeled:smithers",
      "change.landed",
      "github.push:main",
      "schedule:0 9 * * 1-5"
    ])
    /* A description is the sentence with the flow beside it; without one the row says what runs. */
    expect(rows[0]?.textContent).toBe("On a new issueTriage every new issue (issue)")
    expect(rows[1]?.textContent).toBe("On an issue labeled smithersruns implement")
    expect(rows[2]?.textContent).toBe("On a Change landedruns wiki, history.fold")
    expect(rows[3]?.textContent).toBe("GitHub push on mainruns history.fold")
    expect(rows[4]?.textContent).toBe("Every weekday at 09:00Weekday morning review of main (review)")
    expect(host.querySelector("[data-testid='trigger-list-empty']")).toBeNull()
  })

  test("signed out there is no live column and no placeholder for one", () => {
    const host = render(triggerCard({ declared: DECLARED, live: false }))
    expect(host.querySelector("[data-testid='trigger-live']")).toBeNull()
    expect(host.querySelector("[data-source='box']")).toBeNull()
    expect(host.querySelector("[data-trigger]")).toBeNull()
    expect(host.textContent).not.toMatch(/listening|enabled|disabled|next /)
    /* Live rows persisted on an older card still stay out of a card whose box did not answer this time. */
    const stale = render(
      triggerCard({
        declared: DECLARED,
        live: false,
        triggers: [{ id: "nightly", flowId: "review", cron: "0 9 * * 1-5", enabled: true }]
      })
    )
    expect(stale.querySelector("[data-source='box']")).toBeNull()
    expect(stale.textContent).not.toMatch(/enabled/)
  })

  test("registered schedules add the live columns: listening, state, next fire", () => {
    const host = render(
      triggerCard({
        declared: DECLARED.slice(0, 1),
        live: true,
        triggers: [
          {
            id: "nightly",
            flowId: "review",
            cron: "0 9 * * 1-5",
            timezone: "UTC",
            enabled: true,
            nextFireAt: Date.now() + 3_600_000
          },
          { id: "sweep", flowId: "issue", cron: "*/15 * * * *", enabled: false }
        ]
      })
    )
    expect(host.querySelector("[data-testid='trigger-live']")?.textContent).toBe("listening")
    /* Declared rows first, then the box's. */
    expect([...host.querySelectorAll("[data-source]")].map((row) => row.getAttribute("data-source"))).toEqual([
      "declared",
      "box",
      "box"
    ])
    const nightly = host.querySelector("[data-trigger='nightly']")
    expect(nightly?.textContent).toContain("Every weekday at 09:00 UTC")
    expect(nightly?.textContent).toContain("runs review")
    expect(host.querySelector("[data-testid='trigger-state-nightly']")?.textContent).toMatch(
      /^enabled · next .+$/
    )
    expect(host.querySelector("[data-testid='trigger-state-sweep']")?.textContent).toBe("disabled")
  })

  test("with nothing declared and no box answering, the card is exactly one sentence", () => {
    const host = render(triggerCard({ declared: [], live: false }))
    expect(host.querySelector("[data-testid='trigger-list-empty']")?.textContent).toBe("No rules declared yet")
    expect(host.querySelector("[data-testid='trigger-list']")).toBeNull()
    expect(host.querySelector("[data-testid='trigger-declared-pill']")).toBeNull()
    expect(host.textContent).not.toContain("trigger store")
    /* A card persisted before the declaration joined the listing carries neither field and still renders the sentence. */
    const legacy = render(triggerCard({}))
    expect(legacy.querySelector("[data-testid='trigger-list-empty']")?.textContent).toBe("No rules declared yet")
    /* A listening box with nothing registered and nothing declared: still the sentence, beside the fact that it listens. */
    const listening = render(triggerCard({ declared: [], live: true }))
    expect(listening.querySelector("[data-testid='trigger-list-empty']")?.textContent).toBe("No rules declared yet")
    expect(listening.querySelector("[data-testid='trigger-live']")?.textContent).toBe("listening")
  })

  test("Register is the button door of triggers.register and carries the repository", () => {
    const calls: Array<[string, string | undefined]> = []
    const host = render(triggerCard({ declared: DECLARED, live: false }), (name, args) => calls.push([name, args]))
    const button = host.querySelector<HTMLButtonElement>("[data-testid='trigger-register']")
    expect(button?.dataset.flow).toBe("triggers.register")
    expect(button?.textContent).toBe("Register a rule")
    button?.click()
    expect(calls).toEqual([["triggers.register", REPO]])
    /* The one button: nothing in the card removes or edits a declared rule. */
    expect(host.querySelectorAll("button")).toHaveLength(1)
  })

  /*
   * The manual fire the canary walk could not press (D-REPORT part 1, "Run
   * now, twice"): a registered schedule's own row carries it, a row the box
   * reported without a registration name does not, and two presses are two
   * dispatches.
   */
  test("Run now is the button door of triggers.run on a registered schedule's row", () => {
    const calls: Array<[string, string | undefined]> = []
    const host = render(
      triggerCard({
        declared: [],
        live: true,
        triggers: [
          { id: "registration-nightly", slug: "nightly", flowId: "nightly-lint", cron: "0 9 * * 1-5", timezone: "UTC", enabled: true },
          { id: "sweep", flowId: "issue", cron: "*/15 * * * *", enabled: false }
        ]
      }),
      (name, args) => calls.push([name, args])
    )
    const run = host.querySelector<HTMLButtonElement>("[data-testid='trigger-run-nightly']")
    expect(run?.dataset.flow).toBe("triggers.run")
    expect(run?.textContent).toBe("Run now")
    run?.click()
    run?.click()
    expect(calls).toEqual([["triggers.run", `nightly ${REPO}`], ["triggers.run", `nightly ${REPO}`]])
    /* A trigger-store row Smithers Cloud never named holds no schedule to fire. */
    expect(host.querySelector("[data-testid='trigger-run-sweep']")).toBeNull()
  })

  /*
   * Pause had no button on any card, so the only way to stop a schedule was
   * the slash path — which fills the form and then answers with the grammar's
   * own refusal, "triggers.pause takes the values its button carries"
   * (CHAT.md B1). The button carries them, so it never meets that sentence.
   */
  test("Pause is the button door of triggers.pause, carrying its values as the object the grammar reads", () => {
    const calls: Array<[string, string | undefined]> = []
    const host = render(triggerCard(TWO_ROWS), (name, args) => calls.push([name, args]))
    const pause = host.querySelector<HTMLButtonElement>("[data-testid='trigger-pause-nightly']")
    expect(pause?.dataset.flow).toBe("triggers.pause")
    expect(pause?.textContent).toBe("Pause")
    pause?.click()
    expect(calls).toEqual([["triggers.pause", JSON.stringify({ slug: "nightly", repo: REPO })]])
    /* Pause is a Plue route keyed by slug; a trigger-store row carries none, and no Control procedure pauses one. */
    expect(host.querySelector("[data-testid='trigger-pause-sweep']")).toBeNull()
  })
})


test("a paused named schedule offers Resume with its repository and slug", () => {
  const raised: Array<[string, string | undefined]> = []
  const host = render(triggerCard({ ...TWO_ROWS, triggers: [{ ...TWO_ROWS.triggers![0]!, enabled: false }] }),
    (name, args) => { raised.push([name, args]) })
  const button = host.querySelector<HTMLButtonElement>("[data-testid='trigger-resume-nightly']")!
  expect(button.tagName).toBe("BUTTON")
  expect(button.textContent).toBe("Resume")
  button.click()
  expect(raised).toEqual([["triggers.resume", `nightly ${REPO}`]])
  expect(host.querySelector("[data-testid='trigger-pause-nightly']")).toBeNull()
  expect(host.querySelector("[data-testid='trigger-run-nightly']") === null).toBe(true)
})

test("a failed Pause remains visible and retries the same repository and schedule", () => {
  const raised: Array<[string, string | undefined]> = []
  const host = render(triggerCard({ pauseRequests: [{
    id: "pause-1", slug: "missing", owner: "will", phase: "failed", error: "Could not confirm Pause."
  }] }), (name, args) => { raised.push([name, args]) })
  const notice = host.querySelector<HTMLElement>('[role="status"][data-fault]')!
  expect(notice.querySelector(":scope > p")?.textContent).toBe("Smithers could not pause this schedule. Not your fault.")
  expect(notice.querySelector("details")?.open).toBe(false)
  expect(notice.querySelector("details pre")?.textContent).toBe("Could not confirm Pause.")
  const retry = [...host.querySelectorAll("button")].find(button => button.textContent === "Retry")!
  expect(retry.tagName).toBe("BUTTON")
  retry.click()
  expect(raised.map(([name, args]) => [name, JSON.parse(args!)])).toEqual([["triggers.pause", { slug: "missing", repo: REPO }]])
})


test("an unread failed preparation offers Retry with the full draft without claiming no rules exist", () => {
  const raised: Array<[string, string | undefined]> = []
  const draft = { flow: "lint", slug: "nightly", schedule: "0 9 * * *", input: '{"args":"keep --flow inside input"}', tokens: 1000, minutes: 5 }
  const host = render(triggerCard({ preparations: [{ id: "prepare-1", owner: "will", phase: "failed", draft, error: "Try again" }] }),
    (name, args) => { raised.push([name, args]) })
  expect(host.querySelector('[data-testid="trigger-list-empty"]') === null).toBe(true)
  const retry = host.querySelector<HTMLButtonElement>('[aria-label="Retry preparation for nightly"]')!
  retry.click()
  expect(raised.map(([name, args]) => [name, JSON.parse(args!)])).toEqual([["triggers.register", { repo: REPO, ...draft, tokens: "1000", minutes: "5" }]])
})
