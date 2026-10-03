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
      step: "Check",
      steps: [
        { id: "plan", label: "Plan", state: "done" },
        { id: "implement", label: "Implement", state: "done" },
        { id: "check", label: "Check", state: "next" },
        { id: "propose", label: "Propose", state: "next" },
        { id: "merge", kind: "wait", state: "next" },
      ],
      evidence: fixtures.reviewing.model.evidence.map((evidence) => ({ ...evidence, reviewing: false, items: [
        ...evidence.items,
        { kind: "check" as const, name: "pnpm test", state: "running" as const },
        { kind: "github_check" as const, name: "required-ci", state: "pending" as const, required: true, url: "https://github.com/smithersai/smithers/actions/runs/124" },
      ] })),
    },
  },
  checks_passed: {
    ...fixtures.in_review,
    name: "Checks passed, waiting for merge",
    model: {
      ...fixtures.in_review.model,
      steps: [
        { id: "plan", label: "Plan", state: "done" },
        { id: "implement", label: "Implement", state: "done" },
        { id: "check", label: "Check", state: "done" },
        { id: "propose", label: "Propose", state: "next" },
        { id: "merge", kind: "wait", state: "held" },
      ],
    },
  },
  actor_variants: {
    ...fixtures.working,
    name: "Every actor variant",
    model: { ...fixtures.working.model, present: Object.values(actors).map((story) => story.model.actor) },
  },
} satisfies Record<string, typeof fixtures.needs_you>;
import type { ViewStory } from "./stories";
export const stories: ViewStory[] = Object.entries(todoStories).map(([name, fixture]) => ({
  name, expect: fixture.expect,
  render: ({ onAction, onView }) => <TodoView {...fixture} onAction={onAction} onView={onView} />,
  // The shared unit harness exercises supplied forms as well as the named TODO race and removal cases.
  interactionSuite: "TODO",
}));
