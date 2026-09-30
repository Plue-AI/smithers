/**
 * Messages typed while a turn runs, delivered at the next cell boundary.
 *
 * This is the harness's own steering queue (`@smthrs/harness/Steering`):
 * a message sent with Enter mid-turn reaches the model before its next cell,
 * the way pi steers between tool calls. A drain is idempotent per boundary,
 * as the `Source` contract requires.
 *
 * Taking over (`t`) holds every later boundary: the run parks there until the
 * person drives it (one message, or none, runs one more frame) or releases it,
 * after which it runs on by itself. The hold is in the queue, not the harness:
 * the harness only ever sees a drain that took a while to answer.
 *
 * A park (`ctx.park`) is a question for the person: its boundary waits for
 * {@link Hooks.ask} and delivers the reply. With no one to ask, the drain
 * fails, so the run stops loudly instead of answering its own question.
 */
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Steering from "@smthrs/harness/Steering"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Effect } from "effect"

export interface Queue {
  readonly source: Steering.Source
  readonly steer: (text: string) => void
  /** Removes and returns every message no boundary has delivered yet. */
  readonly take: () => ReadonlyArray<string>
  /** Takes over: every later boundary waits for {@link Queue.drive} or {@link Queue.release}. */
  readonly hijack: () => void
  /** Hands back: the boundary waiting now, and every later one, proceeds. */
  readonly release: () => void
  /**
   * While taken over, sends `text` for the next frame, or runs the waiting frame with nothing new
   * when it is blank. False for a blank one while the run still works.
   */
  readonly drive: (text: string) => boolean
  /** Whether a boundary is waiting for the person now. */
  readonly holding: () => boolean
}

const text = (item: Steering.Item): string =>
  item._tag === "Insert"
    ? item.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    : ""

/** What the owner of a taken-over run does while a boundary waits for the person. */
export interface Hooks {
  /** A boundary started waiting for the person: the run holds no seat. */
  readonly parked?: () => void
  /** The person drove or released: resolves once the run may go on, its seat back. */
  readonly unparked?: () => Promise<void>
  /** A park's question for the person: resolves with their reply; rejects when no one will answer. */
  readonly ask?: (question: string, signal: AbortSignal) => Promise<string>
}

export const make = (hooks: Hooks = {}): Queue => {
  let queue = Steering.empty()
  const drained = new Map<string, Steering.Drain>()
  let hijacked = false
  /** The boundary parked for the person, woken by a drive or a release. One at a time: the harness drains in order. */
  let waiter: (() => void) | undefined
  /** Messages sent while the run worked: each lets one boundary through. */
  let ready = 0
  const wake = () => {
    const resume = waiter
    waiter = undefined
    resume?.()
  }
  const steer = (text: string) => {
    queue = Steering.enqueue(queue, {
      _tag: "Insert",
      delivery: "steer",
      admittedAt: Date.now(),
      message: new ModelRequest.UserMessage({ role: "user", content: [ModelRequest.TextPart.make({ text })] })
    })
  }
  /** Parks here unless the person already sent a message or released; decided where it parks, so none is lost. */
  const hold = Effect.suspend(() => {
    let parked = false
    return Effect.andThen(
      Effect.callback<void>((resume) => {
        if (!hijacked) return resume(Effect.void)
        if (ready > 0) {
          ready--
          return resume(Effect.void)
        }
        parked = true
        waiter = () => resume(Effect.void)
        hooks.parked?.()
        return Effect.sync(() => {
          waiter = undefined
        })
      }),
      Effect.suspend(() => (parked && hooks.unparked !== undefined ? Effect.promise(hooks.unparked) : Effect.void))
    )
  })
  /** Puts a park's question to the person and queues the reply, or fails when no one answers. */
  const answer = (question: string) =>
    Effect.tryPromise({
      try: (signal) =>
        hooks.ask === undefined ? Promise.reject(new Error("no one to ask")) : hooks.ask(question, signal),
      catch: () => new HarnessError({ code: "suspended", message: `No one answered: ${question}` })
    }).pipe(Effect.map(steer))
  return {
    steer,
    take: () => {
      const texts = queue.items.map(text).filter((entry) => entry !== "")
      queue = Steering.empty()
      return texts
    },
    hijack: () => {
      hijacked = true
      ready = 0
    },
    release: () => {
      hijacked = false
      ready = 0
      wake()
    },
    drive: (text) => {
      const blank = text.trim() === ""
      // A blank Enter only moves a run that waits for it.
      if (blank && waiter === undefined) return false
      if (!blank) steer(text)
      if (waiter === undefined) ready++
      else wake()
      return true
    },
    holding: () => waiter !== undefined,
    source: Steering.make({
      read: () => Effect.sync(() => queue),
      drain: (input) =>
        Effect.suspend(() => {
          if (drained.has(input.boundary)) return Effect.succeed({ ...drained.get(input.boundary)!, duplicate: true })
          return Effect.andThen(
            hijacked ? hold : input.park === undefined ? Effect.void : answer(input.park.message),
            Effect.sync(() => {
              const seen = drained.get(input.boundary)
              if (seen !== undefined) return { ...seen, duplicate: true }
              const drain = { ...Steering.drainAtClose(queue, Date.now()), duplicate: false }
              queue = drain.remaining
              drained.set(input.boundary, drain)
              return drain
            })
          )
        })
    })
  }
}
