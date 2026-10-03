import { fixtures } from "@smthrs/rpc/fixtures/Draft"
import type { DraftViewProps } from "@smthrs/rpc/DraftCard"
import { DraftView } from "./DraftView"

export const draftStories = fixtures
export type DraftStoryName = keyof typeof draftStories
export function DraftStory({ name, onAction = () => {}, onView = () => {} }: {
  name: DraftStoryName
  onAction?: DraftViewProps["onAction"]
  onView?: DraftViewProps["onView"]
}) {
  return <DraftView {...draftStories[name]} onAction={onAction} onView={onView} />
}
