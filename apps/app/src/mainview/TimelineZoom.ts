/*
 * The timeline zooms out with distance from the on-screen band (T-UI-08 zoom,
 * Will 2026-10-05, #3728). Lines near the band stay one per entry; farther
 * away they fold into coarser groups:
 *
 *   level 1   one message (a prompt or an answer) and what followed it
 *   level 2   a run of level 1s, starting fresh at each prompt
 *   level 3+  a run of the level below, starting at a prompt once half full
 *
 * There are at least three levels, and more while the coarsest still holds
 * more than `cap` groups, so the rail stays a few dozen lines at any length.
 * A group within `radius` groups of the band's own group at its level opens
 * into its children, and so does any group holding an open group, so the
 * zoom steps down one level at a time toward the band across group edges.
 * Any other group is one line (a group of one entry is that entry). Every entry is covered by exactly one shown line, in order.
 * Short conversations are returned as they are.
 *
 * A folded line is deterministic: its title is the group's first prompt, else
 * its first answer, else its first line; its summary counts what it holds;
 * its tone and pending act are its most urgent child's. The fast model may
 * retitle it (#3732): `withTitles` takes a title written for exactly that
 * run's key, and the deterministic one stands otherwise.
 */
import type { TimelineLine } from "@smthrs/rpc/TimelineCard"

export interface ZoomOptions {
  /** Conversations with at most this many lines are not zoomed. */
  readonly threshold?: number
  /** Children per group at every level; the coarsest level holds at most this many groups. */
  readonly cap?: number
  /** Groups at levels 1, 2 and 3 within this many of the band's own group open into their children; above level 3, none do on their own. */
  readonly radius?: readonly [number, number, number]
}

export const ZOOM_DEFAULTS = { threshold: 60, cap: 8, radius: [2, 1, 1] } as const satisfies Required<ZoomOptions>

interface Group { readonly level: number; readonly children: ReadonlyArray<Group | number>; readonly first: number; readonly last: number }

const firstLine = (node: Group | number): number => typeof node === "number" ? node : node.first
const lastLine = (node: Group | number): number => typeof node === "number" ? node : node.last

/**
 * Pack children into groups of at most `cap`, starting a new group where `breaks` says the child begins one
 * (given how full the current group is).
 */
const pack = (level: number, children: ReadonlyArray<Group | number>, cap: number, breaks: (child: Group | number, size: number) => boolean): Group[] => {
  const groups: Group[] = []
  let current: Array<Group | number> = []
  const close = () => {
    if (current.length > 0) groups.push({ level, children: current, first: firstLine(current[0]!), last: lastLine(current.at(-1)!) })
    current = []
  }
  for (const child of children) {
    if (current.length >= cap || (current.length > 0 && breaks(child, current.length))) close()
    current.push(child)
  }
  close()
  return groups
}

/**
 * The levels over the lines, finest first: level 1 starts at every prompt and answer, level 2 at every prompt,
 * higher levels at a prompt once half full. At least three; more until the coarsest has at most `cap` groups.
 */
export const zoomLevels = (lines: ReadonlyArray<Pick<TimelineLine, "kind">>, cap: number = ZOOM_DEFAULTS.cap): Group[][] => {
  const startsWithPrompt = (node: Group | number): boolean => lines[firstLine(node)]?.kind === "prompt"
  const levels = [pack(1, lines.map((_, index) => index), cap, child => { const kind = lines[child as number]!.kind; return kind === "prompt" || kind === "answer" })]
  levels.push(pack(2, levels[0]!, cap, startsWithPrompt))
  while (levels.length < 3 || levels.at(-1)!.length > cap) {
    levels.push(pack(levels.length + 1, levels.at(-1)!, cap, (child, size) => startsWithPrompt(child) && size * 2 >= cap))
  }
  return levels
}

