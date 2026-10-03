import type { Action, BaseView } from "../../src/CardAction.ts"

/**
 * One fixture story (C-UI-12): a model with the actions, gestures and view state its View receives, and `expect`,
 * the strings its View must show. Each `expect` string is carried by the model or the passed actions (a string,
 * case-sensitive, or a number), so no story invents copy the View does not own.
 */
export interface Story<Model, View extends object = {}, Gesture extends string = never> {
  readonly name: string
  readonly model: Model
  readonly actions: ReadonlyArray<Action>
  readonly gestures: Partial<Readonly<Record<Gesture, Action>>>
  readonly view: BaseView & View
  readonly expect: ReadonlyArray<string>
}

/** A story with no buttons, no gestures and the default view unless `parts` gives them. */
export const story = <Model, View extends object = {}, Gesture extends string = never>(
  name: string,
  model: Model,
  parts: Partial<Omit<Story<Model, View, Gesture>, "name" | "model">> & { readonly expect: ReadonlyArray<string> }
): Story<Model, View, Gesture> => ({
  name,
  model,
  actions: [],
  gestures: {},
  view: { maximized: false } as BaseView & View,
  ...parts
})
