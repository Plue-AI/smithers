import { fixtures } from "@smthrs/rpc/fixtures/Confirm"
import { fixtures as actors } from "@smthrs/rpc/fixtures/ActorChip"
import type { ConfirmViewProps } from "@smthrs/rpc/ConfirmCard"
import { ConfirmView } from "./ConfirmView"

export const confirmStories = {
  ...fixtures,
  review_again: { ...fixtures.review_merge, name: "Review & merge current revision", expect: ["Review & merge", "You approved 1b2c3d4. Review 4bc79ae."], actions: [{ tag: "merge.confirm" as const, label: "Review & merge", primary: true, args: { n: "12", revision: "4bc79ae" } }], model: { ...fixtures.review_merge.model, review: { ...fixtures.review_merge.model.review!, approved_revision: "1b2c3d4" } } },
  no_actions: { ...fixtures.one_click, name: "No approval action", actions: [] },
  disabled: { ...fixtures.one_click, name: "Disabled approval", actions: [{ tag: "todo.amend" as const, label: "Amend", primary: true, args: { n: "12" }, disabled: { reason: "Revision moved" } }] },
  failed_check: { ...fixtures.reviewing, name: "Failed check", model: { ...fixtures.reviewing.model, review: { ...fixtures.reviewing.model.review!, evidence: { ...fixtures.reviewing.model.review!.evidence, reviewing: false, items: [{ kind: "check" as const, name: "required-ci", state: "failed" as const }] } } } },
  merging: { ...fixtures.review_merge, name: "Merging", expect: ["Merging", "rev 4bc79ae"], actions: [], model: { ...fixtures.review_merge.model, review: { ...fixtures.review_merge.model.review!, merge: { state: "merging" as const, reason: "merging" as const, on_github: false } } } },
  merged: { ...fixtures.review_merge, name: "Merged", expect: ["Merged into main", "rev 4bc79ae"], actions: [], model: { ...fixtures.review_merge.model, review: { ...fixtures.review_merge.model.review!, merge: { state: "done" as const, on_github: false } } } },
  ...Object.fromEntries(Object.entries(actors).map(([key, story]) => [`actor_${key}`, { ...fixtures.one_click, name: `Asker: ${story.name}`, model: { ...fixtures.one_click.model, asked_by: story.model.actor } }]))
}

export const stories: import("./stories").ViewStory[] = Object.entries(confirmStories).map(([name, story]) => ({
  name,
  expect: story.expect,
  actions: story.actions,
  render: (callbacks, actions = story.actions) => <ConfirmView {...story} actions={actions as ConfirmViewProps["actions"]} {...callbacks} />
}))
