/*
 * MOCK SEAM, TODO and Draft lane (delete with ./index.ts). Projects the seeded
 * design world into the real rpc models (TodoCard, DraftCard) so the real
 * TodoContainer and DraftContainer render it, and routes every todo.* and
 * draft.* flow handler to the world's stub mutations wherever this host has no
 * TODO provider, whoever is signed in. A host that serves /api/todos takes
 * over through the real TodoSeam beside it, the way HomeCard's homeSource
 * hands the `home` topic to a served provider (mvp.md §6.3, §7.2).
 * AppController wraps createTodoSeam with withDesignTodos; deleting this
 * directory unwraps it.
 */
import { useMemo } from "react"
import { PlaceholderAvatarUrl, type Actor, type EvidenceItem, type PersonRef } from "@smthrs/rpc/CardPrimitives"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import type { DraftCard } from "@smthrs/rpc/DraftCard"
import type { Card } from "@smthrs/rpc/Cards"
import type { Schema } from "effect"
import type { TodoNewInput, TodoAmendInput } from "../../../flows/entries/todo"
import type { SeamContext } from "../SeamContext"
import type { TodoSeam } from "../TodoSeam"
import { useDesign, useDesignWorldOf } from "./hooks"
import {
  OUTSIDE, STACK, branchOf, memberOf, mergeReadiness, openItems, prOf, todoOf, traceOf,
  type ActorId, type DesignDraft, type DesignResult, type DesignTodo, type DesignWorld, type DesignWorldRows
} from "./index"

/** A design draft's audience id, kept apart from real member logins so TodoSeam never reloads it. */
export const designAudience = (who: ActorId): string => `design:${who}`

export const refNumber = (ref: string): number => Number(ref.slice(1)) || 0
export const designTodoByN = (world: DesignWorldRows, n: number): DesignTodo | undefined => world.todos.find(each => each.ref === `T${n}`)

const repoUrl = (world: DesignWorldRows) => `https://github.com/${world.repo.repo}`

const personOf = (world: DesignWorldRows, who: ActorId): PersonRef => {
  const member = memberOf(world, who)
  return { login: member?.login ?? who, name: member?.name ?? who, avatar_url: PlaceholderAvatarUrl }
}
const laneOf = (world: DesignWorldRows, who: ActorId): number => memberOf(world, who)?.lane ?? 6

export const actorOf = (world: DesignWorldRows, who: ActorId): Actor => {
  if (who === OUTSIDE) return { kind: "outside", color_index: 7 }
  if (who === STACK) return { kind: "agent", id: STACK, agent: "smithers", avatar_url: PlaceholderAvatarUrl, color_index: 6 }
  if (who.startsWith("agent:")) {
    const branch = branchOf(world, who.slice("agent:".length))
    const item = branch?.item === undefined ? undefined : todoOf(world, branch.item)
    return { kind: "agent", id: who, agent: "coding", avatar_url: PlaceholderAvatarUrl,
      ...(item === undefined ? {} : { for_member: personOf(world, item.owner), todo: refNumber(item.ref) }),
      color_index: item === undefined ? 6 : laneOf(world, item.owner) }
  }
  if (who.includes("~")) {
    const [person, tool] = who.split("~") as [string, string]
    if (tool === "ssh") return { kind: "person", ...personOf(world, person), via: "ssh", color_index: Math.min(5, laneOf(world, person)) }
    return { kind: "agent", id: who, agent: tool === "claude" ? "claude-code" : tool === "codex" ? "codex" : "smithers",
      avatar_url: PlaceholderAvatarUrl, for_member: personOf(world, person), color_index: laneOf(world, person) }
  }
  return { kind: "person", ...personOf(world, who), color_index: Math.min(5, laneOf(world, who)) }
}

const STATE: Readonly<Record<DesignTodo["state"], TodoCard["state"]>> = {
  queued: "queued", starting: "starting", working: "working", "needs-you": "needs_you", paused: "paused",
  "in-review": "in_review", merged: "merged", failed: "failed", dropped: "dropped"
}

const seconds = (took?: string): number | undefined => {
  if (took === undefined) return undefined
  const minutes = /(\d+)\s*m/.exec(took)?.[1], secs = /(\d+)\s*s/.exec(took)?.[1]
  return minutes === undefined && secs === undefined ? undefined : Number(minutes ?? 0) * 60 + Number(secs ?? 0)
}