const RANK: Record<TimelineLine["tone"], number> = { attention: 0, failed: 1, live: 2, done: 3, quiet: 4 }
const GLYPH: Record<TimelineLine["tone"], "running" | "ok" | "attention" | "failed"> = { attention: "attention", failed: "failed", live: "running", done: "ok", quiet: "ok" }
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`

/** One line standing for `group`: its first prompt (else answer) as title, what it holds as summary, its most urgent tone and act. */
export const foldedLine = (lines: ReadonlyArray<TimelineLine>, group: Pick<Group, "level" | "first" | "last">, times?: ReadonlyMap<string, number>): TimelineLine => {
  const inside = lines.slice(group.first, group.last + 1)
  const named = inside.find(line => line.kind === "prompt") ?? inside.find(line => line.kind === "answer") ?? inside[0]!
  const urgent = inside.reduce((best, line) => RANK[line.tone] < RANK[best.tone] ? line : best)
  const acting = inside.filter(line => line.action !== undefined).sort((left, right) => RANK[left.tone] - RANK[right.tone])[0]
  const prompts = inside.filter(line => line.kind === "prompt").length
  const answers = inside.filter(line => line.kind === "answer").length
  const failed = inside.filter(line => line.tone === "failed").length
  const summary = [prompts ? plural(prompts, "prompt") : "", answers ? plural(answers, "answer") : "",
    inside.length - prompts - answers ? plural(inside.length - prompts - answers, "step") : "", failed ? `${failed} failed` : ""].filter(Boolean).join(" · ")
  const at = inside.map(line => times?.get(line.entry_id)).filter((time): time is number => time !== undefined && time > 0)
  return {
    entry_id: inside[0]!.entry_id, kind: named.kind, title: named.title, summary, tone: urgent.tone, glyph: { event: GLYPH[urgent.tone] },
    ...(acting?.action === undefined ? {} : { action: acting.action }),
    ...(inside.some(line => line.fresh) ? { fresh: true } : {}),
    zoom: { level: group.level, count: inside.length, last_entry_id: inside.at(-1)!.entry_id,
      ...(at.length === 0 ? {} : { from: Math.min(...at), to: Math.max(...at) }) }
  }
}

/** Which groups at one level hold the band: the first and last index. */
const around = (groups: ReadonlyArray<Group>, from: number, to: number): readonly [number, number] => {
  const first = groups.findIndex(group => group.last >= from)
  let last = groups.length - 1
  while (last > 0 && groups[last]!.first > to) last--
  return [first, last]
}

/**
 * The lines the rail shows for `band`: one per entry near it, folded groups farther away. `times` gives each entry's
 * time, for a folded line's span. Without a band (or with one naming no line), the band is the last line.
 */
export function zoomTimeline(lines: ReadonlyArray<TimelineLine>, band: readonly [string, string] | undefined, times?: ReadonlyMap<string, number>, options: ZoomOptions = {}): TimelineLine[] {
  const { threshold, cap, radius } = { ...ZOOM_DEFAULTS, ...options }
  if (lines.length <= threshold) return [...lines]
  const known = band === undefined ? [] : band.map(id => lines.findIndex(line => line.entry_id === id)).filter(index => index >= 0)
  const from = known.length === 0 ? lines.length - 1 : Math.min(...known)
  const to = known.length === 0 ? from : Math.max(...known)
  const levels = zoomLevels(lines, cap)
  const focus = levels.map(groups => around(groups, from, to))
  const open = new Set<Group>()
  levels.forEach((groups, k) => {
    const [first, last] = focus[k]!
    const reach = radius[k] ?? 0
    groups.forEach((group, at) => {
      if ((at >= first - reach && at <= last + reach) || group.children.some(child => typeof child !== "number" && open.has(child))) open.add(group)
    })
  })
  const shown: TimelineLine[] = []
  const show = (node: Group | number): void => {
    if (typeof node === "number") { shown.push(lines[node]!); return }
    if (open.has(node)) node.children.forEach(show)
    // A group of one entry is that entry; any larger group folds at its own level, even when it has one child.
    else shown.push(node.first === node.last ? lines[node.first]! : foldedLine(lines, node, times))
  }
  levels.at(-1)!.forEach(show)
  return shown
}

/**
 * The key of a folded line's model title: its first and last entries and how many it holds, so a run that grows or
 * moves asks again. Undefined for a line that is not folded.
 */
export const foldKey = (line: Pick<TimelineLine, "entry_id" | "zoom">): string | undefined =>
  line.zoom === undefined ? undefined : JSON.stringify([line.entry_id, line.zoom.last_entry_id, line.zoom.count])

/** Each folded line among `shown` with its key and the lines it stands for, in order. */
export const foldedRuns = (lines: ReadonlyArray<TimelineLine>, shown: ReadonlyArray<TimelineLine>): Array<{ readonly key: string; readonly lines: TimelineLine[] }> => {
  const position = new Map(lines.map((line, index) => [line.entry_id, index]))
  return shown.flatMap(line => {
    const key = foldKey(line)
    const first = position.get(line.entry_id)
    const last = line.zoom === undefined ? undefined : position.get(line.zoom.last_entry_id)
    return key === undefined || first === undefined || last === undefined ? [] : [{ key, lines: lines.slice(first, last + 1) }]
  })
}

/** A folded line whose key has a model-written title takes it, marked `written`; every other line is unchanged. */
export const withTitles = (shown: ReadonlyArray<TimelineLine>, titles: ReadonlyMap<string, string>): TimelineLine[] => shown.map(line => {
  const key = foldKey(line)
  const title = key === undefined ? undefined : titles.get(key)
  return title === undefined || line.zoom === undefined ? line : { ...line, title, zoom: { ...line.zoom, written: true } }
})
