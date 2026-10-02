/*
 * J4. The team's work (mvp.md §5, P0, async). Maya's screen, in the morning.
 * She answers one question, merges the next item after reading its evidence,
 * moves a ready item above a failed one, and retries the failure with a steer.
 * All three machines are busy, so work she resumes is Working but waits for the
 * next free machine; its branch activity says so, and the timeline shows it.
 * Timeline entries report her own background work while she keeps chatting.
 */
import type { Journey } from "../journey"
import { activity, branch, reply, run, say, setTodo, showCard, stackOp, toast, todo, type State } from "../world"
import { MAYA, seedState } from "./seed"
import { buildMorning, CHECKOUT_EVIDENCE, LIMITS_EVIDENCE, passedAgain, RATES_EVIDENCE, rerunning, STRIPE_LESSONS } from "./j4-data"

const ANSWER = "Exponential backoff, capped at 5 minutes."
const STEER = "Break created_at ties with the invoice id."
const QUESTION = "What does #95 change?"
const REPLY = "It limits /v1 to 100 requests a minute per API key."

/* Machines change hands: a TODO that opens its PR releases its machine, and the next one in line takes it. */
const release = (state: State, id: string): void => {
  const target = branch(state.world, id)
  target.machine = "asleep"
  target.presence = []
}

const wake = (state: State, id: string, step: string): void => {
  const target = branch(state.world, id)
  target.machine = "awake"
  target.waitPosition = undefined
  target.presence = [{ who: `agent:${id}`, where: { kind: "step", step } }]
}

const waitFor = (state: State, id: string, position: number): void => {
  const target = branch(state.world, id)
  target.machine = "waiting"
  target.waitPosition = position
  target.presence = []
}

/* Queue places that shift because someone joined ahead; the row keeps quiet about it. */
const logWaits = (state: State, position: number): void => {
  todo(state.world, "t-log").queue = position
  waitFor(state, "b-log", position)
}

const finish = (state: State, id: string, detail: string): void => {
  state.world.runs = state.world.runs.map(each => each.id === id ? { ...each, state: "done" as const, detail, seq: state.seq } : each)
}

const setup = (): State => {
  const state = seedState([MAYA])
  buildMorning(state.world)
  showCard(state, MAYA, "home", "acme/api")
  return state
}

