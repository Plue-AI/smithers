import { useCallback, useSyncExternalStore } from "react"
import { liveChannel, type LiveChannel, type TopicSnapshot } from "../runtime/LiveChannel"

export const useTopic = <T = unknown>(topic: string, channel: LiveChannel = liveChannel()): TopicSnapshot<T> | undefined => {
  const subscribe = useCallback((listener: () => void) => channel.subscribe(topic, listener), [channel, topic])
  const snapshot = useCallback(() => channel.getSnapshot(topic) as TopicSnapshot<T> | undefined, [channel, topic])
  return useSyncExternalStore(subscribe, snapshot, () => undefined)
}
