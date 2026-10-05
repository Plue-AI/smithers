import { z } from "zod"
import { ActorSchema, MachineStateSchema, PlaceholderAvatarUrl, TodoStateSchema, type Actor, type MachineState } from "@smthrs/rpc/CardPrimitives"
import type { BranchCard } from "@smthrs/rpc/BranchCard"
import { TodoCardSchema, type TodoCard } from "@smthrs/rpc/TodoCard"

// T-APP-10 owns validation of the three serialized topic projections, not View props.
const Where = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path: z.string(), line: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("terminal"), id: z.string() }), z.object({ kind: z.literal("step"), label: z.string() }), z.object({ kind: z.literal("branch") })
])
const Terminal = z.object({ id: z.string(), title: z.string(), owner: ActorSchema, agents: z.array(ActorSchema), watchers: z.array(ActorSchema), command: z.string().optional(), frozen: z.boolean() })
const Branch = z.object({ id: z.string(), name: z.string(), machine: MachineStateSchema,
  item: z.object({ n: z.number().int().positive(), title: z.string(), state: TodoStateSchema, step: z.string().optional(), place: z.number().int().nonnegative() }).optional(),
  scratch: z.object({ forked_from: z.discriminatedUnion("kind", [z.object({ kind: z.literal("main") }), z.object({ kind: z.literal("item"), n: z.number().int().positive(), title: z.string() }), z.object({ kind: z.literal("branch"), name: z.string() })]) }).optional(),
  rebase: z.discriminatedUnion("state", [z.object({ state: z.literal("pending"), onto: z.string(), waiting_for: z.object({ actor: ActorSchema, terminal: z.string() }).optional() }), z.object({ state: z.literal("rebasing"), onto: z.string() }), z.object({ state: z.literal("conflict"), onto: z.string(), paths: z.array(z.string()) })]).optional(),
  moved_off: z.object({ by: ActorSchema, item: z.number().int().positive() }).optional(),
  presence: z.array(z.object({ actor: ActorSchema, where: Where, watching: z.string().optional() })), terminals: z.array(Terminal), ssh_line: z.string() })
const Activity = z.array(z.object({ id: z.string(), actor: ActorSchema, asked_by: ActorSchema.optional(), kind: z.enum(["step", "steer", "question", "answer", "edit", "change", "github", "rebase", "read", "context"]), text: z.string(), items: z.array(z.string()).optional(), files: z.number().int().nonnegative().optional(), github: z.boolean().optional(), at: z.string() }))
const Files = z.array(z.object({ path: z.string(), change: z.enum(["added", "modified", "deleted", "renamed"]), renamed_to: z.string().optional(), authors: z.array(ActorSchema) }))

export function branchModel(branch: unknown, activity: unknown, files: unknown, id: string): BranchCard | undefined {
  const facts = Branch.safeParse(branch), events = Activity.safeParse(activity), paths = Files.safeParse(files)
  if (!facts.success || !events.success || !paths.success || facts.data.id !== id) return
  return { ...facts.data, presence: [...facts.data.presence].sort((a, b) => Number(a.actor.kind !== "person") - Number(b.actor.kind !== "person")),
    terminals: facts.data.terminals.map(terminal => ({ ...terminal, frozen: terminal.frozen || facts.data.rebase?.state === "rebasing" })),
    activity: events.data.map(event => ({ ...event, actions: [] })), changed_files: paths.data }
}

/* An install serves its branches over HTTP (spec §6.3) until the branch topics land: GET /api/branches/{b}, its
 * /diff (the change and its commits), and for a TODO's branch GET /api/todos/{n}, whose latest evidence holds its checks. */
const ServedBranch = z.object({
  name: z.string(), kind: z.enum(["scratch", "item", "main"]), state: z.string(),
  forked_from: z.object({ kind: z.enum(["main", "item"]), ref: z.string(), item: z.number().int().positive().optional() }).optional(),
  item: z.object({ n: z.number().int().positive(), title: z.string(), state: TodoStateSchema, place: z.number().int().nonnegative() }).optional(),
  machine: z.object({ failure_message: z.string().optional() }).passthrough()
})
const ServedDiff = z.object({
  files: z.array(z.object({ path: z.string(), change: z.enum(["added", "modified", "deleted", "renamed"]), renamed_to: z.string().optional() })),
  commits: z.array(z.object({ sha: z.string(), subject: z.string(), author: z.string(), at: z.string() })).optional()
})
type ServedBranch = z.infer<typeof ServedBranch>
type ServedDiff = z.infer<typeof ServedDiff>

const servedMachine = (branch: ServedBranch): MachineState => {
  switch (branch.state) {
    case "awake": case "asleep": case "closed": return { state: branch.state }
    case "waking": case "provisioning": return { state: "waking" }
    case "failed": return { state: "failed", error: { class: "infra", message: branch.machine.failure_message || "The machine failed" } }
    default: return { state: "closed" }
  }
}

