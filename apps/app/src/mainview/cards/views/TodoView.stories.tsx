import { fixtures } from "@smthrs/rpc/fixtures/Todo";
import { fixtures as actors } from "@smthrs/rpc/fixtures/ActorChip";
import { TodoView } from "./TodoView";
export const todoStories = {
  ...fixtures,
  question_moved_off: {
    ...fixtures.needs_you,
    name: "Question and moved off",
    model: {
      ...fixtures.needs_you.model,
      waits: [...fixtures.needs_you.model.waits, ...fixtures.moved_off.model.waits],
    },
  },
  clean_rebase: {
    ...fixtures.reviewing,
    name: "Clean rebase keeps its review",
    model: {
      ...fixtures.reviewing.model,
      evidence: fixtures.reviewing.model.evidence.map((evidence) => ({ ...evidence, reviewing: false })),
    },
  },
  actor_variants: {
    ...fixtures.working,
    name: "Every actor variant",
    model: { ...fixtures.working.model, present: Object.values(actors).map((story) => story.model.actor) },
  },
};
export function TodoStory({ name }: { name: keyof typeof todoStories }) {
  return <TodoView {...todoStories[name]} onAction={() => {}} onView={() => {}} />;
}
