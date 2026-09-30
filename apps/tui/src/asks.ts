/**
 * `ctx.help()`: a worker's `ask` goes to whoever can answer it. `to:"parent"`
 * (the default) goes to the nearest agent above the asker, `to:"person"`
 * straight to the person; a top-level worker's parent is the person. An agent
 * holder answers with `agent.answer`; one that has not after
 * {@link escalateAfter} frames, or cannot answer (parked, settled, gone, or
 * blocked in an ask of its own), hands the ask one level up, and past the
 * root it reaches the person, who answers through the flow form (`a` in the
 * overview or the worker's tab). Asks live in memory.
 */
import { Schema } from "effect"
import { randomUUID } from "node:crypto"
import type { Tab } from "./workspace.ts"

/** Frames an agent holder gets before the ask moves one level up. */
export const escalateAfter = 3
/** The holder that is not an agent. No tab id is empty, so it never names one. */
export const person = ""

export interface Ask {
  readonly id: string
  /** The asking worker's tab id. */
  readonly from: string
  readonly question: string
  readonly options?: ReadonlyArray<string>
  /** A tab id, or {@link person}. */
  readonly holder: string
  /** Holders so far, first to last: `implement/api → plan → you`. */
  readonly trail: ReadonlyArray<string>
  readonly askedAt: number
  /** The holder's frames that could read it; a steered ask counts from the frame after delivery. */
  readonly frames: number
  /** `agent.wait` has returned it to its holder, which then gets it no more that way. */
  readonly returned: boolean
}

export interface Input {
  readonly question: string
  readonly options?: ReadonlyArray<string> | undefined
  readonly to?: "parent" | "person" | undefined
}

export interface Ports {
  readonly tab: (id: string) => Tab | undefined
  /** Delivers text to a running agent before its next frame; false when it is not running. */
  readonly tell: (id: string, text: string, shown: string) => boolean
  readonly changed: () => void
}

/** What a holding agent reads: the question and how to answer. */
export const message = (ask: Ask, title: string): string =>
  `Child "${title}" asks (${ask.id}): ${ask.question}${
    ask.options === undefined || ask.options.length === 0 ? "" : ` Options: ${ask.options.join(" | ")}.`
  } Answer with agent.answer({id: "${ask.id}", answer}). Unanswered after ${escalateAfter} of your frames it goes up.`

/** The form an ask opens: a choice among its options, else free text. */
export const schema = (ask: Pick<Ask, "options">): Schema.Top =>
  ask.options !== undefined && ask.options.length > 0
    ? Schema.Struct({ answer: Schema.Literals(ask.options as [string, ...Array<string>]) })
    : Schema.Struct({ answer: Schema.String.check(Schema.isMinLength(1)) })

type Open = Ask & { readonly settle: (answer: string) => void; readonly refuse: (reason: string) => void }

export class Asks {
  private asks = new Map<string, Open>()
  constructor(private readonly ports: Ports) {}

  /** Opens an ask and resolves with its answer. An abort (the asker stopped) withdraws it. */
  ask(from: Tab, input: Input, signal?: AbortSignal): Promise<string> {
    // Unique across restarts: a resumed holder's history may still name an old id.
    const id = `ask-${randomUUID().slice(0, 8)}`
    return new Promise((resolve, reject) => {
      const withdraw = () => {
        if (this.asks.delete(id)) this.ports.changed()
        reject(new Error("Ask withdrawn"))
      }
      if (signal?.aborted === true) return withdraw()
      signal?.addEventListener("abort", withdraw, { once: true })
      const holder = input.to === "person" ? person : this.next(from, undefined)
      const ask: Open = {
        id,
        from: from.id,
        question: input.question,
        ...(input.options === undefined || input.options.length === 0 ? {} : { options: input.options }),
        holder,
        trail: [holder],
        askedAt: Date.now(),
        frames: 0,
        returned: false,
        settle: (answer: string) => {
          signal?.removeEventListener("abort", withdraw)
          resolve(answer)
        },
        refuse: (reason: string) => {
          signal?.removeEventListener("abort", withdraw)
          reject(new Error(reason))
        }
      }
      this.asks.set(id, ask)
      this.deliver(ask)
      this.ports.changed()
    })
  }

  /** Settles an ask. A tab may answer only an ask it holds; the person may answer any. */
  answer(id: string, answer: string, by: string = person): boolean {
    const ask = this.asks.get(id)
    if (ask === undefined || (by !== person && ask.holder !== by)) return false
    this.asks.delete(id)
    ask.settle(answer)
    this.ports.changed()
    return true
  }