const GITHUB_CHECKS = ["build", "unit", "integration", "lint", "typecheck", "e2e", "docs"]

/** The TodoCard the server's `todo:<n>` topic will send, from the seeded row. */
export const designTodoCard = (world: DesignWorldRows, todo: DesignTodo): TodoCard => {
  const branch = branchOf(world, todo.branch)
  const steps = todo.steps ?? world.repo.flow
  const at = steps.findIndex(step => step.id === todo.step)
  const settled = todo.state === "in-review" || todo.state === "merged"
  const stepState = (index: number) => settled ? "done" as const : at < 0 ? "next" as const : index < at ? "done" as const : index > at ? "next" as const
    : todo.state === "needs-you" ? "waiting" as const : todo.state === "failed" ? "failed" as const : todo.state === "paused" ? "paused" as const : "current" as const
  const open = openItems(world)
  const index = open.findIndex(each => each.id === todo.id)
  const trace = traceOf(world, todo.id)
  const pr = prOf(world, todo)
  const evidence = todo.evidence
  const head = evidence?.rev ?? pr?.sha.slice(0, 7) ?? ""
  const prUrl = `${repoUrl(world)}/pull/${todo.pr ?? 0}`
  const readiness = mergeReadiness(world, todo)
  const n = refNumber(todo.ref)
  const asking = todo.state === "needs-you" && todo.question !== undefined && todo.question.answer === undefined
  const github: EvidenceItem[] = evidence === undefined || todo.pr === undefined ? [] : GITHUB_CHECKS.slice(0, evidence.github.total).map((name, at) => ({
    kind: "github_check" as const, name, required: true, url: `${prUrl}/checks`,
    state: evidence.github.failing === name ? "failed" as const : at < evidence.github.passed ? "passed" as const : "pending" as const
  }))
  return {
    n,
    title: todo.title,
    state: STATE[todo.state],
    owner: personOf(world, todo.owner),
    ...(index < 0 ? {} : { place: index + 1 }),
    ...(todo.state === "queued" ? { queue: { reason: "machine" as const, position: todo.queue ?? branch?.waitPosition ?? 1 } } : {}),
    ...(todo.state === "paused" ? { pause: { reason: "person" as const, since: "" } } : {}),
    ...(branch?.rebasePending === undefined ? {} : { rebase_pending: { onto: branch.rebasePending } }),
    ...(todo.step === undefined || settled ? {} : { step: todo.step }),
    prompt_revisions: [
      { text: todo.prompt, acceptance: [], by: actorOf(world, todo.owner), at: "" },
      ...(todo.amendments ?? []).map(each => ({ text: each.text, acceptance: [], by: actorOf(world, each.by), at: "" }))
    ],
    ...(todo.issue === undefined ? {} : { issue: { number: todo.issue, url: `${repoUrl(world)}/issues/${todo.issue}`, fixes: todo.fixes !== false } }),
    branch: { id: todo.branch, name: branch?.name ?? todo.branch,
      machine: branch?.machine === "waiting" ? { state: "waiting", position: branch.waitPosition ?? 1 } : { state: branch?.machine ?? "asleep" } },
    steps: [
      ...steps.map((step, at) => ({ id: step.id, label: step.title, state: stepState(at) })),
      { id: "merge" as const, kind: "wait" as const, state: todo.state === "merged" ? "done" as const : todo.state === "in-review" ? "held" as const : "next" as const }
    ],
    ...(trace === undefined ? {} : { run: { id: trace.id, attempt: trace.attempt,
      indicators: todo.state === "merged" || todo.state === "dropped" ? [] : trace.phases.flatMap(phase =>
        (phase.tone === "thrash" || phase.tone === "wait") && phase.indicator !== undefined ? [{ tone: phase.tone, text: phase.indicator }] : []) } }),
    waits: asking ? [{ id: `w-${todo.id}`, kind: "question", prompt: todo.question!.text, since: "", by: actorOf(world, `agent:${todo.branch}`),
      actions: [{ tag: "todo.answer", label: "Answer", input: [{ name: "answer", label: "Answer", kind: "text", required: true }] }] }]
      : todo.state === "needs-you" && todo.needs !== undefined && todo.needs !== "question" ? [{ id: `w-${todo.id}`,
        kind: todo.needs === "force_push" ? "foreign_push" : todo.needs === "order" ? "conflict" : todo.needs, prompt: todo.question?.text ?? "Needs you", since: "",
        actions: [{ tag: "branch", label: "Open branch" }] }] : [],
    ...(todo.question?.answer === undefined ? {} : { first_answer: { by: actorOf(world, todo.question.answer.by), text: todo.question.answer.text, at: "" } }),
    steers: (todo.steers ?? []).map(each => ({ text: each.text, by: actorOf(world, each.by), at: "" })),
    ...(todo.state === "failed" ? { failure: { step: steps.find(step => step.id === todo.step)?.title ?? "Run", class: "run",
      message: todo.failure ?? "The run failed", retryable: true } } : {}),
    evidence: evidence === undefined ? (todo.flowVersion === undefined ? [] : [{
      attempt: todo.attempts ?? 1, revision: head, items: [{ kind: "flow", name: "TODO flow", version: todo.flowVersion }]
    }]) : [{
      attempt: todo.attempts ?? 1, revision: head,
      items: [
        ...(todo.flowVersion === undefined ? [] : [{ kind: "flow" as const, name: "TODO flow", version: todo.flowVersion }]),
        { kind: "diff", files: evidence.files, added: evidence.added, removed: evidence.removed },
        ...evidence.checks.map(check => ({ kind: "check" as const, name: check.name, state: check.state, ...(seconds(check.took) === undefined ? {} : { took_s: seconds(check.took)! }) })),
        ...github,
        { kind: "review", summary: evidence.reviewing === true ? `Running on ${head}` : evidence.review }
      ],
      ...(evidence.previous === undefined ? {} : { previous: { revision: evidence.previous.rev, items: [{ kind: "review" as const, summary: evidence.previous.review }] } }),
      ...(evidence.reviewing === true ? { reviewing: true } : {})
    }],
    ...(todo.pr === undefined ? {} : { pr: { number: todo.pr, url: prUrl, head, draft: false, included_items: [] } }),
    merge: readiness.state === "ready" || readiness.state === "done" ? { state: readiness.state, on_github: false } : {
      state: readiness.state,
      reason: readiness.reason.startsWith("Merges after") ? "order" : readiness.github === true ? "github" : readiness.failed === true ? "checks" : "state",
      detail: readiness.reason, on_github: readiness.github === true
    },
    ...(todo.lessons === undefined ? {} : { lessons: todo.lessons }),
    ...(todo.approvalCleared === true ? { approval_cleared: true } : {}),
    present: (branch?.presence ?? []).map(each => actorOf(world, each.who))
  }
}

