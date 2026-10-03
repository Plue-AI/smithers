import { fixtures } from "@smthrs/rpc/fixtures/Confirm"
import { fixtures as actors } from "@smthrs/rpc/fixtures/ActorChip"
import type { ConfirmViewProps } from "@smthrs/rpc/ConfirmCard"
import { ConfirmView } from "./ConfirmView"

export const confirmStories = {
  ...fixtures,
  no_actions: { ...fixtures.one_click, name: "No approval action", actions: [] },
  disabled: { ...fixtures.one_click, name: "Disabled approval", actions: [{ tag: "todo.amend" as const, label: "Amend", primary: true, args: { n: "12" }, disabled: { reason: "Revision moved" } }] },
  failed_check: { ...fixtures.reviewing, name: "Failed check", model: { ...fixtures.reviewing.model, review: { ...fixtures.reviewing.model.review!, evidence: { ...fixtures.reviewing.model.review!.evidence, reviewing: false, items: [{ kind: "check" as const, name: "required-ci", state: "failed" as const }] } } } },
  merging: { ...fixtures.review_merge, name: "Merging", expect: ["Merging", "rev 4bc79ae"], actions: [], model: { ...fixtures.review_merge.model, review: { ...fixtures.review_merge.model.review!, merge: { state: "merging" as const, reason: "merging" as const, on_github: false } } } },
  merged: { ...fixtures.review_merge, name: "Merged", expect: ["Merged into main", "rev 4bc79ae"], actions: [], model: { ...fixtures.review_merge.model, review: { ...fixtures.review_merge.model.review!, merge: { state: "done" as const, on_github: false } } } },
  ...Object.fromEntries(Object.entries(actors).map(([key, story]) => [`actor_${key}`, { ...fixtures.one_click, name: `Asker: ${story.name}`, model: { ...fixtures.one_click.model, asked_by: story.model.actor } }]))
}

export function ConfirmStory({ name, onAction = () => {}, onView = () => {} }: { name: string; onAction?: ConfirmViewProps["onAction"]; onView?: ConfirmViewProps["onView"] }) {
  const story = confirmStories[name as keyof typeof confirmStories]
  if (!story) throw new Error(`Unknown Confirm story: ${name}`)
  return <ConfirmView {...story} onAction={onAction} onView={onView} />
}
