import { fixtures } from "@smthrs/rpc/fixtures/Monitor"
import type { MonitorCard, RunView as RunViewState, RunViewProps } from "@smthrs/rpc/MonitorCard"
import type { BaseView } from "@smthrs/rpc/CardAction"
import { RunView } from "./RunView"
import type { StoryAction, StoryInteraction, ViewStory } from "./stories"

type Fixture = (typeof fixtures)[keyof typeof fixtures]
type View = BaseView & RunViewState
type Attempt = MonitorCard["attempts"][number]

/* The View's own selection controls, mirrored from the model: every node, cell, tab, input and scrubber it renders. */
const stepIdOf = (attempt: Attempt, key: string): string => attempt.steps.find(step => step.key === key)?.id ?? key.replace(/#\d+$/, "")
const nodes = (model: MonitorCard): StoryInteraction[] => model.attempts.flatMap((attempt, index) => {
  const last = index === model.attempts.length - 1
  return attempt.graph.filter(node => node.id !== "merge" && (last || node.state !== "next"))
    .map(node => ({ selector: `[data-node="${attempt.run_id}:${node.id}"]`, patch: { selected: `step:${attempt.run_id}:${node.id}` } }))
})
const shownAttempt = (model: MonitorCard, view: View): Attempt | undefined => {
  const pick = /^step:(.+):([^:]+)$/.exec(view.selected ?? "")
  return (pick === null ? undefined : model.attempts.find(each => each.run_id === pick[1]))
    ?? model.attempts.find(each => each.phases.some(phase => phase.cells.some(cell => cell.id === view.selected)))
    ?? model.attempts.at(-1)
}
const cells = (model: MonitorCard, view: View): StoryInteraction[] => {
  const shown = shownAttempt(model, view)
  const step = /^step:.+:([^:]+)$/.exec(view.selected ?? "")?.[1]
  const transcript = shown === undefined || step === undefined ? [] : shown.phases.filter(phase => stepIdOf(shown, phase.step) === step).flatMap(phase => phase.cells)
    .map(cell => ({ selector: `[data-transcript-cell="${cell.id}"]`, patch: { selected: cell.id } }))
  return [...(shown?.phases ?? []).flatMap(phase => phase.cells).map(cell => ({ selector: `[data-cell="${cell.id}"]`, patch: { selected: cell.id } })), ...transcript]
}
const tabs = (model: MonitorCard, view: View): StoryInteraction[] => model.journal === undefined && view.tab !== "journal" ? []
  : [{ selector: '[data-tab="run"]', patch: { tab: "run" } }, { selector: '[data-tab="journal"]', patch: { tab: "journal" } }]
const scrubber = (model: MonitorCard): StoryInteraction[] => model.replay === undefined ? []
  : [{ selector: 'input[type="range"]', event: "input", value: "2", patch: { at: 2 } }]
const inputs = (actions: ReadonlyArray<StoryAction>): StoryInteraction[] => actions.flatMap(action =>
  ((action as { input?: ReadonlyArray<{ label: string }> }).input ?? []).map(field => ({ selector: `input[aria-label="${field.label}"]`, event: "input" as const, value: "Use backoff() for every retry", action: null })))
const interactionsFor = (model: MonitorCard, view: View, actions: ReadonlyArray<StoryAction>): StoryInteraction[] => !view.maximized ? inputs(actions)
  : [...nodes(model), ...tabs(model, view), ...(view.tab === "journal" ? scrubber(model) : cells(model, view)), ...inputs(actions)]

const story = (name: string, fixture: Fixture, view: View, expect: readonly string[] = fixture.expect): ViewStory => ({
  name, actions: fixture.actions, expect, interactions: interactionsFor(fixture.model, view, fixture.actions),
  render: (callbacks, actions = fixture.actions) => <RunView model={fixture.model} actions={actions as RunViewProps["actions"]} gestures={{}} view={view}
    onAction={callbacks.onAction} onView={callbacks.onView} />
})

/* Every Monitor fixture as the monitor (Inspect), the embedded card for the states it shows differently, and a step selection. */
export const stories: ViewStory[] = [
  ...Object.entries(fixtures).map(([name, fixture]) => story(name, fixture, { ...fixture.view, maximized: true })),
  story("embedded_running", fixtures.running, { maximized: false }, ["Card model contracts", "Ran checks · 2 failed", "Inspect"]),
  story("embedded_waiting", fixtures.waiting, { maximized: false }, ["Include S3 fields?", "Waiting for a person"]),
  story("embedded_held", fixtures.held, { maximized: false }, ["Waiting for merge"]),
  story("embedded_failed", fixtures.failed, { maximized: false }, ["Failed", "Retry"]),
  story("embedded_background", fixtures.background, { maximized: false }, ["Refresh wiki", "Waiting for the docs build", "Sleeping until 18:00"]),
  story("embedded_queued", fixtures.queued, { maximized: false }, ["Card model contracts"]),
  story("step_selected", fixtures.two_attempts, { maximized: true, selected: "step:run-42:check" }, ["Check", "Ran checks · 1 failed", "Running checks"]),
  story("earlier_attempt_step", fixtures.two_attempts, { maximized: true, selected: "step:run-41:implement" }, ["Implement", "Publish card projections", "Ran checks · 2 failed"])
]
