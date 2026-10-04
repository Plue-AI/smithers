/*
 * MOCK SEAM, chat lane (delete with ./index.ts). The app agent's plain-word
 * answers and its A✓ confirmations (mvp.md §6.5, Appendix B) read and write
 * the seeded world here. A prompt maps to the flows the agent runs at once,
 * a one-line reply with the context it rests on, or a confirmation it posts
 * instead of acting; the controller runs the flows through the registry as
 * the person ("Smithers for Ben") and settles the turn.
 *
 * What replaces each part:
 *   designTurn         -> the host turn runner (T-APP-16) with its preflight
 *                         context list (T-APP-17, `context[]` on the answer)
 *   acts, designActCard -> topic `confirmations:<member>` rendered by
 *                         ConfirmView one_click (T-APP-04)
 *   designMergeCard    -> the same topic's review_merge row (`merge.confirm`)
 */
import { useMemo } from "react"
import type { CatalogTag } from "@smthrs/rpc/CardAction"
import type { ContextItem, PersonRef } from "@smthrs/rpc/CardPrimitives"
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import type { ConfirmCard } from "@smthrs/rpc/ConfirmCard"
import type { Card } from "../../AppState"
import type { CardActionDefinition } from "../../../flows/cardActions"
import { branchOf, memberOf, todoOf, traceOf, type ActorId, type DesignAct, type DesignBranch, type DesignTodo, type DesignWorldRows } from "./index"
import { useDesignWorld } from "./hooks"
import { designActor } from "./shell"
import { DESIGN_CARD } from "./subjects"
import { designAudience, designTodoCard, refNumber } from "./todo"

/* ── The app agent's turn ──────────────────────────────────── */

/** One flow the agent runs, through the registry, as the person who asked. */
export interface DesignStep { readonly name: string; readonly payload: Record<string, unknown> }

/** What a plain prompt does (Appendix B: A runs at once, A✓ asks first, merge opens Review & merge). */
export interface DesignTurn {
  readonly run: ReadonlyArray<DesignStep>
  /** The one-line answer; absent when a card is the answer. */
  readonly reply?: string
  /** The Context line under the answer: what it rests on. */
  readonly context?: ReadonlyArray<ContextItem>
  /** A✓: posted in the asker's conversation; nothing happens until they press it. */
  readonly ask?: Omit<DesignAct, "id" | "state" | "by">
  /** The person's own Review & merge for this TODO id; the agent never merges. */
  readonly merge?: string
  /** A wiki write runs at once: the page this answer becomes. */
  readonly wiki?: { readonly title: string; readonly lines: ReadonlyArray<string> }
}

/** `/theme` (was theme): the flow a theme request runs. */
export const THEME_FLOW = "theme"

const CHECKOUT_TEST = "src/checkout/checkout.test.ts"
const RACE_TITLE = "Await the payment intent in the checkout test"
const RACE_PROMPT = "In checkout.test.ts, await result.settled before asserting the status, so the test no longer races the payment intent."
const RACE_ANSWER = "It checks the status before the payment intent settles."

const firstName = (world: DesignWorldRows, who: ActorId): string => (memberOf(world, who)?.name ?? who).split(" ")[0]!

/** A TODO named by ref ("T10", "#88" for its PR) or by a word of its title ("the checkout TODO"). */
const todoNamed = (world: DesignWorldRows, text: string): DesignTodo | undefined => {
  const words = text.toLowerCase().replace(/^the\s+/, "").replace(/\s+todo$/, "").trim()
  const pr = /^#(\d+)$/.exec(words)
  if (pr !== null) return world.todos.find(each => each.pr === Number(pr[1]))
  const ref = /^t(\d+)$/.exec(words)
  if (ref !== null) return world.todos.find(each => each.ref.toLowerCase() === `t${ref[1]}`)
  return world.todos.find(each => each.title.toLowerCase().includes(words) || branchOf(world, each.branch)?.name === words)
}

