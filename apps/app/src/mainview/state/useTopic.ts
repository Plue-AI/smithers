import { useCallback, useSyncExternalStore } from "react"
import { liveChannel, type LiveChannel, type TopicSnapshot } from "../runtime/LiveChannel"

export const useTopic = <T = unknown>(topic: string | undefined, channel: LiveChannel = liveChannel()): TopicSnapshot<T> | undefined => {
  const subscribe = useCallback((listener: () => void) => topic === undefined ? () => {} : channel.subscribe(topic, listener), [channel, topic])
  const snapshot = useCallback(() => topic === undefined ? undefined : channel.getSnapshot(topic) as TopicSnapshot<T> | undefined, [channel, topic])
  return useSyncExternalStore(subscribe, snapshot, () => undefined)
}

/** The unmounted shared shell supplies no scope until dependency checks enable it.
 * Server membership and audience checks remain the authority for both topics.
 * Private browser messages, Drafts and confirmations never seed shared entries.
 */
export const useBranchConversationTopics = <Entries, View>(
  scope: { branch: string; member: string } | undefined,
  channel: LiveChannel = liveChannel()
): { entries: TopicSnapshot<Entries> | undefined; view: TopicSnapshot<View> | undefined } => {
  const valid = scope && /^[^:\s]+$/.test(scope.branch) && /^[^:\s]+$/.test(scope.member)
  return {
    entries: useTopic<Entries>(valid ? `conversation:${scope.branch}` : undefined, channel),
    view: useTopic<View>(valid ? `view:${scope.member}:${scope.branch}` : undefined, channel)
  }
}
