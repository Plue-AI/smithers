import type { ComponentType, ReactNode } from "react"

export type StoryAction = { tag: string; label: string; args?: Record<string, unknown>; disabled?: { reason: string } }
export type StoryCallbacks = { onAction: (tag: string, args: Record<string, unknown>) => void; onView: (patch: Record<string, unknown>) => void }
export type StoryInteraction = {
  selector: string; event?: "click" | "input" | "change" | "keydown"; value?: string; key?: string;
  action?: { tag: string; args: Record<string, unknown> }; patch?: Record<string, unknown>
}
export type ViewStory = {
  name: string; expect: readonly string[]; actions?: readonly StoryAction[];
  render: (callbacks: StoryCallbacks, actions?: readonly StoryAction[]) => ReactNode;
  interactions?: readonly StoryInteraction[]
}
export type StoryFixture<M, V, G> = {
  name: string; model: M; actions: readonly StoryAction[]; gestures: G; view: V; expect: readonly string[]
}
/** Adapt RPC fixtures without a Container, store or network connection. */
export function fixtureStories<M, V, G>(
  View: ComponentType<{ model: M; actions: readonly StoryAction[]; gestures: G; view: V } & StoryCallbacks>,
  fixtures: Record<string, StoryFixture<M, V, G>>,
): ViewStory[] {
  return Object.values(fixtures).map(fixture => ({
    name: fixture.name, expect: fixture.expect, actions: fixture.actions,
    render: (callbacks, actions = fixture.actions) => <View {...fixture} {...callbacks} actions={actions} />,
  }))
}
export type StoryModule = { stories: readonly ViewStory[] }
