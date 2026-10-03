import type { Card } from "./AppState"
import { notificationWasRead, type NotificationReadReceipt, type RepositoryNotification } from "./RepositoryNotifications"

/** Saved activity content joins exact-version read receipts and current tags without rewriting history. */
export const projectRepositoryUpdate = (
  card: Extract<Card, { kind: "repo-update" }>,
  notifications: ReadonlyArray<RepositoryNotification>,
  receipts: ReadonlyArray<NotificationReadReceipt>
): Extract<Card, { kind: "repo-update" }> => {
  const current = new Map(notifications.map(row => [row.id, row]))
  const read = new Set(receipts.map(row => row.id))
  return { ...card, payload: { ...card.payload, items: card.payload.items.map(item => ({
    ...item,
    read: notificationWasRead(read, item.id, item.version),
    tags: [...(current.get(item.id)?.tags ?? item.tags)]
  })) } }
}