  /** Fails an open ask with `reason`: nobody can answer it. */
  refuse(id: string, reason: string): boolean {
    const ask = this.asks.get(id)
    if (ask === undefined) return false
    this.asks.delete(id)
    ask.refuse(reason)
    this.ports.changed()
    return true
  }

  /** A holding agent finished a frame: past {@link escalateAfter} its asks move up. */
  frame(tabId: string): void {
    let moved = false
    for (const ask of this.asks.values()) {
      if (ask.holder !== tabId) continue
      const frames = ask.frames + 1
      if (frames < escalateAfter) this.asks.set(ask.id, { ...ask, frames })
      else moved = this.escalate(ask) || moved
    }
    if (moved) this.ports.changed()
  }

  /** Re-checks every holder: one that stopped listening passes its asks up. */
  check(): void {
    let moved = false
    for (const ask of this.asks.values()) {
      if (ask.holder !== person && !this.listening(this.ports.tab(ask.holder))) moved = this.escalate(ask) || moved
    }
    if (moved) this.ports.changed()
  }

  /**
   * A holder starts `agent.wait`: an ask a wait already returned to it and it
   * left unanswered moves up at once, so a wait never blocks on its own ask.
   */
  waited(tabId: string): void {
    let moved = false
    for (const ask of this.asks.values()) {
      if (ask.holder === tabId && ask.returned) moved = this.escalate(ask) || moved
    }
    if (moved) this.ports.changed()
  }

  /** What a holder's `agent.wait` returns early with: the asks it holds that no wait has returned. */
  take(tabId: string): ReadonlyArray<Ask> {
    const taken = [...this.asks.values()].filter((ask) => ask.holder === tabId && !ask.returned)
    for (const ask of taken) this.asks.set(ask.id, { ...ask, returned: true })
    return taken.map(plain)
  }

  /** Whether a tab holds an ask no wait has returned. */
  waiting(tabId: string): boolean {
    return [...this.asks.values()].some((ask) => ask.holder === tabId && !ask.returned)
  }

  /** Open asks, oldest first. */
  list(): ReadonlyArray<Ask> {
    return [...this.asks.values()].map(plain)
  }

  get(id: string): Ask | undefined {
    const ask = this.asks.get(id)
    return ask === undefined ? undefined : plain(ask)
  }

  /** The ask the person holds from this worker, if any. */
  fromPerson(tabId: string): Ask | undefined {
    return this.list().find((ask) => ask.from === tabId && ask.holder === person)
  }

  /** Whether a worker is blocked in an ask of its own. */
  asking(tabId: string): boolean {
    return [...this.asks.values()].some((ask) => ask.from === tabId)
  }

  /**
   * An agent that can read and answer: it runs, or it waits on its children, and it is not blocked
   * asking or parked for the person driving it.
   */
  private listening(tab: Tab | undefined): boolean {
    return tab !== undefined && (tab.status === "running" || tab.status === "waiting") && !this.asking(tab.id) &&
      !(tab.driver !== undefined && tab.status === "waiting")
  }

  /** Where an ask held by `holder` (or first asked by `from`) goes next. */
  private next(from: Tab, holder: string | undefined): string {
    let parent = holder === undefined ? from.parent : this.ports.tab(holder)?.parent
    // A holder that cannot answer passes it on at once.
    while (parent !== undefined && !this.listening(this.ports.tab(parent))) parent = this.ports.tab(parent)?.parent
    return parent ?? person
  }

  private escalate(ask: Open): boolean {
    const from = this.ports.tab(ask.from)
    if (from === undefined || ask.holder === person) return false
    const holder = this.next(from, ask.holder)
    const moved: Open = { ...ask, holder, trail: [...ask.trail, holder], frames: 0, returned: false }
    this.asks.set(ask.id, moved)
    this.deliver(moved)
    return true
  }

  private deliver(ask: Open): void {
    // A waiting holder gets it from `agent.wait`; a running one before its next frame. The frame
    // running now settles before it reads the message, so it does not count.
    if (ask.holder === person || this.ports.tab(ask.holder)?.status !== "running") return
    const title = this.ports.tab(ask.from)?.title ?? ask.from
    if (this.ports.tell(ask.holder, message(ask, title), `? ${title} asks: ${ask.question}`)) {
      this.asks.set(ask.id, { ...ask, frames: -1 })
    }
  }
}

const plain = ({ settle: _settle, refuse: _refuse, ...ask }: Open): Ask => ask
