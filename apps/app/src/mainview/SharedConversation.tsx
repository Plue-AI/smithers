import { useSyncExternalStore } from "react"
import { Markdown, MessageScrollerItem } from "@smthrs/ui"
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import { EntryRow } from "./EntryRow"
import { CardView } from "./ChatCards"
import { controllerCardActions } from "./cards/controllerCardActions"
import { useController } from "./ControllerContext"
import type { SharedConversationSeam } from "./state/seams/SharedConversationSeam"

/** Output only: no tool-call frame can invoke a browser command. */
export function SharedConversation({ source }: { source: SharedConversationSeam }) {
  const controller = useController()
  const snapshot = useSyncExternalStore(source.subscribe, source.get, source.get)
  if (snapshot.error) return <p role="status">{snapshot.error}</p>
  return <div data-shared-conversation={snapshot.conversation?.id}>
    {snapshot.conversation?.entries.map(turn => {
      const person = { login: turn.authorLogin, name: turn.authorLogin, avatar_url: PlaceholderAvatarUrl }
      const frames = turn.frames.filter(frame => frame.runId === turn.runId)
      const text = frames.flatMap(frame => frame.type === "delta" && frame.kind === "text" ? [frame.text] : []).join("")
      const failure = [...frames].reverse().find(frame => frame.type === "done" && frame.error)
      const answer = { kind: "agent" as const, id: turn.runId, agent: "smithers" as const, for_member: person, avatar_url: PlaceholderAvatarUrl, color_index: 6 as const }
      return <div key={turn.id} data-shared-turn={turn.id} data-state={turn.state}>
        <MessageScrollerItem messageId={`${turn.id}:prompt`}><EntryRow kind="prompt" author={{ kind: "person", ...person, color_index: (turn.author % 6) as 0 }} title="" tone="quiet" card={<Markdown content={turn.prompt} />} onAction={() => {}} /></MessageScrollerItem>
        <MessageScrollerItem messageId={`${turn.id}:answer`}><EntryRow kind="answer" author={answer} title="" tone="quiet" context={turn.context ? { count: turn.context.length, items: turn.context } : undefined} card={<><Markdown content={text} />{failure?.type === "done" && failure.error ? <p role="status">{failure.error}</p> : null}</>} onAction={() => {}} /></MessageScrollerItem>
        {frames.flatMap((frame) => {
          if (frame.type !== "card") return []
          const card = frame.card
          return [<MessageScrollerItem key={card.id} messageId={card.id}><CardView card={card} worldDocuments={[]} maximized={controller.store.session().maximizedCardId === card.id} {...controllerCardActions(controller, card)} /></MessageScrollerItem>]
        })}
      </div>
    })}
  </div>
}