export const j4: Journey = {
  id: "j4",
  title: "The team's work",
  spec: "J4",
  intro: "Morning. Maya, the owner, opens Smithers. The home card is the team's stack, and all 3 machines are busy.",
  viewers: [MAYA],
  setup,
  steps: [
    {
      caption: "Needs you 2, Working 3, Queued 1, In review 4, and 5 merged since she last looked.",
      target: '[data-mock="card-home"] .mvp-filters', hover: true, hold: 2800,
      show: [{ viewer: MAYA, target: '[data-mock="card-home"] .mvp-filters' }],
      act: () => {}
    },
    {
      caption: "Retry failed webhooks needs an answer. Answer opens its TODO card with the agent's question.",
      target: '[data-mock="answer-t-retry"]', hold: 2400,
      act: state => { showCard(state, MAYA, "todo", "t-retry") }
    },
    {
      caption: "She answers. Its machine went to other work while it waited, and all 3 are busy, so it queues first in line.",
      target: '[data-mock="answer-input-t-retry"]', typing: { into: "answer:t-retry", text: ANSWER }, hold: 3000,
      act: state => {
        const item = todo(state.world, "t-retry")
        item.question = { text: item.question!.text, answer: { by: MAYA, text: ANSWER } }
        activity(state, "b-retry", MAYA, "answer", ANSWER)
        setTodo(state, "t-retry", { state: "queued", queue: 1, step: undefined })
        waitFor(state, "b-retry", 1)
        activity(state, "b-retry", "agent:b-retry", "step", "Waiting for a machine · #1", "run")
        logWaits(state, 2)
      }
    },
    {
      caption: "Next to merge is the Stripe upgrade. Merge opens its evidence first: the diff, checks run on the machine, GitHub checks and the agent's review.",
      target: '[data-mock="merge-t-stripe"]', hold: 3000,
      act: state => { showCard(state, MAYA, "todo", "t-stripe") }
    },
    {
      caption: "She merges. The card shows the receipt, and learning starts in the background.",
      target: '[data-mock="evidence-t-stripe"] [data-mock="merge-t-stripe"]', hold: 2400,
      act: state => {
        setTodo(state, "t-stripe", { state: "merged" })
        branch(state.world, "b-stripe").machine = "closed"
        run(state, { id: "learn-88", title: "Learning from #88", state: "running" })
        run(state, { id: "wiki-88", title: "Wiki refresh", state: "running" })
      }
    },
    {
      caption: "Cache exchange rates is green, but it merges after #90, which failed. She opens its ⋯ menu.",
      target: '[data-mock="more-t-rates"]', hold: 2000,
      show: [{ viewer: MAYA, target: '[data-mock="menu-t-rates"]' }],
      act: state => { showCard(state, MAYA, "home", "acme/api", "menu:t-rates") }
    },
    {
      caption: "Move up makes it next to merge. The rebase clears its earlier approval, and its checks rerun.",
      target: '[data-mock="move-up-t-rates"]', hold: 2600,
      show: [{ viewer: MAYA, target: '[data-mock="row-t-rates"]' }],
      act: state => {
        const { world } = state
        world.stack = world.stack.map(id => id === "t-invoices" ? "t-rates" : id === "t-rates" ? "t-invoices" : id)
        setTodo(state, "t-rates", { approvalCleared: true, mergeBlock: "Checks running", evidence: rerunning(RATES_EVIDENCE) })
        stackOp(state, "b-rates", "Moved up · rebased onto main", MAYA)
        showCard(state, MAYA, "home", "acme/api", "")
        toast(state, MAYA, { tone: "running", title: "Cache exchange rates", detail: "Rebased onto main · checks running" })
      }
    },
    {
      caption: "Meanwhile Rate-limit the public API opens PR #95. Its machine goes to Retry failed webhooks: Starting, with her answer.",
      hold: 3000,
      show: [{ viewer: MAYA, target: '[data-mock="row-t-limits"]' }],
      act: state => {
        setTodo(state, "t-limits", { state: "in-review", step: undefined, elapsed: undefined, pr: 95, evidence: LIMITS_EVIDENCE })
        release(state, "b-limits")
        setTodo(state, "t-retry", { state: "starting", queue: undefined })
        wake(state, "b-retry", "verify")
        activity(state, "b-retry", "agent:b-retry", "step", "Switching to exponential backoff", "run")
        logWaits(state, 1)
      }
    },
    {
      caption: "Paginate GET /invoices failed at Verify. Retry opens the failure.",
      target: '[data-mock="row-t-invoices"] [data-mock="retry-t-invoices"]', hold: 2200,
      act: state => {
        setTodo(state, "t-retry", { state: "working", step: "verify", elapsed: "13m" })
        showCard(state, MAYA, "todo", "t-invoices")
      }
    },
    {
      caption: "She retries with a steer. A new attempt queues, first in line for the next free machine.",
      target: '[data-mock="retry-input-t-invoices"]', typing: { into: "retry:t-invoices", text: STEER }, hold: 2800,
      act: state => {
        setTodo(state, "t-invoices", { state: "queued", queue: 1, step: undefined, failure: undefined, attempts: 2 })
        activity(state, "b-invoices", MAYA, "steer", STEER)
        waitFor(state, "b-invoices", 1)
        activity(state, "b-invoices", "agent:b-invoices", "step", "Waiting for a machine · #1", "run")
        logWaits(state, 2)
      }
    },
    {
      caption: "While her retry waits, she asks the app agent about #95 and gets an instant answer. The timeline reports the moved item passed its checks.",
      keys: "⌘ K", typing: { into: "composer", text: QUESTION }, hold: 3000,
      pre: state => { state.viewers[MAYA]!.composerOpen = true },
      act: state => {
        say(state, MAYA, QUESTION)
        reply(state, MAYA, REPLY)
        setTodo(state, "t-rates", { mergeBlock: undefined, evidence: passedAgain(RATES_EVIDENCE) })
        toast(state, MAYA, { tone: "ok", title: "Cache exchange rates", detail: "Checks passed · next to merge", action: "Open" })
      }
    },
    {
      caption: "Fix the flaky checkout test opens PR #96. Its machine goes to her retry: Starting, with her steer.",
      hold: 2800,
      show: [{ viewer: MAYA, target: '[data-card="todo:t-invoices:maya"]' }],
      act: state => {
        setTodo(state, "t-checkout", { state: "in-review", step: undefined, elapsed: undefined, pr: 96, evidence: CHECKOUT_EVIDENCE })
        release(state, "b-checkout")
        setTodo(state, "t-invoices", { state: "starting", queue: undefined })
        wake(state, "b-invoices", "implement")
        activity(state, "b-invoices", "agent:b-invoices", "step", "Breaking created_at ties with the invoice id", "run")
        logWaits(state, 1)
      }
    },
    {
      caption: "Learning leaves 2 lessons on #88, and the wiki refresh finishes. The failed run from overnight stays until someone retries or dismisses it.",
      hold: 3000,
      show: [{ viewer: MAYA, target: '[data-mock="card-home"] .mvp-runs' }],
      act: state => {
        setTodo(state, "t-invoices", { state: "working", step: "implement", elapsed: "1m" })
        setTodo(state, "t-stripe", { lessons: STRIPE_LESSONS })
        finish(state, "learn-88", `${STRIPE_LESSONS} lessons`)
        finish(state, "wiki-88", "4 pages")
      }
    },
    {
      caption: "Needs you 1, Working 3, Queued 1, In review 5. Cache exchange rates is next and ready to merge; the rename conflict waits for Alice.",
      target: '[data-mock="card-home"] .mvp-filters', hover: true, hold: 3200,
      show: [{ viewer: MAYA, target: '[data-mock="card-home"] .mvp-filters' }],
      act: () => {}
    }
  ]
}
