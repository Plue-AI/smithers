import { useLiveQuery } from "@tanstack/react-db"
import { useSyncExternalStore } from "react"
import { Markdown, MessageScrollerItem } from "@smthrs/ui"
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import { TranscriptMessage } from "./TranscriptMessage"
import { cardActions } from "./flows/cardActions"
import { contextActions } from "./flows/contextActions"
import { contextOpenAction } from "./flows/contextOpenAction"
import { EntryRow } from "./EntryRow"
import { CardView } from "./ChatCards"
import { controllerCardActions } from "./cards/controllerCardActions"
import { useController } from "./ControllerContext"
import type { SharedConversationSeam } from "./state/seams/SharedConversationSeam"

/** Output only: no tool-call frame can invoke a browser command. */
export function SharedConversation({ source }: { source: SharedConversationSeam }) {
  const controller = useController()
  const { data: sessions } = useLiveQuery(q => q.from({ session: controller.store.collections.sessions }).select(({ session }) => ({ id: session.id, requests: session.sharedPrompts })))
  const { data: identities } = useLiveQuery(controller.store.collections.identitySessions)
  const owner = identities[0]?.state === "signed-in" ? identities[0].login : undefined
  const navigation = controller.store.session().branchNavigation
  const branch = navigation?.owner === owner ? navigation?.selected_branch : "main"
  const requests = (sessions[0]?.requests ?? []).filter(row => row.owner === owner && row.branch === branch && (row.state === "requested" || row.state === "failed"))
  const snapshot = useSyncExternalStore(source.subscribe, source.get, source.get)
  return <div data-shared-conversation={snapshot.conversation?.id}>
    {snapshot.error ? <p role="status">{snapshot.error}</p> : null}
    {requests.map(row => <EntryRow key={row.id} kind="prompt" private author={{ kind: "person", login: row.owner, name: row.owner, avatar_url: PlaceholderAvatarUrl, color_index: 0 }} title="" tone={row.state === "failed" ? "failed" : "quiet"} card={<div data-prompt-request={row.id}><Markdown content={row.prompt} /><p role="status">{row.error ?? "Requested"}</p></div>} onAction={() => {}} />)}
    {snapshot.conversation?.entries.map(turn => {
      if ("origin" in turn && turn.origin === "external" && "role" in turn) return <MessageScrollerItem key={turn.id} messageId={turn.id} style={{ contentVisibility: "visible" }}><TranscriptMessage entry={{ kind: "message", message: turn }} streamingMessageId={undefined} /></MessageScrollerItem>
      if (!("frames" in turn)) return null
      const person = { login: turn.authorLogin, name: turn.authorLogin, avatar_url: PlaceholderAvatarUrl }
      const frames = turn.frames.filter(frame => frame.runId === turn.runId)
      const text = frames.flatMap(frame => frame.type === "delta" && frame.kind === "text" ? [frame.text] : []).join("")
      const failure = [...frames].reverse().find(frame => frame.type === "done" && frame.error)
      const color = (turn.author % 6) as 0 | 1 | 2 | 3 | 4 | 5
      const inspect = cardActions((tag, input) => controller.runCommand(tag, JSON.stringify(input)), turn.preflight ? [
        { tag: "run.inspect", label: "Inspect", command_input: { id: turn.runId } }
      ] : [])
      const answer = { kind: "agent" as const, id: turn.runId, agent: "smithers" as const, for_member: person, avatar_url: PlaceholderAvatarUrl, color_index: color }
      return <div key={turn.id} data-shared-turn={turn.id} data-state={turn.state}>
        <MessageScrollerItem style={{ contentVisibility: "visible" }} messageId={`${turn.id}:prompt`}><EntryRow kind="prompt" author={{ kind: "person", ...person, color_index: color }} title="" tone="quiet" card={<Markdown content={turn.prompt} />} onAction={() => {}} /></MessageScrollerItem>
        <MessageScrollerItem style={{ contentVisibility: "visible" }} messageId={`${turn.id}:answer`}><EntryRow kind="answer" author={answer} title="" tone="quiet" action={inspect.actions[0]} contextActions={turn.context ? contextActions(turn.context, (tag, input) => controller.runCommand(tag, JSON.stringify(input)), contextOpenAction) : undefined} context={turn.context ? { count: turn.context.length, items: turn.context } : undefined} card={<><Markdown content={text} />{failure?.type === "done" && failure.error ? <p role="status">{failure.error}</p> : null}</>} onAction={inspect.onAction} /></MessageScrollerItem>
        {frames.flatMap((frame) => {
          if (frame.type !== "card") return []
          const card = frame.card
          return [<MessageScrollerItem style={{ contentVisibility: "visible" }} key={card.id} messageId={card.id}><CardView card={card} worldDocuments={[]} maximized={snapshot.view?.card_view?.[card.id] === "maximized"} {...controllerCardActions(controller, card)} /></MessageScrollerItem>]
        })}
      </div>
    })}
  </div>
}