/** The DraftCard fields a draft row stores, from the seeded draft. */
export const designDraftCard = (world: DesignWorldRows, draft: DesignDraft, acceptance: ReadonlyArray<string> = []): DraftCard => {
  const options = openItems(world).map(each => ({ n: refNumber(each.ref), title: each.title, state: STATE[each.state] as Exclude<TodoCard["state"], "merged" | "dropped"> }))
  const target = draft.place.kind === "append" ? undefined : todoOf(world, draft.place.id)
  const committed = draft.committed === undefined ? undefined : todoOf(world, draft.committed)
  const issue = draft.issue === undefined ? undefined : world.issues.find(each => each.number === draft.issue)
  return {
    title: draft.title,
    prompt: draft.prompt,
    acceptance: [...acceptance],
    place: target === undefined || draft.place.kind === "append" ? { mode: "append", options } : { mode: draft.place.kind, n: refNumber(target.ref), options },
    ...(draft.issue === undefined ? {} : { issue: { number: draft.issue, title: issue?.title ?? `#${draft.issue}`, url: `${repoUrl(world)}/issues/${draft.issue}`, fixes: draft.fixes } }),
    ...(committed === undefined ? {} : { committed: { n: refNumber(committed.ref), rev: 1 + (draft.place.kind === "amend" ? (committed.amendments?.length ?? 1) : 0) } }),
    private: committed === undefined
  }
}

/** A TODO card's model and the viewer's role, read live from the seed; undefined when the seed has no Tn. */
export const useDesignTodoCard = (n: number): { readonly model: TodoCard; readonly role: "owner" | "maintainer" | "member" } | undefined => {
  const design = useDesign()
  const world = useDesignWorldOf(design)
  return useMemo(() => {
    const todo = designTodoByN(world, n)
    return todo === undefined ? undefined : { model: designTodoCard(world, todo), role: memberOf(world, design.viewer())?.role ?? "member" }
  }, [world, design, n])
}

