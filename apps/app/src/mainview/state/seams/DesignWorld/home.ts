/*
 * MOCK SEAM, Home lane (delete with ./index.ts). Maps the seeded design world
 * to the Home card's wire model (`@smthrs/rpc/HomeCard`), which the `home`
 * topic and GET /api/stack serve once the stack service lands (mvp.md §6.3,
 * §7.2). The card file reads it through `useDesignHome`; the stub flows in
 * flows/entries/home.ts resolve a row's `n` back to a seeded TODO here.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react"
import { createCollection, localOnlyCollectionOptions, localStorageCollectionOptions, type StorageApi } from "@tanstack/db"
import { PlaceholderAvatarUrl, type Actor, type PersonRef, type TodoState } from "@smthrs/rpc/CardPrimitives"
import type { Action } from "@smthrs/rpc/CardAction"
import type { HomeCard, HomeItem, HomeViewProps } from "@smthrs/rpc/HomeCard"
import { useDesign, useDesignViewer, useDesignWorld } from "./hooks"
import { goToBranch } from "./shell"
import {
  branchOf, canMerge, machineSlots, memberOf, mergeReadiness, needsAction, openItems, stackItems,
  type ActorId, type DesignMergeReadiness, type DesignResult, type DesignTodo, type DesignWorld, type DesignWorldRows
} from "./index"

/** A TODO's wire number from its ref: T9 → 9. */
export const designTodoNumber = (todo: DesignTodo): number => Number(todo.ref.slice(1)) || 1

/** The seeded TODO a wire number names. */
export const designTodoByNumber = (world: DesignWorldRows, n: number): DesignTodo | undefined =>
  world.todos.find(each => each.ref === `T${n}`)

const STATES: Readonly<Record<DesignTodo["state"], TodoState>> = {
  queued: "queued", starting: "starting", working: "working", "needs-you": "needs_you", paused: "paused",
  "in-review": "in_review", merged: "merged", failed: "failed", dropped: "dropped"
}

const lane = (value: number): 0 | 1 | 2 | 3 | 4 | 5 => Math.min(5, Math.max(0, value)) as 0 | 1 | 2 | 3 | 4 | 5

const personRef = (world: DesignWorldRows, who: ActorId): PersonRef => {
  const member = memberOf(world, who)
  return { login: member?.login ?? who, name: member?.name ?? who, avatar_url: PlaceholderAvatarUrl }
}

/** A design actor id as a wire Actor: a member, a branch's coding agent, or Smithers. */
export const designActor = (world: DesignWorldRows, who: ActorId): Actor => {
  if (who.startsWith("agent:")) {
    const branch = branchOf(world, who.slice("agent:".length))
    const item = branch?.item === undefined ? undefined : world.todos.find(each => each.id === branch.item)
    const owner = item === undefined ? undefined : memberOf(world, item.owner)
    return { kind: "agent", id: who, agent: "coding", avatar_url: PlaceholderAvatarUrl,
      ...(owner === undefined ? {} : { for_member: personRef(world, owner.id) }), color_index: owner === undefined ? 6 : lane(owner.lane) }
  }
  const [person, via] = who.split("~")
  const member = memberOf(world, person ?? who)
  if (member === undefined) return { kind: "agent", id: who, agent: "smithers", avatar_url: PlaceholderAvatarUrl, color_index: 6 }
  if (via === undefined || via === "ssh") return { kind: "person", ...personRef(world, member.id), ...(via === "ssh" ? { via: "ssh" as const } : {}), color_index: lane(member.lane) }
  return { kind: "agent", id: who, agent: via === "claude" ? "claude-code" : via === "codex" ? "codex" : "smithers",
    avatar_url: PlaceholderAvatarUrl, for_member: personRef(world, member.id), color_index: lane(member.lane) }
}

/** The shared readiness rule as the wire Merge: the reason word plus its detail. */
const mergeOf = (readiness: DesignMergeReadiness): HomeItem["merge"] => {
  if (readiness.state === "ready" || readiness.state === "done") return { state: readiness.state, on_github: false }
  const reason = readiness.reason
  const github = readiness.github === true
  if (reason === "Not in review yet") return { state: readiness.state, reason: "state", on_github: false }
  if (reason.startsWith("Merges after ")) return { state: readiness.state, reason: "order", detail: reason.slice("Merges after ".length), on_github: false }
  if (reason.startsWith("Checks running")) return { state: readiness.state, reason: "rechecking", detail: reason.slice("Checks running".length).trim() || undefined, on_github: false }
  if (github) return { state: readiness.state, reason: "github", detail: reason.replace(/^GitHub /, ""), on_github: true }
  return { state: readiness.state, reason: "checks", detail: reason, on_github: false }
}

