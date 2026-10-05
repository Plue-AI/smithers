import { z } from "zod"
import { ActorSchema, MachineStateSchema, TodoStateSchema } from "@smthrs/rpc/CardPrimitives"
import type { BranchCard } from "@smthrs/rpc/BranchCard"

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
