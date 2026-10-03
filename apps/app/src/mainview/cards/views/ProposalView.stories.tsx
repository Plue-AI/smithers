import { fixtures, receipts } from "@smthrs/rpc/fixtures/Proposal"
import { ProposalView, LessonsReceiptView } from "./ProposalView"
import { fixtureStories } from "./stories"

export const proposalStories = {
  ...fixtures,
  disabled: { ...fixtures.open, name: "Disabled proposal", actions: fixtures.open.actions.map(action => ({ ...action, disabled: { reason: "Member removed" } })) },
  no_actions: { ...fixtures.open, name: "Read-only proposal", actions: [] },
  accepted_link: { ...fixtures.accepted, name: "Accepted TODO link", gestures: { todo: { tag: "todo" as const, label: "TODO", args: { n: "14" } } } },
}
const lessonStories = {
  ...receipts,
  navigable: { ...receipts.lessons, name: "Lesson links", gestures: {
    "wiki:Retry policy": { tag: "wiki.page" as const, label: "Retry policy", args: { name: "Retry policy" } },
    "proposal-12": { tag: "run" as const, label: "Keep completion receipts", args: { id: "proposal-12" } },
  } },
  empty: { ...receipts.lessons, name: "No lessons", model: { todo: 12, lessons: [] }, expect: ["0 lessons"] },
  single: { ...receipts.lessons, name: "One lesson", model: { todo: 12, lessons: [receipts.lessons.model.lessons[0]!] }, expect: ["Retry policy"] },
}
export const stories = [
  ...fixtureStories(proposalStories, (story, callbacks) => <ProposalView {...story} {...callbacks} />, {
    "Accepted TODO link": [{ selector: ".proposal-made button", gesture: "todo" }],
  }),
  ...fixtureStories(lessonStories, (story, callbacks) => <LessonsReceiptView {...story} {...callbacks} />, {
    "Lesson links": [{ selector: '.proposal-page button[data-flow="wiki.page"]', gesture: "wiki:Retry policy" }, { selector: '.proposal-page button[data-flow="run"]', gesture: "proposal-12" }],
  }),
]