const branchNamed = (world: DesignWorldRows, text: string): DesignBranch | undefined => {
  const name = text.trim().replace(/[?.!]+$/, "")
  return world.branches.find(each => each.id === name || each.name === name) ?? (() => {
    const todo = todoNamed(world, name)
    return todo === undefined ? undefined : branchOf(world, todo.branch)
  })()
}

/**
 * The app agent's reading of a plain prompt, or undefined when this mock has
 * no answer and the real turn runs. `at` is the branch the asker is in.
 */
export const designTurn = (world: DesignWorldRows, viewer: ActorId, prompt: string, at = "main"): DesignTurn | undefined => {
  const text = prompt.trim().replace(/\s+/g, " ")
  const lower = text.toLowerCase()
  let match: RegExpExecArray | null

  if ((match = /^(?:who'?s|who is) on (.+?)\??$/i.exec(text)) !== null) {
    const branch = branchNamed(world, match[1]!)
    return branch === undefined ? undefined : { run: [{ name: "branch", payload: { name: branch.id } }] }
  }

  if (/\b(dark|light) mode\b|\btheme\b/.test(lower)) {
    const mode = /\bdark\b/.test(lower) ? "dark" : /\blight\b/.test(lower) ? "light" : undefined
    return {
      run: [{ name: THEME_FLOW, payload: mode === undefined ? {} : { mode } }],
      reply: `Changed ${firstName(world, viewer)}'s theme${mode === undefined ? "" : ` to ${mode}`}.`
    }
  }

  if (/\bflaky\b/.test(lower) && /\bcheckout\b|\btest\b/.test(lower)) {
    const file = world.files.find(each => each.path === CHECKOUT_TEST)
    if (file === undefined) return undefined
    const page = world.wiki.find(each => each.id === "payments-testing")
    const item = world.todos.find(each => each.branch === file.branch)
    const trace = item === undefined ? undefined : traceOf(world, item.id)
    return {
      run: [{ name: "file", payload: { path: file.path, branch: file.branch, line: 6 } }],
      reply: RACE_ANSWER,
      context: [
        { kind: "file", label: "checkout.test.ts", ref: file.path, revision: file.branch },
        ...(page === undefined ? [] : [{ kind: "page" as const, label: `wiki: ${page.title}`, ref: page.id, revision: `r${page.rev}` }]),
        ...(item === undefined ? [] : [{ kind: "run" as const, label: `${item.ref} run`, ref: trace?.id ?? item.id }])
      ]
    }
  }

  if (/^save (?:that|this|it) to the wiki/.test(lower)) {
    const title = "Checkout test race"
    return { run: [], reply: `Saved to the wiki as ${title}.`, wiki: { title, lines: [`The checkout test ${RACE_ANSWER.slice(3)}`, "Code: `checkout.test.ts` lines 6–8"] } }
  }

  if (/^make (?:that|this|it) a todo/.test(lower)) {
    return { run: [{ name: "todo.new", payload: { title: RACE_TITLE, text: RACE_PROMPT } }] }
  }

  if ((match = /^merge (.+)$/i.exec(text)) !== null) {
    const todo = todoNamed(world, match[1]!)
    return todo === undefined ? undefined : { run: [], merge: todo.id }
  }

  if ((match = /^(stop|pause|resume|retry) (.+)$/i.exec(text)) !== null) {
    const todo = todoNamed(world, match[2]!)
    if (todo === undefined) return undefined
    const verb = match[1]!.toLowerCase()
    const n = refNumber(todo.ref)
    const flow = verb === "resume" ? "todo.resume" : verb === "retry" ? "todo.retry" : "todo.stop"
    const said = verb === "resume" ? `Resumed ${todo.ref}.` : verb === "retry" ? `Retrying ${todo.ref}.` : `Stopped ${todo.ref}.`
    return { run: [{ name: flow, payload: { n } }, { name: "todo", payload: { n } }], reply: said }
  }

  if ((match = /^drop (.+)$/i.exec(text)) !== null) {
    const todo = todoNamed(world, match[1]!)
    if (todo === undefined) return undefined
    const branch = branchOf(world, todo.branch)
    return { run: [], ask: {
      verb: "Drop", target: `${todo.ref} ${branch?.name ?? todo.branch}`, receipt: `Dropped ${todo.ref}`, todo: todo.id,
      tag: "todo.drop", args: { n: refNumber(todo.ref) }
    } }
  }

  if ((match = /^review(?: this branch| (.+))?$/i.exec(text)) !== null) {
    const branch = match[1] === undefined ? branchOf(world, at) : branchNamed(world, match[1])
    if (branch === undefined) return undefined
    return { run: [], ask: {
      verb: "Run review", target: `on ${branch.name}`, text: `/review ${branch.name}`, receipt: `Review ran on ${branch.name}`,
      tag: "review", args: { branch: branch.id }
    } }
  }

  return undefined
}

const STATE_SAID: Record<DesignTodo["state"], string> = {
  queued: "is queued behind the TODOs above it", starting: "is starting", working: "is working",
  "needs-you": "is waiting for an answer", paused: "is paused", "in-review": "is in review",
  merged: "is merged", failed: "failed its last attempt", dropped: "was dropped"
}

/**
 * Any other prompt while no agent provider answers (the mounted design has none):
 * about a TODO it names, or a one-line read of the stack. A runtime with an agent takes the real turn.
 */
export const designPlainTurn = (world: DesignWorldRows, prompt: string, at = "main"): DesignTurn => {
  const text = prompt.trim().replace(/\s+/g, " ")
  const named = /\b(t\d+|#\d+)\b/i.exec(text)
  const todo = named === null ? undefined : todoNamed(world, named[1]!)
  if (todo !== undefined) {
    const asked = todo.state === "needs-you" && todo.question !== undefined && todo.question.answer === undefined ? `: ${todo.question.text}` : "."
    return {
      run: [{ name: "todo", payload: { n: refNumber(todo.ref) } }],
      reply: `${todo.ref} ${STATE_SAID[todo.state]}${asked}`,
      context: [{ kind: "todo", label: `${todo.ref} ${todo.title}`, ref: todo.id }]
    }
  }
  const live = world.todos.filter(each => each.state !== "merged" && each.state !== "dropped")
  const count = (state: DesignTodo["state"]) => live.filter(each => each.state === state).length
  const where = branchOf(world, at)?.name ?? "main"
  return { run: [], reply: `On ${where}: ${count("working")} working, ${count("needs-you")} need you, ${count("in-review")} in review, ${count("queued")} queued.` }
}

/* ── A✓ and Review & merge cards ───────────────────────────── */

/** The retained `confirm` card for an act or a TODO's Review & merge; private to the person who presses it. */
export type ConfirmPresent = Pick<Card, "id" | "kind" | "title" | "payload"> & { readonly audience_member_id: string | null }

export const actCard = (act: DesignAct): ConfirmPresent => ({
  id: `${DESIGN_CARD}confirm:act:${act.id}`, kind: "confirm", title: `${act.verb} ${act.target}?`,
  payload: { id: `act:${act.id}` }, audience_member_id: designAudience(act.by)
})

export const mergeCard = (todo: DesignTodo, viewer: ActorId): ConfirmPresent => ({
  id: `${DESIGN_CARD}confirm:merge:${todo.id}`, kind: "confirm", title: `Merge ${todo.ref} into main?`,
  payload: { id: `merge:${todo.id}` }, audience_member_id: designAudience(viewer)
})

/** What a `confirm` card's payload id names. */
export const confirmSubject = (id: string): { readonly kind: "act" | "merge"; readonly id: string } | undefined => {
  const act = /^act:(.+)$/.exec(id)
  if (act !== null) return { kind: "act", id: act[1]! }
  const merge = /^merge:(.+)$/.exec(id)
  return merge === null ? undefined : { kind: "merge", id: merge[1]! }
}

const personOf = (world: DesignWorldRows, who: ActorId): PersonRef => {
  const member = memberOf(world, who)
  return { login: member?.login ?? who, name: member?.name ?? who, avatar_url: PlaceholderAvatarUrl }
}

export interface DesignConfirm { readonly model: ConfirmCard; readonly actions: ReadonlyArray<CardActionDefinition> }

/** ConfirmView one_click from an act: the primary button is the act's own flow; pressed, the card is its receipt. */
export const designActCard = (world: DesignWorldRows, act: DesignAct): DesignConfirm => {
  const todo = act.todo === undefined ? undefined : todoOf(world, act.todo)
  const model: ConfirmCard = {
    kind: "one_click",
    action: { tag: act.tag as CatalogTag, verb: act.verb },
    summary: `${act.verb} ${act.target}`,
    subject: todo === undefined ? { kind: "branch", ref: act.target } : { kind: "todo", ref: todo.ref },
    ...(act.text === undefined ? {} : { text: act.text }),
    asked_by: designActor(world, act.asker ?? `${act.by}~smithers`),
    ...(act.state === "asked" ? {} : { receipt: { by: personOf(world, act.by), result: act.state === "done" ? "done" : "cancelled", at: "", ...(act.state === "done" ? { text: act.receipt } : {}) } })
  }
  if (act.state !== "asked") return { model, actions: [] }
  /* The mock act names its flow as a string; the catalog types it (T-CAT-01 inference). */
  const primary = { tag: act.tag as CatalogTag, label: act.verb, primary: true, command_input: (act.args ?? {}) as never } as CardActionDefinition
  return { model, actions: [
    primary,
    { tag: "confirm.cancel", label: "Cancel", command_input: { confirmation: act.id, revision: act.id } }
  ] }
}

/** ConfirmView review_merge from a TODO in review: the person's approval, bound to the revision shown. */
export const designMergeCard = (world: DesignWorldRows, todo: DesignTodo, viewer: ActorId): DesignConfirm | undefined => {
  const card = designTodoCard(world, todo)
  const evidence = card.evidence.at(-1)
  if (card.pr === undefined || evidence === undefined) return undefined
  const stale = todo.approvedRev !== undefined && todo.approvedRev !== evidence.revision
  const role = memberOf(world, viewer)?.role
  const ready = card.merge.state === "ready" && role !== "member"
  const model: ConfirmCard = {
    kind: "review_merge",
    action: { tag: "merge", verb: "Merge" },
    summary: `Merge ${todo.ref}`,
    subject: { kind: "todo", ref: todo.ref, revision: evidence.revision },
    asked_by: designActor(world, viewer),
    review: {
      title: todo.title, place: card.place ?? 1, pr: { number: card.pr.number, url: card.pr.url }, evidence,
      ...(todo.approvedRev === undefined ? {} : { approved_revision: todo.approvedRev }), merge: card.merge
    },
    ...(todo.state === "merged" ? { receipt: { by: personOf(world, viewer), result: "done", at: "", text: `Merged ${todo.ref}` } } : {})
  }
  if (todo.state === "merged") return { model, actions: [] }
  const confirmation = `merge:${todo.id}`
  return { model, actions: [
    { tag: "pr", label: "on GitHub ↗", command_input: { number: card.pr.number } },
    { tag: "confirm.cancel", label: "Cancel", command_input: { confirmation, revision: evidence.revision } },
    ...(ready ? [{ tag: "merge", label: stale ? "Review & merge" : "Merge", primary: true, command_input: { n: card.n, reviewed_head_sha: evidence.revision } } as CardActionDefinition]
      : role === "member" ? [{ tag: "merge", label: "Merge", command_input: { n: card.n }, disabled: { reason: "A maintainer merges" } } as CardActionDefinition] : [])
  ] }
}

export const useDesignAct = (id: string): DesignAct | undefined => {
  const world = useDesignWorld()
  return useMemo(() => world.acts.find(each => each.id === id), [world, id])
}
