/*
 * MOCK SEAM, Branch and Terminal lane (delete with ./index.ts). Maps the
 * seeded design rows to the Branch and Terminal Views' rpc models. Replaced
 * by topics `branch:<id>` (+ `:activity`, `:files`) and the terminal stream
 * (CloudTerminalClient) once those land (mvp.md §7.2).
 */
import type { BranchCard } from "@smthrs/rpc/BranchCard"
import type { TerminalCard } from "@smthrs/rpc/TerminalCard"
import type { TodoState } from "@smthrs/rpc/CardPrimitives"
import { branchOf, openItems, todoOf, type ActorId, type DesignBranch, type DesignTerminal, type DesignWorldRows } from "./index"
import { designActor } from "./shell"

const STATE: Readonly<Record<string, TodoState>> = { "needs-you": "needs_you", "in-review": "in_review" }

const refNumber = (ref: string): number => Math.max(1, Number(ref.replace(/^T/i, "")) || 1)

/** A branch by id, name, or its item's ref ("T9"). */
export const designBranchFor = (world: DesignWorldRows, name: string): DesignBranch | undefined => {
  const target = name.trim()
  return world.branches.find(each => each.id === target || each.name === target)
    ?? world.branches.find(each => each.id === world.todos.find(todo => todo.ref.toLowerCase() === target.toLowerCase())?.branch)
}

const stepTitle = (world: DesignWorldRows, todoId: string | undefined, step: string): string => {
  const item = todoId === undefined ? undefined : todoOf(world, todoId)
  return (item?.steps ?? world.repo.flow).find(each => each.id === step)?.title ?? step
}

const hostOf = (address: string | undefined): string => {
  try { return new URL(address ?? "").hostname || "localhost" } catch { return "localhost" }
}

/** The SSH line a person copies: `ssh -p 2222 <branch>@<install host>`. */
export const designSshLine = (world: DesignWorldRows, branch: DesignBranch): string =>
  `ssh -p 2222 ${branch.name}@${hostOf(world.repo.setup.addresses[0])}`

const terminalModel = (world: DesignWorldRows, terminal: DesignTerminal) => {
  const owner = designActor(world, terminal.owner)
  return {
    id: terminal.id, title: terminal.title, owner,
    agents: owner.kind === "agent" ? [owner] : [],
    watchers: terminal.watchers.map(each => designActor(world, each)),
    ...(terminal.running === undefined ? {} : { command: terminal.running }),
    frozen: false
  }
}

/** The Branch View's model for one seeded branch. */
export const designBranchModel = (world: DesignWorldRows, branch: DesignBranch): BranchCard => {
  const item = branch.item === undefined ? undefined : todoOf(world, branch.item)
  const place = item === undefined ? -1 : openItems(world).findIndex(each => each.id === item.id)
  const from = branch.from === "main" ? undefined : branchOf(world, branch.from)
  const fromItem = from?.item === undefined ? undefined : todoOf(world, from.item)
  const moved = branch.movedOff === undefined ? undefined : todoOf(world, branch.movedOff.item)
  const authors = new Map<string, ActorId[]>()
  for (const file of world.files.filter(each => each.branch === branch.id)) {
    const who = [...new Set(file.lines.flatMap(line => line.by === undefined ? [] : [line.by]))]
    if (who.length > 0 || (file.editors?.length ?? 0) > 0) authors.set(file.path, [...new Set([...who, ...(file.editors ?? []).map(each => each.who)])])
  }
  return {
    id: branch.id,
    name: branch.name,
    ...(item === undefined ? {} : { item: {
      n: refNumber(item.ref), title: item.title, state: STATE[item.state] ?? item.state as TodoState,
      ...(item.step === undefined ? {} : { step: stepTitle(world, item.id, item.step) }),
      place: Math.max(1, place + 1)
    } }),
    ...(item !== undefined ? {} : { scratch: { forked_from: from === undefined ? { kind: "main" as const }
      : fromItem !== undefined ? { kind: "item" as const, n: refNumber(fromItem.ref), title: fromItem.title }
      : { kind: "branch" as const, name: from.name } } }),
    machine: branch.machine === "waiting" ? { state: "waiting", position: Math.max(1, branch.waitPosition ?? 1) } : { state: branch.machine },
    ...(branch.rebasePending === undefined ? {} : { rebase: { state: "pending" as const, onto: branch.rebasePending } }),
    ...(branch.movedOff === undefined ? {} : { moved_off: { by: designActor(world, branch.movedOff.by), item: refNumber(moved?.ref ?? "T1") } }),
    /* People first, then agents (§14.3). */
    presence: [...branch.presence].sort((a, b) => Number(a.who.startsWith("agent:")) - Number(b.who.startsWith("agent:"))).map(each => ({
      actor: designActor(world, each.who),
      where: each.where.kind === "file" || each.where.kind === "reading"
        ? { kind: "file" as const, path: each.where.path, ...(each.where.line === undefined ? {} : { line: each.where.line }) }
        : each.where.kind === "terminal" ? { kind: "terminal" as const, id: each.where.id }
        : each.where.kind === "step" ? { kind: "step" as const, label: stepTitle(world, branch.item, each.where.step) }
        : { kind: "branch" as const },
      ...(each.watching === undefined ? {} : { watching: each.watching })
    })),
    terminals: world.terminals.filter(each => each.branch === branch.id).map(each => terminalModel(world, each)),
    activity: branch.activity.map(each => ({
      id: each.id,
      actor: designActor(world, each.who),
      ...(each.asked === undefined ? {} : { asked_by: designActor(world, each.asked) }),
      kind: each.kind,
      text: each.kind !== "change" ? each.text : each.who === "outside" ? "Changed outside Smithers" : "changed",
      ...(each.items === undefined ? {} : { items: [...each.items] }),
      ...(each.files === undefined ? {} : { files: each.files }),
      ...(each.github === undefined ? {} : { github: each.github }),
      at: "",
      actions: []
    })),
    changed_files: [...authors].map(([path, who]) => ({ path, change: "modified" as const, authors: who.map(each => designActor(world, each)) })),
    ssh_line: designSshLine(world, branch)
  }
}

/** The Terminal View's model; only the owner types. */
export const designTerminalModel = (world: DesignWorldRows, terminal: DesignTerminal, viewer: ActorId): TerminalCard => ({
  ...terminalModel(world, terminal),
  branch: branchOf(world, terminal.branch)?.name ?? terminal.branch,
  viewer_is_owner: terminal.owner === viewer
})

const ANSI: Readonly<Record<string, string>> = { prompt: "\x1b[2m", ok: "\x1b[32m", fail: "\x1b[31m", dim: "\x1b[2m" }

/** One stored terminal line as xterm text. */
export const designTerminalText = (line: DesignTerminal["lines"][number]): string =>
  line.tone === undefined ? line.text : `${ANSI[line.tone]}${line.text}\x1b[0m`

/** The prompt the owner types after: `maya@retry-webhooks $ `. */
export const designTerminalPrompt = (world: DesignWorldRows, terminal: DesignTerminal): string =>
  terminal.prompt ?? `${terminal.owner.split(/[~:]/)[0]}@${branchOf(world, terminal.branch)?.name ?? terminal.branch} $ `
