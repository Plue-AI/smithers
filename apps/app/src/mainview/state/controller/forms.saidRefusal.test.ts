import { stubCommandActions } from "../../flows/StubCommandActions"
import { expect, test } from "bun:test"
import { createCommandRegistry } from "../../flows/Commands"
import type { Card, Message } from "../AppState"
import type { ControllerContext } from "./context"
import { createFailureController } from "./failures"
import { createFormsController } from "./forms"

/*
 * Canary W1 item 3a, second half. A consequential door whose refusal has to
 * outlive a four-second toast appends the sentence to the transcript itself
 * and returns it; the form card must not print the same sentence underneath.
 * Which transcript line that is cannot be "the last one": between the door's
 * `message.appended` and the form's patch any other actor may append — and
 * then the tail comparison the first fix used goes false and the duplicate is
 * back. The door marks its own line (`Message.spoken`) and the form reads the
 * mark, within this submission only.
 *
 * And it reads the mark by CLAIMING it (controller/spokenLines.ts). A door's
 * line stands in for at most one act, so a row that merely matched the
 * sentence yielded to a line another act had already been given: two lost
 * acts, one line, with the second act's word going to a form card that then
 * printed nothing. The last test here is that shape.
 */
const REFUSAL = 'No schedule "canary-w1-not-registered" is registered on will/flows.'
const AFTERWARDS = "Started a new conversation. Open the archived conversation."
/** One of the closed lost-act sentences (state/BrowserWriteFailure.ts), which is why two acts carry the same one. */
const STORAGE_FULL =
  "This browser has no room left for Smithers' saved data, so that change was not saved. Free space for this site in your browser settings, then make the change again."

interface Door {
  /** Append a transcript line as any actor; `spoken` marks it as the door's own. */
  readonly append: (text: string, spoken?: true) => void
  /**
   * Another lost act, admitted in the same window and settling in the
   * surfacing path first, takes a door's line for itself.
   */
  readonly anotherActTakes: (sentence: string) => void
}

const fixture = (submit: (door: Door) => string) => {
  const cards = new Map<string, Card>()
  const messages = new Map<string, Message>()
  let ordinal = 0
  const append = (text: string, spoken?: true) => {
    ordinal += 1
    const id = `message-${ordinal}`
    messages.set(id, { id, role: "smithers", text, status: "complete", createdAt: ordinal, ordinal, ...(spoken === undefined ? {} : { spoken }) })
  }
  const store = {
    session: () => ({ activeRepoKey: null }),
    collections: { cards, messages, toasts: new Map(), repositories: new Map(), workingCopies: new Map(), harnesses: new Map() },
    dispatch: (event: { type: string; card?: Card; text?: string }) => {
      if (event.type === "card.upsert") cards.set(event.card!.id, event.card!)
      if (event.type === "message.appended") append(event.text!)
      return { isPersisted: { promise: Promise.resolve() } }
    }
  }
  const actions = stubCommandActions({
    repositoryFlows: () => undefined,
    knownRepositories: () => new Set<string>(),
    noteCommandRun: () => {},
    traceFlow: () => {},
    snapshot: () => ({ surface: "chat", typing: false, hasConnectors: true, admin: false, signedOut: false })
  })
  const registry = createCommandRegistry(actions)
  // Both acts were admitted before either settled, so they share one window.
  let surface: ((sentence: string, window: number) => void) | undefined
  const commands = { ...registry, submit: async () => {
    const window = ordinal
    return {
      status: "failed" as const,
      error: submit({ append, anotherActTakes: (sentence) => surface?.(sentence, window) })
    }
  } }
  const context = {
    store, commands, commandActor: "user",
    disposed: false,
    onDispose: () => {},
    unref: () => {},
    toastRuns: new Map<string, number>(),
    toastDebounceMs: 0,
    toastAutoDismissMs: 0
  } as unknown as ControllerContext
  // The surfacing path and the form card are two surfaces of one controller.
  const failures = createFailureController(context)
  surface = (sentence, window) =>
    failures.surfaceCommandFailure("runs.open", { status: "failed", error: sentence, persistenceFailed: true, writeRefused: true }, window)
  return { forms: createFormsController(context, { nextOrdinal: () => 1 }), cards, messages, append }
}

const errorOn = (cards: Map<string, Card>, cardId: string): string | undefined => {
  const card = cards.get(cardId)
  return card?.kind === "flow-form" ? card.payload.error : "no card"
}

const submitted = async (fields: ReturnType<typeof fixture>) => {
  const rendered = fields.forms.renderFlowForm({ name: "browser.open", args: undefined, via: "user" })!
  await fields.forms.setFormField(rendered.cardId, "url", "https://example.com")
  await fields.forms.submitForm(rendered.cardId)
  return rendered.cardId
}

test("a refusal the door said stays off the form card even when another line lands after it", async () => {
  const fields = fixture(({ append }) => {
    append(REFUSAL, true)
    append(AFTERWARDS)
    return REFUSAL
  })
  expect(errorOn(fields.cards, await submitted(fields))).toBeUndefined()
})

test("a refusal no door said is still the card's to state", async () => {
  const fields = fixture(() => REFUSAL)
  expect(errorOn(fields.cards, await submitted(fields))).toBe(REFUSAL)
})

test("a sentence a door said before this submission lands on the card the person is looking at", async () => {
  const fields = fixture(() => REFUSAL)
  fields.append(REFUSAL, true)
  expect(errorOn(fields.cards, await submitted(fields))).toBe(REFUSAL)
})

test("a door's line already spent on another act is not this form's to yield to", async () => {
  const fields = fixture(({ append, anotherActTakes }) => {
    // One door speaks, once, inside both acts' window.
    append(STORAGE_FULL, true)
    // Act A settles first and the line is given to it.
    anotherActTakes(STORAGE_FULL)
    return STORAGE_FULL
  })
  // Act B is this form's own submission. Its word is its error row.
  expect(errorOn(fields.cards, await submitted(fields))).toBe(STORAGE_FULL)
  // And act A still has the door's line: the transcript gained nothing for it.
  expect([...fields.messages.values()].filter(message => message.text === STORAGE_FULL)).toHaveLength(1)
})
