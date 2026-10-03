import type { ReactNode } from "react"

export type StoryAction = { tag: string; label: string; args?: Record<string, string>; disabled?: { reason: string } }
export type StoryCallbacks = { onAction: (tag: string, args?: Record<string, string>) => void; onView: (patch: Record<string, unknown>) => void }
export type StoryInteraction = {
  selector: string; gesture?: string; event?: "focusout" | "click" | "input" | "change" | "keydown"; value?: string; key?: string;
  action?: { tag: string; args: Record<string, string> } | null; patch?: Record<string, unknown>
}
export type ViewStory = {
  interactionSuite?: "TODO";
  name: string; expect: readonly string[]; actions?: readonly StoryAction[]; gestures?: Partial<Record<string, StoryAction>>;
  render: (callbacks: StoryCallbacks, actions?: readonly StoryAction[]) => ReactNode;
  interactions?: readonly StoryInteraction[]
}
export type StoryFixture<M, V, G> = {
  name: string; model: M; actions: readonly StoryAction[]; gestures: G; view: V; expect: readonly string[]
}
/** Adapt RPC fixtures without a Container, store or network connection. */
export function fixtureStories<F extends { name: string; actions: readonly StoryAction[]; gestures?: Partial<Record<string, StoryAction>>; expect: readonly string[] }>(
  fixtures: Record<string, F>,
  render: (fixture: F, callbacks: StoryCallbacks) => ReactNode,
  interactions: Partial<Record<string, readonly StoryInteraction[]>> = {},
): ViewStory[] {
  return Object.values(fixtures).map(fixture => ({
    name: fixture.name, expect: fixture.expect, actions: fixture.actions, gestures: fixture.gestures, interactions: interactions[fixture.name],
    render: (callbacks, actions = fixture.actions) => render({ ...fixture, actions }, callbacks),
  }))
}
export type StoryModule = { stories: readonly ViewStory[] }