/** The Branch card's model of a served branch: its commits, then its TODO's checks, as activity; its changed files. */
export function installBranchModel(branch: ServedBranch, diff: ServedDiff | undefined, todo: TodoCard | undefined): BranchCard {
  const coding: Actor = { kind: "agent", id: `agent:${branch.name}`, agent: "coding", avatar_url: PlaceholderAvatarUrl,
    ...(branch.item ? { todo: branch.item.n } : {}), color_index: 6 }
  const commits: BranchCard["activity"] = (diff?.commits ?? []).map(commit => ({ id: `commit:${commit.sha}`, kind: "change", at: commit.at,
    items: [commit.sha.slice(0, 7)], actions: [],
    ...(branch.kind === "item" ? { actor: coding, text: commit.subject } : { actor: { kind: "outside", color_index: 7 }, text: `${commit.subject} · ${commit.author}` }) }))
  const checks: BranchCard["activity"] = (todo?.evidence.at(-1)?.items ?? []).flatMap((item, index): BranchCard["activity"] =>
    item.kind === "check" ? [{ id: `check:${index}`, actor: coding, kind: "step", text: `${item.name} ${item.state}`, at: "", actions: [] }]
      : item.kind === "github_check" ? [{ id: `check:${index}`, actor: { kind: "github", login: "github", color_index: 7 }, kind: "github",
        text: `${item.name} ${item.state}`, github: true, at: "", actions: [] }]
        : [])
  const from = branch.forked_from
  return {
    id: branch.name, name: branch.name, machine: servedMachine(branch),
    ...(branch.item ? { item: branch.item } : {}),
    ...(branch.kind === "scratch" ? { scratch: { forked_from: from?.kind === "item" && from.item ? { kind: "item" as const, n: from.item, title: "" } : { kind: "main" as const } } } : {}),
    presence: [], terminals: [], activity: [...commits, ...checks],
    changed_files: (diff?.files ?? []).map(file => ({ path: file.path, change: file.change, ...(file.renamed_to ? { renamed_to: file.renamed_to } : {}), authors: [] })),
    ssh_line: ""
  }
}

export interface InstallBranchSnapshot {
  readonly model?: BranchCard
  /** Why the install answered no branch: its message, or "Branch unavailable". */
  readonly error?: string
}
export interface InstallBranches {
  readonly get: (name: string) => InstallBranchSnapshot | undefined
  readonly subscribe: (listener: () => void) => () => void
  /** Reads the branch again and publishes it; a string is the install's refusal. */
  readonly read: (name: string) => Promise<BranchCard | string>
}

/** The branches an install serves, read once per open; the Branch card renders the snapshot. */
export function createInstallBranches(http: (path: string, init?: RequestInit) => Promise<Response>): InstallBranches {
  const snapshots = new Map<string, InstallBranchSnapshot>()
  const reads = new Map<string, number>()
  const listeners = new Set<() => void>()
  const json = async (path: string): Promise<{ readonly ok: boolean; readonly body: unknown }> => {
    const response = await http(path, { credentials: "same-origin" })
    return { ok: response.ok, body: await response.json().catch(() => undefined) }
  }
  const publish = (name: string, generation: number, snapshot: InstallBranchSnapshot) => {
    if (reads.get(name) !== generation) return
    snapshots.set(name, snapshot)
    for (const listener of listeners) listener()
  }
  return {
    get: name => snapshots.get(name),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    read: async name => {
      const generation = (reads.get(name) ?? 0) + 1
      reads.set(name, generation)
      const path = `/api/branches/${encodeURIComponent(name)}`
      const refuse = (message: string) => { publish(name, generation, { error: message }); return message }
      try {
        const read = await json(path)
        const message = (read.body as { readonly message?: unknown } | undefined)?.message
        if (!read.ok) return refuse(typeof message === "string" && message !== "" ? message : "Branch unavailable")
        const branch = ServedBranch.safeParse(read.body)
        if (!branch.success) return refuse("Branch unavailable")
        // A diff or a TODO the install cannot read leaves the branch without its files or checks, never unopened.
        const [diff, todo] = await Promise.all([
          json(`${path}/diff`).then(diff => diff.ok ? ServedDiff.safeParse(diff.body).data : undefined, () => undefined),
          branch.data.item ? json(`/api/todos/${branch.data.item.n}`).then(todo => todo.ok ? TodoCardSchema.safeParse(todo.body).data : undefined, () => undefined)
            : Promise.resolve(undefined)
        ])
        const model = installBranchModel(branch.data, diff, todo)
        publish(name, generation, { model })
        return model
      } catch { return refuse("Branch unavailable") }
    }
  }
}

export type BrowserWhere = { branch: string } & ({ path: string; line?: number } | { terminal: string } | { run: string; step: string } | {})
/** T-COL-06's runtime bridge supplies presence(); no second socket or roster. */
export function createBrowserPresence(options: {
  presence: (where: BrowserWhere) => void
  schedule?: (callback: () => void, ms: number) => unknown
  cancel?: (timer: unknown) => void
}) {
  let where: BrowserWhere | undefined, timer: unknown, disposed = false
  const beat = () => {
    if (disposed || !where) return
    options.presence(where)
    timer = (options.schedule ?? setTimeout)(beat, 10000)
  }
  return {
    move: (next: BrowserWhere) => {
      if (disposed) return
      where = { ...next }
      options.presence(where)
      if (timer === undefined) timer = (options.schedule ?? setTimeout)(beat, 10000)
    },
    dispose: () => { disposed = true; if (timer !== undefined) (options.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>)))(timer) }
  }
}