const menu = (n: number, first: boolean, last: boolean): Action[] => [
  ...(first ? [] : [{ tag: "stack.move" as const, label: "Move up", args: { n: String(n), direction: "up" } }]),
  ...(last ? [] : [{ tag: "stack.move" as const, label: "Move down", args: { n: String(n), direction: "down" } }]),
  { tag: "todo.drop", label: "Drop", args: { n: String(n) } }
]

/** The row's one action (design Home.tsx rowAction), then the ⋯ menu. */
const rowActions = (world: DesignWorldRows, todo: DesignTodo, viewer: ActorId, first: boolean, last: boolean): Action[] => {
  const n = designTodoNumber(todo)
  const args = { n: String(n) }
  /* The title opens the TODO card (design Home.tsx button.mvp-link); first, so its `door` arg tells it from Answer/Review. */
  const own: Action[] = [{ tag: "todo", label: todo.title, args: { ...args, door: "title" } }]
  /* The branch chip opens the row's branch (design Home.tsx BranchChip onOpen). */
  const branch = branchOf(world, todo.branch)
  own.push({ tag: "branch", label: branch?.name ?? todo.branch, args: { ...args, door: "branch" } })
  if (todo.state === "needs-you") {
    const word = needsAction(todo)
    /* Answer is the question's door: pressed without an answer it opens the TODO card, where the answer is typed (design Home.tsx). */
    own.push(word === "Answer" ? { tag: "todo.answer", label: word, args, primary: true } : { tag: "todo", label: word, args })
  }
  if (todo.state === "in-review") own.push(mergeReadiness(world, todo).state === "ready" && canMerge(world, viewer)
    ? { tag: "merge", label: "Merge", args, primary: true }
    : { tag: "todo", label: "Review", args })
  if (todo.state === "failed") own.push({ tag: "todo.retry", label: "Retry", args })
  if (todo.state === "paused") own.push({ tag: "todo.resume", label: "Resume", args })
  return [...own, ...menu(n, first, last)]
}

