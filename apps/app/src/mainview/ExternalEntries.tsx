/*
 * A Codex session in the conversation (mvp.md M-38, T-AGT-03): a binding, not
 * a View. It maps the session's read-only entries to the shell's own
 * presentation: ChatMessage for prompts and answers, the tool-act Marker for a
 * run of commands, and DiffCardSurface for each edited file. Prompts are the
 * owner's; everything else is "Codex for <owner>". No entry carries an act:
 * copy, disclosure and navigation are all it offers.
 */
import { ChatMessage, Markdown, Marker } from "@smthrs/ui"
import type { Entry } from "@smthrs/harness/ExternalTranscript"
import type { Actor } from "@smthrs/rpc/CardPrimitives"
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import type { DiffCard } from "@smthrs/rpc/DiffCard"
import { useMemo, useSyncExternalStore } from "react"
import { DiffCardSurface } from "./cards/DiffSurface"
import { actorName } from "./cards/views/ActorChip"
import type { ExternalSessionSnapshot, ExternalSessionSource } from "./state/seams/ExternalSessionSeam"
import { timeLabel } from "./Timestamps"

type ToolPart = Extract<Entry["part"], { type: "tool" | "search" | "helper" | "compaction" }>
export type ExternalItem = { readonly id: string; readonly at: number } & (
  | { readonly kind: "message"; readonly role: "user" | "assistant"; readonly text: string; readonly reasoning?: string }
  | { readonly kind: "acts"; readonly acts: ReadonlyArray<ToolPart>; readonly failed: number }
  | { readonly kind: "diff"; readonly card: DiffCard }
  | { readonly kind: "error"; readonly text: string })
export interface ExternalConversation {
  readonly session: string
  readonly owner: Extract<Actor, { kind: "person" }>
  readonly agent: Extract<Actor, { kind: "agent" }>
  readonly items: ReadonlyArray<ExternalItem>
}

const basename = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path

/** Where an edited file sits: relative to the session's directory, or under the checkout it names (`/tmp/<lane>/…`, `~/<repo>/…`). */
export const placeOf = (path: string, cwd: string | undefined): { readonly branch: string; readonly path: string } => {
  if (cwd && path.startsWith(`${cwd}/`)) return { branch: basename(cwd), path: path.slice(cwd.length + 1) }
  const checkout = /^(?:\/private)?\/tmp\/([^/]+)\/(.+)$/.exec(path) ?? /^\/(?:Users|home)\/[^/]+\/([^/]+)\/(.+)$/.exec(path)
  return checkout ? { branch: checkout[1]!, path: checkout[2]! } : { branch: basename(cwd ?? "") || "codex", path }
}

/** A unified diff's hunks; header lines and "\ No newline" markers are not lines of the file. */
export const hunksOf = (diff: string): DiffCard["hunks"] => {
  const hunks: Array<{ old_start: number; new_start: number; lines: Array<{ op: " " | "+" | "-"; text: string }> }> = []
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) { hunks.push({ old_start: Number(header[1]), new_start: Number(header[2]), lines: [] }); continue }
    const op = line[0]
    if (hunks.length > 0 && (op === " " || op === "+" || op === "-")) hunks.at(-1)!.lines.push({ op, text: line.slice(1) })
  }
  return hunks
}