const result = (outcome: DesignResult): string | { readonly value: string } => outcome.ok ? { value: outcome.ack } : outcome.refusal

/** Who answers TODO and Draft flows on this host: the seeded world (no provider) or the install's /api/todos. */
export type TodoSource = "seed" | "real"

/** This host's answer to GET /api/todos, asked without holding any flow. */
export interface TodoSourceProbe {
  /** The answer flows route by now: undefined until the host first answers. */
  readonly known: () => TodoSource | undefined
  /** Asks the host unless its answer is settled for good; one request at a time. */
  readonly ask: () => Promise<TodoSource>
}

/** No bootstrap: there is no provider to ask. */
const SEED_ONLY: TodoSourceProbe = { known: () => "seed", ask: () => Promise.resolve("seed") }

/**
 * The TODO provider on this host, from GET /api/todos. No bootstrap, a 404, or a 200 that is not JSON by its
 * content type (a static host or dev server answering index.html) means no provider, for good: the seed stands in.
 * A JSON list is the provider, for good. Anything else is a provider failing or refusing now (an error status,
 * declared JSON that does not decode or is not a list, an unreachable host): it answers real, so its failure
 * shows, and the next flow asks again.
 */
export const todoSourceProbe = (ctx: SeamContext, configured: boolean): TodoSourceProbe => {
  if (!configured) return SEED_ONLY
  let last: TodoSource | undefined
  let held: Promise<TodoSource> | undefined
  const read = async (): Promise<readonly [TodoSource, boolean]> => {
    try {
      const response = await ctx.http(`${ctx.baseUrl}/api/todos`, { credentials: "include" })
      if (response.status === 404) return ["seed", true]
      if (!response.ok) return ["real", false]
      if (!/\bjson\b/i.test(response.headers.get("Content-Type") ?? "")) return ["seed", true]
      const body: unknown = await response.json().catch(() => undefined)
      return ["real", Array.isArray(body)]
    } catch {
      return ["real", false]
    }
  }
  return {
    known: () => last,
    ask: () => held ??= read().then(([source, lasting]) => {
      last = source
      if (!lasting) held = undefined
      return source
    })
  }
}

/** A TODO flow's acknowledgment while this host's provider probe has not answered. */
const REQUESTED = { value: "Requested" } as const

/**
 * Runs `seed` where this host has no TODO provider and `provider` where it has one, for TODO Tn. Before the host
 * first answers, the flow is acknowledged at once and runs, once, when it does.
 */
export type TodoRoute = <T>(n: number, act: ReadonlyArray<unknown>, seed: () => T | Promise<T>, provider: () => T | Promise<T>) =>
  Promise<T | typeof REQUESTED>

/**
 * The TodoSeam the controller exposes: every todo.* and draft.* flow lands on the design world while `source`
 * says this host has no TODO provider, signed in or not, and on the real seam where one exists. A flow that
 * arrives before the host answers is acknowledged at once and runs when it does, in arrival order; a repeat of
 * one still waiting is the same request, and a refusal then shows on the toast stack. A seeded Draft stays on
 * the seed whatever the source, so its edits, Commit and Discard never reach a provider that did not draft it.
 * `todo:<n>` rows the seed opens carry only `n` (TodoBody reads the model live from the seed); draft rows carry
 * the DraftCard the seed projects, rewritten after each edit.
 */