/** The Home model one viewer sees. `syncedAt` is when main last synced, in ms. */
export const designHomeModel = (world: DesignWorldRows, viewer: ActorId, syncedAt: number): HomeCard => {
  const repo = world.repo
  const open = openItems(world)
  const counts: Record<TodoState, number> = { queued: 0, starting: 0, working: 0, needs_you: 0, paused: 0, failed: 0, in_review: 0, merged: 0, dropped: 0 }
  for (const todo of stackItems(world)) counts[STATES[todo.state]] += 1
  const merged = stackItems(world).filter(each => each.state === "merged").map(designTodoNumber)
  const items: HomeItem[] = open.map((todo, index) => {
    const branch = branchOf(world, todo.branch)
    const steps = todo.steps ?? repo.flow
    const step = todo.step === undefined ? undefined : steps.find(each => each.id === todo.step)?.title ?? todo.step
    const waiting = branch?.machine === "waiting" ? branch.waitPosition ?? 1 : undefined
    const position = todo.queue ?? (todo.state === "queued" ? waiting : undefined)
    return {
      n: designTodoNumber(todo),
      title: todo.title,
      state: STATES[todo.state],
      owner: personRef(world, todo.owner),
      place: index + 1,
      ...(position === undefined ? {} : { queue: { reason: "machine" as const, position } }),
      ...(step === undefined || todo.state === "queued" ? {} : { step }),
      ...(branch?.rebasePending === undefined ? {} : { rebase_pending: { onto: branch.rebasePending } }),
      merge: mergeOf(mergeReadiness(world, todo)),
      ...(todo.approvalCleared === true ? { approval_cleared: true } : {}),
      ...(todo.lessons === undefined ? {} : { lessons: todo.lessons }),
      ...(todo.pr === undefined ? {} : { pr: { number: todo.pr, draft: false } }),
      branch: { id: todo.branch, name: branch?.name ?? todo.branch },
      present: todo.state === "queued" ? [] : (branch?.presence ?? []).map(each => designActor(world, each.who)),
      amendments: todo.amendments?.length ?? 0,
      actions: rowActions(world, todo, viewer, index === 0, index === open.length - 1)
    }
  })
  const slots = machineSlots(world).flatMap(slot => slot.kind === "branch"
    ? [{ branch: slot.branch.name, awake: slot.branch.machine === "awake",
        actor: designActor(world, slot.branch.item === undefined
          ? slot.branch.presence.find(each => !each.who.startsWith("agent"))?.who ?? `agent:${slot.branch.id}`
          : `agent:${slot.branch.id}`) }]
    : slot.kind === "run" ? [{ branch: slot.run.title, awake: true, actor: designActor(world, "smithers") }] : [])
  const health = repo.mainHealth
  return {
    repository: repo.repo,
    main: {
      sha: repo.mainSha,
      title: repo.mainHead?.text ?? "main",
      last_success_at: new Date(syncedAt).toISOString(),
      health: health?.state ?? (repo.syncedAgo > 120 ? "stale" : "fresh"),
      ...(health === undefined ? {} : { cause: health.cause }),
      ...(health?.retryAt === undefined ? {} : { retry_at: health.retryAt })
    },
    attention: [],
    items,
    counts,
    merged_since_last_look: [...Array.from({ length: repo.mergedSinceLook }, (_, index) => index + 1), ...merged],
    machines: { in_use: slots.length, capacity: repo.capacity, slots },
    ...(memberOf(world, viewer)?.role === "owner" ? { parallel: repo.parallel } : {}),
    background_runs: world.runs.filter(run => run.state !== "done").map(run => ({
      id: run.id,
      title: run.title,
      state: run.queue !== undefined ? "queued" as const : run.state === "failed" ? "failed" as const : "running" as const,
      ...(run.queue !== undefined ? { detail: `Queued · #${run.queue}` } : run.detail === undefined ? {} : { detail: run.detail }),
      actions: run.state === "failed"
        ? [{ tag: "background.retry" as const, label: "Retry", args: { id: run.id } }, { tag: "background.dismiss" as const, label: "Dismiss", args: { id: run.id } }]
        : []
    }))
  }
}

/** The viewer's role on the seeded world. */
export const designRole = (world: DesignWorldRows, viewer: ActorId): "owner" | "maintainer" | "member" =>
  memberOf(world, viewer)?.role ?? "member"

/** `/stack`: back to main, where Home stands first (spec §14.3; the shell's `branch main`). */
export const openDesignHome = (design: DesignWorld, who: ActorId): DesignResult => {
  const went = goToBranch(design, who, "main")
  return went.ok ? { ok: true, ack: "Opened the stack" } : went
}

/*
 * The Home card's per-member view state (mvp.md §7.2 `view:<member>:main`, mocked). The filter is
 * kept across reloads in this browser; whether the card is on screen is this tab's alone.
 */
export interface DesignHomeView { readonly id: ActorId; readonly filter?: TodoState | undefined }
export interface DesignHomeScreen { readonly id: ActorId; readonly on_screen: boolean }
export const HOME_VIEW_STORAGE_KEY = "smithers.design.home-view"

/** Browser storage that never throws: a private window or blocked site data falls back to memory. */
const safeStorage = (): StorageApi => {
  const memory = new Map<string, string>()
  const local = (): Storage | undefined => { try { return globalThis.localStorage ?? undefined } catch { return undefined } }
  return {
    getItem: key => { try { const value = local()?.getItem(key); if (value !== null && value !== undefined) return value } catch { /* memory below */ } return memory.get(key) ?? null },
    setItem: (key, value) => { memory.set(key, value); try { local()?.setItem(key, value) } catch { /* kept in memory */ } },
    removeItem: key => { memory.delete(key); try { local()?.removeItem(key) } catch { /* kept in memory */ } }
  }
}
const noStorageEvents = { addEventListener: () => {}, removeEventListener: () => {} }
const uid = () => globalThis.crypto?.randomUUID?.() ?? String(Date.now())

