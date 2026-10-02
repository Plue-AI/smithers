/*
 * Not in this release (mvp.md §16). Review material, not a journey: one card
 * lists every deferral, one line each, so Will can ratify them visually.
 */
import type { Journey } from "../journey"
import { showCard, type State } from "../world"
import { BEN, seedState } from "./seed"

const setup = (): State => {
  const state = seedState([BEN])
  showCard(state, BEN, "later", "§16")
  return state
}

export const later: Journey = {
  id: "later",
  title: "Not in this release",
  spec: "§16",
  intro: "What the MVP leaves for the first release after it, one line each, with where the spec defers it.",
  viewers: [BEN],
  setup,
  steps: [
    { caption: "Will ratifies these deferrals, or names any the MVP must keep.", hold: 4000, act: () => {} }
  ]
}