export const withDesignTodos = (real: TodoSeam, ctx: SeamContext, design: DesignWorld,
  source: TodoSourceProbe = SEED_ONLY): TodoSeam & { readonly todoRoute: TodoRoute } => {
  let waiting: Promise<void> = Promise.resolve()
  const queued = new Set<string>()
  /** Route one flow on `card` (its title names a refusal); `ack` answers it while the host has not answered. */
  const route = async <T>(card: string, act: ReadonlyArray<unknown>, seed: () => T | Promise<T>, provider: () => T | Promise<T>, ack: T): Promise<T> => {
    const asked = source.ask()
    const key = JSON.stringify([card, ...act])
    if (queued.has(key)) return ack
    const answer = source.known()
    if (answer !== undefined) return answer === "seed" ? seed() : provider()
    queued.add(key)
    const work = async (): Promise<T | string> => (source.known() ?? await asked) === "seed" ? seed() : provider()
    waiting = waiting.then(async () => {
      const title = ctx.store.collections.cards.get(card)?.title ?? "TODO"
      try { await (ctx.withToast ? ctx.withToast(`todo.route:${key}`, title, title, work, true) : work()) }
      catch (error) { ctx.report?.("todo.route", error) }
      finally { queued.delete(key) }
    })
    return ack
  }
  const acceptance = new Map<string, ReadonlyArray<string>>()
  const me = (): ActorId => design.viewer()
  /* The app agent acts with the member's authority; what it does reads "<member> via Smithers" (ctx.actor is the binding's principal). */
  const by = (): ActorId => ctx.actor() === "smithers" ? `${me()}~smithers` : me()
  const byN = (n: number): DesignTodo | undefined => designTodoByN(design.world(), n)
  const missing = (n: number): string => `No TODO T${n}`
  /** The seed draft a `draft:<id>` card shows, when the seed still holds it. */
  const draftId = (cardId: string): string | undefined => {
    const id = cardId.startsWith("draft:") ? cardId.slice("draft:".length) : cardId
    return design.world().drafts.some(each => each.id === id) ? id : undefined
  }
  const write = (card: Card) => ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card }).isPersisted.promise
  /** Open (or keep) the TODO's card; a card that exists keeps its place. */
  const openTodo = async (todo: DesignTodo): Promise<void> => {
    const id = `todo:${refNumber(todo.ref)}`
    const existing = ctx.store.collections.cards.get(id)
    await write({ id, kind: "todo", title: `${todo.ref} ${todo.title}`, status: "active", createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(), payload: { n: refNumber(todo.ref), requests: [] } })
  }
  const writeDraft = async (id: string): Promise<void> => {
    const world = design.world()
    const draft = world.drafts.find(each => each.id === id)
    if (draft === undefined) return
    const existing = ctx.store.collections.cards.get(`draft:${id}`)
    const model = designDraftCard(world, draft, acceptance.get(id))
    await write({ id: `draft:${id}`, kind: "draft", audience_member_id: model.private ? designAudience(draft.by) : null,
      title: model.title || "New TODO", status: "active", createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(), payload: { ...model, idempotencyKey: id } })
  }
  const commit = async (cardId: string) => {
    const id = draftId(cardId)
    if (id === undefined) return "No such draft"
    const outcome = design.commitDraft(id, me())
    if (!outcome.ok) return outcome.refusal
    await writeDraft(id)
    const todo = outcome.id === undefined ? undefined : todoOf(design.world(), outcome.id)
    if (todo !== undefined) await openTodo(todo)
    return { value: outcome.ack }
  }
  const control = (todo: DesignTodo, operation: "stop" | "resume" | "retry" | "retry-current-flow" | "drop", text?: string): DesignResult => {
    switch (operation) {
      case "stop": return design.stop(todo.id, by())
      case "resume": return design.resume(todo.id, by())
      case "retry":
      case "retry-current-flow": return design.retry(todo.id, by(), text)
      case "drop": return design.drop(todo.id, by())
    }
  }
  const setSeedField = async (id: string, field: string, value: string): Promise<string | void> => {
    let outcome: DesignResult = { ok: true, ack: "Saved" }
    switch (field) {
      case "title": case "prompt": outcome = design.setDraft(id, { [field]: value }); break
      case "fixes": outcome = design.setDraft(id, { fixes: value === "true" }); break
      case "acceptance": {
        let lines: ReadonlyArray<string>
        try { const parsed: unknown = JSON.parse(value); lines = Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : value.split("\n").filter(Boolean) }
        catch { lines = value.split("\n").filter(Boolean) }
        acceptance.set(id, lines)
        break
      }
      case "place": {
        let place: { readonly mode?: string; readonly n?: number }
        try { place = JSON.parse(value) as typeof place } catch { return "Invalid draft value." }
        const target = place.n === undefined ? undefined : designTodoByN(design.world(), place.n)
        outcome = design.setDraft(id, { place: place.mode === "append" || target === undefined ? { kind: "append" }
          : { kind: place.mode === "amend" ? "amend" : "before", id: target.id } })
        break
      }
      default: return "Unknown draft field."
    }
    if (!outcome.ok) return outcome.refusal
    await writeDraft(id)
  }
  const draftOnSeed = async (input: Schema.Schema.Type<typeof TodoNewInput>) => {
    const world = design.world()
    const text = input.text ?? ""
    const before = input.before === undefined ? undefined : designTodoByN(world, input.before)
    const outcome = design.newDraft(me(), { title: input.title ?? text.split("\n")[0]!, prompt: text,
      place: before === undefined ? { kind: "append" } : { kind: "before", id: before.id } })
    if (!outcome.ok || outcome.id === undefined) return outcome.ok ? "No draft" : outcome.refusal
    if (input.acceptance !== undefined) acceptance.set(outcome.id, input.acceptance)
    await writeDraft(outcome.id)
    return { value: "Drafted" }
  }
  /** A Tn flow: the seed's Tn (an unknown number refuses by name), or the provider's. */
  const onTodo = <T>(n: number, act: ReadonlyArray<unknown>, seeded: (todo: DesignTodo) => T | Promise<T>, provider: () => T | Promise<T>) =>
    route<T | string | typeof REQUESTED>(`todo:${n}`, act, () => { const todo = byN(n); return todo === undefined ? missing(n) : seeded(todo) }, provider, REQUESTED)
  /** A card-scoped Draft flow: the seed's own Draft stays on the seed; another goes to the provider, if this host has one. */
  const onDraft = async <T>(cardId: string, act: ReadonlyArray<unknown>, seeded: (id: string) => T | Promise<T>, provider: () => T | Promise<T>, ack: T): Promise<T | string> => {
    const id = draftId(cardId)
    return id !== undefined ? seeded(id) : route<T | string>(cardId, act, () => "No such draft", provider, ack)
  }
  return {
    ...real,
    todoRoute: <T>(n: number, act: ReadonlyArray<unknown>, seed: () => T | Promise<T>, provider: () => T | Promise<T>) =>
      route<T | typeof REQUESTED>(`todo:${n}`, act, seed, provider, REQUESTED),
    showTodo: (n: number) => onTodo(n, ["show"], async todo => {
      await openTodo(todo)
      return { value: `Opened ${todo.ref}` }
    }, () => real.showTodo(n)),
    mergeTodo: (n: number, head: string) => onTodo(n, ["merge", head], todo => result(design.merge(todo.id, me(), head)), () => real.mergeTodo(n, head)),
    newTodo: (input: Schema.Schema.Type<typeof TodoNewInput>) => input.cardId !== undefined
      ? onDraft(input.cardId, ["commit"], () => commit(input.cardId!), () => real.newTodo(input), REQUESTED)
      : route("", ["new", input], () => draftOnSeed(input), () => real.newTodo(input), REQUESTED),
    amendTodo: (input: Schema.Schema.Type<typeof TodoAmendInput>) => input.cardId !== undefined
      ? onDraft(input.cardId, ["commit"], () => commit(input.cardId!), () => real.amendTodo(input), REQUESTED)
      : onTodo(input.n, ["amend", input.text], todo => result(design.amend(todo.id, input.text, by())), () => real.amendTodo(input)),
    setTodoFormField: (cardId: string, field: string, value: string) =>
      onDraft<string | void>(cardId, ["set", field, value], id => setSeedField(id, field, value), () => real.setTodoFormField(cardId, field, value), undefined),
    dismissTodoDraft: (cardId: string) => {
      const id = draftId(cardId)
      // Synchronous, so it reads the last answer: a Draft the seed does not hold is the provider's, unless the seed answers here.
      if (id === undefined) return source.known() !== "seed" && ctx.store.collections.cards.get(cardId)?.kind === "draft" ? real.dismissTodoDraft(cardId) : "No such draft"
      const outcome = design.discardDraft(id)
      if (!outcome.ok) return outcome.refusal
      acceptance.delete(id)
      ctx.dispatch({ type: "card.removed", actor: ctx.actor(), id: `draft:${id}` })
    },
    answerTodo: (n: number, answer: string, wait?: string) =>
      onTodo(n, ["answer", answer, wait], todo => result(design.answer(todo.id, answer, by())), () => real.answerTodo(n, answer, wait)),
    steerTodo: (n: number, text: string) => onTodo(n, ["steer", text], todo => result(design.steer(todo.id, text, by())), () => real.steerTodo(n, text)),
    controlTodo: (n: number, operation: "stop" | "resume" | "retry" | "retry-current-flow" | "drop", text?: string) =>
      onTodo(n, [operation, text], todo => result(control(todo, operation, text)), () => real.controlTodo(n, operation, text))
  }
}
