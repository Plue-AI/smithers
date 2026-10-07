import { BranchActivityEntry, BranchParticipant } from "@smthrs/rpc/BranchCard"
import { toActor, type ActorContext } from "../ProductActor"
import { branchFileRows } from "@smthrs/rpc/FileCard"
import { z } from "zod"
import { ActorSchema, MachineStateSchema, TodoStateSchema } from "@smthrs/rpc/CardPrimitives"
import type { BranchCard } from "@smthrs/rpc/BranchCard"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"

/** Demo hosts keep their seed when topics are absent; installs never use it. */
export const branchSeedAvailable = (host: { readonly bootstrap?: AppBootstrap; readonly live?: unknown }): boolean =>
  host.bootstrap === undefined ? !host.live : !host.bootstrap.capabilities.includes("install")

// T-APP-10 owns validation of the three serialized topic projections, not View props.
const Where = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path: z.string(), line: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("terminal"), id: z.string() }), z.object({ kind: z.literal("step"), label: z.string() }), z.object({ kind: z.literal("branch") })
])
const Terminal = z.object({ id: z.string(), title: z.string(), owner: ActorSchema, agents: z.array(ActorSchema), watchers: z.array(ActorSchema), command: z.string().optional(), frozen: z.boolean() })
const Branch = z.object({ id: z.string(), name: z.string(), machine: MachineStateSchema,
  item: z.object({ n: z.number().int().positive(), title: z.string(), state: TodoStateSchema, step: z.string().optional(), place: z.number().int().nonnegative() }).optional(),
  scratch: z.object({ forked_from: z.discriminatedUnion("kind", [z.object({ kind: z.literal("main") }), z.object({ kind: z.literal("item"), n: z.number().int().positive(), title: z.string() }), z.object({ kind: z.literal("branch"), name: z.string() })]) }).optional(),
  rebase: z.discriminatedUnion("state", [z.object({ state: z.literal("pending"), onto: z.string(), waiting_for: z.object({ actor: ActorSchema, terminal: z.string() }).optional() }), z.object({ state: z.literal("rebasing"), onto: z.string() }), z.object({ state: z.literal("conflict"), onto: z.string(), paths: z.array(z.string()), conflict_change: z.string().min(1).optional(), onto_revision: z.string().min(1).optional() })]).optional(),
  moved_off: z.object({ by: ActorSchema, item: z.number().int().positive() }).optional(),
  presence: z.array(z.object({ actor: ActorSchema, where: Where, watching: z.string().optional() })), terminals: z.array(Terminal), ssh_line: z.string() })
const Activity = z.array(z.object({ id: z.string(), actor: ActorSchema, asked_by: ActorSchema.optional(), kind: z.enum(["step", "steer", "question", "answer", "edit", "change", "github", "rebase", "read", "context"]), text: z.string(), items: z.array(z.string()).optional(), files: z.number().int().nonnegative().optional(), github: z.boolean().optional(), at: z.string() }))
const Files = z.array(z.object({ path: z.string(), change: z.enum(["added", "modified", "deleted", "renamed"]), renamed_to: z.string().optional(), authors: z.array(ActorSchema) }))

/** Decode the durable change stream at the socket boundary, with roster-owned names. */
function participantActor(value: unknown, context: ActorContext) {
  const rendered = ActorSchema.safeParse(value)
  if (rendered.success) return rendered.data
  const participant = BranchParticipant.parse(value)
  if (participant.kind === "outside") return toActor({ outside: true })
  if (participant.kind === "person") return toActor({ person: participant.member_id ?? participant.id, via: participant.via }, context.roster)
  return toActor({ agent: participant.kind, run: participant.run_id ?? participant.id }, context.roster, context.runs, context.sessions)
}
function activityRows(value: unknown, context: ActorContext): unknown {
  if (!Array.isArray(value)) return value
  return value.map(row => {
    const entry = BranchActivityEntry.safeParse(row)
    if (!entry.success) return row
    const actor = participantActor(entry.data.actor, context)
    return { id: entry.data.id, at: entry.data.at, actor,
      kind: entry.data.kind === "rebase" ? "rebase" : "change",
      text: actor.kind === "outside" ? "changed outside Smithers" : `changed ${entry.data.files.length} ${entry.data.files.length === 1 ? "file" : "files"}`,
      files: entry.data.files.length }
  })
}
function changedRows(value: unknown, context: ActorContext): unknown {
  const rows = branchFileRows(value)
  if (!rows || typeof rows !== "object" || !("changed" in rows) || !Array.isArray(rows.changed)) return rows
  return rows.changed.map(row => ({ ...row, authors: row.last_writer === undefined ? [] : [participantActor(row.last_writer, context)] }))
}

export function branchModel(branch: unknown, activity: unknown, files: unknown, id: string, context: ActorContext = {}): BranchCard | undefined {
  try {
    const facts = Branch.safeParse(branch), events = Activity.safeParse(activityRows(activity, context)), paths = Files.safeParse(changedRows(files, context))
    if (!facts.success || !events.success || !paths.success || facts.data.id !== id) return
    return { ...facts.data, presence: [...facts.data.presence].sort((a, b) => Number(a.actor.kind !== "person") - Number(b.actor.kind !== "person")),
      terminals: facts.data.terminals.map(terminal => ({ ...terminal, frozen: terminal.frozen || facts.data.rebase?.state === "rebasing" })),
      activity: events.data.map(event => ({ ...event, actions: [] })), changed_files: paths.data }
  } catch { return undefined }
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
    pause: () => { where = undefined; if (timer !== undefined) (options.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>)))(timer); timer = undefined },
    dispose: () => { disposed = true; if (timer !== undefined) (options.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>)))(timer) }
  }
}

/** Activity is a bounded log; replayed rows replace by identity without duplication. */
export function projectBranchActivity(previous: unknown, delta: unknown): unknown {
  if (!Array.isArray(previous) || !Array.isArray(delta)) throw new Error("Invalid activity delta")
  const rows = new Map<string, unknown>()
  for (const entry of [...previous, ...delta]) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") throw new Error("Invalid activity entry")
    rows.set(entry.id, entry)
  }
  return [...rows.values()].slice(-200)
}
