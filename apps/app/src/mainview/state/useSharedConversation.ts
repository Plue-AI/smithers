import { useSyncExternalStore } from "react"
import type { ConversationSnapshot, SharedConversationSeam } from "./seams/SharedConversationSeam"
const absent: ConversationSnapshot = {}
const get = () => absent
const subscribe = () => () => {}
export const useSharedConversation = (source?: SharedConversationSeam) => useSyncExternalStore(source?.subscribe ?? subscribe, source?.get ?? get, source?.get ?? get)