/** The session as conversation items: consecutive tool steps fold into one act line; each edited file is its own diff. */
export function externalConversation(snapshot: ExternalSessionSnapshot): ExternalConversation | undefined {
  if (snapshot.owner === undefined) return undefined
  const owner = { kind: "person" as const, login: snapshot.owner.login, name: snapshot.owner.name, avatar_url: PlaceholderAvatarUrl, color_index: 0 }
  const agent = { kind: "agent" as const, id: `codex:${snapshot.session}`, agent: "codex" as const, avatar_url: PlaceholderAvatarUrl,
    session_id: snapshot.session, for_member: { login: owner.login, name: owner.name, avatar_url: PlaceholderAvatarUrl }, color_index: 0 }
  const items: ExternalItem[] = []
  for (const entry of snapshot.entries) {
    const { part, source_id: id, at } = entry
    const last = items.at(-1)
    switch (part.type) {
      case "prompt": items.push({ id, at, kind: "message", role: "user", text: part.text }); break
      case "goal": items.push({ id, at, kind: "message", role: "user", text: part.status === "active" ? `Goal: ${part.objective}` : `Goal ${part.status}: ${part.objective}` }); break
      case "text": items.push({ id, at, kind: "message", role: "assistant", text: part.text }); break
      case "reasoning": items.push({ id, at, kind: "message", role: "assistant", text: "", reasoning: part.text }); break
      case "encrypted": items.push({ id, at, kind: "message", role: "assistant", text: "Encrypted by Codex" }); break
      case "error": items.push({ id, at, kind: "error", text: part.message }); break
      case "edit":
        part.files.forEach((file, index) => {
          const place = placeOf(file.path, snapshot.cwd)
          items.push({ id: `${id}:${index}`, at, kind: "diff", card: {
            path: place.path, branch: place.branch, change: file.change,
            ...(file.renamed_to === undefined ? {} : { renamed_to: placeOf(file.renamed_to, snapshot.cwd).path }),
            against: { kind: "burst", burst: entry.turn_id ?? id, actor: agent, at: timeLabel(at) }, hunks: hunksOf(file.diff)
          } })
        })
        if (part.outcome === "failed") items.push({ id: `${id}:failed`, at, kind: "error", text: `The edit to ${part.files.map(file => basename(file.path)).join(", ")} did not apply.` })
        break
      default: {
        const failed = part.type === "tool" && part.status === "error" ? 1 : 0
        if (last?.kind === "acts") items[items.length - 1] = { ...last, acts: [...last.acts, part], failed: last.failed + failed }
        else items.push({ id, at, kind: "acts", acts: [part], failed })
      }
    }
  }
  return { session: snapshot.session, owner, agent, items }
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`

/** The act line's words: what the run of steps did, and how many failed. */
export const actsLine = (item: Extract<ExternalItem, { kind: "acts" }>): string => {
  const commands = item.acts.filter(act => act.type === "tool").length
  const others = item.acts.length - commands
  const parts = [commands ? `ran ${plural(commands, "command")}` : "", others ? plural(others, "step") : "", item.failed ? `${item.failed} failed` : ""].filter(Boolean)
  return parts.join(" · ")
}

const actText = (act: ToolPart): string =>
  act.type === "tool" ? (act.reads.length > 0 ? act.reads.join(" · ") : act.command.split("\n")[0]!)
    : act.type === "search" ? `Searched the web: ${act.query}`
    : act.type === "helper" ? `${act.agent}: ${act.activity}`
    : "Compacted its context"

/** One conversation item of the session. */
export function ExternalEntry({ item, conversation }: { readonly item: ExternalItem; readonly conversation?: ExternalConversation | undefined }) {
  if (conversation === undefined && item.kind !== "error") return null
  const time = <time className="message-time" dateTime={new Date(item.at).toISOString()}>{timeLabel(item.at)}</time>
  switch (item.kind) {
    case "message":
      return <ChatMessage className="smithers-chat-message" role={item.role} data-origin="external"
        label={actorName(item.role === "user" ? conversation!.owner : conversation!.agent)}>
        {item.reasoning === undefined ? null : <details className="message-reasoning"><summary>Reasoning</summary><div className="message-reasoning-text">{item.reasoning}</div></details>}
        {item.text === "" ? null : <Markdown className="message-markdown" content={item.text} />}
        {time}
      </ChatMessage>
    case "acts":
      return <Marker variant="note" className="bubble-system-note tool-act-line" data-origin="external">
        <details className="external-acts">
          <summary>{actorName(conversation!.agent)} {actsLine(item)}</summary>
          <ol>{item.acts.map((act, index) => <li key={index} data-status={act.type === "tool" ? act.status : undefined}>
            <code>{actText(act)}</code>
            {act.type === "tool" && act.output !== "" ? <details><summary>Output{act.exit_code ? ` · exit ${act.exit_code}` : ""}</summary><pre>{act.output}</pre></details> : null}
          </li>)}</ol>
        </details>
      </Marker>
    case "diff":
      return <DiffCardSurface model={item.card} actions={[]} gestures={{}} view={{ maximized: false }} onAction={() => undefined} onView={() => undefined} />
    case "error":
      return <Marker variant="note" className="bubble-system-note" data-origin="external" data-tone="failed">{item.text}</Marker>
  }
}

/** The `?codex=<session>` conversation, read while the transcript shows it. */
export function useExternalConversation(source: ExternalSessionSource | undefined): { readonly conversation?: ExternalConversation; readonly error?: string } {
  const subscribe = source?.subscribe ?? noSubscribe
  const snapshot = useSyncExternalStore(subscribe, source?.get ?? noSnapshot, source?.get ?? noSnapshot)
  return useMemo(() => {
    if (snapshot === undefined) return {}
    const conversation = externalConversation(snapshot)
    return { ...(conversation === undefined ? {} : { conversation }), ...(snapshot.error === undefined ? {} : { error: snapshot.error }) }
  }, [snapshot])
}
const noSubscribe = () => () => undefined
const noSnapshot = (): ExternalSessionSnapshot | undefined => undefined