const createHomeViews = (storage: StorageApi) => {
  const collection = createCollection(localStorageCollectionOptions<DesignHomeView, ActorId>({
    id: `design-home-view-${uid()}`, storageKey: HOME_VIEW_STORAGE_KEY, storage,
    storageEventApi: typeof window === "undefined" ? noStorageEvents : window,
    getKey: row => row.id
  }))
  collection.preload()
  return collection
}
const createHomeScreens = () => createCollection(localOnlyCollectionOptions<DesignHomeScreen, ActorId>({
  id: `design-home-screen-${uid()}`, getKey: row => row.id, initialData: []
}))
const homeViews = new WeakMap<DesignWorld, ReturnType<typeof createHomeViews>>()
const homeScreens = new WeakMap<DesignWorld, ReturnType<typeof createHomeScreens>>()
/** One view collection per DesignWorld instance; `storage` is the browser's unless a test supplies one. */
export const homeViewsOf = (design: DesignWorld, storage: StorageApi = safeStorage()) => {
  const existing = homeViews.get(design)
  if (existing !== undefined) return existing
  const created = createHomeViews(storage)
  homeViews.set(design, created)
  return created
}
const homeScreensOf = (design: DesignWorld) => {
  const existing = homeScreens.get(design)
  if (existing !== undefined) return existing
  const created = createHomeScreens()
  homeScreens.set(design, created)
  return created
}

/** The member's Home view: the remembered filter, plus whether the card is on screen once reported. */
export const designHomeView = (design: DesignWorld, who: ActorId): HomeViewProps["view"] => {
  const filter = homeViewsOf(design).get(who)?.filter
  const onScreen = homeScreensOf(design).get(who)?.on_screen
  return { maximized: false, ...(filter === undefined ? {} : { filter }), ...(onScreen === undefined ? {} : { on_screen: onScreen }) }
}

/** Patch the member's Home view. Idempotent: a value it already holds writes nothing. Answers whether it wrote. */
export const setDesignHomeView = (design: DesignWorld, who: ActorId, patch: Parameters<HomeViewProps["onView"]>[0]): boolean => {
  let wrote = false
  if ("filter" in patch) {
    const views = homeViewsOf(design)
    const filter = patch.filter as TodoState | undefined
    const current = views.get(who)
    if (current === undefined) { if (filter !== undefined) { views.insert({ id: who, filter }); wrote = true } }
    else if (current.filter !== filter) { views.update(who, draft => { draft.filter = filter }); wrote = true }
  }
  if (patch.on_screen !== undefined) {
    const screens = homeScreensOf(design)
    const current = screens.get(who)
    if (current === undefined) { screens.insert({ id: who, on_screen: patch.on_screen }); wrote = true }
    else if (current.on_screen !== patch.on_screen) { screens.update(who, draft => { draft.on_screen = patch.on_screen! }); wrote = true }
  }
  return wrote
}

/** The tab member's Home view and its one stable, idempotent writer (the card's `onView`). */
export const useDesignHomeView = (): { readonly view: HomeViewProps["view"]; readonly onView: HomeViewProps["onView"] } => {
  const design = useDesign()
  const viewer = useDesignViewer()
  const subscribe = useCallback((notify: () => void) => {
    const views = homeViewsOf(design).subscribeChanges(notify)
    const screens = homeScreensOf(design).subscribeChanges(notify)
    return () => { views.unsubscribe(); screens.unsubscribe() }
  }, [design])
  const readFilter = () => homeViewsOf(design).get(viewer)?.filter
  const readScreen = () => homeScreensOf(design).get(viewer)?.on_screen
  const filter = useSyncExternalStore(subscribe, readFilter, readFilter)
  const onScreen = useSyncExternalStore(subscribe, readScreen, readScreen)
  const view = useMemo(() => ({ maximized: false, ...(filter === undefined ? {} : { filter }), ...(onScreen === undefined ? {} : { on_screen: onScreen }) }), [filter, onScreen])
  const onView = useCallback((patch: Parameters<HomeViewProps["onView"]>[0]) => { setDesignHomeView(design, viewer, patch) }, [design, viewer])
  return { view, onView }
}

/** The Home model for this tab's member (`?as=ben`), re-derived on every world change. */
export const useDesignHome = (): { readonly model: HomeCard; readonly role: "owner" | "maintainer" | "member" } => {
  const viewer = useDesignViewer()
  const world = useDesignWorld()
  /* main's last sync moves only when `syncedAgo` changes; the View's 1 s clock ages it from there. */
  const syncedAt = useMemo(() => Date.now() - world.repo.syncedAgo * 1000, [world.repo.syncedAgo])
  return useMemo(() => ({ model: designHomeModel(world, viewer, syncedAt), role: designRole(world, viewer) }), [world, viewer, syncedAt])
}
