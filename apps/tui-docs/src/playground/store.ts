/** One atomic persistence boundary for files, completed calls, and their visible history. */
export type Files = Record<string, string>
export type Event = { kind: string; text: string }
export type Reply = { request: string; text: string }
export type Run = {
  id: string
  prompt: string
  context: Event[]
  initial: Files
  replies: Reply[]
  calls: Record<string, { input: string; result: unknown; files: Files }>
  status: "requested" | "running" | "done" | "failed"
  error?: string
}
export type Frame = { files: Files; events: Event[]; run?: Run }
export type Branch = { id: string; title: string; frames: Frame[] }
export type State = { version: 1; current: string; branches: Branch[] }
export interface Storage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
export const storageKey = "smithers.tui.playground.v1"
export const seed: Files = {
  "math.js": "export const add = (a, b) => a - b\n",
  "check.js": "assert(add(2, 3) === 5)\nassert(add(-2, 3) === 1)\n"
}
const copy = <T>(value: T): T => structuredClone(value)
const initial = (): State => ({
  version: 1,
  current: "main",
  branches: [{ id: "main", title: "main", frames: [{ files: copy(seed), events: [] }] }]
})
export class Journal {
  state: State
  private storage: Storage
  constructor(storage: Storage) {
    this.storage = storage
    const raw = storage.getItem(storageKey)
    if (raw === null) this.state = initial()
    else {
      const parsed = JSON.parse(raw) as State
      if (
        parsed.version !== 1 || !Array.isArray(parsed.branches) ||
        !parsed.branches.some((b) => b.id === parsed.current && b.frames.length > 0)
      ) throw new Error("Saved sandbox is unreadable. Export or clear site data to restart.")
      this.state = parsed
    }
  }
  get branch() {
    return this.state.branches.find((b) => b.id === this.state.current)!
  }
  get head() {
    return this.branch.frames.at(-1)!
  }
  private commit(next: State) {
    const bytes = JSON.stringify(next)
    if (new TextEncoder().encode(bytes).byteLength > 4_000_000) {
      throw new Error("Sandbox history is full. Clear site data to start again.")
    }
    this.storage.setItem(storageKey, bytes) // Failure leaves in-memory state unchanged.
    this.state = next
  }
  update(edit: (frame: Frame) => void) {
    const next = copy(this.state), branch = next.branches.find((b) => b.id === next.current)!
    const frame = copy(branch.frames.at(-1)!)
    edit(frame)
    branch.frames.push(frame)
    this.commit(next)
  }
  start(prompt: string, id: string) {
    if (["requested", "running"].includes(this.head.run?.status ?? "")) throw new Error("Resume the saved run first.")
    this.update((frame) => {
      frame.run = {
        id,
        prompt,
        context: copy(frame.events),
        initial: copy(frame.files),
        replies: [],
        calls: {},
        status: "requested"
      }
      frame.events.push({ kind: "user", text: prompt })
    })
  }
  branchAt(index: number, id: string) {
    if (!Number.isInteger(index) || index < 0 || index >= this.branch.frames.length) {
      throw new Error("Unknown checkpoint")
    }
    const next = copy(this.state), selected = copy(this.branch.frames[index]!)
    // A branch begins a new task from these exact files and visible events.
    delete selected.run
    next.branches.push({ id, title: `branch ${next.branches.length}`, frames: [selected] })
    next.current = id
    this.commit(next)
  }
  select(id: string) {
    if (!this.state.branches.some((b) => b.id === id)) throw new Error("Unknown branch")
    this.commit({ ...this.state, current: id })
  }
  settle(status: "done" | "failed", error?: string) {
    this.update((frame) => {
      if (frame.run) {
        frame.run.status = status
        if (error) frame.run.error = error
        else delete frame.run.error
      }
    })
  }
}
/** Canonical JSON makes call identity independent of object insertion order. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) :
      item)
export function path(value: string): string {
  if (!/^[a-zA-Z0-9_-]+\.(js|txt|json|md)$/.test(value)) throw new Error("Use a file in the sandbox root.")
  return value
}
